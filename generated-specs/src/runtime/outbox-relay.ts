import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Channel, ConfirmChannel } from 'amqplib';
import type { Pool } from 'pg';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

export interface Topology {
  exchange: string;
  queue: string;
  dlx: string;
  dlq: string;
}

/** Default topology for this feature (pass a prefix to isolate environments or tests). */
export function topology(prefix = 'creacion-de-pedido-con-token-de-autenticacion'): Topology {
  return { exchange: `${prefix}.events`, queue: `${prefix}.consumer`, dlx: `${prefix}.dlx`, dlq: `${prefix}.dlq` };
}
export const DEFAULT_TOPOLOGY: Topology = {"exchange":"creacion-de-pedido-con-token-de-autenticacion.events","queue":"creacion-de-pedido-con-token-de-autenticacion.consumer","dlx":"creacion-de-pedido-con-token-de-autenticacion.dlx","dlq":"creacion-de-pedido-con-token-de-autenticacion.dlq"};

/** Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ. */
export async function declareTopology(channel: Channel, t: Topology = DEFAULT_TOPOLOGY): Promise<void> {
  await channel.assertExchange(t.exchange, 'topic', { durable: true });
  await channel.assertExchange(t.dlx, 'fanout', { durable: true });
  await channel.assertQueue(t.dlq, { durable: true });
  await channel.bindQueue(t.dlq, t.dlx, '');
  await channel.assertQueue(t.queue, { durable: true, arguments: { 'x-dead-letter-exchange': t.dlx } });
  await channel.bindQueue(t.queue, t.exchange, '#');
}

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease,
 * so concurrent relays never publish the same row; publisher confirms guarantee delivery
 * to the broker before a row is marked published.
 */
export class OutboxRelay {
  private readonly s: string;

  constructor(
    private readonly pool: Pool,
    private readonly channel: ConfirmChannel,
    private readonly exchange: string = DEFAULT_TOPOLOGY.exchange,
    schema = 'public',
    private readonly leaseSeconds = 30,
    private readonly maxAttempts = 5
  ) {
    this.s = schemaName(schema);
  }

  async publishBatch(workerId: string, limit = 50): Promise<number> {
    const { rows } = await this.pool.query(
      `UPDATE ${this.s}.ghk_outbox SET claimed_by = $1, claimed_until = now() + make_interval(secs => $2), attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM ${this.s}.ghk_outbox
         WHERE published_at IS NULL AND failed_at IS NULL AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id, aggregate_id, event_type, payload, traceparent, attempts`,
      [workerId, this.leaseSeconds, limit]
    );
    let published = 0;
    for (const row of rows) {
      const parent = contextFrom(row.traceparent);
      const span = tracer().startSpan(`${this.exchange} publish`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': this.exchange, 'messaging.message.id': row.id, 'tenant.id': row.tenant_id }
      }, parent);
      try {
        const headers: Record<string, string> = { tenant_id: row.tenant_id };
        const traceparent = traceparentOf(trace.setSpan(parent, span));
        if (traceparent) headers.traceparent = traceparent;
        await new Promise<void>((resolve, reject) => {
          this.channel.publish(this.exchange, row.event_type, Buffer.from(row.payload), {
            messageId: row.id, persistent: true, contentType: 'application/json', type: row.event_type, headers
          }, err => (err ? reject(err) : resolve()));
        });
        await this.pool.query(`UPDATE ${this.s}.ghk_outbox SET published_at = now(), claimed_until = NULL WHERE id = $1 AND claimed_by = $2`, [row.id, workerId]);
        published++;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        await this.pool.query(
          `UPDATE ${this.s}.ghk_outbox SET claimed_until = NULL, last_error = $2, failed_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END WHERE id = $1`,
          [row.id, String((err as Error).message ?? err), this.maxAttempts]
        );
      } finally {
        span.end();
      }
    }
    return published;
  }
}
