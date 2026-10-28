import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { ApiErrors } from '../common/swagger/api-docs.decorators';
import { NotificationQueryDto } from './dto/notification-query.dto';
import {
  MarkAllReadResultDto,
  MarkedNotificationDto,
  NotificationListDto,
  UnreadCountDto,
} from './dto/notification.response';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your notifications',
    description:
      'Newest first, with the total unread count. New ones also arrive as `notification:new`.',
  })
  @ApiOkResponse({ type: NotificationListDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: NotificationQueryDto) {
    return this.notifications.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (for badges)' })
  @ApiOkResponse({ type: UnreadCountDto })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read', description: 'Idempotent.' })
  @ApiOkResponse({ type: MarkedNotificationDto })
  @ApiErrors(ErrorCode.RESOURCE_NOT_FOUND)
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiOkResponse({ type: MarkAllReadResultDto })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }
}
