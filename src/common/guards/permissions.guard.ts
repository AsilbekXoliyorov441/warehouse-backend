import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BranchAccessService } from '../../branch-memberships/branch-access.service';
import { Permission } from '../constants/permissions';
import {
  BRANCH_PERMISSION_KEY,
  BranchPermissionRequirement,
  GLOBAL_PERMISSION_KEY,
} from '../decorators/permissions.decorator';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AppRequest } from '../interfaces/request-context.interface';
import { isUuid } from '../utils/uuid';

/** Enforces @RequirePermission and @RequireBranchPermission. Runs after JwtAuthGuard. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: BranchAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const globalPermission = this.reflector.getAllAndOverride<Permission | undefined>(
      GLOBAL_PERMISSION_KEY,
      targets,
    );
    const branchRequirement = this.reflector.getAllAndOverride<
      BranchPermissionRequirement | undefined
    >(BRANCH_PERMISSION_KEY, targets);
    if (!globalPermission && !branchRequirement) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!req.user) throw AppException.unauthorized();

    if (globalPermission) {
      await this.access.assertGlobalPermission(req.user.id, globalPermission);
    }
    if (branchRequirement) {
      const container = req[branchRequirement.source] as Record<string, unknown> | undefined;
      const branchId = container?.[branchRequirement.key];
      if (!isUuid(branchId)) {
        throw AppException.badRequest(ErrorCode.VALIDATION_ERROR, 'Request validation failed', [
          { field: branchRequirement.key, errors: [`${branchRequirement.key} must be a UUID`] },
        ]);
      }
      await this.access.assertBranchPermission(req.user.id, branchId, branchRequirement.permission);
    }
    return true;
  }
}
