import type { WebhookSourceConfig } from '@open-mercato/shared/lib/webhooks'
import { CALCOM_SOURCE_KEY } from './integration'
import { extractCalcomEventType, extractCalcomMessageId } from './lib/payload'
import { verifyCalcomSignature } from './lib/signature'

export const CALCOM_MAX_BODY_BYTES = 2 * 1024 * 1024

export const webhookSources: WebhookSourceConfig[] = [
  {
    key: CALCOM_SOURCE_KEY,
    label: 'Cal.com',
    verifier: verifyCalcomSignature,
    eventTypeExtractor: extractCalcomEventType,
    messageIdExtractor: extractCalcomMessageId,
    credentialFields: [
      { key: 'webhookSecret', label: 'Webhook signing secret', secret: true, required: true },
    ],
    maxBodyBytes: CALCOM_MAX_BODY_BYTES,
  },
]

export default webhookSources
