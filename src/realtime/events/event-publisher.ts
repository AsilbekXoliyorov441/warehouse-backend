import type { Tx } from '../../prisma/prisma.service';
import type { ServerEventName, ServerEventPayloads } from './event-contracts';

export type OutboundEvent = {
  [N in ServerEventName]: {
    /** Stable id; equals payload.eventId when present so duplicates can be detected. */
    id: string;
    name: N;
    room: string;
    payload: ServerEventPayloads[N];
  };
}[ServerEventName];

/**
 * The only way business services emit real-time events. Implementations must make events
 * visible to clients only if `tx` commits.
 */
export abstract class EventPublisher {
  abstract publish(tx: Tx, events: OutboundEvent[]): Promise<void>;
}
