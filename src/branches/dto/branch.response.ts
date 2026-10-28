import { ApiProperty } from '@nestjs/swagger';
import { BranchRole } from '@prisma/client';

export class BranchDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Downtown Store' }) name!: string;
  @ApiProperty({ example: '12 Main St, Springfield' }) address!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class BranchWithRoleDto extends BranchDto {
  @ApiProperty({
    enum: BranchRole,
    enumName: 'BranchRole',
    nullable: true,
    description: "The caller's role in this branch (null for admins who are not members)",
  })
  myRole!: BranchRole | null;
}
