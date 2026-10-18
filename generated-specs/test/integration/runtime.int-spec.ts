// Runtime integration tests (docs/RUNTIME-KERNEL.md, IT1-IT7) against PostgreSQL and the selected broker
// (GHK_BROKER: rabbitmq with AMQP_URL, pubsub with PUBSUB_PROJECT_ID [+ PUBSUB_EMULATOR_HOST], servicebus).
// Requires DATABASE_URL. Run with: npm run test:integration
import { randomUUID } from 'crypto';
import { SpanKind, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Pool } from 'pg';
import { CommandService, InboxConsumer, OutboxRelay, SagaOrchestrator, brokerConfigured, connectBroker, migrate, topology, type Broker, type BrokerMessage, type Topology } from '../../src/runtime/index';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL || !brokerConfigured()) throw new Error('Integration tests need DATABASE_URL and the broker variables (see docs/RUNTIME-KERNEL.md).');

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

const COMMAND = 'process_creacion_de_pedido_con_token_de_autenticacion';
const EVENT = 'ProcessCreacionDePedidoConTokenDeAutenticacionCompleted';
let pool: Pool;
let broker: Broker;
let schema: string;
let t: Topology;
const uid = () => randomUUID().replace(/-/g, '').slice(0, 12);
const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${where}`, params)).rows[0].n);
/** Receives and acknowledges messages until the expected number arrived and the source stays quiet for 500 ms (10 s at most). */
const receive = async (source: string, expected: number): Promise<BrokerMessage[]> => {
  const out: BrokerMessage[] = [];
  const subscription = await broker.subscribe(source, t);
  const deadline = Date.now() + 10000;
  let quietSince = Date.now();
  try {
    while (Date.now() < deadline && (out.length < expected || Date.now() - quietSince < 500)) {
      const delivery = await subscription.poll();
      if (!delivery) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      out.push(delivery.message);
      await delivery.ack();
      quietSince = Date.now();
    }
  } finally {
    await subscription.close();
  }
  return out;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 20 });
  broker = await connectBroker();
});

afterAll(async () => {
  await broker?.close();
  await pool?.end();
});

beforeEach(async () => {
  schema = `it_${uid()}`;
  // Brokers with fixed entities (Service Bus emulator) share one topology, emptied before each test.
  t = broker.dynamicTopology ? topology(`it-${uid()}`) : topology('it');
  await migrate(pool, schema);
  await broker.declare(t);
  if (!broker.dynamicTopology) {
    await receive(t.queue, 0);
    await receive(t.dlq, 0);
  }
  exporter.reset();
});

afterEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
});

describe('CreacionDePedidoConTokenDeAutenticacion runtime (PostgreSQL + event broker)', () => {
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
    const [a, b] = await Promise.all([broker.publisher(t.exchange), broker.publisher(t.exchange)]);
    const drain = async (relay: OutboxRelay, worker: string) => {
      let total = 0;
      for (let n = await relay.publishBatch(worker, 3); n > 0; n = await relay.publishBatch(worker, 3)) total += n;
      return total;
    };
    const [na, nb] = await Promise.all([drain(new OutboxRelay(pool, a, schema), 'relay-a'), drain(new OutboxRelay(pool, b, schema), 'relay-b')]);
    await Promise.all([a.close(), b.close()]);
    expect(na + nb).toBe(20);
    expect(await count('ghk_outbox', 'published_at IS NULL')).toBe(0);
    const received = await receive(t.queue, 20);
    expect(received).toHaveLength(20);
    expect(new Set(received.map(m => m.messageId)).size).toBe(20);
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
    const handled: string[] = [];
    const publisher = await broker.publisher(t.exchange);
    const subscription = await broker.subscribe(t.queue, t);
    const consumer = new InboxConsumer(pool, subscription, 'it-consumer', async (event, meta) => {
      if (event.poison) throw new Error('cannot process');
      handled.push(meta.messageId);
    }, schema);
    const publish = (messageId: string, body: object) =>
      publisher.publish({ messageId, eventType: 'Test', tenantId: 't1', body: Buffer.from(JSON.stringify(body)) });
    await publish('m-1', { ok: true });
    await publish('m-1', { ok: true });
    await publish('m-poison', { poison: true });
    await consumer.drain(1000);
    await Promise.all([publisher.close(), subscription.close()]);
    expect(handled).toEqual(['m-1']);
    expect(await count('ghk_inbox', 'consumer = $1', ['it-consumer'])).toBe(1);
    const dead = await receive(t.dlq, 1);
    expect(dead.map(m => m.messageId)).toEqual(['m-poison']);
  });

  it('IT7 the incoming trace context flows through command, outbox, publish and consume spans', async () => {
    const service = new CommandService(pool, schema);
    await service.handle({ tenantId: 't1', aggregateId: 'agg-1', command: COMMAND, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    const row = (await pool.query(`SELECT traceparent FROM ${schema}.ghk_outbox`)).rows[0];
    expect(row.traceparent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');

    const publisher = await broker.publisher(t.exchange);
    expect(await new OutboxRelay(pool, publisher, schema).publishBatch('relay', 10)).toBe(1);
    await publisher.close();
    const received: string[] = [];
    const subscription = await broker.subscribe(t.queue, t);
    await new InboxConsumer(pool, subscription, 'trace-consumer', async (_event, meta) => { received.push(meta.messageId); }, schema).drain(1000);
    await subscription.close();
    expect(received).toHaveLength(1);

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
