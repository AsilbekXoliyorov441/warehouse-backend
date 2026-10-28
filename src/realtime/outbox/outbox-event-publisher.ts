import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../../prisma/prisma.service';
import { EventPublisher, OutboundEvent } from '../events/event-publisher';

/** Transactional outbox: events are rows written inside the business transaction. */
@Injectable()
export class OutboxEventPublisher extends EventPublisher {
  async publish(tx: Tx, events: OutboundEvent[]): Promise<void> {
    if (events.length === 0) return;
    await tx.outboxEvent.createMany({
      data: events.map((e) => ({
        id: e.id,
        eventName: e.name,
        room: e.room,
        payload: e.payload as unknown as Prisma.InputJsonObject,
      })),
    });
  }
}
