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

describe('Transfers (e2e)', () => {
  let ctx: TestContext;
  let src: string;
  let dst: string;
  let third: string;
  let t: Record<'worker' | 'srcManager' | 'dstManager' | 'seller' | 'outsider', string>;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    src = (await createBranch(ctx.prisma, 'src')).id;
    dst = (await createBranch(ctx.prisma, 'dst')).id;
    third = (await createBranch(ctx.prisma, 'third')).id;
    const mk = async (branchId: string, role: BranchRole) =>
      login(ctx, (await createUser(ctx.prisma, [{ branchId, role }])).email);
    t = {
      worker: await mk(src, BranchRole.WAREHOUSE_WORKER),
      srcManager: await mk(src, BranchRole.MANAGER),
      dstManager: await mk(dst, BranchRole.MANAGER),
      seller: await mk(src, BranchRole.SELLER),
      outsider: await mk(third, BranchRole.MANAGER),
    };
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const as = (who: keyof typeof t) => ({ Authorization: `Bearer ${t[who]}` });
  const qty = async (branchId: string, productId: string) =>
    (
      await ctx.prisma.inventory.findUnique({
        where: { branchId_productId: { branchId, productId } },
      })
    )?.quantity ?? 0;
  const createTransfer = (
    items: { productId: string; quantity: number }[],
    who: keyof typeof t = 'worker',
    overrides = {},
  ) =>
    ctx
      .http()
      .post('/api/transfers')
      .set(as(who))
      .send({
        sourceBranchId: src,
        destinationBranchId: dst,
        items,
        idempotencyKey: `tr-${randomUUID()}`,
        ...overrides,
      });

  it('creates a PENDING transfer without moving stock', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 10);
    const res = await createTransfer([{ productId: p.id, quantity: 4 }]).expect(201);
    expect(res.body).toMatchObject({
      status: 'PENDING',
      sourceBranchId: src,
      destinationBranchId: dst,
      items: [{ productId: p.id, quantity: 4 }],
    });
    expect(await qty(src, p.id)).toBe(10);
  });

  it('completes atomically: both balances, two linked movements, audit and events', async () => {
    const a = await createProduct(ctx.prisma);
    const b = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, a.id, 10);
    await setStock(ctx.prisma, src, b.id, 5);
    await setStock(ctx.prisma, dst, b.id, 1);
    const created = await createTransfer([
      { productId: a.id, quantity: 4 },
      { productId: b.id, quantity: 5 },
    ]).expect(201);

    const done = await ctx
      .http()
      .post(`/api/transfers/${created.body.id}/complete`)
      .set(as('dstManager'))
      .expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', completedAt: expect.any(String) });
    expect([
      await qty(src, a.id),
      await qty(dst, a.id),
      await qty(src, b.id),
      await qty(dst, b.id),
    ]).toEqual([6, 4, 0, 6]);

    const movements = await ctx.prisma.stockMovement.findMany({
      where: { referenceId: created.body.id },
    });
    expect(movements).toHaveLength(4);
    expect(
      movements.filter((m) => m.type === 'TRANSFER_OUT').every((m) => m.branchId === src),
    ).toBe(true);
    expect(movements.filter((m) => m.type === 'TRANSFER_IN').every((m) => m.branchId === dst)).toBe(
      true,
    );

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'transfer.complete', entityId: created.body.id },
    });
    expect((audit.metadata as { movementIds: string[] }).movementIds).toHaveLength(4);
    const rooms = (
      await ctx.prisma.outboxEvent.findMany({ where: { eventName: 'inventory:updated' } })
    ).map((e) => e.room);
    expect(rooms.filter((r) => r === `branch:${src}`)).toHaveLength(2);
    expect(rooms.filter((r) => r === `branch:${dst}`)).toHaveLength(2);
  });

  it('rolls back everything if any item is short at completion time', async () => {
    const a = await createProduct(ctx.prisma);
    const b = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, a.id, 10);
    await setStock(ctx.prisma, src, b.id, 10);
    const created = await createTransfer([
      { productId: a.id, quantity: 4 },
      { productId: b.id, quantity: 8 },
    ]).expect(201);
    await setStock(ctx.prisma, src, b.id, 3); // stock sold in the meantime

    const res = await ctx
      .http()
      .post(`/api/transfers/${created.body.id}/complete`)
      .set(as('srcManager'))
      .expect(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    expect([await qty(src, a.id), await qty(dst, a.id), await qty(src, b.id)]).toEqual([10, 0, 3]);
    expect(await ctx.prisma.stockMovement.count({ where: { referenceId: created.body.id } })).toBe(
      0,
    );
    expect(
      (await ctx.prisma.stockTransfer.findUniqueOrThrow({ where: { id: created.body.id } })).status,
    ).toBe('PENDING');
  });

  it('prevents double completion and completing a cancelled transfer', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 10);
    const one = await createTransfer([{ productId: p.id, quantity: 2 }]).expect(201);
    await ctx
      .http()
      .post(`/api/transfers/${one.body.id}/complete`)
      .set(as('srcManager'))
      .expect(200);
    const again = await ctx
      .http()
      .post(`/api/transfers/${one.body.id}/complete`)
      .set(as('srcManager'))
      .expect(409);
    expect(again.body.code).toBe('TRANSFER_ALREADY_COMPLETED');
    const cancelDone = await ctx
      .http()
      .post(`/api/transfers/${one.body.id}/cancel`)
      .set(as('srcManager'))
      .send({})
      .expect(409);
    expect(cancelDone.body.code).toBe('TRANSFER_ALREADY_COMPLETED');
    expect(await qty(src, p.id)).toBe(8);

    const two = await createTransfer([{ productId: p.id, quantity: 2 }]).expect(201);
    await ctx
      .http()
      .post(`/api/transfers/${two.body.id}/cancel`)
      .set(as('worker'))
      .send({ reason: 'not needed' })
      .expect(200);
    const twice = await ctx
      .http()
      .post(`/api/transfers/${two.body.id}/cancel`)
      .set(as('worker'))
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('TRANSFER_ALREADY_CANCELLED');
    const completeCancelled = await ctx
      .http()
      .post(`/api/transfers/${two.body.id}/complete`)
      .set(as('srcManager'))
      .expect(409);
    expect(completeCancelled.body.code).toBe('TRANSFER_ALREADY_CANCELLED');
    expect(await qty(src, p.id)).toBe(8);
  });

  it('allows exactly one of concurrent complete requests', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 10);
    const tr = await createTransfer([{ productId: p.id, quantity: 3 }]).expect(201);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.http().post(`/api/transfers/${tr.body.id}/complete`).set(as('srcManager')),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect([await qty(src, p.id), await qty(dst, p.id)]).toEqual([7, 3]);
  });

  it('validates branches, items and stock at creation', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 2);
    const same = await createTransfer([{ productId: p.id, quantity: 1 }], 'worker', {
      destinationBranchId: src,
    }).expect(400);
    expect(same.body.code).toBe('INVALID_BRANCH');
    const missingDst = await createTransfer([{ productId: p.id, quantity: 1 }], 'worker', {
      destinationBranchId: randomUUID(),
    }).expect(400);
    expect(missingDst.body.code).toBe('INVALID_BRANCH');
    await createTransfer([], 'worker').expect(400);
    await createTransfer([{ productId: p.id, quantity: 0 }]).expect(400);
    await createTransfer([
      { productId: p.id, quantity: 1 },
      { productId: p.id, quantity: 1 },
    ]).expect(400);
    const short = await createTransfer([{ productId: p.id, quantity: 3 }]).expect(409);
    expect(short.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('enforces branch permissions', async () => {
    const p = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 10);
    await createTransfer([{ productId: p.id, quantity: 1 }], 'seller').expect(403);
    await createTransfer([{ productId: p.id, quantity: 1 }], 'outsider').expect(403);
    const tr = await createTransfer([{ productId: p.id, quantity: 1 }]).expect(201);
    await ctx.http().post(`/api/transfers/${tr.body.id}/complete`).set(as('worker')).expect(403);
    await ctx.http().post(`/api/transfers/${tr.body.id}/complete`).set(as('outsider')).expect(404);
    await ctx.http().get(`/api/transfers/${tr.body.id}`).set(as('outsider')).expect(404);
    await ctx.http().get(`/api/transfers/${tr.body.id}`).set(as('dstManager')).expect(200);
    const incoming = await ctx
      .http()
      .get(`/api/transfers?branchId=${dst}&direction=incoming`)
      .set(as('dstManager'))
      .expect(200);
    expect(incoming.body.meta.total).toBe(1);
    await ctx.http().get(`/api/transfers?branchId=${src}`).set(as('dstManager')).expect(403);
  });

  it('opposite-direction transfers completed concurrently do not deadlock', async () => {
    const p = await createProduct(ctx.prisma);
    const q = await createProduct(ctx.prisma);
    await setStock(ctx.prisma, src, p.id, 50);
    await setStock(ctx.prisma, src, q.id, 50);
    await setStock(ctx.prisma, dst, p.id, 50);
    await setStock(ctx.prisma, dst, q.id, 50);
    const dstWorker = await login(
      ctx,
      (await createUser(ctx.prisma, [{ branchId: dst, role: BranchRole.WAREHOUSE_WORKER }])).email,
    );
    const items = [
      { productId: p.id, quantity: 1 },
      { productId: q.id, quantity: 1 },
    ];
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await createTransfer(items).expect(201)).body.id);
      const back = await ctx
        .http()
        .post('/api/transfers')
        .set({ Authorization: `Bearer ${dstWorker}` })
        .send({
          sourceBranchId: dst,
          destinationBranchId: src,
          items,
          idempotencyKey: `tr-${randomUUID()}`,
        })
        .expect(201);
      ids.push(back.body.id);
    }
    const admin = await login(
      ctx,
      (
        await createUser(ctx.prisma, [
          { branchId: src, role: BranchRole.ADMIN },
          { branchId: dst, role: BranchRole.ADMIN },
        ])
      ).email,
    );
    const results = await Promise.all(
      ids.map((id) =>
        ctx
          .http()
          .post(`/api/transfers/${id}/complete`)
          .set({ Authorization: `Bearer ${admin}` }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect([
      await qty(src, p.id),
      await qty(dst, p.id),
      await qty(src, q.id),
      await qty(dst, q.id),
    ]).toEqual([50, 50, 50, 50]);
  });
});
