import { ApiProperty } from '@nestjs/swagger';
import { IdRefDto } from '../../common/swagger/api-models';

export class ProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'BEV-COLA-330' }) sku!: string;
  @ApiProperty({ example: 'Cola 330ml' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) categoryId!: string | null;
  @ApiProperty({ example: 'pcs' }) unit!: string;

  @ApiProperty({ example: '1.99', description: 'Decimal string (NUMERIC 12,2)' })
  price!: string;

  @ApiProperty({ example: 5, description: 'Low-stock threshold; 0 disables alerts' })
  minStock!: number;

  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: IdRefDto, nullable: true }) category!: IdRefDto | null;
}
