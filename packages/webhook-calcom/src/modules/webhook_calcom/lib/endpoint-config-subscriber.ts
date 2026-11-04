import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { CALCOM_INTEGRATION_ID } from '../integration'
import { syncCalcomEndpointConfig } from './endpoint-config'

export type IntegrationChangedPayload = {
  integrationId?: string
  tenantId?: string | null
  organizationId?: string | null
}

export async function handleCalcomIntegrationChanged(payload: IntegrationChangedPayload): Promise<void> {
  if (payload.integrationId !== CALCOM_INTEGRATION_ID) return
  if (!payload.tenantId || !payload.organizationId) return
  const container = await createRequestContainer()
  await syncCalcomEndpointConfig(container, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  })
}
