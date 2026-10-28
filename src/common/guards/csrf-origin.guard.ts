import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AppRequest } from '../interfaces/request-context.interface';

/**
 * CSRF defence for cookie-authenticated endpoints (refresh/logout). Browsers always send an
 * Origin header on cross-origin POSTs; if present it must be on the allowlist. Requests without
 * Origin (curl, server-to-server) carry no ambient browser credentials risk and are allowed.
 * This complements the SameSite=Strict refresh cookie.
 */
@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const origin = req.header('origin');
    if (origin && !this.config.allowedOrigins.includes(origin)) {
      throw new AppException(403, ErrorCode.CSRF_ORIGIN_REJECTED, 'Request origin is not allowed');
    }
    if (!origin && req.header('sec-fetch-site') === 'cross-site') {
      throw new AppException(403, ErrorCode.CSRF_ORIGIN_REJECTED, 'Cross-site request rejected');
    }
    return true;
  }
}
