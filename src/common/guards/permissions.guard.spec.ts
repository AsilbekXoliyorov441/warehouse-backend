import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BranchRole } from '@prisma/client';
import { BranchAccessService } from '../../branch-memberships/branch-access.service';
import type { AppConfigService } from '../../config/app-config.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { Permission } from '../constants/permissions';
import { RequireBranchPermission, RequirePermission } from '../decorators/permissions.decorator';
import { ErrorCode } from '../errors/error-codes';
import { PermissionsGuard } from './permissions.guard';

const BRANCH = '3f1c4a5e-8b7d-4c2a-9e1f-0a1b2c3d4e5f';

class Handlers {
  @RequireBranchPermission(Permission.SALE_CREATE, 'body')
  sale() {}
  @RequirePermission(Permission.USER_MANAGE)
  users() {}
  open() {}
}

function contextFor(handler: keyof Handlers, req: object): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard with BranchAccessService', () => {
  let memberships: { branchId: string; role: BranchRole; active?: boolean }[];
  let guard: PermissionsGuard;

  beforeEach(() => {
    memberships = [];
    const prisma = {
      branchMembership: {
        findUnique: jest.fn(({ where }: { where: { userId_branchId: { branchId: string } } }) => {
          const m = memberships.find((x) => x.branchId === where.userId_branchId.branchId);
          return Promise.resolve(
            m ? { role: m.role, branch: { isActive: m.active ?? true } } : null,
          );
        }),
        findMany: jest.fn(() => Promise.resolve(memberships.filter((m) => m.active ?? true))),
      },
    } as unknown as PrismaService;
    const config = { get: () => false } as unknown as AppConfigService;
    guard = new PermissionsGuard(new Reflector(), new BranchAccessService(prisma, config));
  });

  const user = { id: 'u1', email: 'e', name: 'n' };

  it('allows routes without permission metadata', async () => {
    await expect(guard.canActivate(contextFor('open', { user }))).resolves.toBe(true);
  });

  it('allows a seller of the branch to create a sale', async () => {
    memberships.push({ branchId: BRANCH, role: BranchRole.SELLER });
    await expect(
      guard.canActivate(contextFor('sale', { user, body: { branchId: BRANCH } })),
    ).resolves.toBe(true);
  });

  it('forbids a warehouse worker from creating a sale', async () => {
    memberships.push({ branchId: BRANCH, role: BranchRole.WAREHOUSE_WORKER });
    await expect(
      guard.canActivate(contextFor('sale', { user, body: { branchId: BRANCH } })),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('forbids non-members regardless of the role they claim', async () => {
    await expect(
      guard.canActivate(contextFor('sale', { user, body: { branchId: BRANCH, role: 'ADMIN' } })),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('rejects malformed branch ids before querying', async () => {
    await expect(
      guard.canActivate(contextFor('sale', { user, body: { branchId: "1' OR 1=1" } })),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('rejects inactive branches with INVALID_BRANCH', async () => {
    memberships.push({ branchId: BRANCH, role: BranchRole.ADMIN, active: false });
    await expect(
      guard.canActivate(contextFor('sale', { user, body: { branchId: BRANCH } })),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_BRANCH });
  });

  it('grants organisation-wide permissions to ADMIN of any active branch only', async () => {
    memberships.push({ branchId: BRANCH, role: BranchRole.MANAGER });
    await expect(guard.canActivate(contextFor('users', { user }))).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    memberships.push({ branchId: 'other', role: BranchRole.ADMIN });
    await expect(guard.canActivate(contextFor('users', { user }))).resolves.toBe(true);
  });
});
