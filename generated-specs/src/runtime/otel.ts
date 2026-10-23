// OpenTelemetry export of the running service. With OTEL_EXPORTER_OTLP_ENDPOINT set, spans go over OTLP/HTTP to
// that collector (service.name from OTEL_SERVICE_NAME); without it nothing is exported and nothing connects.
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

let provider: NodeTracerProvider | undefined;

export function startTelemetry(serviceName = "cli-adversarial-security-harness"): boolean {
  if (provider || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || serviceName }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())]
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return true;
}

/** Flushes the pending spans (call on shutdown). */
export async function stopTelemetry(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
}
