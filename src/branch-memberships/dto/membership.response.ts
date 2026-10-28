import { ApiProperty } from '@nestjs/swagger';
import { BranchRole } from '@prisma/client';

class MemberUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Jane Doe' }) name!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() isActive!: boolean;
}

export class MemberDto {
  @ApiProperty({ format: 'uuid', description: 'Membership id' }) id!: string;
  @ApiProperty({ enum: BranchRole, enumName: 'BranchRole' }) role!: BranchRole;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: MemberUserDto }) user!: MemberUserDto;
}
