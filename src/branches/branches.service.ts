import { Injectable } from '@nestjs/common';
import { BranchRole, Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { Permission } from '../common/constants/permissions';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
    private readonly audit: AuditLogsService,
  ) {}

  /** The creating admin becomes ADMIN of the new branch so they can operate it immediately. */
  async create(dto: CreateBranchDto, actorId: string) {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const branch = await tx.branch.create({ data: dto });
        await tx.branchMembership.create({
          data: { branchId: branch.id, userId: actorId, role: BranchRole.ADMIN },
        });
        await this.audit.record(
          {
            userId: actorId,
            action: 'branch.create',
            entityType: 'Branch',
            entityId: branch.id,
            metadata: { ...dto },
          },
          tx,
        );
        return branch;
      });
    } catch (err) {
      throw this.mapDuplicate(err);
    }
  }

  /** Branch managers (BRANCH_MANAGE) see every branch; everyone else sees their own branches. */
  async list(userId: string) {
    const canManage = await this.access.hasGlobalPermission(userId, Permission.BRANCH_MANAGE);
    const branches = await this.prisma.branch.findMany({
      where: canManage ? {} : { isActive: true, memberships: { some: { userId } } },
      include: { memberships: { where: { userId }, select: { role: true } } },
      orderBy: { name: 'asc' },
    });
    return branches.map(({ memberships, ...branch }) => ({
      ...branch,
      myRole: memberships[0]?.role ?? null,
    }));
  }

  async findOne(id: string, userId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: { memberships: { where: { userId }, select: { role: true } } },
    });
    const canManage = await this.access.hasGlobalPermission(userId, Permission.BRANCH_MANAGE);
    if (!branch || (!canManage && branch.memberships.length === 0)) {
      // Non-members get the same answer whether or not the branch exists.
      throw canManage
        ? AppException.notFound('Branch')
        : AppException.forbidden('You do not have access to this branch');
    }
    const { memberships, ...rest } = branch;
    return { ...rest, myRole: memberships[0]?.role ?? null };
  }

  async update(id: string, dto: UpdateBranchDto, actorId: string) {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const existing = await tx.branch.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw AppException.notFound('Branch');
        const branch = await tx.branch.update({ where: { id }, data: dto });
        await this.audit.record(
          {
            userId: actorId,
            action: 'branch.update',
            entityType: 'Branch',
            entityId: id,
            metadata: { changes: dto },
          },
          tx,
        );
        return branch;
      });
    } catch (err) {
      throw this.mapDuplicate(err);
    }
  }

  private mapDuplicate(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return AppException.conflict(
        ErrorCode.DUPLICATE_RESOURCE,
        'A branch with this name already exists',
      );
    }
    return err;
  }
}
