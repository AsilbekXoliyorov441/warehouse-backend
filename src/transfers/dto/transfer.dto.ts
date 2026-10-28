import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TransferStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IdempotentCommandDto } from '../../common/dto/idempotency-key.dto';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { trim } from '../../common/utils/transform';
import { MAX_OPERATION_QUANTITY } from '../../inventory/dto/inventory.dto';

export class TransferItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 5, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_OPERATION_QUANTITY)
  quantity!: number;
}

export class CreateTransferDto extends IdempotentCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceBranchId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationBranchId!: string;

  @ApiProperty({ type: [TransferItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TransferItemDto)
  items!: TransferItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelTransferDto {
  @ApiPropertyOptional({ example: 'Destination no longer needs the goods' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class TransferQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ enum: ['incoming', 'outgoing', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['incoming', 'outgoing', 'all'])
  direction: 'incoming' | 'outgoing' | 'all' = 'all';

  @ApiPropertyOptional({ enum: TransferStatus })
  @IsOptional()
  @IsEnum(TransferStatus)
  status?: TransferStatus;
}
