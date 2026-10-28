import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { Permission } from '../common/constants/permissions';
import { paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { MovementQueryDto } from './dto/movement-query.dto';

export const MOVEMENT_INCLUDE = {
  product: { select: { id: true, sku: true, name: true, unit: true } },
  creator: { select: { id: true, name: true } },
} satisfies Prisma.StockMovementInclude;

/** Read-only access to the append-only movement ledger. There is deliberately no update/delete. */
@Injectable()
export class StockMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BranchAccessService,
  ) {}

  async list(query: MovementQueryDto) {
    const where: Prisma.StockMovementWhereInput = {
      branchId: query.branchId,
      ...(query.productId && { productId: query.productId }),
      ...(query.type && { type: query.type }),
      ...(query.referenceId && { referenceId: query.referenceId }),
      ...((query.from || query.to) && {
        createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) },
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        include: MOVEMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  /** Movements in branches the caller cannot read are reported as not found. */
  async findOne(userId: string, id: string) {
    const movement = await this.prisma.stockMovement.findUnique({
      where: { id },
      include: { ...MOVEMENT_INCLUDE, reversal: { select: { id: true, createdAt: true } } },
    });
    if (
      !movement ||
      !(await this.access.hasBranchPermission(userId, movement.branchId, Permission.MOVEMENT_READ))
    ) {
      throw AppException.notFound('Stock movement');
    }
    return movement;
  }
}
