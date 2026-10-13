import { Global, Inject, Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { Pool } from 'pg';
import { DEFAULT_TOPOLOGY, OutboxRelay, declareTopology } from './outbox-relay';
import { InboxConsumer, type MessageHandler } from './inbox-consumer';

export const PG_POOL = Symbol('PG_POOL');
export const EVENT_HANDLERS = Symbol('EVENT_HANDLERS');

/** Handlers for consumed events, keyed by event type. Register them with { provide: EVENT_HANDLERS, useValue: {...} }. */
export type EventHandlers = Record<string, MessageHandler>;

/** Publishes the outbox every 1000 ms and consumes events when handlers are registered. Needs AMQP_URL. */
@Injectable()
export class RuntimeWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RuntimeWorker');
  private readonly workerId = `creacion-de-pedido-con-token-de-autenticacion-${randomUUID()}`;
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private timer?: NodeJS.Timeout;
  private consumer?: InboxConsumer;

  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(EVENT_HANDLERS) private readonly handlers: EventHandlers) {}

  async onApplicationBootstrap(): Promise<void> {
    const url = process.env.AMQP_URL;
    if (!url) {
      this.logger.warn('AMQP_URL is not set: outbox events are stored but not published.');
      return;
    }
    this.connection = await amqp.connect(url);
    const channel = await this.connection.createConfirmChannel();
    await declareTopology(channel);
    const relay = new OutboxRelay(this.pool, channel, DEFAULT_TOPOLOGY.exchange);
    let running = false;
    this.timer = setInterval(() => {
      if (running) return;
      running = true;
      relay.publishBatch(this.workerId)
        .catch(err => this.logger.error(`Outbox relay failed: ${(err as Error).message}`))
        .finally(() => { running = false; });
    }, 1000);
    if (Object.keys(this.handlers).length) {
      const consume = await this.connection.createChannel();
      this.consumer = new InboxConsumer(this.pool, consume, DEFAULT_TOPOLOGY.queue, 'creacion-de-pedido-con-token-de-autenticacion', async (event, meta) => {
        const handler = meta.eventType ? this.handlers[meta.eventType] : undefined;
        if (handler) await handler(event, meta);
      });
      await this.consumer.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.consumer?.stop().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL }) },
    { provide: EVENT_HANDLERS, useValue: {} satisfies EventHandlers },
    RuntimeWorker
  ],
  exports: [PG_POOL]
})
export class RuntimeModule {}
