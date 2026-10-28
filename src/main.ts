process.setSourceMapsEnabled(true); // readable stack traces from compiled dist/
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';

async function bootstrap(): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    // Structured JSON logs in production; readable logs locally.
    logger: new ConsoleLogger({ json: isProduction, colors: !isProduction }),
  });
  configureApp(app);

  const port = app.get(AppConfigService).get('PORT');
  await app.listen(port);
  Logger.log(`StockPulse API listening on http://localhost:${port}/api`, 'Bootstrap');
}

void bootstrap();
