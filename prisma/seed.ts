/**
 * Development seed. Idempotent: safe to run repeatedly. Refuses to run in production so the
 * well-known sample credentials below can never reach a real deployment.
 */
import { BranchRole, MovementDirection, MovementType, Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

if (process.env.NODE_ENV === 'production') {
  console.error(
    'Refusing to seed: NODE_ENV=production. The seed contains public sample credentials.',
  );
  process.exit(1);
}

const prisma = new PrismaClient();

const USERS = [
  { key: 'admin', name: 'Ada Admin', email: 'admin@stockpulse.dev', password: 'Admin12345!' },
  {
    key: 'managerDowntown',
    name: 'Mona Manager',
    email: 'manager.downtown@stockpulse.dev',
    password: 'Manager12345!',
  },
  {
    key: 'managerAirport',
    name: 'Omar Manager',
    email: 'manager.airport@stockpulse.dev',
    password: 'Manager12345!',
  },
  {
    key: 'worker',
    name: 'Wes Warehouse',
    email: 'warehouse@stockpulse.dev',
    password: 'Warehouse12345!',
  },
  { key: 'seller', name: 'Sam Seller', email: 'seller@stockpulse.dev', password: 'Seller12345!' },
] as const;

const BRANCHES = [
  { key: 'downtown', name: 'Downtown Store', address: '12 Market Street, Springfield' },
  {
    key: 'airport',
    name: 'Airport Kiosk',
    address: 'Terminal 2, Springfield International Airport',
  },
] as const;

type UserKey = (typeof USERS)[number]['key'];
type BranchKey = (typeof BRANCHES)[number]['key'];

const MEMBERSHIPS: { user: UserKey; branch: BranchKey; role: BranchRole }[] = [
  { user: 'admin', branch: 'downtown', role: BranchRole.ADMIN },
  { user: 'admin', branch: 'airport', role: BranchRole.ADMIN },
  { user: 'managerDowntown', branch: 'downtown', role: BranchRole.MANAGER },
  { user: 'managerAirport', branch: 'airport', role: BranchRole.MANAGER },
  { user: 'worker', branch: 'downtown', role: BranchRole.WAREHOUSE_WORKER },
  { user: 'seller', branch: 'downtown', role: BranchRole.SELLER },
  { user: 'seller', branch: 'airport', role: BranchRole.SELLER },
];

const CATEGORIES = ['Beverages', 'Snacks', 'Household', 'Personal Care'] as const;

// [sku, name, category, unit, price, minStock, downtownQty, airportQty]
const PRODUCTS: [
  string,
  string,
  (typeof CATEGORIES)[number],
  string,
  string,
  number,
  number,
  number,
][] = [
  ['BEV-COLA-330', 'Cola 330ml can', 'Beverages', 'can', '1.20', 24, 120, 30],
  ['BEV-WATER-500', 'Still water 500ml', 'Beverages', 'bottle', '0.90', 30, 200, 18],
  ['BEV-OJ-1L', 'Orange juice 1L', 'Beverages', 'carton', '2.75', 10, 40, 6],
  ['BEV-COFFEE-250', 'Ground coffee 250g', 'Beverages', 'pack', '6.50', 8, 25, 4],
  ['SNK-CHIPS-150', 'Salted chips 150g', 'Snacks', 'bag', '2.10', 15, 60, 20],
  ['SNK-CHOC-100', 'Dark chocolate 100g', 'Snacks', 'bar', '1.85', 20, 80, 12],
  ['SNK-NUTS-200', 'Mixed nuts 200g', 'Snacks', 'bag', '4.40', 10, 9, 15],
  ['HH-SOAP-DISH', 'Dish soap 750ml', 'Household', 'bottle', '3.20', 6, 18, 0],
  ['HH-TOWEL-2', 'Paper towels (2 rolls)', 'Household', 'pack', '2.95', 8, 30, 5],
  ['HH-BATT-AA4', 'AA batteries (4 pack)', 'Household', 'pack', '5.60', 10, 22, 14],
  ['PC-TOOTH-75', 'Toothpaste 75ml', 'Personal Care', 'tube', '2.30', 10, 35, 8],
  ['PC-SANIT-100', 'Hand sanitizer 100ml', 'Personal Care', 'bottle', '3.10', 12, 11, 25],
];

async function main(): Promise<void> {
  const users = {} as Record<UserKey, string>;
  for (const u of USERS) {
    const passwordHash = await argon2.hash(u.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const row = await prisma.user.upsert({
      where: { email: u.email },
      create: { name: u.name, email: u.email, passwordHash },
      update: { name: u.name, passwordHash, isActive: true },
    });
    users[u.key] = row.id;
  }

  const branches = {} as Record<BranchKey, string>;
  for (const b of BRANCHES) {
    const row = await prisma.branch.upsert({
      where: { name: b.name },
      create: { name: b.name, address: b.address },
      update: { address: b.address, isActive: true },
    });
    branches[b.key] = row.id;
  }

  for (const m of MEMBERSHIPS) {
    await prisma.branchMembership.upsert({
      where: { userId_branchId: { userId: users[m.user], branchId: branches[m.branch] } },
      create: { userId: users[m.user], branchId: branches[m.branch], role: m.role },
      update: { role: m.role },
    });
  }

  const categories = {} as Record<string, string>;
  for (const name of CATEGORIES) {
    categories[name] = (
      await prisma.category.upsert({ where: { name }, create: { name }, update: {} })
    ).id;
  }

  let created = 0;
  for (const [sku, name, category, unit, price, minStock, downtownQty, airportQty] of PRODUCTS) {
    const product = await prisma.product.upsert({
      where: { sku },
      create: {
        sku,
        name,
        unit,
        price: new Prisma.Decimal(price),
        minStock,
        categoryId: categories[category],
      },
      update: {
        name,
        unit,
        price: new Prisma.Decimal(price),
        minStock,
        categoryId: categories[category],
        isActive: true,
      },
    });
    for (const [branchKey, quantity] of [
      ['downtown', downtownQty],
      ['airport', airportQty],
    ] as const) {
      const branchId = branches[branchKey];
      const exists = await prisma.inventory.findUnique({
        where: { branchId_productId: { branchId, productId: product.id } },
      });
      if (exists) continue; // never clobber stock changed since the last seed
      // Opening balances go through the ledger (an IN movement) so history matches inventory.
      await prisma.$transaction(async (tx) => {
        await tx.inventory.create({
          data: { branchId, productId: product.id, quantity, version: quantity > 0 ? 1 : 0 },
        });
        if (quantity > 0) {
          await tx.stockMovement.create({
            data: {
              branchId,
              productId: product.id,
              type: MovementType.IN,
              direction: MovementDirection.INCREASE,
              quantity,
              balanceAfter: quantity,
              inventoryVersion: 1,
              createdBy: users.worker,
              note: 'Opening balance (seed)',
            },
          });
        }
      });
      created += 1;
    }
  }

  console.log(
    `Seed complete: ${USERS.length} users, ${BRANCHES.length} branches, ${PRODUCTS.length} products, ${created} new inventory rows.`,
  );
  console.table(USERS.map(({ email, password }) => ({ email, password })));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
