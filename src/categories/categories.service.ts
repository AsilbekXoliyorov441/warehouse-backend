import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  list() {
    return this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!category) throw AppException.notFound('Category');
    return category;
  }

  async create(dto: CreateCategoryDto, actorId: string) {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const category = await tx.category.create({ data: dto });
        await this.audit.record(
          {
            userId: actorId,
            action: 'category.create',
            entityType: 'Category',
            entityId: category.id,
            metadata: { ...dto },
          },
          tx,
        );
        return category;
      });
    } catch (err) {
      throw this.mapDuplicate(err);
    }
  }

  async update(id: string, dto: UpdateCategoryDto, actorId: string) {
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        await this.ensureExists(tx, id);
        const category = await tx.category.update({ where: { id }, data: dto });
        await this.audit.record(
          {
            userId: actorId,
            action: 'category.update',
            entityType: 'Category',
            entityId: id,
            metadata: { ...dto },
          },
          tx,
        );
        return category;
      });
    } catch (err) {
      throw this.mapDuplicate(err);
    }
  }

  /** Categories still referenced by products cannot be deleted. */
  async remove(id: string, actorId: string): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      await this.ensureExists(tx, id);
      const inUse = await tx.product.count({ where: { categoryId: id } });
      if (inUse > 0) {
        throw AppException.conflict(ErrorCode.CATEGORY_IN_USE, 'Category is assigned to products', {
          productCount: inUse,
        });
      }
      await tx.category.delete({ where: { id } });
      await this.audit.record(
        { userId: actorId, action: 'category.delete', entityType: 'Category', entityId: id },
        tx,
      );
    });
  }

  private async ensureExists(tx: Prisma.TransactionClient, id: string): Promise<void> {
    if (!(await tx.category.findUnique({ where: { id }, select: { id: true } })))
      throw AppException.notFound('Category');
  }

  private mapDuplicate(err: unknown): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return AppException.conflict(
        ErrorCode.DUPLICATE_RESOURCE,
        'A category with this name already exists',
      );
    }
    return err;
  }
}
