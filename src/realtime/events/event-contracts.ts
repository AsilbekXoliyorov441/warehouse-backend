/**
 * Socket.IO event contracts shared by the gateway, publishers and tests.
 * Every server-to-client event is delivered at-least-once to connected sockets; clients must
 * de-duplicate by eventId (or notification id) and order inventory updates by `version`.
 */

export const ClientEvents = {
  SUBSCRIBE: 'inventory:subscribe',
  UNSUBSCRIBE: 'inventory:unsubscribe',
} as const;

export const ServerEvents = {
  INVENTORY_UPDATED: 'inventory:updated',
  LOW_STOCK: 'inventory:low-stock',
  NOTIFICATION_NEW: 'notification:new',
  TRANSFER_UPDATED: 'transfer:updated',
} as const;

export type ServerEventName =
  | (typeof ServerEvents)[keyof typeof ServerEvents]
  | (typeof InternalEvents)[keyof typeof InternalEvents];

export interface InventoryUpdatedPayload {
  eventId: string;
  branchId: string;
  productId: string;
  quantity: number;
  /** Monotonic per (branch, product). Apply only if greater than the cached version. */
  version: number;
  movementId: string;
  movementType: string;
  occurredAt: string;
}

export interface LowStockPayload {
  eventId: string;
  branchId: string;
  productId: string;
  quantity: number;
  minStock: number;
  occurredAt: string;
}

export interface NotificationNewPayload {
  id: string;
  type: string;
  branchId: string | null;
  title: string;
  message: string;
  createdAt: string;
}

export interface TransferUpdatedPayload {
  eventId: string;
  transferId: string;
  sourceBranchId: string;
  destinationBranchId: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  occurredAt: string;
}

/**
 * Internal (never sent to clients): tells the gateway to re-authorise a user's sockets after a
 * membership change or deactivation. Delivered through the outbox like every other event.
 */
export const InternalEvents = {
  ACCESS_CHANGED: 'internal:access-changed',
} as const;

export interface AccessChangedPayload {
  userId: string;
}

export interface ServerEventPayloads {
  'internal:access-changed': AccessChangedPayload;
  'inventory:updated': InventoryUpdatedPayload;
  'inventory:low-stock': LowStockPayload;
  'notification:new': NotificationNewPayload;
  'transfer:updated': TransferUpdatedPayload;
}

/** Server-generated room names. Clients can never name a room directly. */
export const Rooms = {
  branch: (branchId: string) => `branch:${branchId}`,
  user: (userId: string) => `user:${userId}`,
};

export interface SubscribeAck {
  ok: boolean;
  branchId?: string;
  code?: string;
  message?: string;
}
