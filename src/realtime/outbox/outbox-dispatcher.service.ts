import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessChangedPayload, InternalEvents } from '../events/event-contracts';
import { InventoryGateway } from '../inventory.gateway';

const BATCH_SIZE = 100;
const MAX_BACKOFF_MS = 60_000;
const RETENTION_MS = 24 * 3600 * 1000;

interface PendingRow {
  id: string;
  eventName: string;
  room: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

/**
 * Delivers committed outbox rows to Socket.IO.
 *  - Woken immediately after each commit (PrismaService.onCommit) and by a fallback poll.
 *  - Rows are claimed with FOR UPDATE SKIP LOCKED, so several workers never deliver the same row
 *    at the same time.
 *  - Failed deliveries are retried with exponential backoff. Delivery is at-least-once: clients
 *    de-duplicate by eventId.
 */
@Injectable()
export class OutboxDispatcherService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private pollTimer?: NodeJS.Timeout;
  private purgeTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private rerun = false;
  private stopped = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: InventoryGateway,
    private readonly config: AppConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.prisma.onCommit(() => this.trigger());
    this.pollTimer = setInterval(() => this.trigger(), this.config.get('OUTBOX_POLL_INTERVAL_MS'));
    this.purgeTimer = setInterval(() => void this.purgePublished(), 3600_000);
    this.pollTimer.unref();
    this.purgeTimer.unref();
    this.trigger();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    clearInterval(this.pollTimer);
    clearInterval(this.purgeTimer);
    await this.running; // let an in-flight batch finish before Prisma disconnects
  }

  /** Coalesces concurrent wake-ups into at most one running loop plus one follow-up pass. */
  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.drain()
      .catch((err: unknown) =>
        this.logger.error(`Outbox dispatch failed: ${(err as Error).message}`),
      )
      .finally(() => {
        this.running = undefined;
        if (this.rerun && !this.stopped) {
          this.rerun = false;
          this.trigger();
        }
      });
  }

  /** Resolves when the outbox is empty of deliverable rows. Intended for tests and shutdown. */
  async flush(): Promise<void> {
    this.trigger();
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && (await this.processBatch()) === BATCH_SIZE) {
      /* keep draining full batches */
    }
  }

  /** Uses $transaction directly (not runInTransaction) so it does not re-trigger itself. */
  private processBatch(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<PendingRow[]>(Prisma.sql`
        SELECT id, event_name AS "eventName", room, payload, attempts
          FROM outbox_events
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY created_at ASC, id ASC
         LIMIT ${BATCH_SIZE}
         FOR UPDATE SKIP LOCKED`);
      const delivered: string[] = [];
      for (const row of rows) {
        try {
          await this.deliver(row);
          delivered.push(row.id);
        } catch (err) {
          const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** row.attempts);
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: String((err as Error).message).slice(0, 1000),
              nextAttemptAt: new Date(Date.now() + backoff),
            },
          });
          this.logger.warn(
            `Outbox event ${row.id} (${row.eventName}) failed; retry in ${backoff}ms`,
          );
        }
      }
      if (delivered.length > 0) {
        await tx.outboxEvent.updateMany({
          where: { id: { in: delivered } },
          data: { publishedAt: new Date(), attempts: { increment: 1 } },
        });
      }
      return rows.length;
    });
  }

  private async deliver(row: PendingRow): Promise<void> {
    if (row.eventName === InternalEvents.ACCESS_CHANGED) {
      await this.gateway.reauthorizeUser((row.payload as unknown as AccessChangedPayload).userId);
      return;
    }
    this.gateway.deliver(row.eventName, row.room, row.payload);
  }

  private async purgePublished(): Promise<void> {
    try {
      await this.prisma.outboxEvent.deleteMany({
        where: { publishedAt: { lt: new Date(Date.now() - RETENTION_MS) } },
      });
    } catch (err) {
      this.logger.warn(`Outbox purge failed: ${(err as Error).message}`);
    }
  }
}
