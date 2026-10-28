import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from './env.validation';

/** Typed accessor over validated environment variables. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get allowedOrigins(): string[] {
    return this.get('FRONTEND_ORIGIN')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  /** FRONTEND_ORIGIN=* lets any website call the API (CORS, Socket.IO and the CSRF check). */
  get allowAnyOrigin(): boolean {
    return this.allowedOrigins.includes('*');
  }

  isOriginAllowed(origin: string): boolean {
    return this.allowAnyOrigin || this.allowedOrigins.includes(origin);
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED') ?? !this.isProduction;
  }
}
