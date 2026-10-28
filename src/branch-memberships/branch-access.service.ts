import { HttpStatus, Injectable } from '@nestjs/common';
import { BranchRole } from '@prisma/client';
import {
  Permission,
  PermissionPolicy,
  permissionsForRole,
  roleHasPermission,
} from '../common/constants/permissions';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export interface BranchAccess {
  branchId: string;
  role: BranchRole;
}

/**
 * Single source of truth for branch authorization. Used by HTTP guards, services and the
 * Socket.IO gateway so every entry point applies identical rules.
 */
@Injectable()
export class BranchAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  get policy(): PermissionPolicy {
    return { managersCanManageProducts: this.config.get('MANAGERS_CAN_MANAGE_PRODUCTS') };
  }

  can(role: BranchRole, permission: Permission): boolean {
    return roleHasPermission(role, permission, this.policy);
  }

  permissionsFor(role: BranchRole): Permission[] {
    return permissionsForRole(role, this.policy);
  }

  /**
   * Throws unless the user is a member of an active branch with a role granting `permission`.
   * Missing memberships and missing branches both yield FORBIDDEN so branch ids cannot be probed.
   */
  async assertBranchPermission(
    userId: string,
    branchId: string,
    permission: Permission,
  ): Promise<BranchAccess> {
    const membership = await this.prisma.branchMembership.findUnique({
      where: { userId_branchId: { userId, branchId } },
      select: { role: true, branch: { select: { isActive: true } } },
    });
    if (!membership) throw AppException.forbidden('You do not have access to this branch');
    if (!membership.branch.isActive) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_BRANCH,
        'Branch is inactive',
      );
    }
    if (!this.can(membership.role, permission)) {
      throw AppException.forbidden(`Your role in this branch does not allow ${permission}`);
    }
    return { branchId, role: membership.role };
  }

  async hasBranchPermission(
    userId: string,
    branchId: string,
    permission: Permission,
  ): Promise<boolean> {
    try {
      await this.assertBranchPermission(userId, branchId, permission);
      return true;
    } catch (err) {
      if (err instanceof AppException) return false;
      throw err;
    }
  }

  /** Active branches where the user's role grants `permission`. */
  async branchIdsWithPermission(userId: string, permission: Permission): Promise<string[]> {
    const memberships = await this.prisma.branchMembership.findMany({
      where: { userId, branch: { isActive: true } },
      select: { branchId: true, role: true },
    });
    return memberships.filter((m) => this.can(m.role, permission)).map((m) => m.branchId);
  }

  async hasGlobalPermission(userId: string, permission: Permission): Promise<boolean> {
    return (await this.branchIdsWithPermission(userId, permission)).length > 0;
  }

  async assertGlobalPermission(userId: string, permission: Permission): Promise<void> {
    if (!(await this.hasGlobalPermission(userId, permission))) {
      throw AppException.forbidden(`This action requires ${permission}`);
    }
  }
}
