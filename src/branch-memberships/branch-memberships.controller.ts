import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireBranchPermission,
  RequirePermission,
} from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiErrors } from '../common/swagger/api-docs.decorators';
import { BranchMembershipsService } from './branch-memberships.service';
import { AddMemberDto, UpdateMemberDto } from './dto/membership.dto';
import { MemberDto } from './dto/membership.response';

@ApiTags('branch-memberships')
@ApiBearerAuth()
@Controller('branches/:branchId/members')
export class BranchMembershipsController {
  constructor(private readonly memberships: BranchMembershipsService) {}

  @Get()
  @RequireBranchPermission(Permission.MEMBERS_READ, 'params')
  @ApiOperation({ summary: 'List members of a branch', description: 'Oldest membership first.' })
  @ApiOkResponse({ type: [MemberDto] })
  list(@Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.memberships.list(branchId);
  }

  @Post()
  @RequirePermission(Permission.USER_MANAGE)
  @ApiOperation({ summary: 'Grant a user a role in a branch' })
  @ApiCreatedResponse({ type: MemberDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.DUPLICATE_RESOURCE)
  add(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.memberships.add(branchId, dto.userId, dto.role, actor.id);
  }

  @Patch(':userId')
  @RequirePermission(Permission.USER_MANAGE)
  @ApiOperation({
    summary: "Change a member's role",
    description:
      'Takes effect immediately, including on open sockets. You cannot change your own membership.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  update(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.memberships.updateRole(branchId, userId, dto.role, actor.id);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Remove a member from a branch',
    description: 'The user’s sockets lose the branch subscription immediately.',
  })
  @ApiNoContentResponse({ description: 'Membership removed' })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  remove(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.memberships.remove(branchId, userId, actor.id);
  }
}
