// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and RabbitMQ.
// Requires DATABASE_URL and AMQP_URL. Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { SpanKind, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as amqp from 'amqplib';
import { Pool } from 'pg';
import { CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, declareTopology, migrate, topology, type Topology } from '../../src/runtime/index';

const { DATABASE_URL, AMQP_URL } = process.env;
if (!DATABASE_URL || !AMQP_URL) throw new Error('Integration tests need DATABASE_URL and AMQP_URL (see docs/RUNTIME-KERNEL.md).');

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const COMMAND = 'process_creacion_de_pedido_con_token_de_autenticacion';
const EVENT = 'ProcessCreacionDePedidoConTokenDeAutenticacionCompleted';
let pool: Pool;
let connection: amqp.ChannelModel;
let schema: string;
let t: Topology;
const uid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${where}`, params)).rows[0].n);
const until = async (check: () => Promise<boolean>, timeoutMs = 10000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 50));
  }
};
const drainQueue = async (channel: amqp.Channel, queue: string) => {
  const messages: amqp.GetMessage[] = [];
  for (let m = await channel.get(queue, { noAck: true }); m; m = await channel.get(queue, { noAck: true })) messages.push(m);
  return messages;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
  connection = await amqp.connect(AMQP_URL);
});

afterAll(async () => {
  await connection?.close();
  await pool?.end();
});

beforeEach(async () => {
  schema = `it_${uid()}`;
  t = topology(`it-${uid()}`);
  await migrate(pool, schema);
  exporter.reset();
});

afterEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

describe('CreacionDePedidoConTokenDeAutenticacion runtime (PostgreSQL + RabbitMQ)', () => {
  it('IT1 persists the aggregate and exactly one outbox row atomically; a domain error persists nothing', async () => {
    const service = new CommandService(pool, schema);
    const result = await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND });
    expect(result).toMatchObject({ status: 'created', eventType: EVENT, version: 1 });
    expect(await service.load('t1', 'agg-1')).toMatchObject({ version: 1 });
    expect(await count('ghk_outbox', 'aggregate_id = $1', ['agg-1'])).toBe(1);

    await expect(service.handle({ tenantId: 't1', aggregateId: 'agg-2', command: 'no_such_command', idempotencyKey: 'k-fail' })).rejects.toThrow(/Unknown command/);
    expect(await service.load('t1', 'agg-2')).toBeUndefined();
    expect(await count('ghk_outbox', 'aggregate_id = $1', ['agg-2'])).toBe(0);
    expect(await count('ghk_idempotency', 'key = $1', ['k-fail'])).toBe(0);
  });

  it('IT2 five concurrent requests with one idempotency key produce one effect and identical responses', async () => {
    const service = new CommandService(pool, schema);
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, idempotencyKey: 'key-1' })));
    expect(await count('ghk_outbox')).toBe(1);
    expect(await service.load('t1', 'agg-1')).toMatchObject({ version: 1 });
    expect(results.filter(r => r.status === 'created')).toHaveLength(1);
    for (const r of results) expect(r).toMatchObject({ eventType: EVENT, version: 1 });
  });

  it('IT3 two concurrent relays publish every outbox event exactly once', async () => {
    const service = new CommandService(pool, schema);
    for (let i = 0; i < 20; i++) await service.handle({ tenantId: 't1', aggregateId: `agg-${i}`, command: COMMAND });
    const setup = await connection.createChannel();
    await declareTopology(setup, t);
    const [a, b] = await Promise.all([connection.createConfirmChannel(), connection.createConfirmChannel()]);
    const drain = async (relay: OutboxRelay, worker: string) => {
      let total = 0;
      for (let n = await relay.publishBatch(worker, 3); n > 0; n = await relay.publishBatch(worker, 3)) total += n;
      return total;
    };
    const [na, nb] = await Promise.all([drain(new OutboxRelay(pool, a, t.exchange, schema), 'relay-a'), drain(new OutboxRelay(pool, b, t.exchange, schema), 'relay-b')]);
    expect(na + nb).toBe(20);
    expect(await count('ghk_outbox', 'published_at IS NULL')).toBe(0);
    await until(async () => (await setup.checkQueue(t.queue)).messageCount === 20);
    const ids = (await drainQueue(setup, t.queue)).map(m => m.properties.messageId);
    expect(new Set(ids).size).toBe(20);
    await Promise.all([a.close(), b.close(), setup.close()]);
  });

  it('IT4 tenants cannot read or change each other\'s aggregates', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 'tenant-a', aggregateId: 'shared-id', command: COMMAND });
    expect(await service.load('tenant-b', 'shared-id')).toBeUndefined();
    await service.handle({ tenantId: 'tenant-b', aggregateId: 'shared-id', command: COMMAND });
    expect(await service.load('tenant-a', 'shared-id')).toMatchObject({ version: 1 });
    expect(await service.load('tenant-b', 'shared-id')).toMatchObject({ version: 1 });
    expect(await count('ghk_outbox', 'tenant_id = $1', ['tenant-a'])).toBe(1);
  });

  it('IT5 a failing saga step compensates the completed steps in reverse order', async () => {
    const saga = new SagaOrchestrator(pool, schema);
    const log: string[] = [];
    const step = (name: string, fail = false) => ({
      name,
      action: async () => { if (fail) throw new Error(`${name} failed`); log.push(`do:${name}`); },
      compensate: async () => { log.push(`undo:${name}`); }
    });
    expect(await saga.run('saga-1', 't1', [step('reserve'), step('charge'), step('ship', true)])).toBe('COMPENSATED');
    expect(log).toEqual(['do:reserve', 'do:charge', 'undo:charge', 'undo:reserve']);
    expect(await saga.status('saga-1')).toEqual({ status: 'COMPENSATED', completedSteps: [] });
    expect(await saga.run('saga-2', 't1', [step('reserve'), step('charge')])).toBe('COMPLETED');
  });

  it('IT6 a redelivered message is handled once and a failing message is dead-lettered', async () => {
    const channel = await connection.createChannel();
    await declareTopology(channel, t);
    const handled: string[] = [];
    const consumer = new InboxConsumer(pool, channel, t.queue, 'it-consumer', async (event, meta) => {
      if (event.poison) throw new Error('cannot process');
      handled.push(meta.messageId);
    }, schema);
    await consumer.start();
    const publish = (messageId: string, body: object) => channel.publish(t.exchange, 'Test', Buffer.from(JSON.stringify(body)), { messageId, headers: { tenant_id: 't1' } });
    publish('m-1', { ok: true });
    publish('m-1', { ok: true });
    publish('m-poison', { poison: true });
    await until(async () => (await channel.checkQueue(t.dlq)).messageCount === 1 && handled.length === 1);
    await new Promise(r => setTimeout(r, 300));
    expect(handled).toEqual(['m-1']);
    expect(await count('ghk_inbox', 'consumer = $1', ['it-consumer'])).toBe(1);
    const dead = await drainQueue(channel, t.dlq);
    expect(dead.map(m => m.properties.messageId)).toEqual(['m-poison']);
    await consumer.stop();
    await channel.close();
  });

  it('IT7 the incoming trace context flows through command, outbox, publish and consume spans', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    const row = (await pool.query(`SELECT traceparent FROM ${schema}.ghk_outbox`)).rows[0];
    expect(row.traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');

    const channel = await connection.createConfirmChannel();
    await declareTopology(channel, t);
    const received: { traceparent?: unknown }[] = [];
    const consumer = new InboxConsumer(pool, channel, t.queue, 'trace-consumer', async () => { received.push({}); }, schema);
    await consumer.start();
    expect(await new OutboxRelay(pool, channel, t.exchange, schema).publishBatch('relay', 10)).toBe(1);
    await until(async () => received.length === 1 && exporter.getFinishedSpans().some(s => s.kind === SpanKind.CONSUMER));
    await consumer.stop();
    await channel.close();

    const spans = exporter.getFinishedSpans();
    const byKind = (kind: SpanKind) => spans.find(s => s.kind === kind)!;
    const command = byKind(SpanKind.INTERNAL);
    expect(command.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(command.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(byKind(SpanKind.PRODUCER).spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(byKind(SpanKind.CONSUMER).spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(byKind(SpanKind.CONSUMER).parentSpanContext?.spanId).toBe(byKind(SpanKind.PRODUCER).spanContext().spanId);
  });
});
