import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MOVEMENT_INCLUDE } from '../stock-movements/stock-movements.service';

/**
 * Valuation rule: on-hand quantity x the product's *current catalog price* (Product.price),
 * active products only, computed in PostgreSQL NUMERIC and returned as a decimal string.
 * This is a retail-value estimate, not a cost-basis (FIFO/average) valuation.
 */
export const STOCK_VALUE_RULE = 'sum(quantity * current product price) over active products';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(branchId: string) {
    const [stock] = await this.prisma.$queryRaw<
      {
        activeProducts: number;
        totalUnits: string;
        lowStockCount: number;
        outOfStockCount: number;
        stockValue: string;
      }[]
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE p.is_active)::int                                           AS "activeProducts",
             coalesce(sum(i.quantity) FILTER (WHERE p.is_active), 0)::text                       AS "totalUnits",
             count(*) FILTER (WHERE p.is_active AND p.min_stock > 0 AND i.quantity <= p.min_stock)::int AS "lowStockCount",
             count(*) FILTER (WHERE p.is_active AND i.quantity = 0)::int                         AS "outOfStockCount",
             coalesce(sum(i.quantity * p.price) FILTER (WHERE p.is_active), 0)::numeric(14,2)::text AS "stockValue"
        FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.branch_id = ${branchId}::uuid`);

    const [transfers] = await this.prisma.$queryRaw<
      { incomingPending: number; outgoingPending: number }[]
    >(Prisma.sql`
      SELECT count(*) FILTER (WHERE destination_branch_id = ${branchId}::uuid)::int AS "incomingPending",
             count(*) FILTER (WHERE source_branch_id = ${branchId}::uuid)::int      AS "outgoingPending"
        FROM stock_transfers
       WHERE status = 'PENDING' AND (source_branch_id = ${branchId}::uuid OR destination_branch_id = ${branchId}::uuid)`);

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const movementsLast24h = await this.prisma.stockMovement.count({
      where: { branchId, createdAt: { gte: since } },
    });

    return {
      branchId,
      totalActiveProducts: stock.activeProducts,
      totalUnitsInStock: Number(stock.totalUnits),
      lowStockCount: stock.lowStockCount,
      outOfStockCount: stock.outOfStockCount,
      stockValue: stock.stockValue,
      pendingTransfers: {
        incoming: transfers.incomingPending,
        outgoing: transfers.outgoingPending,
      },
      movementsLast24h,
      valuationRule: STOCK_VALUE_RULE,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Active products at or below their minimum, most critical (lowest ratio) first. */
  lowStock(branchId: string, limit: number) {
    return this.prisma.$queryRaw<unknown[]>(Prisma.sql`
      SELECT i.product_id AS "productId", p.sku, p.name, p.unit, i.quantity, p.min_stock AS "minStock",
             (p.min_stock - i.quantity) AS shortfall, i.version, i.updated_at AS "updatedAt"
        FROM inventory i JOIN products p ON p.id = i.product_id
       WHERE i.branch_id = ${branchId}::uuid AND p.is_active AND p.min_stock > 0 AND i.quantity <= p.min_stock
       ORDER BY (i.quantity::numeric / p.min_stock) ASC, p.name ASC
       LIMIT ${limit}`);
  }

  recentMovements(branchId: string, limit: number) {
    return this.prisma.stockMovement.findMany({
      where: { branchId },
      include: MOVEMENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async stockValue(branchId: string) {
    const byCategory = await this.prisma.$queryRaw<
      { categoryId: string | null; categoryName: string | null; units: string; value: string }[]
    >(Prisma.sql`
      SELECT c.id AS "categoryId", c.name AS "categoryName",
             sum(i.quantity)::text AS units,
             sum(i.quantity * p.price)::numeric(14,2)::text AS value
        FROM inventory i
        JOIN products p ON p.id = i.product_id
        LEFT JOIN categories c ON c.id = p.category_id
       WHERE i.branch_id = ${branchId}::uuid AND p.is_active
       GROUP BY c.id, c.name
       ORDER BY sum(i.quantity * p.price) DESC`);
    const total = byCategory.reduce((acc, row) => acc.add(row.value), new Prisma.Decimal(0));
    return {
      branchId,
      currency: 'unspecified',
      valuationRule: STOCK_VALUE_RULE,
      totalValue: total.toFixed(2),
      byCategory: byCategory.map((r) => ({ ...r, units: Number(r.units) })),
      generatedAt: new Date().toISOString(),
    };
  }
}
