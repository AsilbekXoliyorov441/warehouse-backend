import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { paginate, Paginated } from '../common/dto/pagination.dto';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

export interface AuditEntry {
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|hash|authorization|cookie/i;

/** Removes anything that looks like a credential before it is persisted. */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitizeMetadata(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SENSITIVE_KEY.test(k))
        .map(([k, v]) => [k, sanitizeMetadata(v, depth + 1)]),
    );
  }
  return value;
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass the transaction client so the audit row commits or rolls back with the change. */
  async record(entry: AuditEntry, tx: Tx = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: sanitizeMetadata(entry.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });
  }

  async list(query: AuditLogQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.userId && { userId: query.userId }),
      ...(query.action && { action: query.action }),
      ...(query.entityType && { entityType: query.entityType }),
      ...(query.entityId && { entityId: query.entityId }),
      ...((query.from || query.to) && {
        createdAt: { ...(query.from && { gte: query.from }), ...(query.to && { lte: query.to }) },
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginate(data, total, query);
  }
}
