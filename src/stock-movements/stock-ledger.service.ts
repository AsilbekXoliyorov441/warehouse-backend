import { HttpStatus, Injectable } from '@nestjs/common';
import { MovementDirection, MovementType, Prisma, StockMovement } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { crossedIntoLowStock } from '../inventory/low-stock';
import { NotificationsService } from '../notifications/notifications.service';
import type { Tx } from '../prisma/prisma.service';
import { Rooms, ServerEvents } from '../realtime/events/event-contracts';
import { EventPublisher, OutboundEvent } from '../realtime/events/event-publisher';

export interface StockChange {
  branchId: string;
  productId: string;
  type: MovementType;
  direction: MovementDirection;
  /** Always positive. */
  quantity: number;
  createdBy: string;
  referenceId?: string;
  reversedMovementId?: string;
  idempotencyKey?: string;
  note?: string;
}

export interface InventorySnapshot {
  id: string;
  branchId: string;
  productId: string;
  quantity: number;
  version: number;
  updatedAt: Date;
}

export interface AppliedStockChange {
  movement: StockMovement;
  inventory: InventorySnapshot;
  previousQuantity: number;
  lowStockTriggered: boolean;
}

export interface ActiveProduct {
  id: string;
  sku: string;
  name: string;
  minStock: number;
}

/**
 * The only code path that changes inventory quantities. Every change is:
 *   - a single atomic SQL statement (conditional UPDATE for decreases, UPSERT for increases),
 *     so concurrent writers serialise on the row lock and can never drive stock negative;
 *   - paired with an append-only StockMovement row recording the resulting balance and version;
 *   - paired with outbox events that become visible only if the surrounding transaction commits.
 * Must always be called inside a transaction.
 */
@Injectable()
export class StockLedgerService {
  constructor(
    private readonly events: EventPublisher,
    private readonly notifications: NotificationsService,
  ) {}

  /** Loads the product for a stock change. Pass requireActive=false only for corrections. */
  async getActiveProduct(tx: Tx, productId: string, requireActive = true): Promise<ActiveProduct> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { id: true, sku: true, name: true, minStock: true, isActive: true },
    });
    if (!product) throw AppException.notFound('Product');
    if (requireActive && !product.isActive) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.PRODUCT_INACTIVE,
        'Product is inactive',
      );
    }
    return product;
  }

  async apply(tx: Tx, change: StockChange, product: ActiveProduct): Promise<AppliedStockChange> {
    if (!Number.isInteger(change.quantity) || change.quantity <= 0) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'quantity must be a positive integer',
      );
    }
    const inventory =
      change.direction === MovementDirection.INCREASE
        ? await this.increment(tx, change.branchId, change.productId, change.quantity)
        : await this.decrement(tx, change.branchId, change.productId, change.quantity);

    const previousQuantity =
      change.direction === MovementDirection.INCREASE
        ? inventory.quantity - change.quantity
        : inventory.quantity + change.quantity;

    const movement = await tx.stockMovement.create({
      data: {
        branchId: change.branchId,
        productId: change.productId,
        type: change.type,
        direction: change.direction,
        quantity: change.quantity,
        balanceAfter: inventory.quantity,
        inventoryVersion: inventory.version,
        referenceId: change.referenceId,
        reversedMovementId: change.reversedMovementId,
        idempotencyKey: change.idempotencyKey,
        createdBy: change.createdBy,
        note: change.note,
      },
    });

    const occurredAt = movement.createdAt.toISOString();
    const outbound: OutboundEvent[] = [];
    const updatedId = randomUUID();
    outbound.push({
      id: updatedId,
      name: ServerEvents.INVENTORY_UPDATED,
      room: Rooms.branch(change.branchId),
      payload: {
        eventId: updatedId,
        branchId: change.branchId,
        productId: change.productId,
        quantity: inventory.quantity,
        version: inventory.version,
        movementId: movement.id,
        movementType: movement.type,
        occurredAt,
      },
    });

    const lowStockTriggered = crossedIntoLowStock(
      previousQuantity,
      inventory.quantity,
      product.minStock,
    );
    if (lowStockTriggered) {
      const lowId = randomUUID();
      outbound.push({
        id: lowId,
        name: ServerEvents.LOW_STOCK,
        room: Rooms.branch(change.branchId),
        payload: {
          eventId: lowId,
          branchId: change.branchId,
          productId: change.productId,
          quantity: inventory.quantity,
          minStock: product.minStock,
          occurredAt,
        },
      });
    }
    await this.events.publish(tx, outbound);

    if (lowStockTriggered) {
      const branch = await tx.branch.findUniqueOrThrow({
        where: { id: change.branchId },
        select: { name: true },
      });
      await this.notifications.notifyLowStock(tx, {
        branchId: change.branchId,
        branchName: branch.name,
        productName: product.name,
        sku: product.sku,
        quantity: inventory.quantity,
        minStock: product.minStock,
      });
    }
    return { movement, inventory, previousQuantity, lowStockTriggered };
  }

  private async increment(
    tx: Tx,
    branchId: string,
    productId: string,
    quantity: number,
  ): Promise<InventorySnapshot> {
    const rows = await tx.$queryRaw<InventorySnapshot[]>(Prisma.sql`
      INSERT INTO inventory (id, branch_id, product_id, quantity, version, updated_at)
      VALUES (gen_random_uuid(), ${branchId}::uuid, ${productId}::uuid, ${quantity}, 1, now())
      ON CONFLICT (branch_id, product_id) DO UPDATE
        SET quantity = inventory.quantity + EXCLUDED.quantity,
            version = inventory.version + 1,
            updated_at = now()
      RETURNING id, branch_id AS "branchId", product_id AS "productId", quantity, version, updated_at AS "updatedAt"`);
    return rows[0];
  }

  /** Conditional decrement: matches zero rows (and changes nothing) if stock is insufficient. */
  private async decrement(
    tx: Tx,
    branchId: string,
    productId: string,
    quantity: number,
  ): Promise<InventorySnapshot> {
    const rows = await tx.$queryRaw<InventorySnapshot[]>(Prisma.sql`
      UPDATE inventory
         SET quantity = quantity - ${quantity}, version = version + 1, updated_at = now()
       WHERE branch_id = ${branchId}::uuid AND product_id = ${productId}::uuid AND quantity >= ${quantity}
      RETURNING id, branch_id AS "branchId", product_id AS "productId", quantity, version, updated_at AS "updatedAt"`);
    if (rows.length === 1) return rows[0];

    const current = await tx.inventory.findUnique({
      where: { branchId_productId: { branchId, productId } },
      select: { quantity: true },
    });
    throw AppException.insufficientStock({
      branchId,
      productId,
      requested: quantity,
      available: current?.quantity ?? 0,
    });
  }
}
