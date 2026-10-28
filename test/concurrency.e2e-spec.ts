import { BranchRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
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

/**
 * These tests fire requests in parallel over separate HTTP connections against a listening
 * server, so the database really sees concurrent transactions.
 */
describe('Concurrency (e2e)', () => {
  let ctx: TestContext;
  let branchId: string;
  let seller: string;
  let worker: string;

  beforeAll(async () => {
    ctx = await createTestApp({ listen: true });
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    branchId = (await createBranch(ctx.prisma)).id;
    seller = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId, role: BranchRole.SELLER }])).email,
    );
    worker = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId, role: BranchRole.WAREHOUSE_WORKER }])).email,
    );
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const post = (path: string, token: string, body: object) =>
    request(ctx.baseUrl)
      .post(path)
      .set({ Authorization: `Bearer ${token}` })
      .send(body);
  const sale = (productId: string, quantity: number, idempotencyKey = `c-${randomUUID()}`) =>
    post('/api/inventory/sales', seller, { branchId, productId, quantity, idempotencyKey });
  const inventory = (productId: string) =>
    ctx.prisma.inventory.findUniqueOrThrow({
      where: { branchId_productId: { branchId, productId } },
    });

  it.each(Array.from({ length: 5 }, (_, i) => i + 1))(
    'two concurrent sales of 7 from stock 10: exactly one wins (run %i)',
    async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchId, p.id, 10);

      const results = await Promise.all([sale(p.id, 7), sale(p.id, 7)]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(loser.body.code).toBe('INSUFFICIENT_STOCK');
      expect((await inventory(p.id)).quantity).toBe(3);
      expect(
        await ctx.prisma.stockMovement.count({ where: { productId: p.id, type: 'SALE' } }),
      ).toBe(1);
    },
  );

  it('many concurrent single-unit sales never oversell', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 10);
    const results = await Promise.all(Array.from({ length: 25 }, () => sale(p.id, 1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === 'INSUFFICIENT_STOCK'),
    ).toBe(true);
    const inv = await inventory(p.id);
    expect(inv).toMatchObject({ quantity: 0, version: 10 });
    const movements = await ctx.prisma.stockMovement.findMany({
      where: { productId: p.id },
      orderBy: { inventoryVersion: 'asc' },
    });
    // Each movement recorded a distinct version and a consistent running balance.
    expect(movements.map((m) => m.inventoryVersion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(movements.map((m) => m.balanceAfter)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('concurrent duplicate requests with the same idempotency key deduct once', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 10);
    const key = `dup-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => sale(p.id, 4, key)));

    expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
    const movementIds = new Set(results.map((r) => r.body.movement.id));
    expect(movementIds.size).toBe(1);
    expect((await inventory(p.id)).quantity).toBe(6);
    expect(await ctx.prisma.stockMovement.count({ where: { productId: p.id } })).toBe(1);
    expect(await ctx.prisma.idempotencyKey.count()).toBe(1);
  });

  it('concurrent reuse of one key with different payloads: one succeeds, the rest conflict', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 10);
    const key = `mix-${randomUUID()}`;
    const results = await Promise.all([sale(p.id, 1, key), sale(p.id, 2, key), sale(p.id, 3, key)]);
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts.every((r) => r.body.code === 'IDEMPOTENCY_CONFLICT')).toBe(true);
    expect((await inventory(p.id)).quantity).toBe(10 - ok[0].body.movement.quantity);
  });

  it('concurrent first receipts for a never-stocked product create one row with every unit', async () => {
    const p = await createProduct(ctx.prisma);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/inventory/receipts', worker, {
          branchId,
          productId: p.id,
          quantity: 3,
          idempotencyKey: `r-${randomUUID()}`,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await inventory(p.id)).toMatchObject({ quantity: 30, version: 10 });
    expect(await ctx.prisma.inventory.count({ where: { productId: p.id } })).toBe(1);
  });

  it('mixed concurrent receipts and sales keep the ledger consistent with the balance', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 5);
    const ops = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0
        ? post('/api/inventory/receipts', worker, {
            branchId,
            productId: p.id,
            quantity: 2,
            idempotencyKey: `m-${randomUUID()}`,
          })
        : sale(p.id, 1),
    );
    await Promise.all(ops);
    const inv = await inventory(p.id);
    const movements = await ctx.prisma.stockMovement.findMany({ where: { productId: p.id } });
    const net = movements.reduce(
      (acc, m) => acc + (m.direction === 'INCREASE' ? m.quantity : -m.quantity),
      0,
    );
    expect(inv.quantity).toBe(5 + net);
    expect(inv.quantity).toBeGreaterThanOrEqual(0);
    expect(inv.version).toBe(movements.length);
  });
});
