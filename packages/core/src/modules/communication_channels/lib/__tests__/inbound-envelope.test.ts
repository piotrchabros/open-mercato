import {
  CommunicationChannel,
  ExternalConversation,
  ExternalMessage,
  MessageChannelLink,
} from '../../data/entities'
import {
  INBOUND_REPLY_REF_SOURCE_VERSION,
  INBOUND_SUBJECT_MAX_CHARS,
  _resetInboundReplyRefKeyCache,
  classifyInboundLoop,
  maskRecipient,
  readInboundEnvelope,
  resolveInboundReplyTarget,
  type InboundEnvelopeTuple,
} from '../inbound-envelope'

/**
 * Contract D exposes PII to an in-process consumer, so its guarantees are the
 * compensating control: full-tuple verification, event-time classification that
 * a later reprovision cannot rewrite, a bounded projection, and a reply address
 * that never crosses the boundary at all.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'

const tuple: InboundEnvelopeTuple = {
  tenantId: TENANT,
  organizationId: ORG,
  channelId: CHANNEL,
  conversationId: 'conv-row-1',
  messageId: 'msg-1',
  externalMessageId: 'ext-msg-1',
  channelLinkId: 'link-1',
}

type Fixture = {
  link?: Partial<MessageChannelLink> | null
  conversation?: Partial<ExternalConversation> | null
  channel?: Partial<CommunicationChannel> | null
  externalMessage?: Partial<ExternalMessage> | null
  throwOnFind?: boolean
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

function createContainer(fixture: Fixture) {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (fixture.throwOnFind) throw new Error('[internal] database unavailable')
      const row =
        entity === MessageChannelLink
          ? fixture.link
          : entity === ExternalConversation
            ? fixture.conversation
            : entity === CommunicationChannel
              ? fixture.channel
              : entity === ExternalMessage
                ? fixture.externalMessage
                : null
      if (!row) return null
      return matches(row as Record<string, unknown>, where) ? row : null
    }),
  }
  return { resolve: (name: string) => (name === 'em' ? { fork: () => em } : null) }
}

function connectLink(overrides: Partial<MessageChannelLink> = {}): Partial<MessageChannelLink> {
  return {
    id: 'link-1',
    messageId: 'msg-1',
    externalMessageId: 'ext-msg-1',
    externalConversationId: 'conv-row-1',
    tenantId: TENANT,
    organizationId: ORG,
    direction: 'inbound',
    projectionModeAtIngest: 'connect_managed',
    trafficEnabledAtIngest: true,
    channelPayload: { subject: 'Order 4711', from: 'alice@example.com' },
    channelMetadata: {},
    ...overrides,
  }
}

const baseFixture: Fixture = {
  link: connectLink(),
  conversation: {
    id: 'conv-row-1',
    channelId: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    subject: 'Order 4711',
  },
  channel: { id: CHANNEL, tenantId: TENANT, organizationId: ORG },
  externalMessage: {
    id: 'ext-msg-1',
    channelId: CHANNEL,
    conversationId: 'conv-row-1',
    tenantId: TENANT,
    senderIdentifier: 'Alice@Example.com',
    providerTimestamp: new Date('2026-08-22T10:00:00.000Z'),
    createdAt: new Date('2026-08-22T10:00:01.000Z'),
  },
}

beforeEach(() => {
  process.env.OM_INBOUND_REPLY_REF_SECRET = 'test-reply-ref-secret'
  _resetInboundReplyRefKeyCache()
})

describe('maskRecipient', () => {
  it('keeps an address recognizable without making it reconstructable', () => {
    expect(maskRecipient('alice@example.com')).toBe('a…e@example.com')
    expect(maskRecipient('ab@example.com')).toBe('…@example.com')
    expect(maskRecipient('handle-only')).toBe('h…y')
    expect(maskRecipient('')).toBe('')
  })
})

describe('classifyInboundLoop', () => {
  // Replying to an auto-reply is how a shared inbox and a vacation responder
  // generate an infinite mail loop with a customer.
  it.each([
    [{ 'auto-submitted': 'auto-replied' }, {}],
    [{ precedence: 'bulk' }, {}],
    [{}, { subject: 'Automatic reply: out of office' }],
  ])('flags an auto-responder', (headers, payload) => {
    expect(classifyInboundLoop(headers, payload).isAutoResponder).toBe(true)
  })

  it.each([
    [{ 'return-path': '<>' }, {}],
    [{ 'content-type': 'multipart/report; report-type=delivery-status' }, {}],
    [{}, { subject: 'Undeliverable: Order 4711' }],
  ])('flags a bounce', (headers, payload) => {
    expect(classifyInboundLoop(headers, payload).isBounce).toBe(true)
  })

  it('leaves an ordinary message unflagged', () => {
    const result = classifyInboundLoop({ 'auto-submitted': 'no' }, { subject: 'Order 4711' })
    expect(result).toEqual({ isAutoResponder: false, isBounce: false, reason: null })
  })
})

describe('readInboundEnvelope', () => {
  it('returns a bounded projection for a Connect-managed inbound message', async () => {
    const result = await readInboundEnvelope(createContainer(baseFixture), tuple)
    expect(result.status).toBe('found')
    if (result.status !== 'found') return
    expect(result.envelope).toMatchObject({
      senderHandle: 'Alice@Example.com',
      senderType: 'email',
      subject: 'Order 4711',
      isAutoResponder: false,
      isBounce: false,
      replyTargetMaskedLabel: 'A…e@Example.com',
    })
    // The projection must not carry raw headers, HTML, body, attachments or
    // credentials.
    const keys = Object.keys(result.envelope)
    for (const forbidden of ['headers', 'html', 'body', 'attachments', 'credentials', 'raw']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('bounds an oversized subject', async () => {
    const result = await readInboundEnvelope(
      createContainer({
        ...baseFixture,
        conversation: { ...baseFixture.conversation, subject: 'x'.repeat(INBOUND_SUBJECT_MAX_CHARS + 100) } as never,
      }),
      tuple,
    )
    if (result.status !== 'found') throw new Error('expected found')
    expect(result.envelope.subject).toHaveLength(INBOUND_SUBJECT_MAX_CHARS)
  })

  // A mixed tuple is the accidental-misuse case this contract is designed
  // around; it must not say WHICH component failed.
  it.each([
    ['message id', { messageId: 'msg-other' }],
    ['external message id', { externalMessageId: 'ext-other' }],
    ['conversation id', { conversationId: 'conv-other' }],
    ['channel id', { channelId: 'channel-other' }],
    ['tenant id', { tenantId: OTHER_TENANT }],
    ['organization id', { organizationId: 'org-other' }],
  ])('returns an undifferentiated missing for a wrong %s', async (_label, override) => {
    const result = await readInboundEnvelope(createContainer(baseFixture), { ...tuple, ...override })
    expect(result).toEqual({ status: 'missing' })
  })

  it('refuses an outbound record', async () => {
    const result = await readInboundEnvelope(
      createContainer({ ...baseFixture, link: connectLink({ direction: 'outbound' }) }),
      tuple,
    )
    expect(result).toEqual({ status: 'missing' })
  })

  // Event-time classification: reading the channel's CURRENT mode would let a
  // reprovision retroactively hand old messages to a different projection owner.
  it('classifies from the ingest-time snapshot, not the channel\'s current mode', async () => {
    const result = await readInboundEnvelope(
      createContainer({
        ...baseFixture,
        link: connectLink({ projectionModeAtIngest: 'legacy_customers' }),
        // The channel has since been cut over to Connect...
        channel: { id: CHANNEL, tenantId: TENANT, organizationId: ORG, projectionMode: 'connect_managed' },
      }),
      tuple,
    )
    // ...but this message was ingested as legacy and stays legacy.
    expect(result).toEqual({ status: 'not_connect_managed', projectionModeAtEvent: 'legacy_customers' })
  })

  it('treats a pre-contract row with no snapshot as legacy', async () => {
    const result = await readInboundEnvelope(
      createContainer({
        ...baseFixture,
        link: connectLink({ projectionModeAtIngest: null, trafficEnabledAtIngest: null }),
      }),
      tuple,
    )
    expect(result).toEqual({ status: 'not_connect_managed', projectionModeAtEvent: 'legacy_customers' })
  })

  it('reports a Connect-managed message ingested before traffic was enabled', async () => {
    const result = await readInboundEnvelope(
      createContainer({ ...baseFixture, link: connectLink({ trafficEnabledAtIngest: false }) }),
      tuple,
    )
    expect(result).toEqual({ status: 'channel_disabled', projectionModeAtEvent: 'connect_managed' })
  })

  // A record with no sender can never support identity resolution, so retrying
  // it forever would be pointless.
  it('reports a senderless record as permanently invalid, not retryable', async () => {
    const result = await readInboundEnvelope(
      createContainer({
        ...baseFixture,
        externalMessage: { ...baseFixture.externalMessage, senderIdentifier: null } as never,
      }),
      tuple,
    )
    expect(result).toEqual({ status: 'permanent_invalid', reason: 'missing_sender' })
  })

  it('reports a database failure as transient so ingest can retry', async () => {
    const result = await readInboundEnvelope(createContainer({ ...baseFixture, throwOnFind: true }), tuple)
    expect(result).toEqual({ status: 'transient_error' })
  })
})

describe('resolveInboundReplyTarget', () => {
  async function mintRef(fixture: Fixture = baseFixture): Promise<string> {
    const result = await readInboundEnvelope(createContainer(fixture), tuple)
    if (result.status !== 'found') throw new Error('expected found')
    return result.envelope.replyTargetRef
  }

  const resolveScope = {
    tenantId: TENANT,
    organizationId: ORG,
    channelId: CHANNEL,
    conversationId: 'conv-row-1',
    sourceVersion: INBOUND_REPLY_REF_SOURCE_VERSION,
  }

  it('resolves to the sender when there is no Reply-To', async () => {
    const replyTargetRef = await mintRef()
    const result = await resolveInboundReplyTarget(createContainer(baseFixture), {
      ...resolveScope,
      replyTargetRef,
    })
    expect(result).toEqual({
      status: 'resolved',
      kind: 'sender',
      canonicalRecipientInternal: 'alice@example.com',
      maskedLabel: 'a…e@example.com',
    })
  })

  // Reply-To wins because it is what the sender explicitly asked for.
  it('prefers Reply-To over the sender', async () => {
    const fixture: Fixture = {
      ...baseFixture,
      link: connectLink({
        channelPayload: {
          subject: 'Order 4711',
          from: 'alice@example.com',
          replyTo: 'support@example.com',
        },
      }),
    }
    const replyTargetRef = await mintRef(fixture)
    const result = await resolveInboundReplyTarget(createContainer(fixture), {
      ...resolveScope,
      replyTargetRef,
    })
    expect(result).toMatchObject({ status: 'resolved', kind: 'reply_to', canonicalRecipientInternal: 'support@example.com' })
  })

  // Choosing one of several addresses on a customer's behalf is a disclosure
  // decision the hub is not entitled to make.
  it('refuses to guess between multiple Reply-To addresses', async () => {
    const fixture: Fixture = {
      ...baseFixture,
      link: connectLink({
        channelPayload: {
          from: 'alice@example.com',
          replyTo: ['one@example.com', 'two@example.com'],
        },
      }),
    }
    const replyTargetRef = await mintRef(fixture)
    const result = await resolveInboundReplyTarget(createContainer(fixture), {
      ...resolveScope,
      replyTargetRef,
    })
    expect(result).toEqual({ status: 'ambiguous_multi_party' })
  })

  it('reports a record with no repliable address as unavailable', async () => {
    const fixture: Fixture = {
      ...baseFixture,
      link: connectLink({ channelPayload: { subject: 'Order 4711' } }),
    }
    const replyTargetRef = await mintRef(fixture)
    const result = await resolveInboundReplyTarget(createContainer(fixture), {
      ...resolveScope,
      replyTargetRef,
    })
    expect(result).toEqual({ status: 'unavailable' })
  })

  it.each([
    ['a different organization', { organizationId: 'org-other' }],
    ['a different channel', { channelId: 'channel-other' }],
    ['a different conversation', { conversationId: 'conv-other' }],
    ['a different tenant', { tenantId: OTHER_TENANT }],
  ])('refuses a reference presented for %s', async (_label, override) => {
    const replyTargetRef = await mintRef()
    const result = await resolveInboundReplyTarget(createContainer(baseFixture), {
      ...resolveScope,
      ...override,
      replyTargetRef,
    })
    expect(result).toEqual({ status: 'stale_or_wrong_ref' })
  })

  it('refuses a reference minted under an older policy version', async () => {
    const replyTargetRef = await mintRef()
    const result = await resolveInboundReplyTarget(createContainer(baseFixture), {
      ...resolveScope,
      sourceVersion: INBOUND_REPLY_REF_SOURCE_VERSION + 1,
      replyTargetRef,
    })
    expect(result).toEqual({ status: 'stale_or_wrong_ref' })
  })

  it.each([['not-a-ref'], ['v1.link-1.deadbeef'], ['v9.link-1.deadbeef']])(
    'refuses the malformed or forged reference %p',
    async (replyTargetRef) => {
      const result = await resolveInboundReplyTarget(createContainer(baseFixture), {
        ...resolveScope,
        replyTargetRef,
      })
      expect(result).toEqual({ status: 'stale_or_wrong_ref' })
    },
  )

  // A transient source failure must keep the send queued, never become a
  // definitive outcome and never become `unknown` (which is reserved for a
  // possible provider dispatch).
  it('reports a database failure as transient', async () => {
    const replyTargetRef = await mintRef()
    const result = await resolveInboundReplyTarget(
      createContainer({ ...baseFixture, throwOnFind: true }),
      { ...resolveScope, replyTargetRef },
    )
    expect(result).toEqual({ status: 'transient_error' })
  })
})
