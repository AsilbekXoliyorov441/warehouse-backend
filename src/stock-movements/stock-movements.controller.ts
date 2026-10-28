import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission } from '../common/constants/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireBranchPermission } from '../common/decorators/permissions.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiAccess, ApiErrors, ApiPage } from '../common/swagger/api-docs.decorators';
import { MovementQueryDto } from './dto/movement-query.dto';
import { StockMovementDetailDto, StockMovementWithRefsDto } from './dto/movement.response';
import { StockMovementsService } from './stock-movements.service';

@ApiTags('stock-movements')
@ApiBearerAuth()
@Controller('stock-movements')
export class StockMovementsController {
  constructor(private readonly movements: StockMovementsService) {}

  @Get()
  @RequireBranchPermission(Permission.MOVEMENT_READ, 'query')
  @ApiOperation({
    summary: 'Movement history for a branch',
    description:
      'Newest first. Filter by product, type, reference (transfer id / reversed movement id) and a `from`–`to` time range (inclusive).',
  })
  @ApiPage(StockMovementWithRefsDto)
  list(@Query() query: MovementQueryDto) {
    return this.movements.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a movement, including its reversal if any' })
  @ApiAccess('`MOVEMENT_READ` in the movement’s branch; otherwise 404.')
  @ApiOkResponse({ type: StockMovementDetailDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.movements.findOne(user.id, id);
  }
}
