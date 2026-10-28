import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

const RETRYABLE_PG_CODES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);
  private readonly commitListeners = new Set<() => void>();

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /**
   * Disconnects in the last shutdown phase. Nest runs every onModuleDestroy and
   * beforeApplicationShutdown hook first, so in-flight work (e.g. an outbox batch) still has a
   * connection while it finishes.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Registers a callback invoked after every transaction committed through runInTransaction.
   * Used by the outbox dispatcher to deliver events with low latency; never for business logic.
   */
  onCommit(listener: () => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /**
   * Runs `fn` in an interactive transaction and retries it when PostgreSQL aborts the
   * transaction because of a deadlock or serialization failure. Business errors thrown by
   * `fn` are never retried.
   */
  async runInTransaction<T>(
    fn: (tx: Tx) => Promise<T>,
    options: { isolationLevel?: Prisma.TransactionIsolationLevel; maxAttempts?: number } = {},
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.$transaction(fn, {
          isolationLevel: options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5_000,
          timeout: 15_000,
        });
        for (const listener of this.commitListeners) listener();
        return result;
      } catch (err) {
        if (attempt >= maxAttempts || !isRetryableTransactionError(err)) throw err;
        this.logger.warn(`Retrying transaction after concurrency conflict (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
      }
    }
  }
}

export function isRetryableTransactionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2034') return true;
    if (err.code === 'P2010') {
      const code = (err.meta as { code?: string } | undefined)?.code;
      return code !== undefined && RETRYABLE_PG_CODES.has(code);
    }
  }
  const message = err instanceof Error ? err.message : '';
  return /deadlock detected|could not serialize access/i.test(message);
}
