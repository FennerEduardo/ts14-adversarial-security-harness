import { randomUUID } from 'crypto';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { DomainValidationError } from '../creacion-de-pedido-con-token-de-autenticacion/domain/creacion-de-pedido-con-token-de-autenticacion.aggregate';
import { CreacionDePedidoConTokenDeAutenticacionAggregate, type CreacionDePedidoConTokenDeAutenticacionCommand, type CreacionDePedidoConTokenDeAutenticacionState } from '../creacion-de-pedido-con-token-de-autenticacion/domain/creacion-de-pedido-con-token-de-autenticacion.aggregate';
import { schemaName } from './schema';
import { contextFrom, traceparentOf, tracer } from './telemetry';

interface LoadedAggregate {
  readonly state: string;
  readonly version: number;
}

type DomainCommand = { id: string; payload: Record<string, unknown> };

/** How the command service creates, restores and runs commands on one aggregate type. */
interface AggregateRuntime {
  create(id: string): LoadedAggregate;
  restore(id: string, state: string, version: number): LoadedAggregate;
  commands: Record<string, (aggregate: LoadedAggregate, command: DomainCommand) => { type: string; version: number }>;
}

/** Every aggregate of this service, by aggregate type (one per feature). */
const AGGREGATES: Record<string, AggregateRuntime> = {
  CreacionDePedidoConTokenDeAutenticacion: {
    create: id => new CreacionDePedidoConTokenDeAutenticacionAggregate(id),
    restore: (id, state, version) => CreacionDePedidoConTokenDeAutenticacionAggregate.restore(id, state as CreacionDePedidoConTokenDeAutenticacionState, version),
    commands: {
      process_creacion_de_pedido_con_token_de_autenticacion: (a, c) => (a as CreacionDePedidoConTokenDeAutenticacionAggregate).processCreacionDePedidoConTokenDeAutenticacion(c as CreacionDePedidoConTokenDeAutenticacionCommand)
    }
  }
};

/** Aggregate type used when a request does not name one. */
export const DEFAULT_AGGREGATE = 'CreacionDePedidoConTokenDeAutenticacion';

export interface CommandRequest {
  tenantId: string;
  /** Aggregate type (feature), e.g. 'CreacionDePedidoConTokenDeAutenticacion'; defaults to DEFAULT_AGGREGATE. */
  aggregateType?: string;
  aggregateId: string;
  command: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Incoming W3C traceparent (e.g. from the HTTP request). */
  traceparent?: string;
}

export interface CommandResult {
  status: 'created' | 'replayed' | 'in-progress';
  aggregateId: string;
  eventType?: string;
  version?: number;
}

/**
 * Executes a command in one transaction: idempotency claim, aggregate load (FOR UPDATE),
 * domain logic, aggregate save and outbox insert. A domain error rolls everything back.
 */
export class CommandService {
  private readonly s: string;

  constructor(private readonly pool: Pool, schema = 'public') {
    this.s = schemaName(schema);
  }

  async handle(req: CommandRequest): Promise<CommandResult> {
    if (!req.tenantId) throw new DomainValidationError('tenantId is required');
    const aggregateType = req.aggregateType ?? DEFAULT_AGGREGATE;
    const kind = AGGREGATES[aggregateType];
    if (!kind) throw new DomainValidationError(`Unknown aggregate type ${aggregateType}`);
    const parent = contextFrom(req.traceparent);
    const span = tracer().startSpan(`${aggregateType}.${req.command}`, {
      kind: SpanKind.INTERNAL,
      attributes: { 'tenant.id': req.tenantId, 'aggregate.id': req.aggregateId }
    }, parent);
    const ctx = trace.setSpan(parent, span);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (req.idempotencyKey) {
        const claim = await client.query(`INSERT INTO ${this.s}.ghk_idempotency (tenant_id, key, status) VALUES ($1, $2, 'PROCESSING') ON CONFLICT DO NOTHING`, [req.tenantId, req.idempotencyKey]);
        if (claim.rowCount === 0) {
          const { rows } = await client.query(`SELECT status, response FROM ${this.s}.ghk_idempotency WHERE tenant_id = $1 AND key = $2`, [req.tenantId, req.idempotencyKey]);
          await client.query('COMMIT');
          if (rows[0]?.status === 'COMPLETED') return { ...(JSON.parse(rows[0].response) as CommandResult), status: 'replayed' };
          return { status: 'in-progress', aggregateId: req.aggregateId };
        }
      }
      const { rows } = await client.query(`SELECT state, version FROM ${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3 FOR UPDATE`, [req.tenantId, aggregateType, req.aggregateId]);
      const aggregate = rows[0]
        ? kind.restore(req.aggregateId, String(rows[0].state), Number(rows[0].version))
        : kind.create(req.aggregateId);
      const handler = kind.commands[req.command];
      if (!handler) throw new DomainValidationError(`Unknown command ${req.command}`);
      const event = handler(aggregate, { id: req.aggregateId, payload: req.payload ?? {} });

      await client.query(
        `INSERT INTO ${this.s}.ghk_aggregates (tenant_id, aggregate_type, id, state, version) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, aggregate_type, id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()`,
        [req.tenantId, aggregateType, req.aggregateId, aggregate.state, aggregate.version]
      );
      await client.query(
        `INSERT INTO ${this.s}.ghk_outbox (id, tenant_id, aggregate_id, event_type, payload, traceparent) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), req.tenantId, req.aggregateId, event.type, JSON.stringify(event), traceparentOf(ctx) ?? null]
      );
      const result: CommandResult = { status: 'created', aggregateId: req.aggregateId, eventType: event.type, version: event.version };
      if (req.idempotencyKey) {
        await client.query(`UPDATE ${this.s}.ghk_idempotency SET status = 'COMPLETED', response = $3 WHERE tenant_id = $1 AND key = $2`, [req.tenantId, req.idempotencyKey, JSON.stringify(result)]);
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      client.release();
      span.end();
    }
  }

  /** The aggregate as tenant `tenantId` sees it (undefined for other tenants' aggregates). */
  async load(tenantId: string, aggregateId: string, aggregateType = DEFAULT_AGGREGATE): Promise<{ state: string; version: number } | undefined> {
    const { rows } = await this.pool.query(`SELECT state, version FROM ${this.s}.ghk_aggregates WHERE tenant_id = $1 AND aggregate_type = $2 AND id = $3`, [tenantId, aggregateType, aggregateId]);
    return rows[0] ? { state: rows[0].state, version: Number(rows[0].version) } : undefined;
  }
}
