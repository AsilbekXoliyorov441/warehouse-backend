import { ApiProperty } from '@nestjs/swagger';

class PendingTransfersDto {
  @ApiProperty({ example: 2 }) incoming!: number;
  @ApiProperty({ example: 1 }) outgoing!: number;
}

export class DashboardSummaryDto {
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ example: 12 }) totalActiveProducts!: number;
  @ApiProperty({ example: 640 }) totalUnitsInStock!: number;
  @ApiProperty({ example: 3 }) lowStockCount!: number;
  @ApiProperty({ example: 1 }) outOfStockCount!: number;
  @ApiProperty({ example: '2431.50', description: 'Decimal string' }) stockValue!: string;
  @ApiProperty({ type: PendingTransfersDto }) pendingTransfers!: PendingTransfersDto;
  @ApiProperty({ example: 27 }) movementsLast24h!: number;
  @ApiProperty() valuationRule!: string;
  @ApiProperty() generatedAt!: string;
}

export class LowStockItemDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 'SNK-CHIPS-150' }) sku!: string;
  @ApiProperty({ example: 'Potato chips 150g' }) name!: string;
  @ApiProperty({ example: 'pcs' }) unit!: string;
  @ApiProperty({ example: 2 }) quantity!: number;
  @ApiProperty({ example: 10 }) minStock!: number;
  @ApiProperty({ example: 8, description: 'minStock - quantity' }) shortfall!: number;
  @ApiProperty({ example: 7 }) version!: number;
  @ApiProperty() updatedAt!: Date;
}

class CategoryValueDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) categoryId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'Beverages' }) categoryName!: string | null;
  @ApiProperty({ example: 120 }) units!: number;
  @ApiProperty({ example: '238.80' }) value!: string;
}

export class StockValueDto {
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ example: 'unspecified' }) currency!: string;
  @ApiProperty() valuationRule!: string;
  @ApiProperty({ example: '2431.50' }) totalValue!: string;
  @ApiProperty({ type: [CategoryValueDto] }) byCategory!: CategoryValueDto[];
  @ApiProperty() generatedAt!: string;
}
