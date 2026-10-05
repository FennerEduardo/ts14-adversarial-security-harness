import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { Pool, PoolClient } from 'pg';
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
 * rejects the message without requeue, so RabbitMQ dead-letters it to the DLQ.
 */
export class InboxConsumer {
  private readonly s: string;
  private consumerTag?: string;

  constructor(
    private readonly pool: Pool,
    private readonly channel: Channel,
    private readonly queue: string,
    private readonly consumerName: string,
    private readonly handler: MessageHandler,
    schema = 'public'
  ) {
    this.s = schemaName(schema);
  }

  async start(prefetch = 10): Promise<void> {
    await this.channel.prefetch(prefetch);
    const { consumerTag } = await this.channel.consume(this.queue, msg => {
      if (msg) void this.onMessage(msg);
    });
    this.consumerTag = consumerTag;
  }

  async stop(): Promise<void> {
    if (this.consumerTag) await this.channel.cancel(this.consumerTag);
  }

  private async onMessage(msg: ConsumeMessage): Promise<void> {
    const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
    const span = tracer().startSpan(`${this.queue} process`, {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': this.queue, 'messaging.message.id': String(msg.properties.messageId) }
    }, contextFrom(typeof headers.traceparent === 'string' ? headers.traceparent : undefined));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const messageId = String(msg.properties.messageId);
      const first = await client.query(`INSERT INTO ${this.s}.ghk_inbox (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [this.consumerName, messageId]);
      if (first.rowCount === 1) {
        await this.handler(JSON.parse(msg.content.toString('utf8')), {
          messageId,
          tenantId: typeof headers.tenant_id === 'string' ? headers.tenant_id : undefined,
          eventType: msg.properties.type,
          client
        });
      }
      await client.query('COMMIT');
      this.channel.ack(msg);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      this.channel.nack(msg, false, false);
    } finally {
      client.release();
      span.end();
    }
  }
}
