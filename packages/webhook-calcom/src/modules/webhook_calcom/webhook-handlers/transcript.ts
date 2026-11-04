import type { WebhookHandler } from '@open-mercato/shared/lib/webhooks'
import {
  createCalcomHandlerRuntime,
  parseCalcomHandlerPayload,
  resolveCalcomHandlerCredentials,
} from '../lib/handler-runtime'
import { attachCalcomTranscript } from '../lib/transcript-sync'

const handle: WebhookHandler = async (payload) => {
  const parsed = parseCalcomHandlerPayload(payload)
  if (!parsed.notetaker) return
  const runtime = await createCalcomHandlerRuntime(payload, parsed)
  const credentials = await resolveCalcomHandlerCredentials(runtime, payload.eventType)
  if (!credentials) return
  await attachCalcomTranscript(runtime.container, {
    booking: parsed.booking,
    notetaker: parsed.notetaker,
    scope: runtime.scope,
    credentials,
    translate: runtime.translate,
  })
}

export default handle
