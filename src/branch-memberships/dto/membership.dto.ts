import { ApiProperty } from '@nestjs/swagger';
import { BranchRole } from '@prisma/client';
import { IsEnum, IsUUID } from 'class-validator';

export class AddMemberDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: BranchRole })
  @IsEnum(BranchRole)
  role!: BranchRole;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: BranchRole })
  @IsEnum(BranchRole)
  role!: BranchRole;
}
