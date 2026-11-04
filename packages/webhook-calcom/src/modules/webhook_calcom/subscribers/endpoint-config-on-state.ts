import { handleCalcomIntegrationChanged, type IntegrationChangedPayload } from '../lib/endpoint-config-subscriber'

export const metadata = {
  event: 'integrations.state.updated',
  persistent: true,
  id: 'webhook_calcom:endpoint-config-on-state',
}

export default async function handle(payload: IntegrationChangedPayload) {
  await handleCalcomIntegrationChanged(payload)
}
