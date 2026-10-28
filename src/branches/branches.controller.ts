import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiAccess, ApiErrors } from '../common/swagger/api-docs.decorators';
import { BranchesService } from './branches.service';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';
import { BranchDto, BranchWithRoleDto } from './dto/branch.response';

@ApiTags('branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Post()
  @RequirePermission(Permission.BRANCH_MANAGE)
  @ApiOperation({
    summary: 'Create a branch',
    description: 'The creator automatically becomes ADMIN of the new branch.',
  })
  @ApiCreatedResponse({ type: BranchDto })
  @ApiErrors(ErrorCode.DUPLICATE_RESOURCE)
  create(@Body() dto: CreateBranchDto, @CurrentUser() user: AuthenticatedUser) {
    return this.branches.create(dto, user.id);
  }

  @Get()
  @ApiOperation({
    summary: 'List branches visible to the caller',
    description:
      'Members see their active branches; users with `BRANCH_MANAGE` see every branch (including inactive). Sorted by name.',
  })
  @ApiOkResponse({ type: [BranchWithRoleDto] })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.branches.list(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a branch' })
  @ApiAccess('member of the branch, or `BRANCH_MANAGE`.')
  @ApiOkResponse({ type: BranchWithRoleDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.branches.findOne(id, user.id);
  }

  @Patch(':id')
  @RequirePermission(Permission.BRANCH_MANAGE)
  @ApiOperation({
    summary: 'Update or (de)activate a branch',
    description: 'Inactive branches reject stock operations and disappear for non-admin members.',
  })
  @ApiOkResponse({ type: BranchDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.DUPLICATE_RESOURCE)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.branches.update(id, dto, user.id);
  }
}
