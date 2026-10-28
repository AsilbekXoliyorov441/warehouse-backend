import { BranchRole } from '@prisma/client';
import {
  createBranch,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  TestContext,
} from './utils/test-app';

describe('Users, branches and memberships authorization (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function setup() {
    const branchA = await createBranch(ctx.prisma, 'A');
    const branchB = await createBranch(ctx.prisma, 'B');
    const admin = await createUser(ctx.prisma, [{ branchId: branchA.id, role: BranchRole.ADMIN }]);
    const manager = await createUser(ctx.prisma, [
      { branchId: branchA.id, role: BranchRole.MANAGER },
    ]);
    const seller = await createUser(ctx.prisma, [
      { branchId: branchB.id, role: BranchRole.SELLER },
    ]);
    return {
      branchA,
      branchB,
      admin,
      manager,
      seller,
      adminToken: await login(ctx, admin.email),
      managerToken: await login(ctx, manager.email),
      sellerToken: await login(ctx, seller.email),
    };
  }

  it('lets only admins manage users', async () => {
    const s = await setup();
    await ctx.http().get('/api/users').set('Authorization', `Bearer ${s.adminToken}`).expect(200);
    const denied = await ctx
      .http()
      .get('/api/users')
      .set('Authorization', `Bearer ${s.managerToken}`)
      .expect(403);
    expect(denied.body.code).toBe('FORBIDDEN');

    const created = await ctx
      .http()
      .post('/api/users')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ name: 'New', email: 'new@test.dev', password: 'LongPassword1' })
      .expect(201);
    expect(created.body.passwordHash).toBeUndefined();
  });

  it('deactivating a user revokes their refresh tokens and is audited', async () => {
    const s = await setup();
    await ctx
      .http()
      .patch(`/api/users/${s.seller.id}`)
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ isActive: false })
      .expect(200);
    expect(
      await ctx.prisma.refreshToken.count({ where: { userId: s.seller.id, revokedAt: null } }),
    ).toBe(0);
    await ctx
      .http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${s.sellerToken}`)
      .expect(401);
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'user.update', entityId: s.seller.id },
    });
    expect(audit?.userId).toBe(s.admin.id);
  });

  it('lists only member branches for non-admins and all branches for admins', async () => {
    const s = await setup();
    const forSeller = await ctx
      .http()
      .get('/api/branches')
      .set('Authorization', `Bearer ${s.sellerToken}`)
      .expect(200);
    expect(forSeller.body.map((b: { id: string }) => b.id)).toEqual([s.branchB.id]);
    const forAdmin = await ctx
      .http()
      .get('/api/branches')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .expect(200);
    expect(forAdmin.body).toHaveLength(2);
  });

  it('forbids reading a branch the user is not a member of', async () => {
    const s = await setup();
    const res = await ctx
      .http()
      .get(`/api/branches/${s.branchA.id}`)
      .set('Authorization', `Bearer ${s.sellerToken}`)
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('creating a branch makes the creator its ADMIN', async () => {
    const s = await setup();
    const res = await ctx
      .http()
      .post('/api/branches')
      .set('Authorization', `Bearer ${s.adminToken}`)
      .send({ name: 'Brand New', address: 'Somewhere 1' })
      .expect(201);
    const m = await ctx.prisma.branchMembership.findUnique({
      where: { userId_branchId: { userId: s.admin.id, branchId: res.body.id } },
    });
    expect(m?.role).toBe('ADMIN');
    await ctx
      .http()
      .post('/api/branches')
      .set('Authorization', `Bearer ${s.managerToken}`)
      .send({ name: 'X', address: 'Y' })
      .expect(403);
  });

  it('branch-scoped member listing respects membership and role', async () => {
    const s = await setup();
    await ctx
      .http()
      .get(`/api/branches/${s.branchA.id}/members`)
      .set('Authorization', `Bearer ${s.managerToken}`)
      .expect(200);
    // Seller is not a member of A
    await ctx
      .http()
      .get(`/api/branches/${s.branchA.id}/members`)
      .set('Authorization', `Bearer ${s.sellerToken}`)
      .expect(403);
    // Seller is a member of B but lacks MEMBERS_READ
    await ctx
      .http()
      .get(`/api/branches/${s.branchB.id}/members`)
      .set('Authorization', `Bearer ${s.sellerToken}`)
      .expect(403);
    // Malformed branch id
    const bad = await ctx
      .http()
      .get(`/api/branches/not-a-uuid/members`)
      .set('Authorization', `Bearer ${s.managerToken}`)
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });

  it('admins can grant, change and revoke memberships but not their own', async () => {
    const s = await setup();
    const auth = { Authorization: `Bearer ${s.adminToken}` };
    await ctx
      .http()
      .post(`/api/branches/${s.branchA.id}/members`)
      .set(auth)
      .send({ userId: s.seller.id, role: 'SELLER' })
      .expect(201);
    const dup = await ctx
      .http()
      .post(`/api/branches/${s.branchA.id}/members`)
      .set(auth)
      .send({ userId: s.seller.id, role: 'SELLER' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE_RESOURCE');
    await ctx
      .http()
      .patch(`/api/branches/${s.branchA.id}/members/${s.seller.id}`)
      .set(auth)
      .send({ role: 'MANAGER' })
      .expect(200);
    await ctx
      .http()
      .delete(`/api/branches/${s.branchA.id}/members/${s.seller.id}`)
      .set(auth)
      .expect(204);
    await ctx
      .http()
      .delete(`/api/branches/${s.branchA.id}/members/${s.admin.id}`)
      .set(auth)
      .expect(400);
    await ctx
      .http()
      .post(`/api/branches/${s.branchA.id}/members`)
      .set(auth)
      .send({ userId: s.seller.id, role: 'GOD' })
      .expect(400);
  });

  it('inactive branches deny access with INVALID_BRANCH', async () => {
    const s = await setup();
    await ctx.prisma.branch.update({ where: { id: s.branchA.id }, data: { isActive: false } });
    const res = await ctx
      .http()
      .get(`/api/branches/${s.branchA.id}/members`)
      .set('Authorization', `Bearer ${s.managerToken}`)
      .expect(400);
    expect(res.body.code).toBe('INVALID_BRANCH');
  });
});
