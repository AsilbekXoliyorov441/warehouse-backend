import { ApiProperty } from '@nestjs/swagger';
import { PaginationMetaDto } from '../../common/swagger/api-models';

export class NotificationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) branchId!: string | null;
  @ApiProperty({ example: 'LOW_STOCK' }) type!: string;
  @ApiProperty({ example: 'Low stock' }) title!: string;

  @ApiProperty({
    example: 'Cola 330ml (BEV-COLA-330) at Downtown Store is at 4, minimum is 5',
  })
  message!: string;

  @ApiProperty({ type: Date, nullable: true }) readAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] }) data!: NotificationDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
  @ApiProperty({ example: 3, description: 'Unread total, independent of filters' })
  unreadCount!: number;
}

export class MarkedNotificationDto extends NotificationDto {
  @ApiProperty({ description: 'false if it was already read' }) changed!: boolean;
}

export class MarkAllReadResultDto {
  @ApiProperty({ example: 3 }) updated!: number;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 }) unreadCount!: number;
}
