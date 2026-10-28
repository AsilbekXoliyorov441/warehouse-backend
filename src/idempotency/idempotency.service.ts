import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService, Tx } from '../prisma/prisma.service';

export interface IdempotentResult<T> {
  body: T;
  replayed: boolean;
}

const RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Deterministic JSON (sorted keys) so logically equal payloads hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function hashRequest(operation: string, payload: unknown): string {
  return createHash('sha256')
    .update(`${operation}\n${stableStringify(payload)}`)
    .digest('hex');
}

/**
 * Exactly-once semantics for write commands keyed by (user, Idempotency-Key):
 *
 * 1. The key row is inserted *first* inside the business transaction. A concurrent duplicate
 *    blocks on the unique index until the first transaction finishes.
 * 2. If the first commits, the duplicate fails with a unique violation and replays the stored
 *    response. If it rolls back (e.g. insufficient stock) the key is free to be retried.
 * 3. Reusing a key with a different payload or operation yields 409 IDEMPOTENCY_CONFLICT.
 */
@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);
  private purgeTimer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.purgeTimer = setInterval(() => void this.purgeExpired(), 3600_000);
    this.purgeTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.purgeTimer);
  }

  async execute<T>(
    params: { userId: string; key: string; operation: string; payload: unknown },
    work: (tx: Tx) => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = hashRequest(params.operation, params.payload);
    const existing = await this.find(params.userId, params.key);
    if (existing) return this.replay(existing, requestHash);

    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const record = await tx.idempotencyKey.create({
          data: {
            userId: params.userId,
            key: params.key,
            operation: params.operation,
            requestHash,
            responseBody: {},
            statusCode: 0,
          },
          select: { id: true },
        });
        // Normalise through JSON so the first response and replays are byte-for-byte identical.
        const body = JSON.parse(JSON.stringify(await work(tx))) as T;
        await tx.idempotencyKey.update({
          where: { id: record.id },
          data: { responseBody: body as Prisma.InputJsonValue, statusCode: 201 },
        });
        return { body, replayed: false };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.find(params.userId, params.key);
        if (winner) return this.replay(winner, requestHash);
      }
      throw err;
    }
  }

  private find(userId: string, key: string) {
    return this.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  }

  private replay<T>(
    record: { requestHash: string; responseBody: Prisma.JsonValue },
    requestHash: string,
  ): IdempotentResult<T> {
    if (record.requestHash !== requestHash) {
      throw AppException.conflict(
        ErrorCode.IDEMPOTENCY_CONFLICT,
        'This idempotency key was already used with a different request',
      );
    }
    return { body: record.responseBody as T, replayed: true };
  }

  async purgeExpired(): Promise<void> {
    try {
      const { count } = await this.prisma.idempotencyKey.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - RETENTION_MS) } },
      });
      if (count) this.logger.log(`Purged ${count} expired idempotency keys`);
    } catch (err) {
      this.logger.warn(`Idempotency purge failed: ${(err as Error).message}`);
    }
  }
}
