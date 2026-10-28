import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AppConfigService } from '../config/app-config.service';

export const JWT_ISSUER = 'stockpulse';
export const JWT_AUDIENCE = 'stockpulse-api';

interface AccessTokenPayload {
  sub: string;
  typ: 'access';
  exp?: number;
}

export interface AccessTokenClaims {
  userId: string;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
}

export interface ParsedRefreshToken {
  id: string;
  secret: string;
}

/** Issues/verifies access JWTs and generates/hashes opaque refresh tokens. */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async signAccessToken(userId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: userId, typ: 'access' };
    return this.jwt.signAsync(payload);
  }

  /** Returns the user id, or throws UNAUTHORIZED / TOKEN_EXPIRED. */
  async verifyAccessToken(token: string): Promise<string> {
    return (await this.verifyAccessTokenClaims(token)).userId;
  }

  async verifyAccessTokenClaims(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
      if (
        payload.typ !== 'access' ||
        typeof payload.sub !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        throw AppException.unauthorized('Invalid access token');
      }
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    } catch (err) {
      if (err instanceof AppException) throw err;
      if (err instanceof Error && err.name === 'TokenExpiredError') {
        throw AppException.unauthorized('Access token expired', ErrorCode.TOKEN_EXPIRED);
      }
      throw AppException.unauthorized('Invalid access token');
    }
  }

  /** Access-token lifetime in seconds, derived from JWT_ACCESS_TTL. */
  get accessTokenTtlSeconds(): number {
    const ttl = this.config.get('JWT_ACCESS_TTL');
    const value = Number.parseInt(ttl, 10);
    const unit = ttl.slice(-1);
    return value * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  }

  generateRefreshSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshSecret(secret: string): string {
    return createHmac('sha256', this.config.get('REFRESH_TOKEN_SECRET'))
      .update(secret)
      .digest('hex');
  }

  verifyRefreshSecret(secret: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hashRefreshSecret(secret), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Refresh tokens are "<row id>.<secret>"; the id allows O(1) lookup, the secret is verified by hash. */
  formatRefreshToken(id: string, secret: string): string {
    return `${id}.${secret}`;
  }

  parseRefreshToken(raw: string | undefined): ParsedRefreshToken | undefined {
    if (!raw || raw.length > 200) return undefined;
    const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/i.exec(raw);
    return match ? { id: match[1], secret: match[2] } : undefined;
  }
}
