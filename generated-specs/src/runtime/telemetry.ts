// W3C trace-context helpers. Spans go to the globally registered tracer provider
// (configure exporters with the standard OTEL_* environment variables).
import { context, trace, type Context } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

const propagator = new W3CTraceContextPropagator();
type Carrier = Record<string, unknown>;

export const tracer = () => trace.getTracer('creacion-de-pedido-con-token-de-autenticacion');

/** Context whose parent is the span described by an incoming traceparent header. */
export function contextFrom(traceparent?: string | null): Context {
  if (!traceparent) return context.active();
  return propagator.extract(context.active(), { traceparent }, {
    get: (carrier: Carrier, key: string) => (typeof carrier[key] === 'string' ? (carrier[key] as string) : undefined),
    keys: (carrier: Carrier) => Object.keys(carrier)
  });
}

/** traceparent header value for a context (undefined when it carries no span). */
export function traceparentOf(ctx: Context): string | undefined {
  const carrier: Record<string, string> = {};
  propagator.inject(ctx, carrier, { set: (c: Record<string, string>, key: string, value: string) => { c[key] = value; } });
  return carrier.traceparent;
}
