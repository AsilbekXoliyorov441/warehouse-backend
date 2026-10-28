import { randomUUID } from 'node:crypto';
import { InternalEvents, Rooms } from './event-contracts';
import type { OutboundEvent } from './event-publisher';

/** Event that makes the gateway re-check a user's branch rooms once the change commits. */
export function accessChangedEvent(userId: string): OutboundEvent {
  return {
    id: randomUUID(),
    name: InternalEvents.ACCESS_CHANGED,
    room: Rooms.user(userId),
    payload: { userId },
  };
}
