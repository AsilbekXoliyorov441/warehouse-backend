import { ApiProperty } from '@nestjs/swagger';
import { BranchRole } from '@prisma/client';
import { Permission } from '../../common/constants/permissions';

class MeMembershipDto {
  @ApiProperty({ format: 'uuid' }) branchId!: string;
  @ApiProperty({ example: 'Downtown Store' }) branchName!: string;
  @ApiProperty({ example: '12 Main St, Springfield' }) branchAddress!: string;
  @ApiProperty({ enum: BranchRole, enumName: 'BranchRole' }) role!: BranchRole;

  @ApiProperty({
    enum: Permission,
    enumName: 'Permission',
    isArray: true,
    description: 'Effective permissions in this branch (drive UI visibility from this list)',
  })
  permissions!: Permission[];
}

export class MeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;

  @ApiProperty({ type: [MeMembershipDto], description: 'Memberships in active branches only' })
  memberships!: MeMembershipDto[];
}
