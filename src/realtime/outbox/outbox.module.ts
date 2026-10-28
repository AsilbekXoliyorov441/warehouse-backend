import { Global, Module } from '@nestjs/common';
import { EventPublisher } from '../events/event-publisher';
import { OutboxEventPublisher } from './outbox-event-publisher';

/** Provides EventPublisher. Has no dependencies so any business module can import it. */
@Global()
@Module({
  providers: [{ provide: EventPublisher, useClass: OutboxEventPublisher }],
  exports: [EventPublisher],
})
export class OutboxModule {}
