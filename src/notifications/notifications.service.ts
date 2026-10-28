import { Injectable } from '@nestjs/common';
import { BranchRole, Prisma } from '@prisma/client';
import { paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { Rooms, ServerEvents } from '../realtime/events/event-contracts';
import { EventPublisher, OutboundEvent } from '../realtime/events/event-publisher';
import { NotificationQueryDto } from './dto/notification-query.dto';

export const NotificationType = { LOW_STOCK: 'LOW_STOCK' } as const;

/** Roles that receive operational stock alerts for their branch. */
const LOW_STOCK_RECIPIENT_ROLES: BranchRole[] = [
  BranchRole.ADMIN,
  BranchRole.MANAGER,
  BranchRole.WAREHOUSE_WORKER,
];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventPublisher,
  ) {}

  /** Creates per-user notifications inside the caller's transaction and stages notification:new. */
  async notifyLowStock(
    tx: Tx,
    input: {
      branchId: string;
      branchName: string;
      productName: string;
      sku: string;
      quantity: number;
      minStock: number;
    },
  ): Promise<void> {
    const recipients = await tx.branchMembership.findMany({
      where: {
        branchId: input.branchId,
        role: { in: LOW_STOCK_RECIPIENT_ROLES },
        user: { isActive: true },
      },
      select: { userId: true },
    });
    if (recipients.length === 0) return;

    const title = 'Low stock';
    const message = `${input.productName} (${input.sku}) at ${input.branchName} is at ${input.quantity}, minimum is ${input.minStock}`;
    const created = await tx.notification.createManyAndReturn({
      data: recipients.map((r) => ({
        userId: r.userId,
        branchId: input.branchId,
        type: NotificationType.LOW_STOCK,
        title,
        message,
      })),
    });
    await this.events.publish(
      tx,
      created.map((n): OutboundEvent => ({
        id: n.id,
        name: ServerEvents.NOTIFICATION_NEW,
        room: Rooms.user(n.userId),
        payload: {
          id: n.id,
          type: n.type,
          branchId: n.branchId,
          title: n.title,
          message: n.message,
          createdAt: n.createdAt.toISOString(),
        },
      })),
    );
  }

  async list(userId: string, query: NotificationQueryDto) {
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...(query.unreadOnly && { readAt: null }),
    };
    const [data, total, unread] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { ...paginate(data, total, query), unreadCount: unread };
  }

  async unreadCount(userId: string) {
    return {
      unreadCount: await this.prisma.notification.count({ where: { userId, readAt: null } }),
    };
  }

  async markRead(userId: string, id: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    const notification = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!notification) throw AppException.notFound('Notification');
    return { ...notification, changed: count === 1 };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: count };
  }
}
