import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireBranchPermission } from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import {
  ApiAccess,
  ApiErrors,
  ApiIdempotentCreated,
  ApiPage,
} from '../common/swagger/api-docs.decorators';
import { withReplayHeader } from '../common/utils/idempotent-response';
import { CancelTransferDto, CreateTransferDto, TransferQueryDto } from './dto/transfer.dto';
import { TransferDto } from './dto/transfer.response';
import { TransfersService } from './transfers.service';

const EMITS = 'Emits `transfer:updated` to both branches on commit.';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a PENDING transfer',
    description: `Validates the destination, products and current source stock (stock is **not** reserved; it is re-checked on completion). Each product may appear once. ${EMITS}`,
  })
  @ApiAccess(
    '`TRANSFER_CREATE` in the **source** branch. Roles: `ADMIN`, `MANAGER`, `WAREHOUSE_WORKER`.',
  )
  @ApiIdempotentCreated(TransferDto)
  @ApiErrors(
    ErrorCode.INVALID_BRANCH,
    ErrorCode.RESOURCE_NOT_FOUND,
    ErrorCode.PRODUCT_INACTIVE,
    ErrorCode.INSUFFICIENT_STOCK,
  )
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withReplayHeader(res, await this.transfers.create(user.id, dto));
  }

  @Get()
  @RequireBranchPermission(Permission.TRANSFER_READ, 'query')
  @ApiOperation({ summary: 'Transfers into and/or out of a branch', description: 'Newest first.' })
  @ApiPage(TransferDto)
  list(@Query() query: TransferQueryDto) {
    return this.transfers.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a transfer' })
  @ApiAccess('`TRANSFER_READ` in the source or destination branch; otherwise 404.')
  @ApiOkResponse({ type: TransferDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.findOne(user.id, id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a transfer',
    description: `Atomically moves all items (TRANSFER_OUT + TRANSFER_IN movements). Any shortfall rolls everything back and the transfer stays PENDING. Of concurrent complete/cancel calls exactly one wins. ${EMITS}`,
  })
  @ApiAccess('`TRANSFER_APPROVE` in the source or destination branch. Roles: `ADMIN`, `MANAGER`.')
  @ApiOkResponse({ type: TransferDto })
  @ApiErrors(
    ErrorCode.RESOURCE_NOT_FOUND,
    ErrorCode.INSUFFICIENT_STOCK,
    ErrorCode.TRANSFER_ALREADY_COMPLETED,
    ErrorCode.TRANSFER_ALREADY_CANCELLED,
    ErrorCode.CONCURRENT_MODIFICATION,
  )
  complete(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.complete(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a PENDING transfer', description: EMITS })
  @ApiAccess(
    '`TRANSFER_APPROVE` in either branch, or the creator while they still hold `TRANSFER_CREATE` in the source branch.',
  )
  @ApiOkResponse({ type: TransferDto })
  @ApiErrors(
    ErrorCode.RESOURCE_NOT_FOUND,
    ErrorCode.TRANSFER_ALREADY_COMPLETED,
    ErrorCode.TRANSFER_ALREADY_CANCELLED,
  )
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTransferDto,
  ) {
    return this.transfers.cancel(user.id, id, dto);
  }
}
