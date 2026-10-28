import { BranchRole } from '@prisma/client';
import {
  createBranch,
  createUser,
  createTestApp,
  login,
  refreshCookieFrom,
  resetDatabase,
  TEST_PASSWORD,
  TestContext,
} from './utils/test-app';

const NEW_PASSWORD = 'BrandNewPass42';

describe('Account management (e2e)', () => {
  let ctx: TestContext;
  let branchId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    branchId = (await createBranch(ctx.prisma)).id;
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function loginWithCookie(email: string) {
    const res = await ctx
      .http()
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return {
      token: (res.body as { accessToken: string }).accessToken,
      cookie: refreshCookieFrom(res),
    };
  }

  describe('POST /auth/change-password', () => {
    it('rejects a wrong current password without changing anything', async () => {
      const user = await createUser(ctx.prisma);
      const { token, cookie } = await loginWithCookie(user.email);
      const res = await ctx
        .http()
        .post('/api/auth/change-password')
        .set(as(token))
        .send({ currentPassword: 'WrongPassword1', newPassword: NEW_PASSWORD })
        .expect(400);
      expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD');
      await ctx.http().post('/api/auth/refresh').set('Cookie', cookie).expect(200);
    });

    it('rejects reusing the current password and weak new passwords', async () => {
      const user = await createUser(ctx.prisma);
      const { token } = await loginWithCookie(user.email);
      const same = await ctx
        .http()
        .post('/api/auth/change-password')
        .set(as(token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })
        .expect(400);
      expect(same.body.code).toBe('VALIDATION_ERROR');
      await ctx
        .http()
        .post('/api/auth/change-password')
        .set(as(token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'short' })
        .expect(400);
    });

    it('changes the password, revokes every old session and issues a new one', async () => {
      const user = await createUser(ctx.prisma);
      const deviceA = await loginWithCookie(user.email);
      const deviceB = await loginWithCookie(user.email);

      const res = await ctx
        .http()
        .post('/api/auth/change-password')
        .set(as(deviceA.token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);
      expect(res.body.accessToken).toEqual(expect.any(String));
      const freshCookie = refreshCookieFrom(res);

      await ctx.http().post('/api/auth/refresh').set('Cookie', deviceB.cookie).expect(401);
      await ctx.http().post('/api/auth/refresh').set('Cookie', freshCookie).expect(200);

      const old = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(401);
      expect(old.body.code).toBe('INVALID_CREDENTIALS');
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: NEW_PASSWORD })
        .expect(200);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'auth.password_change', entityId: user.id },
      });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit?.metadata)).not.toContain(NEW_PASSWORD);
    });
  });

  describe('PATCH /auth/me', () => {
    it('renames the caller and rejects privileged fields', async () => {
      const user = await createUser(ctx.prisma, [{ branchId, role: BranchRole.SELLER }]);
      const token = await login(ctx, user.email);
      const res = await ctx
        .http()
        .patch('/api/auth/me')
        .set(as(token))
        .send({ name: '  Renamed  ' })
        .expect(200);
      expect(res.body).toMatchObject({ id: user.id, name: 'Renamed' });
      expect(res.body.memberships).toHaveLength(1);

      await ctx
        .http()
        .patch('/api/auth/me')
        .set(as(token))
        .send({ name: 'X', isActive: false })
        .expect(400);
    });
  });

  describe('POST /users/:id/password', () => {
    it('lets admins reset passwords and revokes the target sessions', async () => {
      const admin = await createUser(ctx.prisma, [{ branchId, role: BranchRole.ADMIN }]);
      const target = await createUser(ctx.prisma, [{ branchId, role: BranchRole.SELLER }]);
      const adminToken = await login(ctx, admin.email);
      const targetSession = await loginWithCookie(target.email);

      await ctx
        .http()
        .post(`/api/users/${target.id}/password`)
        .set(as(adminToken))
        .send({ password: NEW_PASSWORD })
        .expect(204);

      await ctx.http().post('/api/auth/refresh').set('Cookie', targetSession.cookie).expect(401);
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: target.email, password: NEW_PASSWORD })
        .expect(200);
    });

    it('is admin-only, refuses self-resets and unknown users', async () => {
      const admin = await createUser(ctx.prisma, [{ branchId, role: BranchRole.ADMIN }]);
      const manager = await createUser(ctx.prisma, [{ branchId, role: BranchRole.MANAGER }]);
      const adminToken = await login(ctx, admin.email);
      const managerToken = await login(ctx, manager.email);

      const forbidden = await ctx
        .http()
        .post(`/api/users/${admin.id}/password`)
        .set(as(managerToken))
        .send({ password: NEW_PASSWORD })
        .expect(403);
      expect(forbidden.body.code).toBe('FORBIDDEN');
      await ctx
        .http()
        .post(`/api/users/${admin.id}/password`)
        .set(as(adminToken))
        .send({ password: NEW_PASSWORD })
        .expect(400);
      await ctx
        .http()
        .post('/api/users/00000000-0000-4000-8000-000000000000/password')
        .set(as(adminToken))
        .send({ password: NEW_PASSWORD })
        .expect(404);
    });
  });

  describe('catalog and notification helpers', () => {
    it('GET /categories/:id returns the product count', async () => {
      const seller = await createUser(ctx.prisma, [{ branchId, role: BranchRole.SELLER }]);
      const token = await login(ctx, seller.email);
      const category = await ctx.prisma.category.create({ data: { name: 'Snacks' } });
      await ctx.prisma.product.create({
        data: { sku: 'SNK-1', name: 'Chips', unit: 'pcs', price: '1.00', categoryId: category.id },
      });

      const res = await ctx.http().get(`/api/categories/${category.id}`).set(as(token)).expect(200);
      expect(res.body).toMatchObject({ id: category.id, name: 'Snacks', _count: { products: 1 } });
      await ctx
        .http()
        .get('/api/categories/00000000-0000-4000-8000-000000000000')
        .set(as(token))
        .expect(404);
    });

    it('GET /notifications/unread-count counts only the caller’s unread notifications', async () => {
      const user = await createUser(ctx.prisma);
      const other = await createUser(ctx.prisma);
      const token = await login(ctx, user.email);
      await ctx.prisma.notification.createMany({
        data: [
          { userId: user.id, type: 'LOW_STOCK', title: 't', message: 'm' },
          { userId: user.id, type: 'LOW_STOCK', title: 't', message: 'm', readAt: new Date() },
          { userId: other.id, type: 'LOW_STOCK', title: 't', message: 'm' },
        ],
      });
      const res = await ctx
        .http()
        .get('/api/notifications/unread-count')
        .set(as(token))
        .expect(200);
      expect(res.body).toEqual({ unreadCount: 1 });
    });
  });
});
