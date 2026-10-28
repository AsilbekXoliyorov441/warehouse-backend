import { ApiProperty } from '@nestjs/swagger';
import { TransferStatus } from '@prisma/client';
import { IdRefDto } from '../../common/swagger/api-models';

class TransferProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BEV-COLA-330' }) sku!: string;
  @ApiProperty({ example: 'Cola 330ml' }) name!: string;
  @ApiProperty({ example: 'pcs' }) unit!: string;
}

class TransferItemResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) transferId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 10 }) quantity!: number;
  @ApiProperty({ type: TransferProductDto }) product!: TransferProductDto;
}

export class TransferDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sourceBranchId!: string;
  @ApiProperty({ format: 'uuid' }) destinationBranchId!: string;
  @ApiProperty({ enum: TransferStatus, enumName: 'TransferStatus' }) status!: TransferStatus;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: Date, nullable: true }) completedAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) completedBy!: string | null;
  @ApiProperty({ type: Date, nullable: true }) cancelledAt!: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) cancelledBy!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: IdRefDto }) sourceBranch!: IdRefDto;
  @ApiProperty({ type: IdRefDto }) destinationBranch!: IdRefDto;
  @ApiProperty({ type: IdRefDto }) creator!: IdRefDto;
  @ApiProperty({ type: [TransferItemResponseDto] }) items!: TransferItemResponseDto[];
}
