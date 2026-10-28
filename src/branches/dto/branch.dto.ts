import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { trim } from '../../common/utils/transform';

export class CreateBranchDto {
  @ApiProperty({ example: 'Downtown Store' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ example: '12 Main St, Springfield' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  address!: string;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
