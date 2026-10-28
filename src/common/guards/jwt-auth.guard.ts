import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../../auth/token.service';
import { UsersService } from '../../users/users.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app.exception';
import type { AppRequest } from '../interfaces/request-context.interface';

export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Global guard: every route requires a valid access token unless marked @Public(). The user is
 * re-loaded on each request so deactivated accounts lose access immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AppRequest>();
    const token = extractBearerToken(req.header('authorization'));
    if (!token) throw AppException.unauthorized();

    const userId = await this.tokens.verifyAccessToken(token);
    const user = await this.users.findActiveIdentity(userId);
    if (!user) throw AppException.unauthorized('Account is inactive or no longer exists');
    req.user = user;
    return true;
  }
}
