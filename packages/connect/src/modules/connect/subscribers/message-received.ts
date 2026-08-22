import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectIngestRetryableError,
  ingestInboundMessage,
  type IngestInboundMessageInput,
} from '../commands/ingest-inbound-message'

const logger = createLogger('connect').child({ component: 'message-received' })

/**
 * Connect's inbound entry point.
 *
 * ALWAYS registered — auto-discovery has no conditional path, and a subscriber
 * that appears only under some conditions is one whose absence nobody notices.
 * It checks activation itself and stays inert until a Connect-managed shared
 * channel exists.
 *
 * Acknowledgement policy, which is the whole point of this file:
 *
 *   - **Inert** (Connect not installed/configured): acknowledge. Every legacy
 *     tenant's mail flows through this event, and failing delivery would
 *     dead-letter all of it.
 *   - **Definitively not ours** (legacy or disabled channel at event time):
 *     acknowledge. Retrying cannot change an immutable event-time answer.
 *   - **Transient outage after the channel was enabled**: do NOT acknowledge.
 *     The message is redelivered instead of lost, which is the only acceptable
 *     outcome for a customer's mail.
 */
export const metadata = {
  event: 'communication_channels.message.received',
  persistent: true,
  id: 'connect:message-received',
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
  hasRegistration?: (name: string) => boolean
}

type InboundEventPayload = {
  messageId?: string
  externalMessageId?: string
  channelLinkId?: string
  conversationId?: string
  channelId?: string
  tenantId?: string
  organizationId?: string | null
  direction?: string
}

export default async function handler(
  payload: InboundEventPayload,
  ctx: SubscriberContext,
): Promise<void> {
  if (payload?.direction && payload.direction !== 'inbound') return

  // A missing tuple component is a malformed event, not a retryable one: the
  // payload will not grow a field on redelivery. In particular we never
  // substitute another identifier for `conversationId`.
  const input = toIngestInput(payload)
  if (!input) {
    logger.warn('ignoring an inbound event with an incomplete identifier tuple')
    return
  }

  try {
    const result = await ingestInboundMessage(ctx as never, input)
    if (result.status === 'inert') {
      logger.debug('connect ingest inert', { missing: result.missing })
    }
  } catch (err) {
    if (err instanceof ConnectIngestRetryableError) {
      // Rethrow so the persistent subscription does NOT acknowledge; the bus
      // redelivers once the prerequisite recovers.
      logger.warn('deferring inbound ingest without acknowledgement', { reason: err.reason })
      throw err
    }
    throw err
  }
}

function toIngestInput(payload: InboundEventPayload): IngestInboundMessageInput | null {
  const { tenantId, organizationId, channelId, conversationId, messageId, externalMessageId, channelLinkId } =
    payload ?? {}
  if (
    typeof tenantId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof channelId !== 'string' ||
    typeof conversationId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof externalMessageId !== 'string' ||
    typeof channelLinkId !== 'string'
  ) {
    return null
  }
  return { tenantId, organizationId, channelId, conversationId, messageId, externalMessageId, channelLinkId }
}
