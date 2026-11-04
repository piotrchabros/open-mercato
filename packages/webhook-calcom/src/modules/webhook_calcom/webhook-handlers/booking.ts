import type { WebhookHandler } from '@open-mercato/shared/lib/webhooks'
import { syncCalcomBooking } from '../lib/booking-sync'
import {
  createCalcomHandlerRuntime,
  resolveCalcomFallbackTitle,
  resolveCalcomHandlerCredentials,
} from '../lib/handler-runtime'

const handle: WebhookHandler = async (payload) => {
  const runtime = await createCalcomHandlerRuntime(payload)
  const credentials = await resolveCalcomHandlerCredentials(runtime, payload.eventType)
  if (!credentials) return
  await syncCalcomBooking(runtime.container, {
    trigger: payload.eventType,
    booking: runtime.parsed.booking,
    scope: runtime.scope,
    credentials,
    fallbackTitle: resolveCalcomFallbackTitle(runtime.translate),
  })
}

export default handle
