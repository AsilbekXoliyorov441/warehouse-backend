import { BranchRole } from '@prisma/client';
import {
  createBranch,
  createTestApp,
  createUser,
  refreshCookieFrom,
  resetDatabase,
  TEST_PASSWORD,
  TestContext,
} from './utils/test-app';

describe('Auth (e2e)', () => {
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

  describe('register', () => {
    it('normalizes email, hashes the password and never returns secrets', async () => {
      const res = await ctx
        .http()
        .post('/api/auth/register')
        .send({ name: 'Ann', email: '  Ann@Example.COM ', password: 'LongPassword1' })
        .expect(201);
      expect(res.body.user).toEqual({
        id: expect.any(String),
        name: 'Ann',
        email: 'ann@example.com',
      });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash|LongPassword1/);

      const stored = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'ann@example.com' },
      });
      expect(stored.passwordHash).toMatch(/^\$argon2id\$/);

      const cookie = res.headers['set-cookie'][0];
      expect(cookie).toMatch(/sp_refresh=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/auth/);
    });

    it('rejects duplicate emails case-insensitively', async () => {
      await ctx
        .http()
        .post('/api/auth/register')
        .send({ name: 'A', email: 'dup@example.com', password: 'LongPassword1' })
        .expect(201);
      const res = await ctx
        .http()
        .post('/api/auth/register')
        .send({ name: 'B', email: 'DUP@example.com', password: 'LongPassword1' })
        .expect(409);
      expect(res.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('rejects weak passwords with VALIDATION_ERROR', async () => {
      const res = await ctx
        .http()
        .post('/api/auth/register')
        .send({ name: 'A', email: 'a@example.com', password: 'short' })
        .expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
      });
    });
  });

  describe('login', () => {
    it('returns an access token for valid credentials', async () => {
      const user = await createUser(ctx.prisma);
      const res = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    });

    it('returns the same error for unknown email and wrong password', async () => {
      const user = await createUser(ctx.prisma);
      const wrong = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'nope-nope-1' })
        .expect(401);
      const unknown = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: 'ghost@test.dev', password: 'nope-nope-1' })
        .expect(401);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('rejects inactive users', async () => {
      const user = await createUser(ctx.prisma, [], { isActive: false });
      await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(401);
    });
  });

  describe('refresh rotation', () => {
    it('rotates the refresh token and stores only hashes', async () => {
      const user = await createUser(ctx.prisma);
      const loginRes = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      const cookie1 = refreshCookieFrom(loginRes);

      const refreshRes = await ctx
        .http()
        .post('/api/auth/refresh')
        .set('Cookie', cookie1)
        .expect(200);
      const cookie2 = refreshCookieFrom(refreshRes);
      expect(cookie2).not.toBe(cookie1);
      expect(refreshRes.body.accessToken).toEqual(expect.any(String));

      const rows = await ctx.prisma.refreshToken.findMany({ where: { userId: user.id } });
      expect(rows).toHaveLength(2);
      const rawSecret = decodeURIComponent(cookie1.split('=')[1]).split('.')[1];
      for (const row of rows) expect(row.tokenHash).not.toContain(rawSecret);
      expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
    });

    it('detects reuse of a rotated token and revokes the whole family', async () => {
      const user = await createUser(ctx.prisma);
      const loginRes = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      const cookie1 = refreshCookieFrom(loginRes);
      const cookie2 = refreshCookieFrom(
        await ctx.http().post('/api/auth/refresh').set('Cookie', cookie1).expect(200),
      );

      const reuse = await ctx.http().post('/api/auth/refresh').set('Cookie', cookie1).expect(401);
      expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
      // The legitimate latest token is now revoked too.
      const after = await ctx.http().post('/api/auth/refresh').set('Cookie', cookie2).expect(401);
      expect(after.body.code).toBe('REFRESH_TOKEN_REUSED');
    });

    it('rejects missing, malformed and forged tokens', async () => {
      await ctx.http().post('/api/auth/refresh').expect(401);
      await ctx.http().post('/api/auth/refresh').set('Cookie', 'sp_refresh=garbage').expect(401);
      const user = await createUser(ctx.prisma);
      const cookie = refreshCookieFrom(
        await ctx
          .http()
          .post('/api/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD }),
      );
      const id = decodeURIComponent(cookie.split('=')[1]).split('.')[0];
      await ctx
        .http()
        .post('/api/auth/refresh')
        .set('Cookie', `sp_refresh=${id}.${'x'.repeat(43)}`)
        .expect(401);
    });

    it('rejects refresh requests from disallowed origins (CSRF)', async () => {
      const user = await createUser(ctx.prisma);
      const cookie = refreshCookieFrom(
        await ctx
          .http()
          .post('/api/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD }),
      );
      const res = await ctx
        .http()
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(res.body.code).toBe('CSRF_ORIGIN_REJECTED');
      await ctx
        .http()
        .post('/api/auth/refresh')
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:5173')
        .expect(200);
    });
  });

  describe('logout', () => {
    it('revokes the session so the refresh token stops working', async () => {
      const user = await createUser(ctx.prisma);
      const cookie = refreshCookieFrom(
        await ctx
          .http()
          .post('/api/auth/login')
          .send({ email: user.email, password: TEST_PASSWORD }),
      );
      await ctx.http().post('/api/auth/logout').set('Cookie', cookie).expect(204);
      await ctx.http().post('/api/auth/refresh').set('Cookie', cookie).expect(401);
      const live = await ctx.prisma.refreshToken.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });
  });

  describe('me', () => {
    it('requires a valid bearer token', async () => {
      const res = await ctx.http().get('/api/auth/me').expect(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
      await ctx.http().get('/api/auth/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    });

    it('returns memberships with effective permissions', async () => {
      const branch = await createBranch(ctx.prisma);
      const user = await createUser(ctx.prisma, [{ branchId: branch.id, role: BranchRole.SELLER }]);
      const { body } = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      const res = await ctx
        .http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
      expect(res.body.memberships).toEqual([
        expect.objectContaining({
          branchId: branch.id,
          role: 'SELLER',
          permissions: expect.arrayContaining(['SALE_CREATE']),
        }),
      ]);
      expect(res.body.memberships[0].permissions).not.toContain('STOCK_RECEIVE');
      expect(res.body.passwordHash).toBeUndefined();
    });

    it('rejects tokens of users deactivated after login', async () => {
      const user = await createUser(ctx.prisma);
      const { body } = await ctx
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD });
      await ctx.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
      await ctx
        .http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(401);
    });
  });
});
