import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { safeOutboundFetch } from '@open-mercato/shared/lib/url-safety'
import { CALCOM_INTEGRATION_ID } from '../integration'
import { calcomCredentialsSchema, type CalcomCredentialsService } from './credentials'

const HEALTH_PROBE_TIMEOUT_MS = 5000

type HealthResult = {
  status: 'healthy' | 'degraded' | 'unhealthy'
  message?: string
  details?: Record<string, unknown>
}

export type CalcomHealthCheckDeps = {
  credentialsService: CalcomCredentialsService
  fetchImpl?: typeof fetch
}

export function createCalcomHealthCheck(deps: CalcomHealthCheckDeps) {
  return {
    async check(credentials: Record<string, unknown> | null, scope: IntegrationScope): Promise<HealthResult> {
      const raw = credentials ?? (await deps.credentialsService.resolve(CALCOM_INTEGRATION_ID, scope))
      if (!raw) return { status: 'unhealthy', message: 'Cal.com credentials are missing or invalid.' }

      const webhookSecret = typeof raw.webhookSecret === 'string' ? raw.webhookSecret.trim() : ''
      if (!webhookSecret) return { status: 'unhealthy', message: 'Webhook signing secret is not set.' }
      const instanceUrl = typeof raw.instanceUrl === 'string' ? raw.instanceUrl.trim() : ''
      if (!instanceUrl) return { status: 'unhealthy', message: 'Cal.com instance URL is not set.' }

      const parsed = calcomCredentialsSchema.safeParse(raw)
      if (!parsed.success) return { status: 'unhealthy', message: 'Cal.com credentials are missing or invalid.' }

      try {
        const response = await safeOutboundFetch(
          parsed.data.instanceUrl,
          { method: 'GET', signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) },
          { fetchImpl: deps.fetchImpl },
        )
        if (response.status >= 200 && response.status < 400) {
          return { status: 'healthy', message: 'Cal.com is configured and ready to receive webhooks.', details: { httpStatus: response.status } }
        }
        return {
          status: response.status >= 500 ? 'unhealthy' : 'degraded',
          message: 'Cal.com instance is unreachable or returned an error.',
          details: { httpStatus: response.status },
        }
      } catch {
        return { status: 'unhealthy', message: 'Cal.com instance is unreachable or returned an error.' }
      }
    },
  }
}
