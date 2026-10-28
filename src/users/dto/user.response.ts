import { ApiProperty } from '@nestjs/swagger';
import { BranchRole } from '@prisma/client';

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
  @ApiProperty({ format: 'email', example: 'jane@example.com' }) email!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

class UserMembershipBranchDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Downtown Store' }) name!: string;
  @ApiProperty() isActive!: boolean;
}

class UserMembershipDto {
  @ApiProperty({ enum: BranchRole, enumName: 'BranchRole' }) role!: BranchRole;
  @ApiProperty({ type: UserMembershipBranchDto }) branch!: UserMembershipBranchDto;
}

export class UserDetailDto extends UserDto {
  @ApiProperty({ type: [UserMembershipDto] }) memberships!: UserMembershipDto[];
}
