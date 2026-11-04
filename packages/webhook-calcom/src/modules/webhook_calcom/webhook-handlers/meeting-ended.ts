import type { WebhookHandler } from '@open-mercato/shared/lib/webhooks'
import { syncCalcomBooking } from '../lib/booking-sync'
import {
  createCalcomHandlerRuntime,
  resolveCalcomFallbackTitle,
  resolveCalcomHandlerCredentials,
} from '../lib/handler-runtime'

const MEETING_ENDED_TRIGGER = 'MEETING_ENDED'

const handle: WebhookHandler = async (payload) => {
  const runtime = await createCalcomHandlerRuntime(payload)
  const credentials = await resolveCalcomHandlerCredentials(runtime, MEETING_ENDED_TRIGGER)
  if (!credentials) return
  await syncCalcomBooking(runtime.container, {
    trigger: MEETING_ENDED_TRIGGER,
    booking: runtime.parsed.booking,
    scope: runtime.scope,
    credentials,
    fallbackTitle: resolveCalcomFallbackTitle(runtime.translate),
  })
}

export default handle
