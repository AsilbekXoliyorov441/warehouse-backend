import { Injectable } from '@nestjs/common';
import { MovementDirection, MovementType, Prisma, TransferStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { Permission } from '../common/constants/permissions';
import { paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { Rooms, ServerEvents } from '../realtime/events/event-contracts';
import { EventPublisher, OutboundEvent } from '../realtime/events/event-publisher';
import { StockLedgerService } from '../stock-movements/stock-ledger.service';
import { CancelTransferDto, CreateTransferDto, TransferQueryDto } from './dto/transfer.dto';

const TRANSFER_INCLUDE = {
  sourceBranch: { select: { id: true, name: true } },
  destinationBranch: { select: { id: true, name: true } },
  creator: { select: { id: true, name: true } },
  items: { include: { product: { select: { id: true, sku: true, name: true, unit: true } } } },
} satisfies Prisma.StockTransferInclude;

/**
 * Transfer workflow: create (PENDING) -> complete | cancel.
 * Completion moves stock atomically: the status change, the source decrement, the destination
 * increment, both movements per item, the audit entry and outbox events commit together or not at all.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditLogsService,
    private readonly access: BranchAccessService,
    private readonly events: EventPublisher,
  ) {}

  async create(userId: string, dto: CreateTransferDto) {
    if (dto.sourceBranchId === dto.destinationBranchId) {
      throw AppException.badRequest(
        ErrorCode.INVALID_BRANCH,
        'Source and destination branches must differ',
      );
    }
    const productIds = dto.items.map((i) => i.productId);
    if (new Set(productIds).size !== productIds.length) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'Each product may appear only once per transfer',
      );
    }
    await this.access.assertBranchPermission(
      userId,
      dto.sourceBranchId,
      Permission.TRANSFER_CREATE,
    );

    const { idempotencyKey, ...payload } = dto;
    const result = await this.idempotency.execute(
      { userId, key: idempotencyKey, operation: 'transfer.create', payload },
      async (tx) => {
        const destination = await tx.branch.findUnique({
          where: { id: dto.destinationBranchId },
          select: { isActive: true },
        });
        if (!destination?.isActive) {
          throw AppException.badRequest(
            ErrorCode.INVALID_BRANCH,
            'Destination branch does not exist or is inactive',
          );
        }
        for (const item of dto.items) await this.ledger.getActiveProduct(tx, item.productId);
        await this.assertSourceStock(tx, dto.sourceBranchId, dto.items);

        const transfer = await tx.stockTransfer.create({
          data: {
            sourceBranchId: dto.sourceBranchId,
            destinationBranchId: dto.destinationBranchId,
            createdBy: userId,
            note: dto.note,
            items: {
              create: dto.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
            },
          },
          include: TRANSFER_INCLUDE,
        });
        await this.audit.record(
          {
            userId,
            action: 'transfer.create',
            entityType: 'StockTransfer',
            entityId: transfer.id,
            metadata: { ...payload },
          },
          tx,
        );
        await this.events.publish(tx, this.transferEvents(transfer));
        return transfer;
      },
    );
    return result;
  }

  async list(query: TransferQueryDto) {
    const byDirection: Record<TransferQueryDto['direction'], Prisma.StockTransferWhereInput> = {
      incoming: { destinationBranchId: query.branchId },
      outgoing: { sourceBranchId: query.branchId },
      all: { OR: [{ sourceBranchId: query.branchId }, { destinationBranchId: query.branchId }] },
    };
    const where: Prisma.StockTransferWhereInput = {
      ...byDirection[query.direction],
      ...(query.status && { status: query.status }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        include: TRANSFER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  async findOne(userId: string, id: string) {
    const transfer = await this.prisma.stockTransfer.findUnique({
      where: { id },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer || !(await this.canAccess(userId, transfer, Permission.TRANSFER_READ))) {
      throw AppException.notFound('Transfer');
    }
    return transfer;
  }

  /** Approver must hold TRANSFER_APPROVE in the source or destination branch. */
  async complete(userId: string, id: string) {
    await this.assertCanApprove(userId, id);
    return this.prisma.runInTransaction(async (tx) => {
      await this.claimPending(tx, id, TransferStatus.COMPLETED, userId);
      const transfer = await tx.stockTransfer.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });

      // Apply every row change in one global (branch, product) order so that concurrent
      // transfers touching the same rows always lock them in the same sequence (no deadlocks).
      const operations = transfer.items
        .flatMap((item) => [
          {
            branchId: transfer.sourceBranchId,
            productId: item.productId,
            quantity: item.quantity,
            direction: MovementDirection.DECREASE,
            type: MovementType.TRANSFER_OUT,
          },
          {
            branchId: transfer.destinationBranchId,
            productId: item.productId,
            quantity: item.quantity,
            direction: MovementDirection.INCREASE,
            type: MovementType.TRANSFER_IN,
          },
        ])
        .sort((a, b) =>
          `${a.branchId}:${a.productId}`.localeCompare(`${b.branchId}:${b.productId}`),
        );

      const movementIds: string[] = [];
      for (const op of operations) {
        const product = await this.ledger.getActiveProduct(tx, op.productId, false);
        const applied = await this.ledger.apply(
          tx,
          { ...op, createdBy: userId, referenceId: transfer.id },
          product,
        );
        movementIds.push(applied.movement.id);
      }

      const completed = await tx.stockTransfer.findUniqueOrThrow({
        where: { id },
        include: TRANSFER_INCLUDE,
      });
      await this.audit.record(
        {
          userId,
          action: 'transfer.complete',
          entityType: 'StockTransfer',
          entityId: id,
          metadata: {
            movementIds,
            items: transfer.items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
          },
        },
        tx,
      );
      await this.events.publish(tx, this.transferEvents(completed));
      return completed;
    });
  }

  /** Cancellable by approvers of either branch, or by the creator while they can still create transfers. */
  async cancel(userId: string, id: string, dto: CancelTransferDto) {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer || !(await this.canAccess(userId, transfer, Permission.TRANSFER_READ)))
      throw AppException.notFound('Transfer');
    const isApprover = await this.canAccess(userId, transfer, Permission.TRANSFER_APPROVE);
    const isCreator =
      transfer.createdBy === userId &&
      (await this.access.hasBranchPermission(
        userId,
        transfer.sourceBranchId,
        Permission.TRANSFER_CREATE,
      ));
    if (!isApprover && !isCreator) throw AppException.forbidden('You cannot cancel this transfer');

    return this.prisma.runInTransaction(async (tx) => {
      await this.claimPending(tx, id, TransferStatus.CANCELLED, userId);
      const cancelled = await tx.stockTransfer.findUniqueOrThrow({
        where: { id },
        include: TRANSFER_INCLUDE,
      });
      await this.audit.record(
        {
          userId,
          action: 'transfer.cancel',
          entityType: 'StockTransfer',
          entityId: id,
          metadata: { reason: dto.reason },
        },
        tx,
      );
      await this.events.publish(tx, this.transferEvents(cancelled));
      return cancelled;
    });
  }

  /**
   * Atomically moves a PENDING transfer to its final status. The conditional UPDATE takes the row
   * lock, so of two concurrent complete/cancel calls exactly one wins; the other sees the final state.
   */
  private async claimPending(
    tx: Tx,
    id: string,
    status: 'COMPLETED' | 'CANCELLED',
    userId: string,
  ): Promise<void> {
    const updated =
      status === TransferStatus.COMPLETED
        ? await tx.$executeRaw`UPDATE stock_transfers SET status = 'COMPLETED', completed_at = now(), completed_by = ${userId}::uuid, updated_at = now() WHERE id = ${id}::uuid AND status = 'PENDING'`
        : await tx.$executeRaw`UPDATE stock_transfers SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = ${userId}::uuid, updated_at = now() WHERE id = ${id}::uuid AND status = 'PENDING'`;
    if (updated === 1) return;

    const current = await tx.stockTransfer.findUnique({ where: { id }, select: { status: true } });
    if (!current) throw AppException.notFound('Transfer');
    if (current.status === TransferStatus.COMPLETED) {
      throw AppException.conflict(
        ErrorCode.TRANSFER_ALREADY_COMPLETED,
        'Transfer has already been completed',
      );
    }
    throw AppException.conflict(
      ErrorCode.TRANSFER_ALREADY_CANCELLED,
      'Transfer has already been cancelled',
    );
  }

  private async assertCanApprove(userId: string, id: string): Promise<void> {
    const transfer = await this.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer || !(await this.canAccess(userId, transfer, Permission.TRANSFER_READ)))
      throw AppException.notFound('Transfer');
    if (!(await this.canAccess(userId, transfer, Permission.TRANSFER_APPROVE))) {
      throw AppException.forbidden(
        'Completing a transfer requires TRANSFER_APPROVE in the source or destination branch',
      );
    }
  }

  private async canAccess(
    userId: string,
    transfer: { sourceBranchId: string; destinationBranchId: string },
    permission: Permission,
  ): Promise<boolean> {
    return (
      (await this.access.hasBranchPermission(userId, transfer.sourceBranchId, permission)) ||
      (await this.access.hasBranchPermission(userId, transfer.destinationBranchId, permission))
    );
  }

  /** Early, non-authoritative check; completion re-checks under row locks. */
  private async assertSourceStock(
    tx: Tx,
    branchId: string,
    items: { productId: string; quantity: number }[],
  ): Promise<void> {
    const rows = await tx.inventory.findMany({
      where: { branchId, productId: { in: items.map((i) => i.productId) } },
      select: { productId: true, quantity: true },
    });
    const available = new Map(rows.map((r) => [r.productId, r.quantity]));
    const short = items
      .filter((i) => (available.get(i.productId) ?? 0) < i.quantity)
      .map((i) => ({
        productId: i.productId,
        requested: i.quantity,
        available: available.get(i.productId) ?? 0,
      }));
    if (short.length > 0) throw AppException.insufficientStock({ branchId, items: short });
  }

  private transferEvents(t: {
    id: string;
    sourceBranchId: string;
    destinationBranchId: string;
    status: TransferStatus;
    updatedAt: Date;
  }): OutboundEvent[] {
    return [t.sourceBranchId, t.destinationBranchId].map((branchId) => {
      const eventId = randomUUID();
      return {
        id: eventId,
        name: ServerEvents.TRANSFER_UPDATED,
        room: Rooms.branch(branchId),
        payload: {
          eventId,
          transferId: t.id,
          sourceBranchId: t.sourceBranchId,
          destinationBranchId: t.destinationBranchId,
          status: t.status,
          occurredAt: t.updatedAt.toISOString(),
        },
      };
    });
  }
}
