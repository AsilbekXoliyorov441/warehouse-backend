import { BranchRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../src/audit-logs/audit-logs.service';
import {
  createBranch,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  setStock,
  TestContext,
} from './utils/test-app';

describe('Inventory operations (e2e)', () => {
  let ctx: TestContext;
  let branchId: string;
  let otherBranchId: string;
  let tokens: Record<'admin' | 'manager' | 'worker' | 'seller' | 'outsider', string>;
  let sellerId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    branchId = (await createBranch(ctx.prisma)).id;
    otherBranchId = (await createBranch(ctx.prisma)).id;
    const mk = async (role: BranchRole, b = branchId) =>
      createUser(ctx.prisma, [{ branchId: b, role }]);
    const seller = await mk(BranchRole.SELLER);
    sellerId = seller.id;
    tokens = {
      admin: await login(ctx, (await mk(BranchRole.ADMIN)).email),
      manager: await login(ctx, (await mk(BranchRole.MANAGER)).email),
      worker: await login(ctx, (await mk(BranchRole.WAREHOUSE_WORKER)).email),
      seller: await login(ctx, seller.email),
      outsider: await login(ctx, (await mk(BranchRole.ADMIN, otherBranchId)).email),
    };
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const as = (role: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[role]}` });
  const key = () => `test-${randomUUID()}`;
  const qty = async (productId: string, b = branchId) =>
    (
      await ctx.prisma.inventory.findUnique({
        where: { branchId_productId: { branchId: b, productId } },
      })
    )?.quantity;

  describe('receipts', () => {
    it('creates the inventory row, a movement, an audit entry and an outbox event', async () => {
      const p = await createProduct(ctx.prisma);
      const res = await ctx
        .http()
        .post('/api/inventory/receipts')
        .set(as('worker'))
        .send({ branchId, productId: p.id, quantity: 12, note: 'PO-1', idempotencyKey: key() })
        .expect(201);
      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body.inventory).toMatchObject({ quantity: 12, version: 1 });
      expect(res.body.movement).toMatchObject({
        type: 'IN',
        direction: 'INCREASE',
        quantity: 12,
        balanceAfter: 12,
        inventoryVersion: 1,
      });

      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'inventory.receipt' },
      });
      expect(audit.entityId).toBe(res.body.movement.id);
      expect(audit.metadata).toMatchObject({ previousQuantity: 0, newQuantity: 12 });

      const events = await ctx.prisma.outboxEvent.findMany({
        where: { eventName: 'inventory:updated' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].room).toBe(`branch:${branchId}`);
      expect(events[0].payload).toMatchObject({
        quantity: 12,
        version: 1,
        movementId: res.body.movement.id,
      });
    });

    it('is forbidden for sellers and for members of other branches', async () => {
      const p = await createProduct(ctx.prisma);
      const body = { branchId, productId: p.id, quantity: 1, idempotencyKey: key() };
      await ctx.http().post('/api/inventory/receipts').set(as('seller')).send(body).expect(403);
      await ctx.http().post('/api/inventory/receipts').set(as('outsider')).send(body).expect(403);
      await ctx.http().post('/api/inventory/receipts').set(as('manager')).send(body).expect(403);
    });

    it('rejects inactive products and invalid quantities', async () => {
      const inactive = await createProduct(ctx.prisma, { isActive: false });
      const res = await ctx
        .http()
        .post('/api/inventory/receipts')
        .set(as('worker'))
        .send({ branchId, productId: inactive.id, quantity: 1, idempotencyKey: key() })
        .expect(409);
      expect(res.body.code).toBe('PRODUCT_INACTIVE');
      const p = await createProduct(ctx.prisma);
      for (const quantity of [0, -3, 1.5, '4', 2_000_000]) {
        await ctx
          .http()
          .post('/api/inventory/receipts')
          .set(as('worker'))
          .send({ branchId, productId: p.id, quantity, idempotencyKey: key() })
          .expect(400);
      }
      await ctx
        .http()
        .post('/api/inventory/receipts')
        .set(as('worker'))
        .send({ branchId, productId: p.id, quantity: 1 })
        .expect(400);
    });
  });

  describe('sales', () => {
    it('decrements stock and records a SALE movement', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const res = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 3, idempotencyKey: key() })
        .expect(201);
      expect(res.body.inventory.quantity).toBe(7);
      expect(res.body.movement).toMatchObject({
        type: 'SALE',
        direction: 'DECREASE',
        quantity: 3,
        balanceAfter: 7,
        createdBy: sellerId,
      });
      expect(await qty(p.id)).toBe(7);
    });

    it('rejects insufficient stock with 409 INSUFFICIENT_STOCK and changes nothing', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 2);
      const res = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 3, idempotencyKey: key() })
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        code: 'INSUFFICIENT_STOCK',
        details: { requested: 3, available: 2 },
      });
      expect(await qty(p.id)).toBe(2);
      expect(await ctx.prisma.stockMovement.count()).toBe(0);
      expect(await ctx.prisma.outboxEvent.count()).toBe(0);
      expect(await ctx.prisma.idempotencyKey.count()).toBe(0);
    });

    it('treats a never-stocked product as zero stock', async () => {
      const p = await createProduct(ctx.prisma);
      const res = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: key() })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    });

    it('cannot be created by warehouse workers', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 5);
      await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('worker'))
        .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: key() })
        .expect(403);
    });
  });

  describe('idempotency', () => {
    it('replays a repeated request without deducting stock twice', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const body = { branchId, productId: p.id, quantity: 4, idempotencyKey: key() };
      const first = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send(body)
        .expect(201);
      const second = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send(body)
        .expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(await qty(p.id)).toBe(6);
      expect(await ctx.prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(1);
    });

    it('rejects reuse of a key with a different payload', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const k = key();
      await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: k })
        .expect(201);
      const res = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 2, idempotencyKey: k })
        .expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(await qty(p.id)).toBe(9);
    });

    it('allows retrying a key whose first attempt failed', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 1);
      const body = { branchId, productId: p.id, quantity: 2, idempotencyKey: key() };
      await ctx.http().post('/api/inventory/sales').set(as('seller')).send(body).expect(409);
      await setStock(ctx.prisma, branchId, p.id, 5);
      await ctx.http().post('/api/inventory/sales').set(as('seller')).send(body).expect(201);
      expect(await qty(p.id)).toBe(3);
    });
  });

  describe('transaction rollback', () => {
    it('rolls back stock, movement, idempotency key and events when a later step fails', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const audit = ctx.app.get(AuditLogsService);
      const spy = jest
        .spyOn(audit, 'record')
        .mockRejectedValueOnce(new Error('simulated failure after stock update'));
      try {
        const res = await ctx
          .http()
          .post('/api/inventory/sales')
          .set(as('seller'))
          .send({ branchId, productId: p.id, quantity: 4, idempotencyKey: key() })
          .expect(500);
        expect(res.body).toEqual({
          statusCode: 500,
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal server error',
          requestId: expect.any(String),
        });
      } finally {
        spy.mockRestore();
      }
      const inv = await ctx.prisma.inventory.findUniqueOrThrow({
        where: { branchId_productId: { branchId, productId: p.id } },
      });
      expect(inv).toMatchObject({ quantity: 10, version: 0 });
      expect(await ctx.prisma.stockMovement.count()).toBe(0);
      expect(await ctx.prisma.idempotencyKey.count()).toBe(0);
      expect(await ctx.prisma.outboxEvent.count()).toBe(0);
    });
  });

  describe('adjustments', () => {
    it('requires ADMIN and a reason, and records direction', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      await ctx
        .http()
        .post('/api/inventory/adjustments')
        .set(as('manager'))
        .send({ branchId, productId: p.id, delta: -2, reason: 'damaged', idempotencyKey: key() })
        .expect(403);
      await ctx
        .http()
        .post('/api/inventory/adjustments')
        .set(as('admin'))
        .send({ branchId, productId: p.id, delta: -2, idempotencyKey: key() })
        .expect(400);
      await ctx
        .http()
        .post('/api/inventory/adjustments')
        .set(as('admin'))
        .send({ branchId, productId: p.id, delta: 0, reason: 'noop', idempotencyKey: key() })
        .expect(400);

      const res = await ctx
        .http()
        .post('/api/inventory/adjustments')
        .set(as('admin'))
        .send({
          branchId,
          productId: p.id,
          delta: -2,
          reason: 'damaged in count',
          idempotencyKey: key(),
        })
        .expect(201);
      expect(res.body.movement).toMatchObject({
        type: 'ADJUSTMENT',
        direction: 'DECREASE',
        quantity: 2,
        note: 'damaged in count',
        balanceAfter: 8,
      });
      const audit = await ctx.prisma.auditLog.findFirstOrThrow({
        where: { action: 'inventory.adjustment' },
      });
      expect(audit.metadata).toMatchObject({
        reason: 'damaged in count',
        delta: -2,
        previousQuantity: 10,
        newQuantity: 8,
      });

      const neg = await ctx
        .http()
        .post('/api/inventory/adjustments')
        .set(as('admin'))
        .send({ branchId, productId: p.id, delta: -9, reason: 'too many', idempotencyKey: key() })
        .expect(409);
      expect(neg.body.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('reversals', () => {
    it('reverses a sale exactly once', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const sale = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 4, idempotencyKey: key() })
        .expect(201);
      await ctx
        .http()
        .post('/api/inventory/reversals')
        .set(as('seller'))
        .send({ movementId: sale.body.movement.id, reason: 'returned', idempotencyKey: key() })
        .expect(403);

      const rev = await ctx
        .http()
        .post('/api/inventory/reversals')
        .set(as('manager'))
        .send({
          movementId: sale.body.movement.id,
          reason: 'customer return',
          idempotencyKey: key(),
        })
        .expect(201);
      expect(rev.body.movement).toMatchObject({
        type: 'REVERSAL',
        direction: 'INCREASE',
        quantity: 4,
        referenceId: sale.body.movement.id,
      });
      expect(await qty(p.id)).toBe(10);

      const again = await ctx
        .http()
        .post('/api/inventory/reversals')
        .set(as('manager'))
        .send({ movementId: sale.body.movement.id, reason: 'again', idempotencyKey: key() })
        .expect(409);
      expect(again.body.code).toBe('MOVEMENT_ALREADY_REVERSED');
      const ofReversal = await ctx
        .http()
        .post('/api/inventory/reversals')
        .set(as('admin'))
        .send({ movementId: rev.body.movement.id, reason: 'nested', idempotencyKey: key() })
        .expect(409);
      expect(ofReversal.body.code).toBe('MOVEMENT_NOT_REVERSIBLE');
    });

    it('hides movements of other branches', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);
      const sale = await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: key() })
        .expect(201);
      await ctx
        .http()
        .post('/api/inventory/reversals')
        .set(as('outsider'))
        .send({ movementId: sale.body.movement.id, reason: 'hack', idempotencyKey: key() })
        .expect(404);
      await ctx
        .http()
        .get(`/api/stock-movements/${sale.body.movement.id}`)
        .set(as('outsider'))
        .expect(404);
      await ctx
        .http()
        .get(`/api/stock-movements/${sale.body.movement.id}`)
        .set(as('seller'))
        .expect(200);
    });
  });

  describe('reads', () => {
    it('lists the branch snapshot with versions and low-stock flags', async () => {
      const low = await createProduct(ctx.prisma, { minStock: 5 });
      const ok = await createProduct(ctx.prisma, { minStock: 5 });
      await setStock(ctx.prisma, branchId, low.id, 3);
      await setStock(ctx.prisma, branchId, ok.id, 30);
      await setStock(ctx.prisma, otherBranchId, ok.id, 99);
      const res = await ctx
        .http()
        .get(`/api/inventory?branchId=${branchId}`)
        .set(as('seller'))
        .expect(200);
      expect(res.body.meta.total).toBe(2);
      expect(res.body.snapshotAt).toEqual(expect.any(String));
      const byId = Object.fromEntries(
        res.body.data.map((r: { productId: string }) => [r.productId, r]),
      );
      expect(byId[low.id]).toMatchObject({
        quantity: 3,
        isLowStock: true,
        version: 0,
        product: { price: '10.00' },
      });
      expect(byId[ok.id]).toMatchObject({ quantity: 30, isLowStock: false });
      const lowOnly = await ctx
        .http()
        .get(`/api/inventory?branchId=${branchId}&lowStockOnly=true`)
        .set(as('seller'))
        .expect(200);
      expect(lowOnly.body.data).toHaveLength(1);
      await ctx.http().get(`/api/inventory?branchId=${branchId}`).set(as('outsider')).expect(403);
      await ctx.http().get(`/api/inventory`).set(as('seller')).expect(400);
    });

    it('returns a zero record for products never stocked in the branch', async () => {
      const p = await createProduct(ctx.prisma);
      const res = await ctx
        .http()
        .get(`/api/inventory/${branchId}/${p.id}`)
        .set(as('seller'))
        .expect(200);
      expect(res.body).toMatchObject({ quantity: 0, version: 0, id: null });
    });

    it('filters movement history and exposes no write endpoints', async () => {
      const p = await createProduct(ctx.prisma);
      await ctx
        .http()
        .post('/api/inventory/receipts')
        .set(as('worker'))
        .send({ branchId, productId: p.id, quantity: 5, idempotencyKey: key() })
        .expect(201);
      await ctx
        .http()
        .post('/api/inventory/sales')
        .set(as('seller'))
        .send({ branchId, productId: p.id, quantity: 2, idempotencyKey: key() })
        .expect(201);
      const all = await ctx
        .http()
        .get(`/api/stock-movements?branchId=${branchId}`)
        .set(as('seller'))
        .expect(200);
      expect(all.body.data.map((m: { type: string }) => m.type)).toEqual(['SALE', 'IN']);
      const sales = await ctx
        .http()
        .get(`/api/stock-movements?branchId=${branchId}&type=SALE`)
        .set(as('seller'))
        .expect(200);
      expect(sales.body.meta.total).toBe(1);
      const id = all.body.data[0].id;
      await ctx
        .http()
        .patch(`/api/stock-movements/${id}`)
        .set(as('admin'))
        .send({ quantity: 1 })
        .expect(404);
      await ctx.http().delete(`/api/stock-movements/${id}`).set(as('admin')).expect(404);
    });
  });

  describe('low stock', () => {
    it('emits low-stock events and notifications only when crossing the threshold', async () => {
      const p = await createProduct(ctx.prisma, { minStock: 5 });
      await setStock(ctx.prisma, branchId, p.id, 8);
      const sell = (quantity: number) =>
        ctx
          .http()
          .post('/api/inventory/sales')
          .set(as('seller'))
          .send({ branchId, productId: p.id, quantity, idempotencyKey: key() })
          .expect(201);

      await sell(2); // 8 -> 6: above threshold
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventName: 'inventory:low-stock' } }),
      ).toBe(0);
      const crossing = await sell(1); // 6 -> 5: reaches threshold
      expect(crossing.body.lowStock).toBe(true);
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventName: 'inventory:low-stock' } }),
      ).toBe(1);
      await sell(1); // 5 -> 4: already low, no new alert
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventName: 'inventory:low-stock' } }),
      ).toBe(1);

      // ADMIN, MANAGER and WAREHOUSE_WORKER of the branch are notified; SELLER is not.
      const notifications = await ctx.prisma.notification.findMany({ where: { branchId } });
      expect(notifications).toHaveLength(3);
      expect(notifications.some((n) => n.userId === sellerId)).toBe(false);
      expect(await ctx.prisma.outboxEvent.count({ where: { eventName: 'notification:new' } })).toBe(
        3,
      );

      const mine = await ctx.http().get('/api/notifications').set(as('manager')).expect(200);
      expect(mine.body).toMatchObject({
        unreadCount: 1,
        data: [expect.objectContaining({ type: 'LOW_STOCK' })],
      });
      await ctx
        .http()
        .patch(`/api/notifications/${mine.body.data[0].id}/read`)
        .set(as('manager'))
        .expect(200);
      await ctx
        .http()
        .patch(`/api/notifications/${mine.body.data[0].id}/read`)
        .set(as('admin'))
        .expect(404);
    });
  });
});
