import type { AwilixContainer } from 'awilix'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import bookingCreated from './fixtures/booking-created.json'
import bookingRescheduled from './fixtures/booking-rescheduled.json'
import bookingCancelled from './fixtures/booking-cancelled.json'
import meetingEnded from './fixtures/meeting-ended.json'
import { createCalcomInteraction, syncCalcomBooking, resolveCalcomInteraction } from '../lib/booking-sync'
import { excludeStaffAttendees, resolveCalcomCustomers, resolveOrganizerUser } from '../lib/people'
import { calcomInteractionId } from '../lib/ids'
import { parseCalcomWebhook } from '../lib/payload'
import type { CalcomCredentials } from '../lib/credentials'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))
jest.mock('../lib/people', () => ({
  excludeStaffAttendees: jest.fn(),
  resolveCalcomCustomers: jest.fn(),
  resolveOrganizerUser: jest.fn(),
}))

type Body = Record<string, unknown>
type StoredInteraction = { id: string; status: string; entityId: string; deletedAt: Date | null }
type CommandCall = { commandId: string; input: Record<string, unknown> }

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }
const personId = '33333333-3333-4333-8333-333333333333'
const userId = '44444444-4444-4444-8444-444444444444'
const credentials: CalcomCredentials = {
  webhookSecret: 'secret',
  instanceUrl: 'https://cal.example.com',
  unmatchedAttendeePolicy: 'create_person',
}

const findOne = findOneWithDecryption as jest.Mock
const resolveCustomers = resolveCalcomCustomers as jest.Mock
const resolveOrganizer = resolveOrganizerUser as jest.Mock
const excludeStaff = excludeStaffAttendees as jest.Mock

function buildHarness(options: { enabled?: boolean } = {}) {
  const interactions = new Map<string, StoredInteraction>()
  const mappings = new Map<string, string>()
  const calls: CommandCall[] = []
  const logs: Array<Record<string, unknown>> = []

  findOne.mockImplementation(async (_em: unknown, _entity: unknown, where: { id: string; tenantId: string }) => {
    const stored = interactions.get(where.id)
    if (!stored || where.tenantId !== scope.tenantId) return null
    return { id: stored.id, status: stored.status, entity: { id: stored.entityId }, deletedAt: stored.deletedAt }
  })

  const execute = jest.fn(async (commandId: string, { input }: { input: Record<string, unknown> }) => {
    calls.push({ commandId, input })
    const id = String(input.id)
    if (commandId === 'customers.interactions.create') {
      interactions.set(id, { id, status: 'planned', entityId: String(input.entityId), deletedAt: null })
      return { result: { interactionId: id, entityId: input.entityId }, logEntry: null }
    }
    const stored = interactions.get(id)
    if (stored && commandId === 'customers.interactions.cancel') stored.status = 'canceled'
    if (stored && commandId === 'customers.interactions.complete') stored.status = 'done'
    return { result: { interactionId: id }, logEntry: null }
  })

  const tx = { getConnection: () => ({ execute: jest.fn().mockResolvedValue([]) }) }
  const em = { transactional: jest.fn(async (run: (trx: typeof tx) => Promise<unknown>) => run(tx)) }

  const services: Record<string, unknown> = {
    em,
    commandBus: { execute },
    externalIdMappingService: {
      lookupLocalId: jest.fn(async (_integration: string, _entity: string, uid: string) => mappings.get(uid) ?? null),
      storeExternalIdMapping: jest.fn(async (_integration: string, _entity: string, localId: string, uid: string) => {
        mappings.set(uid, localId)
      }),
    },
    integrationStateService: { isEnabled: jest.fn().mockResolvedValue(options.enabled ?? true) },
    integrationLogService: { write: jest.fn(async (entry: Record<string, unknown>) => { logs.push(entry) }) },
  }
  const container = { resolve: (name: string) => services[name] } as unknown as AwilixContainer
  return { container, interactions, mappings, calls, logs, em, services }
}

function bookingOf(body: Body) {
  return parseCalcomWebhook(body).booking
}

function sync(container: AwilixContainer, trigger: string, body: Body, overrides: Partial<CalcomCredentials> = {}) {
  return syncCalcomBooking(container, {
    trigger,
    booking: bookingOf(body),
    scope,
    credentials: { ...credentials, ...overrides },
    fallbackTitle: 'Meeting',
  })
}

describe('syncCalcomBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveCustomers.mockResolvedValue({ primaryEntityId: personId, linkedEntities: [], createdPersonId: null })
    resolveOrganizer.mockResolvedValue({ id: userId, name: 'Piotr Host' })
    excludeStaff.mockImplementation(async (_em: unknown, _scope: unknown, attendees: unknown[]) => attendees)
  })

  it('removes CRM staff from attendees before resolving customers', async () => {
    const harness = buildHarness()
    excludeStaff.mockImplementation(async (_em: unknown, _scope: unknown, attendees: Array<{ email: string }>) =>
      attendees.filter((attendee) => attendee.email !== 'anna@example.com'),
    )
    await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    expect(excludeStaff).toHaveBeenCalledWith(harness.em, scope, bookingOf(bookingCreated as Body).attendees)
    expect(resolveCustomers.mock.calls[0][2].map((attendee: { email: string }) => attendee.email)).toEqual(['ben@example.com'])
  })

  it('creates a planned meeting with the deterministic id and maps the uid', async () => {
    const harness = buildHarness()
    const outcome = await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    const expectedId = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    expect(outcome).toEqual({ action: 'created', interactionId: expectedId })
    expect(harness.calls).toHaveLength(1)
    const [call] = harness.calls
    expect(call.commandId).toBe('customers.interactions.create')
    expect(call.input).toMatchObject({
      id: expectedId,
      entityId: personId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      interactionType: 'meeting',
      status: 'planned',
      ownerUserId: userId,
    })
    expect(harness.mappings.get('bk-uid-1')).toBe(expectedId)
    expect(harness.em.transactional).toHaveBeenCalledTimes(1)
    expect(harness.logs[0]).toMatchObject({ level: 'info', code: 'calcom.booking.created', scopeEntityId: expectedId })
  })

  it('treats a replayed BOOKING_CREATED as an update without a duplicate create', async () => {
    const harness = buildHarness()
    await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    const outcome = await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    expect(outcome.action).toBe('updated')
    const commandIds = harness.calls.map((call) => call.commandId)
    expect(commandIds).toEqual(['customers.interactions.create', 'customers.interactions.update'])
    const update = harness.calls[1].input
    expect(update).not.toHaveProperty('status')
    expect(update).not.toHaveProperty('title')
    expect(update).toHaveProperty('scheduledAt')
    expect(update).toHaveProperty('participants')
  })

  it('re-keys a rescheduled booking onto the existing interaction', async () => {
    const harness = buildHarness()
    await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    const originalId = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    const outcome = await sync(harness.container, 'BOOKING_RESCHEDULED', bookingRescheduled as Body)
    expect(outcome).toEqual({ action: 'updated', interactionId: originalId })
    expect(harness.calls[1].commandId).toBe('customers.interactions.update')
    expect(harness.calls[1].input).toMatchObject({ id: originalId, scheduledAt: '2026-11-12T14:00:00.000Z' })
    expect(harness.mappings.get('bk-uid-2')).toBe(originalId)
  })

  it('creates an unknown rescheduled booking keyed by the new uid and maps both uids', async () => {
    const harness = buildHarness()
    const outcome = await sync(harness.container, 'BOOKING_RESCHEDULED', bookingRescheduled as Body)
    const newId = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-2')
    expect(outcome).toEqual({ action: 'created', interactionId: newId })
    expect(harness.mappings.get('bk-uid-1')).toBe(newId)
    expect(harness.mappings.get('bk-uid-2')).toBe(newId)
  })

  it('creates then cancels when a cancellation arrives before the booking', async () => {
    const harness = buildHarness()
    const outcome = await sync(harness.container, 'BOOKING_CANCELLED', bookingCancelled as Body)
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-2')
    expect(outcome).toEqual({ action: 'canceled', interactionId: id })
    expect(harness.calls.map((call) => call.commandId)).toEqual([
      'customers.interactions.create',
      'customers.interactions.cancel',
    ])
    expect(harness.calls[1].input).toEqual({ id })
  })

  it('does not cancel an already canceled interaction again', async () => {
    const harness = buildHarness()
    await sync(harness.container, 'BOOKING_CANCELLED', bookingCancelled as Body)
    const outcome = await sync(harness.container, 'BOOKING_REJECTED', bookingCancelled as Body)
    expect(outcome).toMatchObject({ action: 'skipped', reason: 'already_canceled' })
    expect(harness.calls).toHaveLength(2)
  })

  it('completes a known meeting on MEETING_ENDED using endTime', async () => {
    const harness = buildHarness()
    await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    const outcome = await sync(harness.container, 'MEETING_ENDED', meetingEnded as Body)
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    expect(outcome).toEqual({ action: 'completed', interactionId: id })
    expect(harness.calls[1]).toEqual({
      commandId: 'customers.interactions.complete',
      input: { id, occurredAt: '2026-11-10T10:30:00.000Z' },
    })
  })

  it('skips MEETING_ENDED for an unknown booking', async () => {
    const harness = buildHarness()
    const outcome = await sync(harness.container, 'MEETING_ENDED', meetingEnded as Body)
    expect(outcome).toEqual({ action: 'skipped', interactionId: null, reason: 'booking_not_found' })
    expect(harness.calls).toHaveLength(0)
  })

  it('skips a soft-deleted interaction', async () => {
    const harness = buildHarness()
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    harness.interactions.set(id, { id, status: 'planned', entityId: personId, deletedAt: new Date() })
    const outcome = await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    expect(outcome).toEqual({ action: 'skipped', interactionId: id, reason: 'soft_deleted' })
    expect(harness.calls).toHaveLength(0)
  })

  it('skips when no attendee matches and the policy is skip', async () => {
    const harness = buildHarness()
    resolveCustomers.mockResolvedValue({ primaryEntityId: null, linkedEntities: [], createdPersonId: null })
    const outcome = await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body, { unmatchedAttendeePolicy: 'skip' })
    expect(outcome).toEqual({ action: 'skipped', interactionId: null, reason: 'no_matching_attendee' })
    expect(resolveCustomers.mock.calls[0][3]).toBe('skip')
    expect(harness.calls).toHaveLength(0)
  })

  it('skips when the integration is disabled', async () => {
    const harness = buildHarness({ enabled: false })
    const outcome = await sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)
    expect(outcome).toEqual({ action: 'skipped', interactionId: null, reason: 'integration_disabled' })
    expect(harness.em.transactional).not.toHaveBeenCalled()
    expect(harness.calls).toHaveLength(0)
  })

  it('ignores other booking triggers', async () => {
    const harness = buildHarness()
    const outcome = await sync(harness.container, 'BOOKING_PAID', bookingCreated as Body)
    expect(outcome).toEqual({ action: 'skipped', interactionId: null, reason: 'ignored' })
  })

  it('logs and rethrows command failures', async () => {
    const harness = buildHarness()
    const failure = new Error('boom')
    ;(harness.services.commandBus as { execute: jest.Mock }).execute.mockRejectedValueOnce(failure)
    await expect(sync(harness.container, 'BOOKING_CREATED', bookingCreated as Body)).rejects.toBe(failure)
    expect(harness.logs[0]).toMatchObject({ level: 'error', code: 'calcom.booking.failed' })
  })
})

describe('resolveCalcomInteraction', () => {
  it('falls back to the deterministic id when no mapping exists', async () => {
    const harness = buildHarness()
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-9')
    harness.interactions.set(id, { id, status: 'done', entityId: personId, deletedAt: null })
    const deps = {
      em: harness.services.em as never,
      externalIdMappingService: { lookupLocalId: jest.fn().mockResolvedValue(null) },
    }
    const out = await resolveCalcomInteraction(deps, scope, ['missing', 'bk-uid-9'])
    expect(out).toEqual({ interaction: { id, status: 'done', entityId: personId, deletedAt: null }, matchedUid: 'bk-uid-9' })
  })
})

describe('createCalcomInteraction', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveOrganizer.mockResolvedValue({ id: userId, name: 'Piotr Host' })
  })

  function runtimeOf(harness: ReturnType<typeof buildHarness>) {
    return {
      em: harness.services.em as never,
      commandBus: harness.services.commandBus as never,
      commandCtx: {} as never,
      externalIdMappingService: harness.services.externalIdMappingService as never,
      scope,
      booking: bookingOf(bookingCreated as Body),
      fallbackTitle: 'Meeting',
    }
  }

  it('creates with the deterministic id and maps every uid', async () => {
    const harness = buildHarness()
    const out = await createCalcomInteraction(runtimeOf(harness), {
      keyUid: 'bk-uid-1',
      uids: ['bk-uid-1', 'bk-uid-0'],
      entityId: personId,
      linkedEntities: [],
    })
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    expect(out).toEqual({ interactionId: id, existing: false })
    expect(harness.calls[0]).toMatchObject({ commandId: 'customers.interactions.create', input: { id, entityId: personId } })
    expect(harness.mappings.get('bk-uid-1')).toBe(id)
    expect(harness.mappings.get('bk-uid-0')).toBe(id)
  })

  it('reports an existing interaction on a primary-key clash', async () => {
    const harness = buildHarness()
    const id = calcomInteractionId(scope.tenantId, scope.organizationId, 'bk-uid-1')
    harness.interactions.set(id, { id, status: 'planned', entityId: personId, deletedAt: null })
    ;(harness.services.commandBus as { execute: jest.Mock }).execute.mockRejectedValueOnce({ code: '23505' })
    const out = await createCalcomInteraction(runtimeOf(harness), {
      keyUid: 'bk-uid-1',
      uids: ['bk-uid-1'],
      entityId: personId,
      linkedEntities: [],
    })
    expect(out).toEqual({ interactionId: id, existing: true })
    expect(harness.mappings.get('bk-uid-1')).toBe(id)
  })
})
