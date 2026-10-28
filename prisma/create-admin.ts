/**
 * Production bootstrap: creates (or promotes) the first administrator. Safe in production and
 * idempotent: re-running with the same email keeps the user and only ensures the ADMIN membership.
 * An existing user's password is changed only when ADMIN_RESET_PASSWORD=true.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' ADMIN_NAME='Jane Admin' \
 *   ADMIN_BRANCH_NAME='Head Office' ADMIN_BRANCH_ADDRESS='1 Main St' node dist/seed/create-admin.js
 */
import { BranchRole, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

// Keep in sync with src/users/dto/create-user.dto.ts and src/users/users.service.ts.
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,128}$/;
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const email = required('ADMIN_EMAIL').toLowerCase();
const password = required('ADMIN_PASSWORD');
const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
const branchName = process.env.ADMIN_BRANCH_NAME?.trim() || 'Head Office';
const branchAddress = process.env.ADMIN_BRANCH_ADDRESS?.trim() || '-';
const resetPassword = ['1', 'true', 'yes'].includes(
  (process.env.ADMIN_RESET_PASSWORD ?? '').toLowerCase(),
);

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error('ADMIN_EMAIL is not a valid email address');
  process.exit(1);
}
if (!PASSWORD_RULE.test(password)) {
  console.error('ADMIN_PASSWORD must be 10-128 characters with at least one letter and one digit');
  process.exit(1);
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email }, select: { id: true } });
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: { isActive: true, ...(resetPassword ? { passwordHash } : {}) },
        })
      : await tx.user.create({ data: { name, email, passwordHash } });

    if (existing && resetPassword) {
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const branch = await tx.branch.upsert({
      where: { name: branchName },
      create: { name: branchName, address: branchAddress },
      update: { isActive: true },
    });

    await tx.branchMembership.upsert({
      where: { userId_branchId: { userId: user.id, branchId: branch.id } },
      create: { userId: user.id, branchId: branch.id, role: BranchRole.ADMIN },
      update: { role: BranchRole.ADMIN },
    });

    await tx.auditLog.create({
      data: {
        userId: null,
        action: 'admin.bootstrap',
        entityType: 'User',
        entityId: user.id,
        metadata: { email, branchId: branch.id, created: !existing, passwordReset: resetPassword },
      },
    });

    console.log(
      `${existing ? 'Updated' : 'Created'} admin ${email} with ADMIN role in branch "${branch.name}"` +
        (existing && !resetPassword ? ' (password unchanged)' : ''),
    );
  });
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
