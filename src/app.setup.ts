import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createValidationPipe } from './common/pipes/validation.pipe';
import { setupSwagger } from './common/swagger/swagger.setup';
import { AppConfigService } from './config/app-config.service';
import { ConfiguredSocketIoAdapter } from './realtime/socket-io.adapter';

export const API_PREFIX = 'api';

/**
 * Applies HTTP-level configuration. Shared by main.ts and the e2e tests so that tests exercise
 * exactly the production middleware stack.
 */
export function configureApp(app: INestApplication, options: { swagger?: boolean } = {}): void {
  const config = app.get(AppConfigService);
  const express = app as NestExpressApplication;

  express.set('trust proxy', config.get('TRUST_PROXY'));
  express.disable('x-powered-by');
  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    // `true` reflects the request origin: with credentials the browser rejects a literal `*`.
    origin: config.allowAnyOrigin ? true : config.allowedOrigins,
    credentials: true, // required so the browser sends the HttpOnly refresh cookie
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalPipes(createValidationPipe());
  app.useWebSocketAdapter(
    new ConfiguredSocketIoAdapter(app, (origin) => config.isOriginAllowed(origin)),
  );
  app.enableShutdownHooks();

  if (options.swagger ?? config.swaggerEnabled) setupSwagger(app, API_PREFIX);
}
