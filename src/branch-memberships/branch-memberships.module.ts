import { Module } from '@nestjs/common';
import { BranchAccessService } from './branch-access.service';
import { BranchMembershipsController } from './branch-memberships.controller';
import { BranchMembershipsService } from './branch-memberships.service';

@Module({
  controllers: [BranchMembershipsController],
  providers: [BranchAccessService, BranchMembershipsService],
  exports: [BranchAccessService],
})
export class BranchMembershipsModule {}
