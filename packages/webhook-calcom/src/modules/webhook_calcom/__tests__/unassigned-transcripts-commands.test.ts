import type { AwilixContainer } from 'awilix'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createAttachmentFromBuffer } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import transcriptGenerated from './fixtures/transcript-generated.json'
import { CalcomUnassignedTranscript } from '../data/entities'
import { emitWebhookCalcomEvent } from '../events'
import { calcomInteractionId } from '../lib/ids'
import { parseCalcomWebhook } from '../lib/payload'
import { calcomTranscriptExternalId } from '../lib/transcript-sync'
import {
  UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID,
  UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID,
  type UnassignedTranscriptAssignResult,
  type UnassignedTranscriptDismissResult,
} from '../commands/unassigned-transcripts'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (key: string, fallback?: string) => fallback ?? key,
  })),
}))
jest.mock('@open-mercato/core/modules/attachments/lib/createFromBuffer', () => ({
  createAttachmentFromBuffer: jest.fn(),
}))
jest.mock('../events', () => ({
  emitWebhookCalcomEvent: jest.fn(),
}))

type StoredInteraction = { id: string; status: string; entityId: string; deletedAt: Date | null }
type CommandCall = { commandId: string; input: Record<string, unknown>; ctx: CommandRuntimeContext }
type StoredRow = {
  id: string
  tenantId: string
  organizationId: string
  bookingUid: string
  transcriptId: string
  status: string
  payload: { booking: Record<string, unknown>; notetaker: Record<string, unknown> }
  updatedAt: Date
  resolvedAt?: Date | null
  resolvedBy?: string | null
  resolvedEntityId?: string | null
  resolvedToInteractionId?: string | null
  resolvedAttachmentId?: string | null
  deletedAt?: Date | null
}

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const rowId = '44444444-4444-4444-8444-444444444444'
const personId = '33333333-3333-4333-8333-333333333333'
const otherPersonId = '99999999-9999-4999-8999-999999999999'
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const attachmentId = '55555555-5555-4555-8555-555555555555'
const uid = 'bk-uid-1'
const interactionId = calcomInteractionId(scope.tenantId, scope.organizationId, uid)
const transcriptId = '22222222-2222-4222-8222-222222222222'
const rowUpdatedAt = new Date('2026-11-04T10:00:00.000Z')

const findOne = findOneWithDecryption as jest.Mock
const createAttachment = createAttachmentFromBuffer as jest.Mock
const emitEvent = emitWebhookCalcomEvent as jest.Mock

function fixturePayload() {
  const parsed = parseCalcomWebhook(transcriptGenerated as Record<string, unknown>)
  if (!parsed.notetaker) throw new Error('fixture has no notetaker')
  return { booking: parsed.booking as Record<string, unknown>, notetaker: parsed.notetaker as Record<string, unknown> }
}

type HarnessOptions = {
  row?: Partial<StoredRow> | null
  interaction?: StoredInteraction | null
  personExists?: boolean
}

function buildHarness(options: HarnessOptions = {}) {
  const row: StoredRow | null = options.row === null
    ? null
    : {
        id: rowId,
        ...scope,
        bookingUid: uid,
        transcriptId,
        status: 'pending',
        payload: fixturePayload(),
        updatedAt: rowUpdatedAt,
        ...options.row,
      }
  const interactions = new Map<string, StoredInteraction>()
  if (options.interaction) interactions.set(options.interaction.id, options.interaction)
  const mappings = new Map<string, string>()
  const calls: CommandCall[] = []
  const personExists = options.personExists ?? true

  findOne.mockImplementation(async (
    _em: unknown,
    entity: unknown,
    where: { id?: string; tenantId: string; organizationId?: string; kind?: string; emailHash?: unknown },
  ) => {
    if (where.tenantId !== scope.tenantId) return null
    if (entity === CalcomUnassignedTranscript) return row && row.id === where.id ? row : null
    if (entity === CustomerEntity) {
      return personExists && where.id === personId && where.kind === 'person' ? { id: personId, kind: 'person' } : null
    }
    if (where.emailHash) return null
    const stored = where.id ? interactions.get(where.id) : undefined
    if (!stored) return null
    return { id: stored.id, status: stored.status, entity: { id: stored.entityId }, deletedAt: stored.deletedAt }
  })
  createAttachment.mockResolvedValue({ id: attachmentId })

  const execute = jest.fn(async (commandId: string, { input, ctx }: { input: Record<string, unknown>; ctx: CommandRuntimeContext }) => {
    calls.push({ commandId, input, ctx })
    if (commandId === 'customers.interactions.create') {
      const id = String(input.id)
      interactions.set(id, { id, status: 'planned', entityId: String(input.entityId), deletedAt: null })
      return { result: { interactionId: id, entityId: input.entityId }, logEntry: null }
    }
    return { result: {}, logEntry: null }
  })
  const tx = { getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) }
  const em = {
    fork: jest.fn(),
    transactional: jest.fn(async (run: (trx: typeof tx) => Promise<unknown>) => run(tx)),
    flush: jest.fn().mockResolvedValue(undefined),
  }
  em.fork.mockReturnValue(em)

  const services: Record<string, unknown> = {
    em,
    dataEngine: { markOrmEntityChange: jest.fn() },
    commandBus: { execute },
    externalIdMappingService: {
      lookupLocalId: jest.fn(async (_integration: string, entity: string, externalId: string) =>
        mappings.get(`${entity}|${externalId}`) ?? null),
      storeExternalIdMapping: jest.fn(async (_integration: string, entity: string, localId: string, externalId: string) => {
        mappings.set(`${entity}|${externalId}`, localId)
      }),
    },
  }
  const container = {
    resolve: (name: string) => {
      if (!(name in services)) throw new Error(`missing ${name}`)
      return services[name]
    },
  } as unknown as AwilixContainer
  return { container, row, interactions, mappings, calls, em }
}

function buildCtx(container: AwilixContainer, headers: Record<string, string> = {}): CommandRuntimeContext {
  return {
    container,
    auth: {
      sub: userId,
      tenantId: scope.tenantId,
      orgId: scope.organizationId,
    } as CommandRuntimeContext['auth'],
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    request: new Request('http://localhost/api/webhook_calcom/unassigned-transcripts', { headers }),
  }
}

function handler<TInput, TResult>(id: string): CommandHandler<TInput, TResult> {
  const found = commandRegistry.get(id)
  if (!found) throw new Error(`command ${id} not registered`)
  return found as CommandHandler<TInput, TResult>
}

const assign = handler<{ id: string; personId: string }, UnassignedTranscriptAssignResult>(UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID)
const dismiss = handler<{ body?: Record<string, unknown>; query?: Record<string, unknown> }, UnassignedTranscriptDismissResult>(
  UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID,
)

async function expectHttpError(promise: Promise<unknown> | unknown, status: number): Promise<Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    if (!isCrudHttpError(error)) throw error
    expect(error.status).toBe(status)
    return error.body
  }
  throw new Error('expected command to fail')
}

describe('webhook_calcom unassigned transcript commands', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('registers both commands as non-undoable', () => {
    expect(assign.isUndoable).toBe(false)
    expect(dismiss.isUndoable).toBe(false)
  })

  it('assigns the transcript by creating a meeting for the chosen person', async () => {
    const harness = buildHarness()
    const ctx = buildCtx(harness.container, { [OPTIMISTIC_LOCK_HEADER_NAME]: rowUpdatedAt.toISOString() })
    const result = await assign.execute({ id: rowId, personId }, ctx)

    expect(result).toEqual({ id: rowId, interactionId, attachmentId, resolvedEntityId: personId, transcriptId })
    expect(harness.calls.map((call) => call.commandId)).toEqual([
      'customers.interactions.create',
      'customers.comments.create',
      'customers.interactions.complete',
    ])
    expect(harness.calls[0].input).toMatchObject({ id: interactionId, entityId: personId })
    for (const call of harness.calls) {
      expect(call.ctx.auth?.sub).toBe(userId)
      expect(call.ctx.request).toBeUndefined()
    }
    expect(harness.mappings.get(`customers:customer_interaction|${uid}`)).toBe(interactionId)
    expect(harness.mappings.get(`attachments:attachment|${calcomTranscriptExternalId(uid, transcriptId)}`)).toBe(attachmentId)
    expect(createAttachment.mock.calls[0][0]).toMatchObject({ recordId: personId, ...scope })
    expect(harness.row).toMatchObject({
      status: 'resolved',
      resolvedBy: userId,
      resolvedEntityId: personId,
      resolvedToInteractionId: interactionId,
      resolvedAttachmentId: attachmentId,
    })
    expect(harness.row?.resolvedAt).toBeInstanceOf(Date)
    expect(harness.em.flush).toHaveBeenCalledTimes(1)
    expect(emitEvent).toHaveBeenCalledWith(
      'webhook_calcom.unassigned_transcript.resolved',
      { id: rowId, ...scope, transcriptId, resolvedEntityId: personId },
      { persistent: true, ...scope },
    )
  })

  it('reuses the meeting when the booking arrived after the transcript was queued', async () => {
    const harness = buildHarness({
      interaction: { id: interactionId, status: 'planned', entityId: otherPersonId, deletedAt: null },
    })
    const result = await assign.execute({ id: rowId, personId }, buildCtx(harness.container))

    expect(result).toMatchObject({ interactionId, resolvedEntityId: otherPersonId, attachmentId })
    expect(harness.calls.map((call) => call.commandId)).toEqual([
      'customers.comments.create',
      'customers.interactions.complete',
    ])
    expect(createAttachment.mock.calls[0][0]).toMatchObject({ recordId: otherPersonId })
    expect(harness.row).toMatchObject({ status: 'resolved', resolvedToInteractionId: interactionId })
  })

  it('rejects a stale optimistic-lock token with a 409 and leaves the row pending', async () => {
    const harness = buildHarness()
    const ctx = buildCtx(harness.container, { [OPTIMISTIC_LOCK_HEADER_NAME]: '2026-11-01T00:00:00.000Z' })
    const body = await expectHttpError(assign.execute({ id: rowId, personId }, ctx), 409)

    expect(body).toMatchObject({ currentUpdatedAt: rowUpdatedAt.toISOString() })
    expect(harness.calls).toHaveLength(0)
    expect(harness.row?.status).toBe('pending')
    expect(emitEvent).not.toHaveBeenCalled()
  })

  it('rejects a transcript that is no longer pending', async () => {
    const harness = buildHarness({ row: { status: 'resolved' } })
    const body = await expectHttpError(assign.execute({ id: rowId, personId }, buildCtx(harness.container)), 409)

    expect(body.error).toBe('This transcript has already been handled')
    expect(harness.calls).toHaveLength(0)
  })

  it('returns 404 when the transcript does not exist', async () => {
    const harness = buildHarness({ row: null })
    const body = await expectHttpError(assign.execute({ id: rowId, personId }, buildCtx(harness.container)), 404)
    expect(body.error).toBe('Transcript not found')
  })

  it('returns 404 when the person is missing from the organization', async () => {
    const harness = buildHarness({ personExists: false })
    const body = await expectHttpError(assign.execute({ id: rowId, personId }, buildCtx(harness.container)), 404)

    expect(body.error).toBe('Person not found')
    expect(harness.calls).toHaveLength(0)
    expect(createAttachment).not.toHaveBeenCalled()
    expect(harness.row?.status).toBe('pending')
  })

  it('dismisses a pending transcript using the makeCrudRoute delete input shape', async () => {
    const harness = buildHarness()
    const ctx = buildCtx(harness.container, { [OPTIMISTIC_LOCK_HEADER_NAME]: rowUpdatedAt.toISOString() })
    const result = await dismiss.execute({ body: {}, query: { id: rowId } }, ctx)

    expect(result).toEqual({ id: rowId })
    expect(harness.row).toMatchObject({ status: 'dismissed', resolvedBy: userId })
    expect(harness.row?.deletedAt).toBeInstanceOf(Date)
    expect(harness.em.flush).toHaveBeenCalledTimes(1)
    expect(harness.calls).toHaveLength(0)
  })

  it('rejects dismissing with a stale optimistic-lock token', async () => {
    const harness = buildHarness()
    const ctx = buildCtx(harness.container, { [OPTIMISTIC_LOCK_HEADER_NAME]: '2026-11-01T00:00:00.000Z' })
    await expectHttpError(dismiss.execute({ query: { id: rowId } }, ctx), 409)
    expect(harness.row?.status).toBe('pending')
  })
})
