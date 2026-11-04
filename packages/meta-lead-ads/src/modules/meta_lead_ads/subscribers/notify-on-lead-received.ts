import { createLogger } from '@open-mercato/shared/lib/logger'
import type { LeadReceivedPayload } from '../events'
import { notifyLeadReceived } from '../lib/notifier'

const logger = createLogger('meta_lead_ads').child({ component: 'notify-on-lead-received' })

export const metadata = {
  event: 'meta_lead_ads.lead.received',
  persistent: true,
  id: 'meta_lead_ads:notify-on-lead-received',
}

export default async function handle(
  payload: unknown,
  ctx: { resolve: <T = unknown>(name: string) => T; eventName?: string },
): Promise<void> {
  const data = payload as LeadReceivedPayload | null | undefined
  if (!data?.leadEventId || !data.tenantId || !data.organizationId) return

  try {
    await notifyLeadReceived(ctx, data)
  } catch (err) {
    logger.error('Failed to send lead received notification', {
      errorName: err instanceof Error ? err.name : 'unknown',
    })
    throw err
  }
}
