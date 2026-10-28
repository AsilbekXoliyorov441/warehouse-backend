import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchRole, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/prisma/prisma.service';
import { assertTestDatabase } from './load-test-env';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  /** Base URL when the app was started with `listen: true` (needed for Socket.IO). */
  baseUrl: string;
}

export async function createTestApp(
  options: { listen?: boolean; swagger?: boolean } = {},
): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app, { swagger: options.swagger ?? false });
  let baseUrl = '';
  if (options.listen) {
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  } else {
    await app.init();
  }
  const server = app.getHttpServer() as Parameters<typeof request>[0];
  return { app, prisma: app.get(PrismaService), http: () => request(server), baseUrl };
}

const TABLES = [
  'outbox_events',
  'idempotency_keys',
  'notifications',
  'audit_logs',
  'stock_transfer_items',
  'stock_transfers',
  'stock_movements',
  'inventory',
  'products',
  'categories',
  'branch_memberships',
  'refresh_tokens',
  'branches',
  'users',
];

/** Wipes all business tables. Guarded so it can only ever touch a *_test database. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  assertTestDatabase(process.env.DATABASE_URL);
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`,
  );
}

export const TEST_PASSWORD = 'TestPassw0rd!';
let cachedHash: Promise<string> | undefined;
const passwordHash = () => (cachedHash ??= argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }));

let seq = 0;
export async function createUser(
  prisma: PrismaClient,
  memberships: { branchId: string; role: BranchRole }[] = [],
  overrides: { email?: string; isActive?: boolean } = {},
) {
  seq += 1;
  return prisma.user.create({
    data: {
      name: `User ${seq}`,
      email: overrides.email ?? `user${seq}-${Date.now()}@test.dev`,
      passwordHash: await passwordHash(),
      isActive: overrides.isActive ?? true,
      memberships: { create: memberships },
    },
  });
}

export async function createBranch(prisma: PrismaClient, name = `Branch ${++seq}`) {
  return prisma.branch.create({
    data: { name: `${name}-${Date.now()}-${seq}`, address: '1 Test Street' },
  });
}

export async function createProduct(
  prisma: PrismaClient,
  overrides: Partial<{ sku: string; minStock: number; price: string; isActive: boolean }> = {},
) {
  seq += 1;
  return prisma.product.create({
    data: {
      sku: overrides.sku ?? `SKU-${seq}-${Date.now()}`,
      name: `Product ${seq}`,
      unit: 'pcs',
      price: overrides.price ?? '10.00',
      minStock: overrides.minStock ?? 0,
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function setStock(
  prisma: PrismaClient,
  branchId: string,
  productId: string,
  quantity: number,
) {
  return prisma.inventory.upsert({
    where: { branchId_productId: { branchId, productId } },
    create: { branchId, productId, quantity },
    update: { quantity },
  });
}

export async function login(ctx: TestContext, email: string): Promise<string> {
  const res = await ctx
    .http()
    .post('/api/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

export function refreshCookieFrom(res: request.Response): string {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const cookie = cookies.find((c) => c.startsWith('sp_refresh='));
  if (!cookie) throw new Error('No refresh cookie set');
  return cookie.split(';')[0];
}
