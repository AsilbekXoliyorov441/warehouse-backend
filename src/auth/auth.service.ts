import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { BranchAccessService } from '../branch-memberships/branch-access.service';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ARGON2_OPTIONS, UsersService } from '../users/users.service';
import {
  AuthTokenResponse,
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { TokenService } from './token.service';

export interface IssuedSession {
  response: AuthTokenResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Verified against when the email is unknown, so response time does not reveal accounts. */
  private readonly dummyHash = argon2.hash('timing-equaliser-not-a-password', ARGON2_OPTIONS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly tokens: TokenService,
    private readonly access: BranchAccessService,
    private readonly audit: AuditLogsService,
    private readonly config: AppConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<IssuedSession> {
    if (!this.config.get('ALLOW_REGISTRATION')) {
      throw new AppException(
        HttpStatus.FORBIDDEN,
        ErrorCode.REGISTRATION_DISABLED,
        'Self-registration is disabled',
      );
    }
    const user = await this.users.create(dto, null);
    return this.issueSession(user, randomUUID());
  }

  async login(dto: LoginDto): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { email: UsersService.normalizeEmail(dto.email) },
      select: { id: true, name: true, email: true, isActive: true, passwordHash: true },
    });
    const valid = user
      ? await argon2.verify(user.passwordHash, dto.password)
      : await argon2.verify(await this.dummyHash, dto.password).then(() => false);
    if (!user || !valid || !user.isActive) {
      throw AppException.unauthorized('Invalid email or password', ErrorCode.INVALID_CREDENTIALS);
    }
    await this.audit.record({
      userId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
    });
    return this.issueSession(user, randomUUID());
  }

  /**
   * Rotates a refresh token. Each token is single-use: presenting an already-rotated token is
   * treated as theft and revokes the entire token family (every session descended from that login).
   */
  async refresh(rawToken: string | undefined): Promise<IssuedSession> {
    const parsed = this.tokens.parseRefreshToken(rawToken);
    if (!parsed) throw AppException.unauthorized('Missing or malformed refresh token');

    const stored = await this.prisma.refreshToken.findUnique({
      where: { id: parsed.id },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    });
    if (!stored || !this.tokens.verifyRefreshSecret(parsed.secret, stored.tokenHash)) {
      throw AppException.unauthorized('Invalid refresh token');
    }
    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId, stored.userId, 'reuse_detected');
      throw AppException.unauthorized(
        'Refresh token reuse detected; please sign in again',
        ErrorCode.REFRESH_TOKEN_REUSED,
      );
    }
    if (stored.expiresAt <= new Date()) {
      throw AppException.unauthorized('Refresh token expired', ErrorCode.TOKEN_EXPIRED);
    }
    if (!stored.user.isActive) throw AppException.unauthorized('Account is inactive');

    // Conditional revoke: of two concurrent refreshes with the same token only one can win.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(stored.familyId, stored.userId, 'concurrent_reuse');
      throw AppException.unauthorized(
        'Refresh token reuse detected; please sign in again',
        ErrorCode.REFRESH_TOKEN_REUSED,
      );
    }
    return this.issueSession(stored.user, stored.familyId);
  }

  /** Revokes the session family of the presented token. Always succeeds from the client's view. */
  async logout(rawToken: string | undefined): Promise<void> {
    const parsed = this.tokens.parseRefreshToken(rawToken);
    if (!parsed) return;
    const stored = await this.prisma.refreshToken.findUnique({ where: { id: parsed.id } });
    if (!stored || !this.tokens.verifyRefreshSecret(parsed.secret, stored.tokenHash)) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      userId: stored.userId,
      action: 'auth.logout',
      entityType: 'User',
      entityId: stored.userId,
    });
  }

  /**
   * Changes the caller's password after re-verifying the current one. Every existing session
   * (including other devices) is revoked and a fresh session is issued for this client.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, passwordHash: true },
    });
    if (!user) throw AppException.unauthorized('Account is inactive or no longer exists');
    if (!(await argon2.verify(user.passwordHash, dto.currentPassword))) {
      throw AppException.badRequest(
        ErrorCode.INVALID_CURRENT_PASSWORD,
        'Current password is incorrect',
      );
    }
    if (dto.newPassword === dto.currentPassword) {
      throw AppException.badRequest(
        ErrorCode.VALIDATION_ERROR,
        'New password must differ from the current password',
      );
    }
    const passwordHash = await this.users.hashPassword(dto.newPassword);
    await this.prisma.runInTransaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        { userId, action: 'auth.password_change', entityType: 'User', entityId: userId },
        tx,
      );
    });
    return this.issueSession(user, randomUUID());
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.runInTransaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { name: dto.name } });
      await this.audit.record(
        {
          userId,
          action: 'user.update_profile',
          entityType: 'User',
          entityId: userId,
          metadata: { changes: dto },
        },
        tx,
      );
    });
    return this.me(userId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        createdAt: true,
        memberships: {
          where: { branch: { isActive: true } },
          select: { role: true, branch: { select: { id: true, name: true, address: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!user) throw AppException.notFound('User');
    return {
      ...user,
      memberships: user.memberships.map((m) => ({
        branchId: m.branch.id,
        branchName: m.branch.name,
        branchAddress: m.branch.address,
        role: m.role,
        permissions: this.access.permissionsFor(m.role),
      })),
    };
  }

  private async issueSession(
    user: { id: string; name: string; email: string },
    familyId: string,
  ): Promise<IssuedSession> {
    const secret = this.tokens.generateRefreshSecret();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.get('REFRESH_TOKEN_TTL_DAYS') * 86_400_000,
    );
    const row = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: this.tokens.hashRefreshSecret(secret),
        expiresAt: refreshExpiresAt,
      },
      select: { id: true },
    });
    return {
      refreshToken: this.tokens.formatRefreshToken(row.id, secret),
      refreshExpiresAt,
      response: {
        accessToken: await this.tokens.signAccessToken(user.id),
        tokenType: 'Bearer',
        expiresIn: this.tokens.accessTokenTtlSeconds,
        user: { id: user.id, name: user.name, email: user.email },
      },
    };
  }

  private async revokeFamily(familyId: string, userId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.warn({ msg: 'Refresh token family revoked', userId, familyId, reason });
    await this.audit.record({
      userId,
      action: 'auth.refresh_reuse',
      entityType: 'User',
      entityId: userId,
      metadata: { reason, familyId },
    });
  }
}
