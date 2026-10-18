// The event broker behind the outbox relay and the inbox consumer, chosen at run time so one image runs on
// any cloud: GHK_BROKER=rabbitmq (AMQP_URL), pubsub (PUBSUB_PROJECT_ID or GOOGLE_CLOUD_PROJECT;
// PUBSUB_EMULATOR_HOST for the emulator).
// Without GHK_BROKER the configured variables decide, then stack.messaging.
import * as amqp from 'amqplib';

/** Event bus destinations: publish to exchange (topic), consume from queue (subscription); dead letters go to dlx, read from dlq. */
export interface Topology {
  exchange: string;
  queue: string;
  dlx: string;
  dlq: string;
}

/** Default topology for this service (pass a prefix to isolate environments or tests). */
export function topology(prefix = 'cli-adversarial-security-harness'): Topology {
  return { exchange: `${prefix}.events`, queue: `${prefix}.consumer`, dlx: `${prefix}.dlx`, dlq: `${prefix}.dlq` };
}
export const DEFAULT_TOPOLOGY: Topology = {"exchange":"cli-adversarial-security-harness.events","queue":"cli-adversarial-security-harness.consumer","dlx":"cli-adversarial-security-harness.dlx","dlq":"cli-adversarial-security-harness.dlq"};

/** A domain event on the wire, independent of the broker. */
export interface BrokerMessage {
  messageId: string;
  eventType?: string;
  tenantId?: string;
  traceparent?: string;
  body: Buffer;
}

/** Publishes to one destination; publish resolves only once the broker has durably accepted the message. */
export interface EventPublisher {
  readonly system: string;
  readonly destination: string;
  publish(message: BrokerMessage): Promise<void>;
  close(): Promise<void>;
}

/** A received message: ack() once processed; deadLetter() moves it to the DLQ (it is not redelivered). */
export interface Delivery {
  message: BrokerMessage;
  ack(): Promise<void>;
  deadLetter(): Promise<void>;
}

/** Pulls messages from one queue / subscription. */
export interface EventSubscription {
  readonly system: string;
  readonly source: string;
  /** The next waiting message, or undefined when there is none. */
  poll(): Promise<Delivery | undefined>;
  close(): Promise<void>;
}

export interface Broker {
  readonly system: string;
  /** False when topics cannot be created at run time (Service Bus emulator: fixed Config.json). */
  readonly dynamicTopology: boolean;
  /** Creates the topology if missing (idempotent); in production it usually comes from infrastructure as code. */
  declare(t: Topology): Promise<void>;
  publisher(destination: string): Promise<EventPublisher>;
  /** @param t where dead-lettered messages go */
  subscribe(source: string, t: Topology): Promise<EventSubscription>;
  close(): Promise<void>;
}

/** Broker of the generated configuration (stack.messaging). */
export const DEFAULT_BROKER = 'rabbitmq';

export function brokerKind(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GHK_BROKER?.trim()) return env.GHK_BROKER.trim().toLowerCase();
  if (env.AMQP_URL) return 'rabbitmq';
  if (env.PUBSUB_PROJECT_ID || env.PUBSUB_EMULATOR_HOST) return 'pubsub';
  if (env.SERVICEBUS_CONNECTION_STRING || env.SERVICEBUS_NAMESPACE) return 'servicebus';
  return DEFAULT_BROKER;
}

/** Whether the variables of the selected broker are set. */
export function brokerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  switch (brokerKind(env)) {
    case 'pubsub': return Boolean(env.PUBSUB_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT);
    case 'servicebus': return Boolean(env.SERVICEBUS_CONNECTION_STRING || env.SERVICEBUS_NAMESPACE);
    default: return Boolean(env.AMQP_URL);
  }
}

export async function connectBroker(env: NodeJS.ProcessEnv = process.env): Promise<Broker> {
  const kind = brokerKind(env);
  switch (kind) {
    case 'rabbitmq':
      if (!env.AMQP_URL) throw new Error('AMQP_URL is not set (amqp://user:password@host:5672)');
      return RabbitMqBroker.connect(env.AMQP_URL);
    case 'pubsub':
      return PubSubBroker.fromEnv(env);
    case 'servicebus':
      throw new Error('The Azure Service Bus adapter is not generated: set stack.messaging to "servicebus" and regenerate');
    default:
      throw new Error(`Unsupported GHK_BROKER: ${kind} (rabbitmq, pubsub, servicebus)`);
  }
}

type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>;

/** RabbitMQ 0-9-1: topic exchange, publisher confirms, dead-lettering through the queue's DLX. */
export class RabbitMqBroker implements Broker {
  readonly system = 'rabbitmq';
  readonly dynamicTopology = true;

  constructor(private readonly connection: AmqpConnection) {}

  static async connect(url: string): Promise<RabbitMqBroker> {
    // A busy host can delay the AMQP handshake: retry before failing.
    for (let attempt = 1; ; attempt++) {
      try {
        return new RabbitMqBroker(await amqp.connect(url));
      } catch (err) {
        if (attempt === 5) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }

  async declare(t: Topology): Promise<void> {
    const channel = await this.connection.createChannel();
    await channel.assertExchange(t.exchange, 'topic', { durable: true });
    await channel.assertExchange(t.dlx, 'fanout', { durable: true });
    await channel.assertQueue(t.dlq, { durable: true });
    await channel.bindQueue(t.dlq, t.dlx, '');
    await channel.assertQueue(t.queue, { durable: true, arguments: { 'x-dead-letter-exchange': t.dlx } });
    await channel.bindQueue(t.queue, t.exchange, '#');
    await channel.close();
  }

  async publisher(exchange: string): Promise<EventPublisher> {
    const channel = await this.connection.createConfirmChannel();
    return {
      system: this.system,
      destination: exchange,
      publish: m => new Promise<void>((resolve, reject) => {
        const headers: Record<string, string> = {};
        if (m.tenantId) headers.tenant_id = m.tenantId;
        if (m.traceparent) headers.traceparent = m.traceparent;
        channel.publish(exchange, m.eventType ?? '', m.body, {
          messageId: m.messageId, persistent: true, contentType: 'application/json', type: m.eventType, headers
        }, err => (err ? reject(err) : resolve()));
      }),
      close: async () => { await channel.close().catch(() => undefined); }
    };
  }

  async subscribe(queue: string): Promise<EventSubscription> {
    const channel = await this.connection.createChannel();
    return {
      system: this.system,
      source: queue,
      poll: async () => {
        const msg = await channel.get(queue, { noAck: false });
        if (!msg) return undefined;
        const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
        return {
          message: { messageId: String(msg.properties.messageId), eventType: msg.properties.type, tenantId: text(headers.tenant_id), traceparent: text(headers.traceparent), body: msg.content },
          ack: async () => channel.ack(msg),
          // Rejected without requeue: RabbitMQ dead-letters it through the queue's DLX.
          deadLetter: async () => channel.nack(msg, false, false)
        };
      },
      close: async () => { await channel.close().catch(() => undefined); }
    };
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => undefined);
  }
}

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * Google Cloud Pub/Sub over its REST API (no client library): topics for the exchange and the DLX, pull
 * subscriptions for the queue and the DLQ. publish resolves once Pub/Sub has stored the message. A failed
 * message is dead-lettered by the consumer: published to the DLX topic, then acknowledged.
 * Auth: none against the emulator; otherwise GOOGLE_OAUTH_ACCESS_TOKEN or the metadata-server token of the
 * workload's service account (Cloud Run, GKE workload identity).
 */
export class PubSubBroker implements Broker {
  readonly system = 'gcp_pubsub';
  readonly dynamicTopology = true;
  private readonly root: string;
  private readonly emulator: boolean;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly project: string, emulatorHost?: string) {
    this.emulator = Boolean(emulatorHost);
    this.root = `${this.emulator ? `http://${emulatorHost}` : 'https://pubsub.googleapis.com'}/v1/projects/${project}`;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): PubSubBroker {
    const project = env.PUBSUB_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
    if (!project) throw new Error('PUBSUB_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) is not set');
    return new PubSubBroker(project, env.PUBSUB_EMULATOR_HOST);
  }

  private async bearer(): Promise<string | undefined> {
    if (this.emulator) return undefined;
    if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) return process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (!this.token || Date.now() > this.tokenExpiresAt) {
      const res = await fetch(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } });
      const body = (await res.json()) as { access_token: string; expires_in: number };
      this.token = body.access_token;
      this.tokenExpiresAt = Date.now() + (body.expires_in - 60) * 1000;
    }
    return this.token;
  }

  /** Calls the API; a status listed in accepted resolves to undefined instead of failing. */
  private async call(method: string, path: string, body?: unknown, accepted: number[] = []): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const bearer = await this.bearer();
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await fetch(`${this.root}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    if (accepted.includes(res.status)) return undefined;
    throw new Error(`Pub/Sub ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }

  async declare(t: Topology): Promise<void> {
    // 409: it already exists (created earlier or by infrastructure as code).
    await this.call('PUT', `/topics/${t.exchange}`, {}, [409]);
    await this.call('PUT', `/topics/${t.dlx}`, {}, [409]);
    await this.call('PUT', `/subscriptions/${t.queue}`, { topic: `projects/${this.project}/topics/${t.exchange}`, ackDeadlineSeconds: 60 }, [409]);
    await this.call('PUT', `/subscriptions/${t.dlq}`, { topic: `projects/${this.project}/topics/${t.dlx}`, ackDeadlineSeconds: 60 }, [409]);
  }

  private async publishTo(topic: string, m: BrokerMessage): Promise<void> {
    const attributes: Record<string, string> = { ghk_message_id: m.messageId };
    if (m.eventType) attributes.event_type = m.eventType;
    if (m.tenantId) attributes.tenant_id = m.tenantId;
    if (m.traceparent) attributes.traceparent = m.traceparent;
    const res = await this.call('POST', `/topics/${topic}:publish`, { messages: [{ data: m.body.toString('base64'), attributes }] });
    if (res?.messageIds?.length !== 1) throw new Error(`Pub/Sub did not accept message ${m.messageId}`);
  }

  async publisher(topic: string): Promise<EventPublisher> {
    return { system: this.system, destination: topic, publish: m => this.publishTo(topic, m), close: async () => undefined };
  }

  async subscribe(subscription: string, t: Topology): Promise<EventSubscription> {
    return {
      system: this.system,
      source: subscription,
      poll: async () => {
        const res = await this.call('POST', `/subscriptions/${subscription}:pull`, { maxMessages: 1, returnImmediately: true });
        const received = res?.receivedMessages?.[0];
        if (!received) return undefined;
        const attrs: Record<string, string> = received.message.attributes ?? {};
        const message: BrokerMessage = {
          messageId: attrs.ghk_message_id ?? received.message.messageId,
          eventType: attrs.event_type,
          tenantId: attrs.tenant_id,
          traceparent: attrs.traceparent,
          body: Buffer.from(received.message.data ?? '', 'base64')
        };
        const ack = async () => { await this.call('POST', `/subscriptions/${subscription}:acknowledge`, { ackIds: [received.ackId] }); };
        return { message, ack, deadLetter: async () => { await this.publishTo(t.dlx, message); await ack(); } };
      },
      close: async () => undefined
    };
  }

  async close(): Promise<void> {}
}
