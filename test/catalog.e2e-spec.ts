import { BranchRole } from '@prisma/client';
import {
  createBranch,
  createProduct,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Categories and products (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  let seller: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const branch = await createBranch(ctx.prisma);
    admin = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId: branch.id, role: BranchRole.ADMIN }])).email,
    );
    seller = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId: branch.id, role: BranchRole.SELLER }])).email,
    );
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('creates products with decimal prices and rejects duplicate SKUs', async () => {
    const cat = await ctx
      .http()
      .post('/api/categories')
      .set(as(admin))
      .send({ name: 'Snacks' })
      .expect(201);
    const body = {
      sku: 'snk-001',
      name: 'Chips',
      unit: 'pcs',
      price: '2.49',
      minStock: 5,
      categoryId: cat.body.id,
    };
    const res = await ctx.http().post('/api/products').set(as(admin)).send(body).expect(201);
    expect(res.body).toMatchObject({
      sku: 'SNK-001',
      price: '2.49',
      minStock: 5,
      isActive: true,
      category: { name: 'Snacks' },
    });

    const dup = await ctx
      .http()
      .post('/api/products')
      .set(as(admin))
      .send({ ...body, sku: 'SNK-001' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE_SKU');
  });

  it.each([
    [{ price: '-1.00' }],
    [{ price: '1.999' }],
    [{ price: 'abc' }],
    [{ minStock: -1 }],
    [{ minStock: 1.5 }],
    [{ quantity: 10 }], // stock cannot be set through the catalog
  ])('rejects invalid product payload %j', async (patch) => {
    const res = await ctx
      .http()
      .post('/api/products')
      .set(as(admin))
      .send({ sku: 'X-1', name: 'X', unit: 'pcs', price: '1.00', ...patch })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('prevents inventory changes through PATCH /products/:id', async () => {
    const p = await createProduct(ctx.prisma);
    await ctx
      .http()
      .patch(`/api/products/${p.id}`)
      .set(as(admin))
      .send({ quantity: 99 })
      .expect(400);
    await ctx
      .http()
      .patch(`/api/products/${p.id}`)
      .set(as(admin))
      .send({ isActive: false })
      .expect(400);
    const ok = await ctx
      .http()
      .patch(`/api/products/${p.id}`)
      .set(as(admin))
      .send({ name: 'Renamed', price: 3 })
      .expect(200);
    expect(ok.body).toMatchObject({ name: 'Renamed', price: '3' });
  });

  it('soft-deactivates products instead of deleting them', async () => {
    const p = await createProduct(ctx.prisma);
    const res = await ctx
      .http()
      .patch(`/api/products/${p.id}/status`)
      .set(as(admin))
      .send({ isActive: false })
      .expect(200);
    expect(res.body.isActive).toBe(false);
    expect(await ctx.prisma.product.count({ where: { id: p.id } })).toBe(1);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'product.deactivate', entityId: p.id } }),
    ).toBe(1);
  });

  it('paginates, searches and filters products', async () => {
    for (let i = 0; i < 5; i++) await createProduct(ctx.prisma, { sku: `FIND-${i}` });
    await createProduct(ctx.prisma, { sku: 'OTHER-1', isActive: false });
    const page = await ctx
      .http()
      .get('/api/products?q=find&limit=2&page=2&sortBy=sku')
      .set(as(seller))
      .expect(200);
    expect(page.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect(page.body.data.map((p: { sku: string }) => p.sku)).toEqual(['FIND-2', 'FIND-3']);
    const inactive = await ctx
      .http()
      .get('/api/products?isActive=false')
      .set(as(seller))
      .expect(200);
    expect(inactive.body.data).toHaveLength(1);
    await ctx.http().get('/api/products?limit=1000').set(as(seller)).expect(400);
    await ctx.http().get('/api/products?sortBy=password').set(as(seller)).expect(400);
  });

  it('only product managers can write the catalog', async () => {
    await ctx.http().post('/api/categories').set(as(seller)).send({ name: 'Nope' }).expect(403);
    await ctx
      .http()
      .post('/api/products')
      .set(as(seller))
      .send({ sku: 'A-1', name: 'A', unit: 'pcs', price: '1' })
      .expect(403);
    await ctx.http().get('/api/categories').set(as(seller)).expect(200);
  });

  it('refuses to delete categories that are in use', async () => {
    const cat = await ctx
      .http()
      .post('/api/categories')
      .set(as(admin))
      .send({ name: 'Used' })
      .expect(201);
    await ctx
      .http()
      .post('/api/products')
      .set(as(admin))
      .send({ sku: 'U-1', name: 'U', unit: 'pcs', price: '1', categoryId: cat.body.id })
      .expect(201);
    const res = await ctx
      .http()
      .delete(`/api/categories/${cat.body.id}`)
      .set(as(admin))
      .expect(409);
    expect(res.body.code).toBe('CATEGORY_IN_USE');
    const unused = await ctx
      .http()
      .post('/api/categories')
      .set(as(admin))
      .send({ name: 'Unused' })
      .expect(201);
    await ctx.http().delete(`/api/categories/${unused.body.id}`).set(as(admin)).expect(204);
    await ctx.http().post('/api/categories').set(as(admin)).send({ name: 'Used' }).expect(409);
  });
});
