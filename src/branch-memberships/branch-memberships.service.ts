import { Injectable } from '@nestjs/common';
import { BranchRole, Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { accessChangedEvent } from '../realtime/events/access-changed';
import { EventPublisher } from '../realtime/events/event-publisher';

const MEMBER_SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { id: true, name: true, email: true, isActive: true } },
} satisfies Prisma.BranchMembershipSelect;

@Injectable()
export class BranchMembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly events: EventPublisher,
  ) {}

  list(branchId: string) {
    return this.prisma.branchMembership.findMany({
      where: { branchId },
      select: MEMBER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  async add(branchId: string, userId: string, role: BranchRole, actorId: string) {
    return this.prisma.runInTransaction(async (tx) => {
      const [branch, user] = await Promise.all([
        tx.branch.findUnique({ where: { id: branchId }, select: { id: true } }),
        tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
      ]);
      if (!branch) throw AppException.notFound('Branch');
      if (!user) throw AppException.notFound('User');
      try {
        const membership = await tx.branchMembership.create({
          data: { branchId, userId, role },
          select: MEMBER_SELECT,
        });
        await this.audit.record(
          {
            userId: actorId,
            action: 'membership.add',
            entityType: 'BranchMembership',
            entityId: membership.id,
            metadata: { branchId, userId, role },
          },
          tx,
        );
        return membership;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw AppException.conflict(
            ErrorCode.DUPLICATE_RESOURCE,
            'User is already a member of this branch',
          );
        }
        throw err;
      }
    });
  }

  async updateRole(branchId: string, userId: string, role: BranchRole, actorId: string) {
    this.assertNotSelf(userId, actorId);
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.branchMembership.findUnique({
        where: { userId_branchId: { userId, branchId } },
      });
      if (!existing) throw AppException.notFound('Membership');
      const membership = await tx.branchMembership.update({
        where: { id: existing.id },
        data: { role },
        select: MEMBER_SELECT,
      });
      await this.audit.record(
        {
          userId: actorId,
          action: 'membership.update',
          entityType: 'BranchMembership',
          entityId: existing.id,
          metadata: { branchId, userId, from: existing.role, to: role },
        },
        tx,
      );
      await this.events.publish(tx, [accessChangedEvent(userId)]);
      return membership;
    });
  }

  async remove(branchId: string, userId: string, actorId: string): Promise<void> {
    this.assertNotSelf(userId, actorId);
    await this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.branchMembership.findUnique({
        where: { userId_branchId: { userId, branchId } },
      });
      if (!existing) throw AppException.notFound('Membership');
      await tx.branchMembership.delete({ where: { id: existing.id } });
      await this.audit.record(
        {
          userId: actorId,
          action: 'membership.remove',
          entityType: 'BranchMembership',
          entityId: existing.id,
          metadata: { branchId, userId, role: existing.role },
        },
        tx,
      );
      await this.events.publish(tx, [accessChangedEvent(userId)]);
    });
  }

  /** Prevents administrators from accidentally locking themselves out. */
  private assertNotSelf(userId: string, actorId: string): void {
    if (userId === actorId) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'You cannot change your own membership',
      );
    }
  }
}
