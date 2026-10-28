import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
} from 'class-validator';
import { IdempotentCommandDto } from '../../common/dto/idempotency-key.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { toBoolean, trim } from '../../common/utils/transform';

export const MAX_OPERATION_QUANTITY = 1_000_000;

export class InventoryQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ description: 'Search product name or SKU' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Only rows at or below their minimum stock' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  lowStockOnly?: boolean;

  @ApiPropertyOptional({
    default: 100,
    maximum: 500,
    description: 'Larger pages make snapshot recovery cheaper',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  override limit: number = 100;
}

class StockCommandDto extends IdempotentCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;
}

export class ReceiptDto extends StockCommandDto {
  @ApiProperty({ example: 25, minimum: 1, maximum: MAX_OPERATION_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_QUANTITY)
  quantity!: number;

  @ApiPropertyOptional({ example: 'PO-1042 from Acme Supplies' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SaleDto extends StockCommandDto {
  @ApiProperty({ example: 3, minimum: 1, maximum: MAX_OPERATION_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_QUANTITY)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdjustmentDto extends StockCommandDto {
  @ApiProperty({
    example: -2,
    description: 'Signed, non-zero change to apply (never an absolute overwrite)',
  })
  @IsInt()
  @NotEquals(0)
  @Min(-MAX_OPERATION_QUANTITY)
  @Max(MAX_OPERATION_QUANTITY)
  delta!: number;

  @ApiProperty({ example: 'Two units damaged during stock count' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ReversalDto extends IdempotentCommandDto {
  @ApiProperty({ format: 'uuid', description: 'IN, SALE or ADJUSTMENT movement to reverse' })
  @IsUUID()
  movementId!: string;

  @ApiProperty({ example: 'Customer returned the goods' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
