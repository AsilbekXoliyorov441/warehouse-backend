import { BranchRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
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

describe('Dashboard and audit logs (e2e)', () => {
  let ctx: TestContext;
  let branchId: string;
  let manager: string;
  let seller: string;
  let admin: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    branchId = (await createBranch(ctx.prisma)).id;
    manager = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId, role: BranchRole.MANAGER }])).email,
    );
    seller = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId, role: BranchRole.SELLER }])).email,
    );
    admin = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId, role: BranchRole.ADMIN }])).email,
    );
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('computes summary KPIs and stock value from active products only', async () => {
    const a = await createProduct(ctx.prisma, { price: '2.50', minStock: 5 });
    const b = await createProduct(ctx.prisma, { price: '10.00', minStock: 0 });
    const c = await createProduct(ctx.prisma, { price: '0.10', minStock: 3 });
    const inactive = await createProduct(ctx.prisma, { price: '99.00', isActive: false });
    await setStock(ctx.prisma, branchId, a.id, 4); // low
    await setStock(ctx.prisma, branchId, b.id, 0); // out of stock, alerting disabled
    await setStock(ctx.prisma, branchId, c.id, 3); // low (at threshold)
    await setStock(ctx.prisma, branchId, inactive.id, 100);

    const s = await ctx
      .http()
      .get(`/api/dashboard/summary?branchId=${branchId}`)
      .set({ Authorization: `Bearer ${manager}` })
      .expect(200);
    expect(s.body).toMatchObject({
      totalActiveProducts: 3,
      totalUnitsInStock: 7,
      lowStockCount: 2,
      outOfStockCount: 1,
      stockValue: '10.30',
      pendingTransfers: { incoming: 0, outgoing: 0 },
    });

    const v = await ctx
      .http()
      .get(`/api/dashboard/stock-value?branchId=${branchId}`)
      .set({ Authorization: `Bearer ${manager}` })
      .expect(200);
    expect(v.body.totalValue).toBe('10.30');
    expect(v.body.valuationRule).toMatch(/current product price/);

    const low = await ctx
      .http()
      .get(`/api/dashboard/low-stock?branchId=${branchId}`)
      .set({ Authorization: `Bearer ${manager}` })
      .expect(200);
    expect(low.body.map((r: { productId: string }) => r.productId)).toEqual([a.id, c.id]);
  });

  it('lists recent movements and restricts reports to ADMIN/MANAGER members', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 10);
    await ctx
      .http()
      .post('/api/inventory/sales')
      .set({ Authorization: `Bearer ${seller}` })
      .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: `k-${randomUUID()}` })
      .expect(201);
    const recent = await ctx
      .http()
      .get(`/api/dashboard/recent-movements?branchId=${branchId}&limit=5`)
      .set({ Authorization: `Bearer ${manager}` })
      .expect(200);
    expect(recent.body).toHaveLength(1);
    expect(recent.body[0]).toMatchObject({ type: 'SALE', product: { id: p.id } });

    await ctx
      .http()
      .get(`/api/dashboard/summary?branchId=${branchId}`)
      .set({ Authorization: `Bearer ${seller}` })
      .expect(403);
    const other = await createBranch(ctx.prisma);
    await ctx
      .http()
      .get(`/api/dashboard/summary?branchId=${other.id}`)
      .set({ Authorization: `Bearer ${manager}` })
      .expect(403);
  });

  it('audit logs are admin-only, filterable and contain no secrets', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, branchId, p.id, 10);
    await ctx
      .http()
      .post('/api/inventory/sales')
      .set({ Authorization: `Bearer ${seller}` })
      .send({ branchId, productId: p.id, quantity: 1, idempotencyKey: `k-${randomUUID()}` })
      .expect(201);
    await ctx
      .http()
      .get('/api/audit-logs')
      .set({ Authorization: `Bearer ${manager}` })
      .expect(403);
    const res = await ctx
      .http()
      .get('/api/audit-logs?action=inventory.sale')
      .set({ Authorization: `Bearer ${admin}` })
      .expect(200);
    expect(res.body.meta.total).toBe(1);
    const all = await ctx
      .http()
      .get('/api/audit-logs?limit=100')
      .set({ Authorization: `Bearer ${admin}` })
      .expect(200);
    expect(JSON.stringify(all.body)).not.toMatch(/password|token|hash/i);
  });
});
