import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { toBoolean, trim } from '../../common/utils/transform';

/** Money is accepted as a decimal string (or number) and stored as NUMERIC(12,2). */
const PRICE_RE = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;
const toPriceString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : typeof value === 'string'
      ? value.trim()
      : value;

export class CreateProductDto {
  @ApiProperty({ example: 'BEV-COLA-330', description: 'Unique, stored upper-case' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9._-]{1,63}$/, {
    message: 'sku must be 2-64 chars of A-Z, 0-9, ".", "_" or "-"',
  })
  sku!: string;

  @ApiProperty({ example: 'Cola 330ml' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiProperty({ example: 'pcs' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @ApiProperty({
    example: '1.99',
    description: 'Non-negative decimal with up to 2 fraction digits',
  })
  @Transform(toPriceString)
  @IsString()
  @Matches(PRICE_RE, { message: 'price must be a non-negative amount with at most 2 decimals' })
  price!: string;

  @ApiPropertyOptional({ example: 5, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  minStock?: number;
}

/** isActive is changed only through PATCH /products/:id/status; stock never via the catalog. */
export class UpdateProductDto extends PartialType(OmitType(CreateProductDto, ['sku'] as const)) {}

export class UpdateProductStatusDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

export class ProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search in name and SKU' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: ['name', 'sku', 'price', 'createdAt'], default: 'name' })
  @IsOptional()
  @IsIn(['name', 'sku', 'price', 'createdAt'])
  sortBy: 'name' | 'sku' | 'price' | 'createdAt' = 'name';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';
}
