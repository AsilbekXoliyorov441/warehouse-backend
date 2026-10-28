import { ApiProperty } from '@nestjs/swagger';
import { MovementDirection, MovementType } from '@prisma/client';

/** A row of the append-only stock ledger. */
export class StockMovementDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ enum: MovementType, enumName: 'MovementType' }) type!: MovementType;

  @ApiProperty({ enum: MovementDirection, enumName: 'MovementDirection' })
  direction!: MovementDirection;

  @ApiProperty({ example: 3, description: 'Always positive; see direction' })
  quantity!: number;

  @ApiProperty({ example: 17, description: 'On-hand quantity right after this movement' })
  balanceAfter!: number;

  @ApiProperty({ example: 42, description: 'Inventory version right after this movement' })
  inventoryVersion!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Transfer id (TRANSFER_IN/OUT) or reversed movement id (REVERSAL)',
  })
  referenceId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reversedMovementId!: string | null;

  @ApiProperty({ type: String, nullable: true }) idempotencyKey!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

class MovementProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BEV-COLA-330' }) sku!: string;
  @ApiProperty({ example: 'Cola 330ml' }) name!: string;
  @ApiProperty({ example: 'pcs' }) unit!: string;
}

class MovementCreatorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
}

export class StockMovementWithRefsDto extends StockMovementDto {
  @ApiProperty({ type: MovementProductDto }) product!: MovementProductDto;
  @ApiProperty({ type: MovementCreatorDto }) creator!: MovementCreatorDto;
}

class MovementReversalRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() createdAt!: Date;
}

export class StockMovementDetailDto extends StockMovementWithRefsDto {
  @ApiProperty({
    type: MovementReversalRefDto,
    nullable: true,
    description: 'The REVERSAL movement that compensated this one, if any',
  })
  reversal!: MovementReversalRefDto | null;
}
