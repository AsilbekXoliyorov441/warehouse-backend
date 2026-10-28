import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { paginate, Paginated } from '../common/dto/pagination.dto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthenticatedUser } from '../common/interfaces/request-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { accessChangedEvent } from '../realtime/events/access-changed';
import { EventPublisher } from '../realtime/events/event-publisher';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserQueryDto } from './dto/user-query.dto';

/** Columns that are safe to return to clients. passwordHash is never selected. */
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{ select: typeof PUBLIC_USER_SELECT }>;

export const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // OWASP minimum recommendation (19 MiB)
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly events: EventPublisher,
  ) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async findActiveIdentity(id: string): Promise<AuthenticatedUser | null> {
    return this.prisma.user.findFirst({
      where: { id, isActive: true },
      select: { id: true, email: true, name: true },
    });
  }

  /** Creates a user; maps the unique-email violation to EMAIL_ALREADY_REGISTERED. */
  async create(dto: CreateUserDto, actorId: string | null): Promise<PublicUser> {
    const passwordHash = await this.hashPassword(dto.password);
    try {
      return await this.prisma.runInTransaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: dto.name, email: UsersService.normalizeEmail(dto.email), passwordHash },
          select: PUBLIC_USER_SELECT,
        });
        await this.audit.record(
          {
            userId: actorId ?? user.id,
            action: 'user.create',
            entityType: 'User',
            entityId: user.id,
            metadata: { email: user.email },
          },
          tx,
        );
        return user;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw AppException.conflict(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'Email is already registered',
        );
      }
      throw err;
    }
  }

  async list(query: UserQueryDto): Promise<Paginated<PublicUser>> {
    const where: Prisma.UserWhereInput = {
      ...(query.isActive !== undefined && { isActive: query.isActive }),
      ...(query.q && {
        OR: [
          { name: { contains: query.q, mode: 'insensitive' } },
          { email: { contains: query.q, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginate(data, total, query);
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...PUBLIC_USER_SELECT,
        memberships: {
          select: { role: true, branch: { select: { id: true, name: true, isActive: true } } },
        },
      },
    });
    if (!user) throw AppException.notFound('User');
    return user;
  }

  /** Administrative password reset. Ends every session of the target user. */
  async resetPassword(id: string, password: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'Use POST /auth/change-password to change your own password',
      );
    }
    const passwordHash = await this.hashPassword(password);
    await this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw AppException.notFound('User');
      await tx.user.update({ where: { id }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        { userId: actorId, action: 'user.password_reset', entityType: 'User', entityId: id },
        tx,
      );
    });
  }

  async update(id: string, dto: UpdateUserDto, actorId: string): Promise<PublicUser> {
    if (dto.isActive === false && id === actorId) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'You cannot deactivate your own account',
      );
    }
    return this.prisma.runInTransaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw AppException.notFound('User');
      const user = await tx.user.update({ where: { id }, data: dto, select: PUBLIC_USER_SELECT });
      if (dto.isActive === false) {
        // Deactivation ends every session immediately.
        await tx.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await this.events.publish(tx, [accessChangedEvent(id)]);
      }
      await this.audit.record(
        {
          userId: actorId,
          action: 'user.update',
          entityType: 'User',
          entityId: id,
          metadata: { changes: dto },
        },
        tx,
      );
      return user;
    });
  }
}
