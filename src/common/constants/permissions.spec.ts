import { BranchRole } from '@prisma/client';
import { Permission, permissionsForRole, roleHasPermission } from './permissions';

const strict = { managersCanManageProducts: false };
const lenient = { managersCanManageProducts: true };

describe('role permissions', () => {
  it('grants ADMIN every permission', () => {
    for (const p of Object.values(Permission))
      expect(roleHasPermission(BranchRole.ADMIN, p, strict)).toBe(true);
  });

  it.each([
    [BranchRole.SELLER, Permission.SALE_CREATE, true],
    [BranchRole.SELLER, Permission.STOCK_RECEIVE, false],
    [BranchRole.SELLER, Permission.TRANSFER_CREATE, false],
    [BranchRole.SELLER, Permission.STOCK_ADJUST, false],
    [BranchRole.WAREHOUSE_WORKER, Permission.STOCK_RECEIVE, true],
    [BranchRole.WAREHOUSE_WORKER, Permission.TRANSFER_CREATE, true],
    [BranchRole.WAREHOUSE_WORKER, Permission.TRANSFER_APPROVE, false],
    [BranchRole.WAREHOUSE_WORKER, Permission.SALE_CREATE, false],
    [BranchRole.MANAGER, Permission.REPORT_READ, true],
    [BranchRole.MANAGER, Permission.TRANSFER_APPROVE, true],
    [BranchRole.MANAGER, Permission.STOCK_ADJUST, false],
    [BranchRole.MANAGER, Permission.USER_MANAGE, false],
    [BranchRole.MANAGER, Permission.AUDIT_READ, false],
  ])('%s has %s = %s', (role, permission, expected) => {
    expect(roleHasPermission(role, permission, strict)).toBe(expected);
  });

  it('every role can read inventory and movements of its branch', () => {
    for (const role of Object.values(BranchRole)) {
      expect(roleHasPermission(role, Permission.INVENTORY_READ, strict)).toBe(true);
      expect(roleHasPermission(role, Permission.MOVEMENT_READ, strict)).toBe(true);
    }
  });

  it('grants MANAGER product management only when the policy allows it', () => {
    expect(roleHasPermission(BranchRole.MANAGER, Permission.PRODUCT_MANAGE, strict)).toBe(false);
    expect(roleHasPermission(BranchRole.MANAGER, Permission.PRODUCT_MANAGE, lenient)).toBe(true);
    expect(roleHasPermission(BranchRole.SELLER, Permission.PRODUCT_MANAGE, lenient)).toBe(false);
    expect(permissionsForRole(BranchRole.MANAGER, lenient)).toContain(Permission.PRODUCT_MANAGE);
  });
});
