import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { Permission } from '../constants/permissions';

export const GLOBAL_PERMISSION_KEY = 'globalPermission';
export const BRANCH_PERMISSION_KEY = 'branchPermission';

export interface BranchPermissionRequirement {
  permission: Permission;
  /** Where the guard reads the branch id from. */
  source: 'params' | 'query' | 'body';
  key: string;
}

/** Requires the permission in at least one active branch (organisation-wide actions). */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(GLOBAL_PERMISSION_KEY, permission),
    // Read by the OpenAPI post-processor to document the rule on each operation.
    ApiExtension('x-permission', { permission, scope: 'organisation' }),
  );

/**
 * Requires the permission in the branch identified by the request. The guard validates the id
 * format and the caller's membership before the handler runs; services re-check whenever the
 * branch is derived from stored data instead of the request.
 */
export const RequireBranchPermission = (
  permission: Permission,
  source: BranchPermissionRequirement['source'] = 'query',
  key = 'branchId',
): MethodDecorator =>
  applyDecorators(
    SetMetadata(BRANCH_PERMISSION_KEY, {
      permission,
      source,
      key,
    } satisfies BranchPermissionRequirement),
    ApiExtension('x-permission', { permission, scope: 'branch', source, key }),
  );
