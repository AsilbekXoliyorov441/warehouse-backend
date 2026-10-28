import { BranchRole } from '@prisma/client';

/**
 * Everything a user can do is expressed as a permission granted by their role in a branch.
 *
 * - Branch-scoped permissions are checked against the user's role in *that* branch.
 * - Organisation-wide permissions (users, branches, catalog, audit) are granted when the user
 *   holds a qualifying role in at least one active branch.
 */
export enum Permission {
  // Organisation-wide
  USER_MANAGE = 'USER_MANAGE',
  BRANCH_MANAGE = 'BRANCH_MANAGE',
  PRODUCT_MANAGE = 'PRODUCT_MANAGE',
  AUDIT_READ = 'AUDIT_READ',
  CATALOG_READ = 'CATALOG_READ',
  // Branch-scoped
  INVENTORY_READ = 'INVENTORY_READ',
  STOCK_RECEIVE = 'STOCK_RECEIVE',
  SALE_CREATE = 'SALE_CREATE',
  STOCK_ADJUST = 'STOCK_ADJUST',
  STOCK_REVERSE = 'STOCK_REVERSE',
  MOVEMENT_READ = 'MOVEMENT_READ',
  TRANSFER_READ = 'TRANSFER_READ',
  TRANSFER_CREATE = 'TRANSFER_CREATE',
  TRANSFER_APPROVE = 'TRANSFER_APPROVE',
  REPORT_READ = 'REPORT_READ',
  MEMBERS_READ = 'MEMBERS_READ',
}

export const ROLE_PERMISSIONS: Readonly<Record<BranchRole, readonly Permission[]>> = {
  ADMIN: Object.values(Permission),
  MANAGER: [
    Permission.CATALOG_READ,
    Permission.INVENTORY_READ,
    Permission.STOCK_REVERSE,
    Permission.MOVEMENT_READ,
    Permission.TRANSFER_READ,
    Permission.TRANSFER_CREATE,
    Permission.TRANSFER_APPROVE,
    Permission.REPORT_READ,
    Permission.MEMBERS_READ,
  ],
  WAREHOUSE_WORKER: [
    Permission.CATALOG_READ,
    Permission.INVENTORY_READ,
    Permission.STOCK_RECEIVE,
    Permission.MOVEMENT_READ,
    Permission.TRANSFER_READ,
    Permission.TRANSFER_CREATE,
  ],
  SELLER: [
    Permission.CATALOG_READ,
    Permission.INVENTORY_READ,
    Permission.SALE_CREATE,
    Permission.MOVEMENT_READ,
  ],
};

export interface PermissionPolicy {
  /** When true, MANAGER also receives PRODUCT_MANAGE. */
  managersCanManageProducts: boolean;
}

export function roleHasPermission(
  role: BranchRole,
  permission: Permission,
  policy: PermissionPolicy,
): boolean {
  if (ROLE_PERMISSIONS[role].includes(permission)) return true;
  return (
    role === BranchRole.MANAGER &&
    permission === Permission.PRODUCT_MANAGE &&
    policy.managersCanManageProducts
  );
}

export function permissionsForRole(role: BranchRole, policy: PermissionPolicy): Permission[] {
  return Object.values(Permission).filter((p) => roleHasPermission(role, p, policy));
}
