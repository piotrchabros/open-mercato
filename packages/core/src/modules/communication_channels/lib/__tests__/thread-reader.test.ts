import {
  CommunicationChannel,
  ExternalConversation,
  MessageChannelLink,
  SharedChannelMembership,
} from '../../data/entities'
import {
  THREAD_READER_MAX_ALLOWLIST,
  THREAD_READER_MAX_BODY_CHARS,
  readAuthorizedThreads,
} from '../thread-reader'
import { _resetThreadReaderCursorKeyCache } from '../thread-reader-cursor'

/**
 * The thread reader relaxes the participant boundary for system-authored
 * inbound rows, so its narrowness is the whole security argument: one
 * authorized channel, an explicit allowlist proven to belong to it, bounded
 * plain projections, and nothing that reveals an id exists elsewhere.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG = '22222222-2222-4222-8222-222222222222'
const SIBLING_ORG = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

const actor = {
  userId: USER,
  tenantId: TENANT,
  organizationId: ORG,
  features: ['communication_channels.shared_inbox.read'],
}

type Fixture = {
  channel?: Partial<CommunicationChannel> | null
  membership?: Partial<SharedChannelMembership> | null
  conversations?: Array<Partial<ExternalConversation>>
  links?: Array<Partial<MessageChannelLink>>
}

function createContainer(fixture: Fixture) {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === CommunicationChannel) {
        const channel = fixture.channel
        if (!channel) return null
        return channel.id === where.id &&
          channel.tenantId === where.tenantId &&
          channel.organizationId === where.organizationId &&
          channel.isSharedInbox === where.isSharedInbox
          ? channel
          : null
      }
      if (entity === SharedChannelMembership) {
        const membership = fixture.membership
        if (!membership) return null
        return membership.channelId === where.channelId && membership.userId === where.userId
          ? membership
          : null
      }
      return null
    }),
    find: jest.fn(async (entity: unknown, where: Record<string, unknown>, options?: { limit?: number }) => {
      if (entity === ExternalConversation) {
        const allowed = new Set((where.externalConversationId as { $in: string[] }).$in)
        return (fixture.conversations ?? []).filter(
          (conversation) =>
            allowed.has(conversation.externalConversationId as string) &&
            conversation.channelId === where.channelId &&
            conversation.tenantId === where.tenantId &&
            conversation.organizationId === where.organizationId,
        )
      }
      if (entity === MessageChannelLink) {
        const allowed = new Set((where.externalConversationId as { $in: string[] }).$in)
        let rows = (fixture.links ?? []).filter(
          (link) => allowed.has(link.externalConversationId as string),
        )
        const or = where.$or as Array<Record<string, unknown>> | undefined
        if (or) {
          const gt = (or[0].createdAt as { $gt: Date }).$gt
          const tieId = (or[1].id as { $gt: string }).$gt
          rows = rows.filter((link) => {
            const createdAt = link.createdAt as Date
            if (createdAt.getTime() > gt.getTime()) return true
            return createdAt.getTime() === gt.getTime() && (link.id as string) > tieId
          })
        }
        rows = [...rows].sort((a, b) => {
          const delta = (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
          return delta !== 0 ? delta : (a.id as string).localeCompare(b.id as string)
        })
        return options?.limit ? rows.slice(0, options.limit) : rows
      }
      return []
    }),
  }
  return { resolve: (name: string) => (name === 'em' ? { fork: () => em } : null) }
}

function sharedChannel(overrides: Partial<CommunicationChannel> = {}): Partial<CommunicationChannel> {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    isActive: true,
    status: 'connected',
    projectionMode: 'legacy_customers',
    ...overrides,
  }
}

function activeMembership(overrides: Partial<SharedChannelMembership> = {}): Partial<SharedChannelMembership> {
  return {
    id: 'membership-1',
    channelId: CHANNEL,
    userId: USER,
    tenantId: TENANT,
    organizationId: ORG,
    isActive: true,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  }
}

function conversation(externalId: string, rowId: string, overrides: Partial<ExternalConversation> = {}) {
  return {
    id: rowId,
    externalConversationId: externalId,
    channelId: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    ...overrides,
  }
}

function link(id: string, conversationRowId: string, overrides: Partial<MessageChannelLink> = {}) {
  return {
    id,
    externalConversationId: conversationRowId,
    direction: 'inbound' as const,
    deliveryStatus: 'received',
    channelType: 'email',
    createdAt: new Date('2026-08-22T10:00:00.000Z'),
    channelPayload: { text: 'hello there' },
    tenantId: TENANT,
    organizationId: ORG,
    ...overrides,
  }
}

const baseFixture: Fixture = {
  channel: sharedChannel(),
  membership: activeMembership(),
  conversations: [conversation('conv-a', 'row-a')],
  links: [link('link-1', 'row-a')],
}

beforeEach(() => {
  process.env.OM_THREAD_READER_CURSOR_SECRET = 'test-cursor-secret'
  _resetThreadReaderCursorKeyCache()
})

describe('readAuthorizedThreads — input bounds', () => {
  it('rejects an empty allowlist rather than reading the whole channel', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), actor, {
      channelId: CHANNEL,
      externalConversationIds: [],
    })
    expect(result).toEqual({ status: 'invalid', reason: 'empty_allowlist' })
  })

  it('rejects an oversized allowlist', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), actor, {
      channelId: CHANNEL,
      externalConversationIds: Array.from(
        { length: THREAD_READER_MAX_ALLOWLIST + 1 },
        (_value, index) => `conv-${index}`,
      ),
    })
    expect(result).toEqual({ status: 'invalid', reason: 'allowlist_too_large' })
  })

  it('rejects an oversized page', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 1_000,
    })
    expect(result).toEqual({ status: 'invalid', reason: 'page_size_too_large' })
  })
})

describe('readAuthorizedThreads — authorization', () => {
  it('reads for an active member holding the read feature', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
    })
    expect(result.status).toBe('ok')
  })

  it('denies a revoked member', async () => {
    const result = await readAuthorizedThreads(
      createContainer({ ...baseFixture, membership: activeMembership({ isActive: false }) }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    expect(result).toEqual({ status: 'denied', reason: 'not_a_member' })
  })

  it('denies a member without the read feature', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), { ...actor, features: [] }, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
    })
    expect(result).toEqual({ status: 'denied', reason: 'missing_feature' })
  })

  it('accepts a wildcard feature grant', async () => {
    const result = await readAuthorizedThreads(
      createContainer(baseFixture),
      { ...actor, features: ['communication_channels.*'] },
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    expect(result.status).toBe('ok')
  })

  it.each([
    ['a sibling organization', sharedChannel({ organizationId: SIBLING_ORG })],
    ['another tenant', sharedChannel({ tenantId: OTHER_TENANT })],
  ])('masks a channel in %s as not_found', async (_label, channel) => {
    const result = await readAuthorizedThreads(createContainer({ ...baseFixture, channel }), actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
    })
    expect(result).toEqual({ status: 'denied', reason: 'not_found' })
  })
})

describe('readAuthorizedThreads — projection', () => {
  it('returns bounded plain text and never HTML', async () => {
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        links: [link('link-1', 'row-a', { channelPayload: { html: '<p>Hi <b>there</b></p>' } })],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const item = result.items[0]
    expect(item.kind).toBe('message')
    if (item.kind !== 'message') return
    expect(item.text).not.toContain('<')
    expect(item.text).toContain('Hi')
  })

  it('truncates an oversized body and says so', async () => {
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        links: [link('link-1', 'row-a', { channelPayload: { text: 'x'.repeat(THREAD_READER_MAX_BODY_CHARS + 500) } })],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    const item = result.items[0]
    if (item.kind !== 'message') throw new Error('expected a message')
    expect(item.text).toHaveLength(THREAD_READER_MAX_BODY_CHARS)
    expect(item.truncated).toBe(true)
  })

  it('strips control characters', async () => {
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        links: [link('link-1', 'row-a', { channelPayload: { text: 'a\u0000b\u001fc\nd' } })],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    const item = result.items[0]
    if (item.kind !== 'message') throw new Error('expected a message')
    expect(item.text).toBe('abc\nd')
  })

  // A signed provider URL is a credential, and Phase 1 has no download
  // affordance at all — so the projection must expose no handle of any kind.
  it('projects attachment metadata without any URL or download handle', async () => {
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        links: [
          link('link-1', 'row-a', {
            channelPayload: {
              text: 'see attached',
              attachments: [
                { fileName: 'invoice.pdf', mimeType: 'application/pdf', fileSize: 1024, url: 'https://provider/secret' },
              ],
            },
          }),
        ],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    const item = result.items[0]
    if (item.kind !== 'message') throw new Error('expected a message')
    expect(item.attachments).toEqual([
      { fileName: 'invoice.pdf', mimeType: 'application/pdf', fileSize: 1024 },
    ])
    expect(JSON.stringify(item)).not.toContain('provider/secret')
  })

  it('emits a stable-position placeholder for an unrenderable item', async () => {
    const brokenPayload = {
      get text(): string {
        throw new Error('[internal] decrypt failed')
      },
    }
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        conversations: [conversation('conv-a', 'row-a')],
        links: [
          link('link-1', 'row-a', { channelPayload: brokenPayload as never }),
          link('link-2', 'row-a', { createdAt: new Date('2026-08-22T11:00:00.000Z') }),
        ],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      kind: 'unavailable',
      code: 'content_unavailable',
      retryable: true,
    })
    // The other item on the page is unaffected.
    expect(result.items[1].kind).toBe('message')
  })
})

describe('readAuthorizedThreads — allowlist binding', () => {
  // A conversation that exists in another channel or scope must not be
  // distinguishable from one that does not exist at all.
  it('reports an unbound conversation without revealing whether it exists elsewhere', async () => {
    const result = await readAuthorizedThreads(
      createContainer({
        ...baseFixture,
        conversations: [
          conversation('conv-a', 'row-a'),
          conversation('conv-foreign', 'row-foreign', { channelId: 'another-channel' }),
        ],
      }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a', 'conv-foreign'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.unboundConversationIds).toEqual(['conv-foreign'])
    expect(result.items.every((item) => item.externalConversationId === 'conv-a')).toBe(true)
  })

  // "Bound but empty" and "not bound at all" are genuinely different answers
  // for a caller, and neither reveals a foreign id.
  it('distinguishes a bound empty thread from a missing binding', async () => {
    const result = await readAuthorizedThreads(
      createContainer({ ...baseFixture, links: [] }),
      actor,
      { channelId: CHANNEL, externalConversationIds: ['conv-a'] },
    )
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.items).toEqual([])
    expect(result.unboundConversationIds).toEqual([])
  })
})

describe('readAuthorizedThreads — paging', () => {
  const manyLinks = Array.from({ length: 3 }, (_value, index) =>
    link(`link-${index + 1}`, 'row-a', {
      createdAt: new Date(`2026-08-22T1${index}:00:00.000Z`),
      channelPayload: { text: `body ${index + 1}` },
    }),
  )

  it('pages in a deterministic order and continues from the cursor', async () => {
    const container = createContainer({ ...baseFixture, links: manyLinks })
    const first = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
    })
    if (first.status !== 'ok') throw new Error('expected ok')
    expect(first.items.map((item) => item.id)).toEqual(['link-1', 'link-2'])
    expect(first.nextCursor).toBeTruthy()

    const second = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
      cursor: first.nextCursor,
    })
    if (second.status !== 'ok') throw new Error('expected ok')
    expect(second.items.map((item) => item.id)).toEqual(['link-3'])
    expect(second.nextCursor).toBeNull()
  })

  // The cursor binds the allowlist, so a caller cannot widen their read
  // mid-page by adding conversations to the next request.
  it('refuses a cursor whose allowlist changed', async () => {
    const container = createContainer({
      ...baseFixture,
      conversations: [conversation('conv-a', 'row-a'), conversation('conv-b', 'row-b')],
      links: manyLinks,
    })
    const first = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
    })
    if (first.status !== 'ok') throw new Error('expected ok')

    const widened = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a', 'conv-b'],
      pageSize: 2,
      cursor: first.nextCursor,
    })
    expect(widened).toEqual({ status: 'invalid', reason: 'invalid_cursor' })
  })

  // Revoking and re-granting membership changes the authorization epoch, so a
  // cursor minted under the old grant cannot be resumed.
  it('refuses a cursor minted before the caller\'s authorization changed', async () => {
    const container = createContainer({ ...baseFixture, links: manyLinks })
    const first = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
    })
    if (first.status !== 'ok') throw new Error('expected ok')

    const regranted = createContainer({
      ...baseFixture,
      links: manyLinks,
      membership: activeMembership({ updatedAt: new Date('2026-08-23T00:00:00.000Z') }),
    })
    const result = await readAuthorizedThreads(regranted, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
      cursor: first.nextCursor,
    })
    expect(result).toEqual({ status: 'invalid', reason: 'invalid_cursor' })
  })

  it('refuses a cursor issued for another page size', async () => {
    const container = createContainer({ ...baseFixture, links: manyLinks })
    const first = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 2,
    })
    if (first.status !== 'ok') throw new Error('expected ok')

    const result = await readAuthorizedThreads(container, actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      pageSize: 3,
      cursor: first.nextCursor,
    })
    expect(result).toEqual({ status: 'invalid', reason: 'invalid_cursor' })
  })

  it('refuses a forged cursor', async () => {
    const result = await readAuthorizedThreads(createContainer(baseFixture), actor, {
      channelId: CHANNEL,
      externalConversationIds: ['conv-a'],
      cursor: 'bm90LWEtY3Vyc29y.c2lnbmF0dXJl',
    })
    expect(result).toEqual({ status: 'invalid', reason: 'invalid_cursor' })
  })
})
