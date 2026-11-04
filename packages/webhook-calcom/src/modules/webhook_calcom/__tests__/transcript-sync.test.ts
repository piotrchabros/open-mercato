import type { AwilixContainer } from 'awilix'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createAttachmentFromBuffer } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import { findPeopleByAddresses } from '@open-mercato/core/modules/customers/lib/findPeopleByAddresses'
import { emailHashLookupValues } from '@open-mercato/core/modules/auth/lib/emailHash'
import transcriptGenerated from './fixtures/transcript-generated.json'
import { attachCalcomTranscript, calcomTranscriptExternalId } from '../lib/transcript-sync'
import { calcomInteractionId } from '../lib/ids'
import { parseCalcomWebhook, type CalcomBooking, type CalcomNotetaker } from '../lib/payload'
import type { CalcomCredentials } from '../lib/credentials'
import { emitWebhookCalcomEvent } from '../events'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/attachments/lib/createFromBuffer', () => ({
  createAttachmentFromBuffer: jest.fn(),
}))
jest.mock('@open-mercato/core/modules/customers/lib/findPeopleByAddresses', () => ({
  ...jest.requireActual('@open-mercato/core/modules/customers/lib/findPeopleByAddresses'),
  findPeopleByAddresses: jest.fn(),
}))
jest.mock('../events', () => ({
  emitWebhookCalcomEvent: jest.fn(),
}))

type StoredInteraction = { id: string; status: string; entityId: string; deletedAt: Date | null }
type CommandCall = { commandId: string; input: Record<string, unknown> }
type AttachmentInput = {
  entityId: string
  recordId: string
  fileName: string
  mimeType: string
  buffer: Buffer
  tenantId: string
  organizationId: string
  dataEngine?: unknown
  additionalAssignments?: Array<{ type: string; id: string; label?: string | null }>
}

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const personId = '33333333-3333-4333-8333-333333333333'
const attachmentId = '55555555-5555-4555-8555-555555555555'
const uid = 'bk-uid-1'
const interactionId = calcomInteractionId(scope.tenantId, scope.organizationId, uid)

const createdPersonId = '66666666-6666-4666-8666-666666666666'
const queuedId = '77777777-7777-4777-8777-777777777777'
const organizerUserId = '88888888-8888-4888-8888-888888888888'
const credentials: CalcomCredentials = {
  webhookSecret: 'secret',
  instanceUrl: 'https://cal.example.com',
  unmatchedAttendeePolicy: 'skip',
}

const findOne = findOneWithDecryption as jest.Mock
const findMany = findWithDecryption as jest.Mock
const findPeople = findPeopleByAddresses as jest.Mock
const createAttachment = createAttachmentFromBuffer as jest.Mock
const emitEvent = emitWebhookCalcomEvent as jest.Mock

const translate = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? `{${name}}`))

function parsedFixture() {
  const parsed = parseCalcomWebhook(transcriptGenerated as Record<string, unknown>)
  if (!parsed.notetaker) throw new Error('fixture has no notetaker')
  return { booking: parsed.booking, notetaker: parsed.notetaker }
}

type HarnessOptions = {
  enabled?: boolean
  interaction?: StoredInteraction | null
  staffEmails?: string[]
  people?: Array<{ id: string; email: string }>
}

type QueuedRow = { id: string; transcriptId: string; reason: string; organizerUserId: string | null }

function buildHarness(options: HarnessOptions = {}) {
  const interactions = new Map<string, StoredInteraction>()
  const initial = options.interaction === undefined
    ? { id: interactionId, status: 'planned', entityId: personId, deletedAt: null }
    : options.interaction
  if (initial) interactions.set(initial.id, initial)
  const mappings = new Map<string, string>()
  const calls: CommandCall[] = []
  const logs: Array<Record<string, unknown>> = []

  const queuedRows = new Map<string, QueuedRow>()
  const pendingRows: QueuedRow[] = []
  const staffEmails = options.staffEmails ?? []

  findOne.mockImplementation(async (
    _em: unknown,
    _entity: unknown,
    where: { id?: string; tenantId: string; transcriptId?: string; emailHash?: { $in: string[] } },
  ) => {
    if (where.tenantId !== scope.tenantId) return null
    if (where.transcriptId) return queuedRows.get(where.transcriptId) ?? null
    if (where.emailHash) {
      return where.emailHash.$in.some((hash) => emailHashLookupValues('host@example.com').includes(hash))
        ? { id: organizerUserId, name: 'Piotr Host' }
        : null
    }
    const stored = where.id ? interactions.get(where.id) : undefined
    if (!stored) return null
    return { id: stored.id, status: stored.status, entity: { id: stored.entityId }, deletedAt: stored.deletedAt }
  })
  findMany.mockImplementation(async (_em: unknown, _entity: unknown, where: { emailHash: { $in: string[] } }) =>
    staffEmails
      .map((email) => emailHashLookupValues(email)[0])
      .filter((hash) => where.emailHash.$in.includes(hash))
      .map((hash) => ({ id: `user-${hash}`, emailHash: hash })))
  findPeople.mockImplementation(async (_em: unknown, emails: string[]) =>
    (options.people ?? []).filter((person) => emails.includes(person.email)))
  createAttachment.mockResolvedValue({
    id: attachmentId,
    fileName: 'transcript.txt',
    mimeType: 'text/plain; charset=utf-8',
    fileSize: 10,
    url: `/api/attachments/file/${attachmentId}`,
  })

  const execute = jest.fn(async (commandId: string, { input }: { input: Record<string, unknown> }) => {
    calls.push({ commandId, input })
    if (commandId === 'customers.interactions.create') {
      const id = String(input.id)
      interactions.set(id, { id, status: 'planned', entityId: String(input.entityId), deletedAt: null })
      return { result: { interactionId: id, entityId: input.entityId }, logEntry: null }
    }
    if (commandId === 'customers.people.create') {
      return { result: { entityId: createdPersonId, personId: createdPersonId }, logEntry: null }
    }
    return { result: {}, logEntry: null }
  })
  const tx = { getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) }
  const em = {
    transactional: jest.fn(async (run: (trx: typeof tx) => Promise<unknown>) => run(tx)),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: queuedId, ...data })),
    persist: jest.fn((row: QueuedRow) => { pendingRows.push(row) }),
    flush: jest.fn(async () => {
      for (const row of pendingRows.splice(0)) queuedRows.set(row.transcriptId, row)
    }),
  }
  const dataEngine = { markOrmEntityChange: jest.fn() }

  const services: Record<string, unknown> = {
    em,
    dataEngine,
    commandBus: { execute },
    externalIdMappingService: {
      lookupLocalId: jest.fn(async (_integration: string, entity: string, externalId: string) =>
        mappings.get(`${entity}|${externalId}`) ?? null),
      storeExternalIdMapping: jest.fn(async (_integration: string, entity: string, localId: string, externalId: string) => {
        mappings.set(`${entity}|${externalId}`, localId)
      }),
    },
    integrationStateService: { isEnabled: jest.fn().mockResolvedValue(options.enabled ?? true) },
    integrationLogService: { write: jest.fn(async (entry: Record<string, unknown>) => { logs.push(entry) }) },
  }
  const container = {
    resolve: (name: string) => {
      if (!(name in services)) throw new Error(`missing ${name}`)
      return services[name]
    },
  } as unknown as AwilixContainer
  return { container, interactions, mappings, calls, logs, em, dataEngine, queuedRows }
}

function attach(
  container: AwilixContainer,
  notetakerOverride?: Partial<CalcomNotetaker>,
  overrides: { booking?: Partial<CalcomBooking>; credentials?: Partial<CalcomCredentials> } = {},
) {
  const { booking, notetaker } = parsedFixture()
  return attachCalcomTranscript(container, {
    booking: { ...booking, ...overrides.booking },
    notetaker: { ...notetaker, ...notetakerOverride },
    scope,
    credentials: { ...credentials, ...overrides.credentials },
    translate,
  })
}

describe('attachCalcomTranscript', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('attaches the transcript to the person, links the meeting, comments the summary and completes it', async () => {
    const harness = buildHarness()
    const outcome = await attach(harness.container)

    expect(outcome).toEqual({ action: 'attached', attachmentId, interactionId })
    expect(createAttachment).toHaveBeenCalledTimes(1)
    const attachmentInput = createAttachment.mock.calls[0][0] as AttachmentInput
    expect(attachmentInput).toMatchObject({
      entityId: 'customers:customer_entity',
      recordId: personId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      mimeType: 'text/plain; charset=utf-8',
      fileName: 'transcript-2026-11-10-discovery-call-between-piotr-and-anna.txt',
      additionalAssignments: [
        { type: 'customers:customer_interaction', id: interactionId, label: 'Discovery call between Piotr and Anna' },
      ],
    })
    expect(attachmentInput.dataEngine).toBe(harness.dataEngine)
    const text = attachmentInput.buffer.toString('utf-8')
    expect(text).toContain('Meeting summary')
    expect(text).toContain('Intro call about pricing and onboarding.')
    expect(text).toContain('- Send proposal')
    expect(text).toContain('[00:00:00] Piotr Host: Hi Anna, thanks for joining.')
    expect(text).toContain('[00:00:04] Anna Kowalska: Happy to be here')
    expect(text).toContain('[00:00:09] Unknown speaker 1: Sorry to interrupt')
    expect(text).not.toContain('s3:')

    const { notetaker } = parsedFixture()
    expect(harness.mappings.get(`attachments:attachment|${calcomTranscriptExternalId(uid, notetaker.transcriptId)}`))
      .toBe(attachmentId)

    expect(harness.calls.map((call) => call.commandId)).toEqual([
      'customers.comments.create',
      'customers.interactions.complete',
    ])
    const [comment, complete] = harness.calls
    expect(comment.input).toMatchObject({ entityId: personId, tenantId: scope.tenantId, organizationId: scope.organizationId })
    expect(String(comment.input.body)).toContain('Meeting summary: Discovery call between Piotr and Anna')
    expect(String(comment.input.body)).toContain('Intro call about pricing and onboarding.')
    expect(complete.input).toEqual({ id: interactionId, occurredAt: '2026-11-10T10:30:00.000Z' })

    expect(harness.logs).toHaveLength(1)
    expect(harness.logs[0]).toMatchObject({ code: 'calcom.transcript.attached', scopeEntityId: interactionId })
    expect(JSON.stringify(harness.logs[0])).not.toContain('pricing')
  })

  it('returns duplicate when the transcript was already attached', async () => {
    const harness = buildHarness()
    await attach(harness.container)
    jest.clearAllMocks()
    const outcome = await attach(harness.container)
    expect(outcome).toEqual({ action: 'duplicate', attachmentId, interactionId })
    expect(createAttachment).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)).toMatchObject({ code: 'calcom.transcript.duplicate' })
  })

  it('creates the meeting for a matching attendee when the booking is unknown', async () => {
    const harness = buildHarness({ interaction: null, people: [{ id: personId, email: 'anna@example.com' }] })
    const outcome = await attach(harness.container)

    expect(outcome).toEqual({ action: 'created_and_attached', attachmentId, interactionId })
    expect(harness.calls.map((call) => call.commandId)).toEqual([
      'customers.interactions.create',
      'customers.comments.create',
      'customers.interactions.complete',
    ])
    expect(harness.calls[0].input).toMatchObject({ id: interactionId, entityId: personId, ownerUserId: organizerUserId })
    expect(harness.mappings.get(`customers:customer_interaction|${uid}`)).toBe(interactionId)
    expect((createAttachment.mock.calls[0][0] as AttachmentInput).recordId).toBe(personId)
    expect(harness.calls[2].input).toEqual({ id: interactionId, occurredAt: '2026-11-10T10:30:00.000Z' })
    expect(harness.queuedRows.size).toBe(0)
    expect(emitEvent).not.toHaveBeenCalled()
    expect(harness.logs[0]).toMatchObject({ code: 'calcom.transcript.created_and_attached', scopeEntityId: interactionId })
  })

  it('creates a person under the create_person policy and attaches the transcript', async () => {
    const harness = buildHarness({ interaction: null })
    const outcome = await attach(harness.container, undefined, { credentials: { unmatchedAttendeePolicy: 'create_person' } })

    expect(outcome).toEqual({ action: 'created_and_attached', attachmentId, interactionId })
    expect(harness.calls[0]).toMatchObject({
      commandId: 'customers.people.create',
      input: { primaryEmail: 'anna@example.com', source: 'calcom' },
    })
    expect(harness.calls[1]).toMatchObject({
      commandId: 'customers.interactions.create',
      input: { id: interactionId, entityId: createdPersonId },
    })
    expect((createAttachment.mock.calls[0][0] as AttachmentInput).recordId).toBe(createdPersonId)
  })

  it('queues the transcript as no_attendees when every attendee is staff', async () => {
    const harness = buildHarness({ interaction: null, staffEmails: ['anna@example.com', 'ben@example.com'] })
    const outcome = await attach(harness.container)

    expect(outcome).toEqual({
      action: 'queued',
      attachmentId: null,
      interactionId: null,
      unassignedTranscriptId: queuedId,
      reason: 'no_attendees',
    })
    expect(findPeople).not.toHaveBeenCalled()
    expect(harness.calls).toHaveLength(0)
    expect(createAttachment).not.toHaveBeenCalled()
    const { notetaker } = parsedFixture()
    expect(harness.queuedRows.get(notetaker.transcriptId)).toMatchObject({
      reason: 'no_attendees',
      organizerUserId,
      bookingUid: uid,
    })
  })

  it('queues the transcript as no_attendees when the booking has no attendees', async () => {
    const harness = buildHarness({ interaction: null })
    const outcome = await attach(harness.container, undefined, { booking: { attendees: [] } })
    expect(outcome).toMatchObject({ action: 'queued', reason: 'no_attendees' })
  })

  it('queues the transcript as no_matching_attendee when external attendees are unknown and the policy skips', async () => {
    const harness = buildHarness({ interaction: null, staffEmails: ['anna@example.com'] })
    const outcome = await attach(harness.container)

    expect(outcome).toMatchObject({ action: 'queued', reason: 'no_matching_attendee', unassignedTranscriptId: queuedId })
    expect(findPeople).toHaveBeenCalledWith(harness.em, ['ben@example.com'], scope.tenantId, scope.organizationId)
    expect(harness.calls).toHaveLength(0)
    expect(harness.logs[0]).toMatchObject({ code: 'calcom.transcript.queued', scopeEntityId: null })
    expect(harness.logs[0].payload).toMatchObject({ unassignedTranscriptId: queuedId, reason: 'no_matching_attendee' })
    expect(JSON.stringify(harness.logs[0])).not.toContain('example.com')
  })

  it('emits the unassigned transcript event once for a new row after the lock is released', async () => {
    const harness = buildHarness({ interaction: null })
    harness.em.transactional.mockImplementation(async (run: (trx: unknown) => Promise<unknown>) => {
      const result = await run({ getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) })
      expect(emitEvent).not.toHaveBeenCalled()
      return result
    })
    await attach(harness.container)

    const { notetaker } = parsedFixture()
    expect(emitEvent).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith(
      'webhook_calcom.unassigned_transcript.created',
      {
        id: queuedId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        transcriptId: notetaker.transcriptId,
        reason: 'no_matching_attendee',
      },
      { persistent: true, tenantId: scope.tenantId, organizationId: scope.organizationId },
    )
  })

  it('returns duplicate without emitting when the transcript is already queued', async () => {
    const harness = buildHarness({ interaction: null })
    await attach(harness.container)
    emitEvent.mockClear()
    harness.em.create.mockClear()

    const outcome = await attach(harness.container)
    expect(outcome).toEqual({
      action: 'duplicate',
      attachmentId: null,
      interactionId: null,
      unassignedTranscriptId: queuedId,
      reason: 'no_matching_attendee',
    })
    expect(harness.em.create).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
    expect(harness.logs.at(-1)).toMatchObject({ code: 'calcom.transcript.duplicate' })
  })

  it('skips soft-deleted meetings', async () => {
    const harness = buildHarness({
      interaction: { id: interactionId, status: 'planned', entityId: personId, deletedAt: new Date() },
    })
    const outcome = await attach(harness.container)
    expect(outcome).toEqual({ action: 'skipped', attachmentId: null, interactionId, reason: 'soft_deleted' })
    expect(createAttachment).not.toHaveBeenCalled()
  })

  it('skips when the integration is disabled', async () => {
    const harness = buildHarness({ enabled: false })
    const outcome = await attach(harness.container)
    expect(outcome).toEqual({ action: 'skipped', attachmentId: null, interactionId: null, reason: 'integration_disabled' })
    expect(harness.em.transactional).not.toHaveBeenCalled()
    expect(createAttachment).not.toHaveBeenCalled()
  })

  it('does not comment when there is no summary', async () => {
    const harness = buildHarness()
    const outcome = await attach(harness.container, { summary: null })
    expect(outcome.action).toBe('attached')
    expect(harness.calls.map((call) => call.commandId)).toEqual(['customers.interactions.complete'])
    const text = (createAttachment.mock.calls[0][0] as AttachmentInput).buffer.toString('utf-8')
    expect(text).not.toContain('Meeting summary')
  })

  it('does not comment when the summary failed', async () => {
    const harness = buildHarness()
    await attach(harness.container, {
      summary: { status: 'FAILED', language: null, overview: null, keyPoints: [], decisions: [], actionItems: [], topics: [] },
    })
    expect(harness.calls.map((call) => call.commandId)).toEqual(['customers.interactions.complete'])
  })

  it('does not complete a meeting that is already done', async () => {
    const harness = buildHarness({
      interaction: { id: interactionId, status: 'done', entityId: personId, deletedAt: null },
    })
    const outcome = await attach(harness.container)
    expect(outcome.action).toBe('attached')
    expect(harness.calls.map((call) => call.commandId)).toEqual(['customers.comments.create'])
  })
})
