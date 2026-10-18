import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';
import type { Delivery, EventSubscription } from './broker';
import { schemaName } from './schema';
import { contextFrom, tracer } from './telemetry';

export interface MessageMeta {
  messageId: string;
  tenantId?: string;
  eventType?: string;
  /** Transaction the inbox record is written in; use it for the handler's own writes. */
  client: PoolClient;
}

export type MessageHandler = (event: Record<string, unknown>, meta: MessageMeta) => Promise<void>;

/**
 * Idempotent consumer: the message id is recorded in ghk_inbox in the same transaction as the
 * handler, so redeliveries are acknowledged without running the handler twice. A handler error
 * dead-letters the message (RabbitMQ DLX, Pub/Sub / Service Bus dead-letter topic): it is not redelivered.
 */
export class InboxConsumer {
  private readonly s: string;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly pool: Pool,
    private readonly subscription: EventSubscription,
    private readonly consumerName: string,
    private readonly handler: MessageHandler,
    schema = 'public'
  ) {
    this.s = schemaName(schema);
  }

  /** Polls the subscription in the background until stop(). */
  start(idleDelayMs = 200): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const delivery = await this.subscription.poll().catch(() => undefined);
        if (delivery) await this.process(delivery);
        else await new Promise(r => setTimeout(r, idleDelayMs));
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** Processes messages until the source stays empty for idleMs; resolves to how many were processed. */
  async drain(idleMs = 1000): Promise<number> {
    let processed = 0;
    let idleSince = Date.now();
    while (Date.now() - idleSince < idleMs) {
      const delivery = await this.subscription.poll();
      if (!delivery) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      await this.process(delivery);
      processed++;
      idleSince = Date.now();
    }
    return processed;
  }

  private async process(delivery: Delivery): Promise<void> {
    const { message } = delivery;
    const span = tracer().startSpan(`${this.subscription.source} process`, {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': this.subscription.system, 'messaging.destination.name': this.subscription.source, 'messaging.message.id': message.messageId }
    }, contextFrom(message.traceparent));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const first = await client.query(`INSERT INTO ${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [this.consumerName, message.messageId]);
      if (first.rowCount === 1) {
        await this.handler(JSON.parse(message.body.toString('utf8')), {
          messageId: message.messageId,
          tenantId: message.tenantId,
          eventType: message.eventType,
          client
        });
      }
      await client.query('COMMIT');
      await delivery.ack();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      await delivery.deadLetter().catch(() => undefined);
    } finally {
      client.release();
      span.end();
    }
  }
}
