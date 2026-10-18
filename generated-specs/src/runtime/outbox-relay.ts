import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { EventPublisher } from './broker';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

/**
 * Publishes pending outbox rows. Rows are claimed with FOR UPDATE SKIP LOCKED and a lease,
 * so concurrent relays never publish the same row; the publisher resolves only once the broker
 * has accepted the message (RabbitMQ confirms, Pub/Sub / Service Bus send), before a row is
 * marked published. Use one relay (and publisher) per worker.
 */
export class OutboxRelay {
  private readonly s: string;

  constructor(
    private readonly pool: Pool,
    private readonly publisher: EventPublisher,
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
      const span = tracer().startSpan(`${this.publisher.destination} publish`, {
        kind: SpanKind.PRODUCER,
        attributes: { 'messaging.system': this.publisher.system, 'messaging.destination.name': this.publisher.destination, 'messaging.message.id': row.id, 'tenant.id': row.tenant_id }
      }, parent);
      try {
        const traceparent = traceparentOf(trace.setSpan(parent, span));
        const payload = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
        await this.publisher.publish({ messageId: row.id, eventType: row.event_type, tenantId: row.tenant_id, traceparent, body: Buffer.from(payload) });
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
