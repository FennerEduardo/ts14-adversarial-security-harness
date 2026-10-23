import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startTelemetry, stopTelemetry } from './runtime/otel';

async function bootstrap(): Promise<void> {
  // OTLP export when OTEL_EXPORTER_OTLP_ENDPOINT is set (runtime/otel.ts).
  startTelemetry();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  process.once('SIGTERM', () => void stopTelemetry());
  await app.listen(Number(process.env.PORT) || 3000);
}

void bootstrap();
