import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MovementType, TransferStatus } from '@prisma/client';
import type {
  InventoryUpdatedPayload,
  LowStockPayload,
  NotificationNewPayload,
  SubscribeAck,
  TransferUpdatedPayload,
} from './event-contracts';

/*
 * OpenAPI mirrors of the Socket.IO contracts in event-contracts.ts. They are registered as extra
 * models so frontend code generators get typed payloads; `implements` keeps them in sync.
 */

export class InventorySubscribeRequest {
  @ApiProperty({ format: 'uuid' }) branchId!: string;
}

export class InventorySubscribeAck implements SubscribeAck {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional({ format: 'uuid' }) branchId?: string;

  @ApiPropertyOptional({ enum: ['FORBIDDEN', 'VALIDATION_ERROR', 'INVALID_BRANCH'] })
  code?: string;

  @ApiPropertyOptional() message?: string;
}

export class InventoryUpdatedEvent implements InventoryUpdatedPayload {
  @ApiProperty({ format: 'uuid', description: 'De-duplicate on this' }) eventId!: string;
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 14, description: 'Absolute on-hand quantity' }) quantity!: number;
  @ApiProperty({ example: 43, description: 'Apply only if greater than cached' }) version!: number;
  @ApiProperty({ format: 'uuid' }) movementId!: string;
  @ApiProperty({ enum: MovementType, enumName: 'MovementType' }) movementType!: string;
  @ApiProperty() occurredAt!: string;
}

export class LowStockEvent implements LowStockPayload {
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 4 }) quantity!: number;
  @ApiProperty({ example: 5 }) minStock!: number;
  @ApiProperty() occurredAt!: string;
}

export class TransferUpdatedEvent implements TransferUpdatedPayload {
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ format: 'uuid' }) transferId!: string;
  @ApiProperty({ format: 'uuid' }) sourceBranchId!: string;
  @ApiProperty({ format: 'uuid' }) destinationBranchId!: string;
  @ApiProperty({ enum: TransferStatus, enumName: 'TransferStatus' })
  status!: TransferUpdatedPayload['status'];
  @ApiProperty() occurredAt!: string;
}

export class NotificationNewEvent implements NotificationNewPayload {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'LOW_STOCK' }) type!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) branchId!: string | null;
  @ApiProperty({ example: 'Low stock' }) title!: string;
  @ApiProperty() message!: string;
  @ApiProperty() createdAt!: string;
}

export const REALTIME_MODELS = [
  InventorySubscribeRequest,
  InventorySubscribeAck,
  InventoryUpdatedEvent,
  LowStockEvent,
  TransferUpdatedEvent,
  NotificationNewEvent,
];
