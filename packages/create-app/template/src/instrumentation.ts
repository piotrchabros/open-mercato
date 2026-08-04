import { assertBackendCustomDomainsConfig } from '@open-mercato/core/modules/customer_accounts/lib/backendCustomDomains'
import { isTelemetryBackendEnabled } from '@open-mercato/shared/lib/telemetry/runtime'

export async function register(): Promise<void> {
  // Fail fast on a misconfigured host-binding setup (#4271). Backend custom
  // domains let the request Host decide which organization an operator acts on,
  // which is only sound behind a proxy that overwrites that header — so
  // enabling the feature without declaring one is a configuration error, not a
  // degraded mode. Throwing here surfaces it at boot instead of leaving the
  // feature silently inert with no signal to the operator.
  //
  // No-op unless BACKEND_CUSTOM_DOMAINS_ENABLED is on.
  assertBackendCustomDomainsConfig()

  // dev warmup is handled by the dev runner splash flow.
  // Initialize telemetry (no-op unless TELEMETRY_BACKEND is set). OTEL's NodeSDK
  // is Node-only and incompatible with the edge runtime, so the telemetry
  // bootstrap — which can pull in the SDK — is imported only on the Node.js
  // runtime. The helper owns init + graceful degrade + shutdown flush.
  if (
    process.env.NEXT_RUNTIME === 'nodejs'
    && isTelemetryBackendEnabled()
  ) {
    const { registerTelemetryForNextjs } = await import('@open-mercato/telemetry/nextjs')
    await registerTelemetryForNextjs()
  }
}
