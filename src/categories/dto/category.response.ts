import { ApiProperty } from '@nestjs/swagger';

export class CategoryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Beverages' }) name!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

class CategoryCountDto {
  @ApiProperty({ example: 4, description: 'Products assigned to the category' }) products!: number;
}

export class CategoryWithCountDto extends CategoryDto {
  @ApiProperty({ type: CategoryCountDto }) _count!: CategoryCountDto;
}
