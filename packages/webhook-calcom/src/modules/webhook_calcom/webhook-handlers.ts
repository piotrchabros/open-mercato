import type { WebhookHandlerRegistryEntry } from '@open-mercato/shared/lib/webhooks'
import { CALCOM_SOURCE_KEY } from './integration'

export const CALCOM_BOOKING_HANDLER_ID = 'webhook_calcom:booking'
export const CALCOM_MEETING_ENDED_HANDLER_ID = 'webhook_calcom:meeting-ended'
export const CALCOM_TRANSCRIPT_HANDLER_ID = 'webhook_calcom:transcript'

export const webhookHandlers: WebhookHandlerRegistryEntry[] = [
  {
    meta: { source: CALCOM_SOURCE_KEY, event: 'BOOKING_*', id: CALCOM_BOOKING_HANDLER_ID },
    handler: () => import('./webhook-handlers/booking'),
  },
  {
    meta: { source: CALCOM_SOURCE_KEY, event: 'MEETING_ENDED', id: CALCOM_MEETING_ENDED_HANDLER_ID },
    handler: () => import('./webhook-handlers/meeting-ended'),
  },
  {
    meta: { source: CALCOM_SOURCE_KEY, event: 'RECORDING_TRANSCRIPTION_GENERATED', id: CALCOM_TRANSCRIPT_HANDLER_ID },
    handler: () => import('./webhook-handlers/transcript'),
  },
]

export default webhookHandlers
