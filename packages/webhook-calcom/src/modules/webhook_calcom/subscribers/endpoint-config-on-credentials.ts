import { handleCalcomIntegrationChanged, type IntegrationChangedPayload } from '../lib/endpoint-config-subscriber'

export const metadata = {
  event: 'integrations.credentials.updated',
  persistent: true,
  id: 'webhook_calcom:endpoint-config-on-credentials',
}

export default async function handle(payload: IntegrationChangedPayload) {
  await handleCalcomIntegrationChanged(payload)
}
