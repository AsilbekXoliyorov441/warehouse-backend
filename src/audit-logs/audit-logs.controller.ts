import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiPage } from '../common/swagger/api-docs.decorators';
import { AuditLogDto } from './dto/audit-log.response';
import { Permission } from '../common/constants/permissions';
import { RequirePermission } from '../common/decorators/permissions.decorator';
import { AuditLogsService } from './audit-logs.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

@ApiTags('audit-logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @RequirePermission(Permission.AUDIT_READ)
  @ApiOperation({
    summary: 'List audit log entries',
    description:
      'Newest first. Filter by actor, exact action (e.g. `inventory.sale`), entity and time range.',
  })
  @ApiPage(AuditLogDto)
  list(@Query() query: AuditLogQueryDto) {
    return this.auditLogs.list(query);
  }
}
