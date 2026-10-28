import { JwtService } from '@nestjs/jwt';
import { BranchRole } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Socket } from 'socket.io-client';
import { JWT_AUDIENCE, JWT_ISSUER } from '../src/auth/token.service';
import { OutboxDispatcherService } from '../src/realtime/outbox/outbox-dispatcher.service';
import {
  collect,
  connectSocket,
  emitWithAck,
  sleep,
  waitForConnect,
  waitForConnectError,
  waitForEvent,
} from './utils/socket-helpers';
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

describe('Socket.IO gateway (e2e)', () => {
  let ctx: TestContext;
  const sockets: Socket[] = [];
  let branchA: string;
  let branchB: string;
  let sellerA: { id: string; token: string };
  let managerA: { id: string; token: string };
  let userB: { id: string; token: string };
  let adminA: string;

  const open = (token: string | undefined, extra?: Record<string, unknown>) => {
    const s = connectSocket(ctx.baseUrl, token, extra);
    sockets.push(s);
    return s;
  };
  const connected = async (token: string) => {
    const s = open(token);
    await waitForConnect(s);
    return s;
  };
  const sell = (token: string, branchId: string, productId: string, quantity: number) =>
    ctx
      .http()
      .post('/api/inventory/sales')
      .set({ Authorization: `Bearer ${token}` })
      .send({ branchId, productId, quantity, idempotencyKey: `rt-${randomUUID()}` });

  beforeAll(async () => {
    ctx = await createTestApp({ listen: true });
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    branchA = (await createBranch(ctx.prisma, 'A')).id;
    branchB = (await createBranch(ctx.prisma, 'B')).id;
    const mk = async (branchId: string, role: BranchRole) => {
      const u = await createUser(ctx.prisma, [{ branchId, role }]);
      return { id: u.id, token: await login(ctx, u.email) };
    };
    sellerA = await mk(branchA, BranchRole.SELLER);
    managerA = await mk(branchA, BranchRole.MANAGER);
    userB = await mk(branchB, BranchRole.ADMIN);
    adminA = (await mk(branchA, BranchRole.ADMIN)).token;
  });
  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  describe('handshake authentication', () => {
    it('accepts a valid access token', async () => {
      const s = await connected(sellerA.token);
      expect(s.connected).toBe(true);
    });

    it('accepts the token via the Authorization header too', async () => {
      const s = open(undefined, { extraHeaders: { Authorization: `Bearer ${sellerA.token}` } });
      await waitForConnect(s);
    });

    it.each([
      ['missing', undefined],
      ['malformed', 'not-a-jwt'],
      ['bad signature', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwidHlwIjoiYWNjZXNzIn0.c2lnbmF0dXJl'],
    ])('rejects a %s token', async (_label, token) => {
      const err = await waitForConnectError(open(token));
      expect(err.message).toBe('UNAUTHORIZED');
    });

    it('rejects an expired token with TOKEN_EXPIRED', async () => {
      const jwt = ctx.app.get(JwtService);
      const expired = jwt.sign(
        { sub: sellerA.id, typ: 'access' },
        { expiresIn: -10, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      );
      const err = await waitForConnectError(open(expired));
      expect(err.message).toBe('TOKEN_EXPIRED');
    });

    it('rejects tokens of deactivated users', async () => {
      await ctx.prisma.user.update({ where: { id: sellerA.id }, data: { isActive: false } });
      const err = await waitForConnectError(open(sellerA.token));
      expect(err.message).toBe('UNAUTHORIZED');
    });

    it('rejects connections from origins outside the allowlist', async () => {
      const allowed = open(sellerA.token, { extraHeaders: { Origin: 'http://localhost:5173' } });
      await waitForConnect(allowed);
      const evil = open(sellerA.token, { extraHeaders: { Origin: 'https://evil.example' } });
      const err = await waitForConnectError(evil);
      expect(err.message).not.toBe('UNAUTHORIZED'); // rejected at transport level, before auth
    });
  });

  describe('subscriptions', () => {
    it('lets members subscribe to their branch only', async () => {
      const s = await connected(sellerA.token);
      expect(await emitWithAck(s, 'inventory:subscribe', { branchId: branchA })).toEqual({
        ok: true,
        branchId: branchA,
      });
      expect(await emitWithAck(s, 'inventory:subscribe', { branchId: branchB })).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(
        await emitWithAck(s, 'inventory:subscribe', { branchId: 'branch:../*' }),
      ).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect(await emitWithAck(s, 'inventory:subscribe', null)).toMatchObject({
        ok: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('ignores identity claims in the payload', async () => {
      const s = await connected(sellerA.token);
      const ack = await emitWithAck(s, 'inventory:subscribe', {
        branchId: branchB,
        userId: userB.id,
        role: 'ADMIN',
      });
      expect(ack).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    });
  });

  describe('event delivery', () => {
    it('delivers committed inventory updates to authorised subscribers only', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchA, p.id, 10);
      await setStock(ctx.prisma, branchB, p.id, 10);

      const subscriber = await connected(managerA.token);
      await emitWithAck(subscriber, 'inventory:subscribe', { branchId: branchA });
      const outsider = await connected(userB.token);
      await emitWithAck(outsider, 'inventory:subscribe', { branchId: branchB });
      const outsiderEvents = collect(outsider, 'inventory:updated');
      const notSubscribed = await connected(sellerA.token); // member of A but never subscribed
      const unsubscribedEvents = collect(notSubscribed, 'inventory:updated');

      const received = waitForEvent<Record<string, unknown>>(subscriber, 'inventory:updated');
      const sale = await sell(sellerA.token, branchA, p.id, 3).expect(201);
      const event = await received;

      expect(event).toEqual({
        eventId: expect.any(String),
        branchId: branchA,
        productId: p.id,
        quantity: 7,
        version: 1,
        movementId: sale.body.movement.id,
        movementType: 'SALE',
        occurredAt: expect.any(String),
      });
      await sleep(300);
      expect(outsiderEvents.items).toHaveLength(0);
      expect(unsubscribedEvents.items).toHaveLength(0);
    });

    it('stops delivering after unsubscribe', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchA, p.id, 10);
      const s = await connected(managerA.token);
      await emitWithAck(s, 'inventory:subscribe', { branchId: branchA });
      await emitWithAck(s, 'inventory:unsubscribe', { branchId: branchA });
      const events = collect(s, 'inventory:updated');
      await sell(sellerA.token, branchA, p.id, 1).expect(201);
      await ctx.app.get(OutboxDispatcherService).flush();
      await sleep(200);
      expect(events.items).toHaveLength(0);
    });

    it('emits low-stock only when the threshold is reached, plus a personal notification', async () => {
      const p = await createProduct(ctx.prisma, { minStock: 5 });
      await setStock(ctx.prisma, branchA, p.id, 8);
      const s = await connected(managerA.token);
      await emitWithAck(s, 'inventory:subscribe', { branchId: branchA });
      const lows = collect(s, 'inventory:low-stock');
      const sellerSocket = await connected(sellerA.token);
      const sellerNotifications = collect(sellerSocket, 'notification:new');

      await sell(sellerA.token, branchA, p.id, 2).expect(201); // 8 -> 6
      await waitForEvent(s, 'inventory:updated', (e) => e.quantity === 6);
      expect(lows.items).toHaveLength(0);

      const notification = waitForEvent(s, 'notification:new');
      const low = waitForEvent(s, 'inventory:low-stock');
      await sell(sellerA.token, branchA, p.id, 2).expect(201); // 6 -> 4 crosses
      expect(await low).toMatchObject({
        branchId: branchA,
        productId: p.id,
        quantity: 4,
        minStock: 5,
      });
      expect(await notification).toMatchObject({
        type: 'LOW_STOCK',
        title: 'Low stock',
        branchId: branchA,
      });

      await sell(sellerA.token, branchA, p.id, 1).expect(201); // 4 -> 3 already low
      await waitForEvent(s, 'inventory:updated', (e) => e.quantity === 3);
      await sleep(200);
      expect(lows.items).toHaveLength(1);
      expect(sellerNotifications.items).toHaveLength(0); // sellers are not alert recipients
    });

    it('never publishes events for rolled-back operations', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchA, p.id, 1);
      const s = await connected(managerA.token);
      await emitWithAck(s, 'inventory:subscribe', { branchId: branchA });
      const events = collect(s, 'inventory:updated');
      await sell(sellerA.token, branchA, p.id, 5).expect(409);
      await ctx.app.get(OutboxDispatcherService).flush();
      await sleep(200);
      expect(events.items).toHaveLength(0);
    });

    it('evicts sockets from a branch room when membership is revoked', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchA, p.id, 10);
      const s = await connected(managerA.token);
      await emitWithAck(s, 'inventory:subscribe', { branchId: branchA });
      await ctx
        .http()
        .delete(`/api/branches/${branchA}/members/${managerA.id}`)
        .set({ Authorization: `Bearer ${adminA}` })
        .expect(204);
      await ctx.app.get(OutboxDispatcherService).flush();

      const events = collect(s, 'inventory:updated');
      await sell(sellerA.token, branchA, p.id, 1).expect(201);
      await ctx.app.get(OutboxDispatcherService).flush();
      await sleep(200);
      expect(events.items).toHaveLength(0);
      expect(await emitWithAck(s, 'inventory:subscribe', { branchId: branchA })).toMatchObject({
        ok: false,
      });
    });
  });

  describe('reconnection recovery', () => {
    it('recovers the authoritative snapshot after missing events while offline', async () => {
      const p = await createProduct(ctx.prisma);
      await setStock(ctx.prisma, branchA, p.id, 20);
      const s = await connected(managerA.token);
      await emitWithAck(s, 'inventory:subscribe', { branchId: branchA });

      const first = waitForEvent<{ version: number; quantity: number }>(s, 'inventory:updated');
      await sell(sellerA.token, branchA, p.id, 1).expect(201);
      const lastSeen = await first;
      expect(lastSeen).toMatchObject({ quantity: 19, version: 1 });

      s.disconnect();
      await sell(sellerA.token, branchA, p.id, 2).expect(201); // missed
      await sell(sellerA.token, branchA, p.id, 3).expect(201); // missed
      await ctx.app.get(OutboxDispatcherService).flush();

      s.connect();
      await waitForConnect(s);
      // Rooms do not survive a reconnect: the client must re-subscribe (re-authorised server-side).
      expect(await emitWithAck(s, 'inventory:subscribe', { branchId: branchA })).toMatchObject({
        ok: true,
      });
      const snapshot = await ctx
        .http()
        .get(`/api/inventory?branchId=${branchA}`)
        .set({ Authorization: `Bearer ${managerA.token}` })
        .expect(200);
      const row = snapshot.body.data.find((r: { productId: string }) => r.productId === p.id);
      expect(row).toMatchObject({ quantity: 14, version: 3 });
      expect(row.version).toBeGreaterThan(lastSeen.version + 1); // gap detected => snapshot was required

      const next = waitForEvent<{ version: number; quantity: number }>(s, 'inventory:updated');
      await sell(sellerA.token, branchA, p.id, 4).expect(201);
      expect(await next).toMatchObject({ quantity: 10, version: 4 });
    });
  });
});
