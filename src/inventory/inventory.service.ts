import { HttpStatus, Injectable } from '@nestjs/common';
import { MovementDirection, MovementType, Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { Permission } from '../common/constants/permissions';
import { paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { IdempotencyService, IdempotentResult } from '../idempotency/idempotency.service';
import { PrismaService, Tx } from '../prisma/prisma.service';
import {
  AppliedStockChange,
  StockChange,
  StockLedgerService,
} from '../stock-movements/stock-ledger.service';
import {
  AdjustmentDto,
  InventoryQueryDto,
  ReceiptDto,
  ReversalDto,
  SaleDto,
} from './dto/inventory.dto';
import { isLowStock } from './low-stock';

export interface StockOperationResult {
  movement: AppliedStockChange['movement'];
  inventory: {
    branchId: string;
    productId: string;
    quantity: number;
    version: number;
    updatedAt: Date;
  };
  lowStock: boolean;
}

interface InventoryRow {
  id: string;
  branchId: string;
  productId: string;
  quantity: number;
  version: number;
  updatedAt: Date;
  sku: string;
  name: string;
  unit: string;
  price: string;
  minStock: number;
  isActive: boolean;
  categoryId: string | null;
}

const REVERSIBLE: MovementType[] = [MovementType.IN, MovementType.SALE, MovementType.ADJUSTMENT];

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: StockLedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: AuditLogsService,
    private readonly access: BranchAccessService,
  ) {}

  /** Authoritative branch snapshot. Clients reload this after (re)connecting. */
  async list(query: InventoryQueryDto) {
    const filters: Prisma.Sql[] = [Prisma.sql`i.branch_id = ${query.branchId}::uuid`];
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      filters.push(Prisma.sql`(p.name ILIKE ${like} OR p.sku ILIKE ${like})`);
    }
    if (query.categoryId) filters.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    if (query.lowStockOnly) filters.push(Prisma.sql`p.min_stock > 0 AND i.quantity <= p.min_stock`);
    const where = Prisma.join(filters, ' AND ');

    const snapshotAt = new Date().toISOString();
    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<InventoryRow[]>(Prisma.sql`
        SELECT i.id, i.branch_id AS "branchId", i.product_id AS "productId", i.quantity, i.version,
               i.updated_at AS "updatedAt", p.sku, p.name, p.unit, p.price::text AS price,
               p.min_stock AS "minStock", p.is_active AS "isActive", p.category_id AS "categoryId"
          FROM inventory i JOIN products p ON p.id = i.product_id
         WHERE ${where}
         ORDER BY p.name ASC, p.id ASC
         LIMIT ${query.limit} OFFSET ${query.skip}`),
      this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT count(*) AS count FROM inventory i JOIN products p ON p.id = i.product_id WHERE ${where}`),
    ]);
    const data = rows.map((r) => ({
      id: r.id,
      branchId: r.branchId,
      productId: r.productId,
      quantity: r.quantity,
      version: r.version,
      updatedAt: r.updatedAt,
      isLowStock: isLowStock(r.quantity, r.minStock),
      product: {
        id: r.productId,
        sku: r.sku,
        name: r.name,
        unit: r.unit,
        price: r.price,
        minStock: r.minStock,
        isActive: r.isActive,
        categoryId: r.categoryId,
      },
    }));
    return { ...paginate(data, Number(countRows[0].count), query), snapshotAt };
  }

  /** A product never stocked in the branch reports quantity 0 at version 0. */
  async getOne(branchId: string, productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        price: true,
        minStock: true,
        isActive: true,
      },
    });
    if (!product) throw AppException.notFound('Product');
    const row = await this.prisma.inventory.findUnique({
      where: { branchId_productId: { branchId, productId } },
    });
    const quantity = row?.quantity ?? 0;
    return {
      id: row?.id ?? null,
      branchId,
      productId,
      quantity,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      isLowStock: isLowStock(quantity, product.minStock),
      product,
      snapshotAt: new Date().toISOString(),
    };
  }

  receive(userId: string, dto: ReceiptDto): Promise<IdempotentResult<StockOperationResult>> {
    const { idempotencyKey, ...payload } = dto;
    return this.idempotency.execute(
      { userId, key: idempotencyKey, operation: 'inventory.receipt', payload },
      (tx) =>
        this.applyWithAudit(tx, 'inventory.receipt', {
          branchId: dto.branchId,
          productId: dto.productId,
          type: MovementType.IN,
          direction: MovementDirection.INCREASE,
          quantity: dto.quantity,
          createdBy: userId,
          idempotencyKey,
          note: dto.note,
        }),
    );
  }

  sell(userId: string, dto: SaleDto): Promise<IdempotentResult<StockOperationResult>> {
    const { idempotencyKey, ...payload } = dto;
    return this.idempotency.execute(
      { userId, key: idempotencyKey, operation: 'inventory.sale', payload },
      (tx) =>
        this.applyWithAudit(tx, 'inventory.sale', {
          branchId: dto.branchId,
          productId: dto.productId,
          type: MovementType.SALE,
          direction: MovementDirection.DECREASE,
          quantity: dto.quantity,
          createdBy: userId,
          idempotencyKey,
          note: dto.note,
        }),
    );
  }

  adjust(userId: string, dto: AdjustmentDto): Promise<IdempotentResult<StockOperationResult>> {
    const { idempotencyKey, ...payload } = dto;
    return this.idempotency.execute(
      { userId, key: idempotencyKey, operation: 'inventory.adjustment', payload },
      (tx) =>
        this.applyWithAudit(
          tx,
          'inventory.adjustment',
          {
            branchId: dto.branchId,
            productId: dto.productId,
            type: MovementType.ADJUSTMENT,
            direction: dto.delta > 0 ? MovementDirection.INCREASE : MovementDirection.DECREASE,
            quantity: Math.abs(dto.delta),
            createdBy: userId,
            idempotencyKey,
            note: dto.reason,
          },
          { reason: dto.reason, delta: dto.delta },
        ),
    );
  }

  /** Compensating movement for a receipt, sale or adjustment. Each movement can be reversed once. */
  async reverse(userId: string, dto: ReversalDto): Promise<IdempotentResult<StockOperationResult>> {
    const original = await this.prisma.stockMovement.findUnique({ where: { id: dto.movementId } });
    if (
      !original ||
      !(await this.access.hasBranchPermission(userId, original.branchId, Permission.MOVEMENT_READ))
    ) {
      throw AppException.notFound('Stock movement');
    }
    await this.access.assertBranchPermission(userId, original.branchId, Permission.STOCK_REVERSE);
    if (!REVERSIBLE.includes(original.type)) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.MOVEMENT_NOT_REVERSIBLE,
        'Only IN, SALE and ADJUSTMENT movements can be reversed; cancel transfers instead',
      );
    }

    const { idempotencyKey, ...payload } = dto;
    return this.idempotency.execute(
      { userId, key: idempotencyKey, operation: 'inventory.reversal', payload },
      async (tx) => {
        try {
          return await this.applyWithAudit(
            tx,
            'inventory.reversal',
            {
              branchId: original.branchId,
              productId: original.productId,
              type: MovementType.REVERSAL,
              direction:
                original.direction === MovementDirection.INCREASE
                  ? MovementDirection.DECREASE
                  : MovementDirection.INCREASE,
              quantity: original.quantity,
              createdBy: userId,
              referenceId: original.id,
              reversedMovementId: original.id,
              idempotencyKey,
              note: dto.reason,
            },
            { reason: dto.reason, reversedMovementId: original.id, reversedType: original.type },
            false,
          );
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            throw AppException.conflict(
              ErrorCode.MOVEMENT_ALREADY_REVERSED,
              'This movement has already been reversed',
            );
          }
          throw err;
        }
      },
    );
  }

  private async applyWithAudit(
    tx: Tx,
    action: string,
    change: StockChange,
    extraMetadata: Record<string, unknown> = {},
    requireActiveProduct = true,
  ): Promise<StockOperationResult> {
    const product = await this.ledger.getActiveProduct(tx, change.productId, requireActiveProduct);
    const applied = await this.ledger.apply(tx, change, product);
    await this.audit.record(
      {
        userId: change.createdBy,
        action,
        entityType: 'StockMovement',
        entityId: applied.movement.id,
        metadata: {
          branchId: change.branchId,
          productId: change.productId,
          direction: change.direction,
          quantity: change.quantity,
          previousQuantity: applied.previousQuantity,
          newQuantity: applied.inventory.quantity,
          ...extraMetadata,
        },
      },
      tx,
    );
    const { branchId, productId, quantity, version, updatedAt } = applied.inventory;
    return {
      movement: applied.movement,
      inventory: { branchId, productId, quantity, version, updatedAt },
      lowStock: isLowStock(quantity, product.minStock),
    };
  }
}
