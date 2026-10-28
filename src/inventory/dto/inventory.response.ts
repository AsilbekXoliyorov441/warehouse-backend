import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../common/swagger/api-models';
import { StockMovementDto } from '../../stock-movements/dto/movement.response';

class InventoryProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BEV-COLA-330' }) sku!: string;
  @ApiProperty({ example: 'Cola 330ml' }) name!: string;
  @ApiProperty({ example: 'pcs' }) unit!: string;
  @ApiProperty({ example: '1.99' }) price!: string;
  @ApiProperty({ example: 5 }) minStock!: number;
  @ApiProperty() isActive!: boolean;
}

class InventorySnapshotProductDto extends InventoryProductDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) categoryId!: string | null;
}

export class InventoryItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 17 }) quantity!: number;

  @ApiProperty({
    example: 42,
    description: 'Increments by exactly 1 per change. Ignore socket events with version ≤ this.',
  })
  version!: number;

  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ description: 'minStock > 0 and quantity ≤ minStock' }) isLowStock!: boolean;
  @ApiProperty({ type: InventorySnapshotProductDto }) product!: InventorySnapshotProductDto;
}

export class InventorySnapshotDto {
  @ApiProperty({ type: [InventoryItemDto] }) data!: InventoryItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;

  @ApiProperty({ description: 'Server time the snapshot was read' })
  snapshotAt!: string;
}

export class InventoryRecordDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null if never stocked',
  })
  id!: string | null;

  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 0 }) quantity!: number;
  @ApiProperty({ example: 0 }) version!: number;
  @ApiProperty({ type: Date, nullable: true }) updatedAt!: Date | null;
  @ApiProperty() isLowStock!: boolean;
  @ApiProperty({ type: InventoryProductDto }) product!: InventoryProductDto;
  @ApiProperty() snapshotAt!: string;
}

class InventoryStateDto {
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 14 }) quantity!: number;
  @ApiProperty({ example: 43 }) version!: number;
  @ApiProperty() updatedAt!: Date;
}

export class StockOperationResultDto {
  @ApiProperty({ type: StockMovementDto }) movement!: StockMovementDto;
  @ApiProperty({ type: InventoryStateDto }) inventory!: InventoryStateDto;

  @ApiProperty({ description: 'Whether the product is at or below its minimum after the change' })
  lowStock!: boolean;
}
