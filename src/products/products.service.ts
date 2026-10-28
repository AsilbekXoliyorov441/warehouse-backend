import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { paginate } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { CreateProductDto, ProductQueryDto, UpdateProductDto } from './dto/product.dto';

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  async create(dto: CreateProductDto, actorId: string) {
    return this.prisma.runInTransaction(async (tx) => {
      if (dto.categoryId) await this.ensureCategory(tx, dto.categoryId);
      try {
        const product = await tx.product.create({
          data: { ...dto, price: new Prisma.Decimal(dto.price) },
          include: PRODUCT_INCLUDE,
        });
        await this.audit.record(
          {
            userId: actorId,
            action: 'product.create',
            entityType: 'Product',
            entityId: product.id,
            metadata: { ...dto },
          },
          tx,
        );
        return product;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw AppException.conflict(
            ErrorCode.DUPLICATE_SKU,
            'A product with this SKU already exists',
          );
        }
        throw err;
      }
    });
  }

  async list(query: ProductQueryDto) {
    const where: Prisma.ProductWhereInput = {
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.categoryId && { categoryId: query.categoryId }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { sku: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });
    if (!product) throw AppException.notFound('Product');
    return product;
  }

  async update(id: string, dto: UpdateProductDto, actorId: string) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) throw AppException.notFound('Product');
      if (dto.categoryId) await this.ensureCategory(tx, dto.categoryId);
      const product = await tx.product.update({
        where: { id },
        data: { ...dto, ...(dto.price !== undefined && { price: new Prisma.Decimal(dto.price) }) },
        include: PRODUCT_INCLUDE,
      });
      await this.audit.record(
        {
          userId: actorId,
          action: 'product.update',
          entityType: 'Product',
          entityId: id,
          metadata: {
            changes: dto,
            previous: {
              name: before.name,
              price: before.price.toFixed(2),
              minStock: before.minStock,
            },
          },
        },
        tx,
      );
      return product;
    });
  }

  /** Soft activation/deactivation. Products are never physically deleted (movements reference them). */
  async setStatus(id: string, isActive: boolean, actorId: string) {
    return this.prisma.runInTransaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id }, select: { isActive: true } });
      if (!before) throw AppException.notFound('Product');
      const product = await tx.product.update({
        where: { id },
        data: { isActive },
        include: PRODUCT_INCLUDE,
      });
      await this.audit.record(
        {
          userId: actorId,
          action: isActive ? 'product.activate' : 'product.deactivate',
          entityType: 'Product',
          entityId: id,
          metadata: { from: before.isActive, to: isActive },
        },
        tx,
      );
      return product;
    });
  }

  private async ensureCategory(tx: Tx, categoryId: string): Promise<void> {
    const exists = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!exists)
      throw AppException.badRequest(ErrorCode.VALIDATION_ERROR, 'Category does not exist');
  }
}
