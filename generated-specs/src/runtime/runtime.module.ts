import { Controller, Get, Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DEFAULT_TOPOLOGY, brokerConfigured, connectBroker, type Broker } from './broker';
import { OutboxRelay } from './outbox-relay';
import { InboxConsumer, type MessageHandler } from './inbox-consumer';

export const PG_POOL = Symbol('PG_POOL');
export const EVENT_HANDLERS = Symbol('EVENT_HANDLERS');

/** Handlers for consumed events, keyed by event type. Register them with { provide: EVENT_HANDLERS, useValue: {...} }. */
export type EventHandlers = Record<string, MessageHandler>;

/**
 * Publishes the outbox every 1000 ms and consumes events when handlers are registered. Needs a configured
 * broker (runtime/broker.ts: GHK_BROKER, AMQP_URL, PUBSUB_*, SERVICEBUS_*).
 */
@Injectable()
export class RuntimeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RuntimeWorker');
  private readonly workerId = `creacion-de-pedido-con-token-de-autenticacion-${randomUUID()}`;
  private broker?: Broker;
  private timer?: NodeJS.Timeout;
  private consumer?: InboxConsumer;

  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(EVENT_HANDLERS) private readonly handlers: EventHandlers) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!brokerConfigured()) {
      this.logger.warn('No event broker is configured (AMQP_URL, PUBSUB_PROJECT_ID or SERVICEBUS_*): outbox events are stored but not published.');
      return;
    }
    this.broker = await connectBroker();
    await this.broker.declare(DEFAULT_TOPOLOGY);
    const relay = new OutboxRelay(this.pool, await this.broker.publisher(DEFAULT_TOPOLOGY.exchange));
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      relay.publishBatch(this.workerId)
        .catch(err => this.logger.error(`Outbox relay failed: ${(err as Error).message}`))
        .finally(() => { running = false; });
    }, 1000);
    if (Object.keys(this.handlers).length) {
      const subscription = await this.broker.subscribe(DEFAULT_TOPOLOGY.queue, DEFAULT_TOPOLOGY);
      this.consumer = new InboxConsumer(this.pool, subscription, 'creacion-de-pedido-con-token-de-autenticacion', async (event, meta) => {
        const handler = meta.eventType ? this.handlers[meta.eventType] : undefined;
        if (handler) await handler(event, meta);
      });
      this.consumer.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.consumer?.stop().catch(() => undefined);
    await this.broker?.close().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }
}

/** Probes for container platforms: /health (process is up) and /health/ready (database reachable). */
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }
}

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: PG_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: EVENT_HANDLERS, useValue: {} satisfies EventHandlers },
    RuntimeWorker
  ],
  exports: [PG_POOL]
})
export class RuntimeModule {}
