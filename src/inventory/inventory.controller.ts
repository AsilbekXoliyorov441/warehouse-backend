import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireBranchPermission } from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiAccess, ApiErrors, ApiIdempotentCreated } from '../common/swagger/api-docs.decorators';
import { withReplayHeader } from '../common/utils/idempotent-response';
import {
  AdjustmentDto,
  InventoryQueryDto,
  ReceiptDto,
  ReversalDto,
  SaleDto,
} from './dto/inventory.dto';
import {
  InventoryRecordDto,
  InventorySnapshotDto,
  StockOperationResultDto,
} from './dto/inventory.response';
import { InventoryService } from './inventory.service';

const EMITS =
  'On commit, emits `inventory:updated` to `branch:<id>` (and `inventory:low-stock` + `notification:new` when the product crosses into low stock).';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequireBranchPermission(Permission.INVENTORY_READ, 'query')
  @ApiOperation({
    summary: 'Branch inventory snapshot',
    description:
      'Authoritative quantities with per-row `version`. Load it after subscribing on every socket (re)connect. Sorted by product name; `limit` up to 500.',
  })
  @ApiOkResponse({ type: InventorySnapshotDto })
  list(@Query() query: InventoryQueryDto) {
    return this.inventory.list(query);
  }

  @Get(':branchId/:productId')
  @RequireBranchPermission(Permission.INVENTORY_READ, 'params')
  @ApiOperation({
    summary: 'Single inventory record',
    description: 'A product never stocked in the branch returns quantity 0 at version 0.',
  })
  @ApiOkResponse({ type: InventoryRecordDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  getOne(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.inventory.getOne(branchId, productId);
  }

  @Post('receipts')
  @RequireBranchPermission(Permission.STOCK_RECEIVE, 'body')
  @ApiOperation({ summary: 'Record incoming goods', description: EMITS })
  @ApiIdempotentCreated(StockOperationResultDto)
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.PRODUCT_INACTIVE)
  async receive(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReceiptDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withReplayHeader(res, await this.inventory.receive(user.id, dto));
  }

  @Post('sales')
  @RequireBranchPermission(Permission.SALE_CREATE, 'body')
  @ApiOperation({
    summary: 'Record a sale',
    description: `Never drives stock negative: concurrent sales are serialised and the loser gets \`INSUFFICIENT_STOCK\` (details: requested, available). ${EMITS}`,
  })
  @ApiIdempotentCreated(StockOperationResultDto)
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.INSUFFICIENT_STOCK, ErrorCode.PRODUCT_INACTIVE)
  async sell(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SaleDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withReplayHeader(res, await this.inventory.sell(user.id, dto));
  }

  @Post('adjustments')
  @RequireBranchPermission(Permission.STOCK_ADJUST, 'body')
  @ApiOperation({
    summary: 'Apply a stock correction',
    description: `Signed, non-zero \`delta\` with a mandatory reason; never an absolute overwrite. ${EMITS}`,
  })
  @ApiIdempotentCreated(StockOperationResultDto)
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND, ErrorCode.INSUFFICIENT_STOCK, ErrorCode.PRODUCT_INACTIVE)
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AdjustmentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withReplayHeader(res, await this.inventory.adjust(user.id, dto));
  }

  @Post('reversals')
  @ApiOperation({
    summary: 'Reverse a movement',
    description: `Creates a compensating REVERSAL for an IN, SALE or ADJUSTMENT movement. Each movement can be reversed once; transfers are cancelled instead. Works on inactive products. ${EMITS}`,
  })
  @ApiAccess(
    '`STOCK_REVERSE` in the branch of the original movement. Roles: `ADMIN`, `MANAGER`. Movements in branches you cannot read return 404.',
  )
  @ApiIdempotentCreated(StockOperationResultDto)
  @ApiErrors(
    ErrorCode.RESOURCE_NOT_FOUND,
    ErrorCode.MOVEMENT_ALREADY_REVERSED,
    ErrorCode.MOVEMENT_NOT_REVERSIBLE,
    ErrorCode.INSUFFICIENT_STOCK,
  )
  async reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReversalDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withReplayHeader(res, await this.inventory.reverse(user.id, dto));
  }
}
