import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '../common/constants/permissions';
import { RequireBranchPermission } from '../common/decorators/permissions.decorator';
import { StockMovementWithRefsDto } from '../stock-movements/dto/movement.response';
import { DashboardService } from './dashboard.service';
import { DashboardListQueryDto, DashboardQueryDto } from './dto/dashboard-query.dto';
import { DashboardSummaryDto, LowStockItemDto, StockValueDto } from './dto/dashboard.response';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequireBranchPermission(Permission.REPORT_READ, 'query')
  @ApiOperation({
    summary: 'Branch KPIs',
    description:
      'Active products, units, low/out-of-stock counts, stock value, pending transfers and movements in the last 24 h.',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@Query() q: DashboardQueryDto) {
    return this.dashboard.summary(q.branchId);
  }

  @Get('low-stock')
  @RequireBranchPermission(Permission.REPORT_READ, 'query')
  @ApiOperation({
    summary: 'Products at or below minimum stock',
    description: 'Active products only, most critical (lowest quantity / minStock) first.',
  })
  @ApiOkResponse({ type: [LowStockItemDto] })
  lowStock(@Query() q: DashboardListQueryDto) {
    return this.dashboard.lowStock(q.branchId, q.limit);
  }

  @Get('recent-movements')
  @RequireBranchPermission(Permission.REPORT_READ, 'query')
  @ApiOperation({ summary: 'Most recent stock movements' })
  @ApiOkResponse({ type: [StockMovementWithRefsDto] })
  recentMovements(@Query() q: DashboardListQueryDto) {
    return this.dashboard.recentMovements(q.branchId, q.limit);
  }

  @Get('stock-value')
  @RequireBranchPermission(Permission.REPORT_READ, 'query')
  @ApiOperation({
    summary: 'Inventory value by category',
    description:
      'Σ(quantity × current catalog price) over active products, computed in NUMERIC. A retail-value estimate, not a cost basis.',
  })
  @ApiOkResponse({ type: StockValueDto })
  stockValue(@Query() q: DashboardQueryDto) {
    return this.dashboard.stockValue(q.branchId);
  }
}
