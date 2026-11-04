import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { z } from 'zod'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerInteraction } from '@open-mercato/core/modules/customers/data/entities'
import type {
  interactionCancelSchema,
  interactionCompleteSchema,
  interactionCreateSchema,
  interactionUpdateSchema,
} from '@open-mercato/core/modules/customers/data/validators'
import {
  INTERACTION_STATUS_CANCELED,
  isTerminalInteractionStatus,
} from '@open-mercato/core/modules/customers/lib/interactionStatus'
import type { ExternalIdMappingService } from '@open-mercato/core/modules/data_sync/lib/id-mapping'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import { CALCOM_INTEGRATION_ID } from '../integration'
import {
  mapBookingToInteraction,
  pickSchedulingFields,
  type CalcomInteractionFields,
  type CalcomInteractionParticipant,
  type CalcomLinkedEntity,
} from './booking-mapper'
import { buildCalcomCommandContext } from './command-context'
import { CALCOM_INTERACTION_ENTITY } from './constants'
import type { CalcomCredentials } from './credentials'
import { calcomInteractionId } from './ids'
import { withCalcomLock } from './locking'
import { extractBookingUid, type CalcomBooking } from './payload'
import { excludeStaffAttendees, resolveCalcomCustomers, resolveOrganizerUser } from './people'

export type CalcomSyncScope = { tenantId: string; organizationId: string }

export type CalcomSyncAction = 'created' | 'updated' | 'canceled' | 'completed' | 'skipped'

export type CalcomSyncOutcome = {
  action: CalcomSyncAction
  interactionId: string | null
  reason?: string
}

export type CalcomResolvedInteraction = {
  id: string
  status: string
  entityId: string
  deletedAt: Date | null
}

export type CalcomInteractionResolution = {
  interaction: CalcomResolvedInteraction | null
  matchedUid: string | null
}

export type CalcomInteractionLookupDeps = {
  em: EntityManager
  externalIdMappingService: Pick<ExternalIdMappingService, 'lookupLocalId'>
}

export type CalcomBookingSyncInput = {
  trigger: string
  booking: CalcomBooking
  scope: CalcomSyncScope
  credentials: CalcomCredentials
  fallbackTitle: string
}

type InteractionCreateInput = z.input<typeof interactionCreateSchema>
type InteractionUpdateInput = z.input<typeof interactionUpdateSchema>
type InteractionCancelInput = z.input<typeof interactionCancelSchema>
type InteractionCompleteInput = z.input<typeof interactionCompleteSchema>

export type CalcomInteractionCreateRuntime = {
  em: EntityManager
  commandBus: CommandBus
  commandCtx: CommandRuntimeContext
  externalIdMappingService: Pick<ExternalIdMappingService, 'storeExternalIdMapping'>
  scope: CalcomSyncScope
  booking: CalcomBooking
  fallbackTitle: string
}

export type CalcomInteractionCreateInput = {
  keyUid: string
  uids: string[]
  entityId: string
  linkedEntities: CalcomLinkedEntity[]
}

export type CalcomInteractionCreateResult = { interactionId: string; existing: boolean }

type SyncRuntime = CalcomInteractionCreateRuntime & {
  externalIdMappingService: Pick<ExternalIdMappingService, 'lookupLocalId' | 'storeExternalIdMapping'>
  credentials: CalcomCredentials
}

const CREATE_TRIGGERS = new Set(['BOOKING_CREATED', 'BOOKING_REQUESTED'])
const CANCEL_TRIGGERS = new Set(['BOOKING_CANCELLED', 'BOOKING_REJECTED'])
const RESCHEDULE_TRIGGER = 'BOOKING_RESCHEDULED'
const MEETING_ENDED_TRIGGER = 'MEETING_ENDED'
const MAX_ORGANIZER_NAME_LENGTH = 200
const UNIQUE_VIOLATION_CODE = '23505'

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function toResolvedInteraction(interaction: CustomerInteraction): CalcomResolvedInteraction {
  const entity = interaction.entity as CustomerInteraction['entity'] | string
  return {
    id: interaction.id,
    status: interaction.status,
    entityId: typeof entity === 'string' ? entity : entity.id,
    deletedAt: interaction.deletedAt ?? null,
  }
}

async function loadInteraction(
  em: EntityManager,
  scope: CalcomSyncScope,
  id: string,
): Promise<CalcomResolvedInteraction | null> {
  const interaction = await findOneWithDecryption(
    em,
    CustomerInteraction,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  return interaction ? toResolvedInteraction(interaction) : null
}

export async function resolveCalcomInteraction(
  deps: CalcomInteractionLookupDeps,
  scope: CalcomSyncScope,
  uids: string[],
): Promise<CalcomInteractionResolution> {
  for (const uid of uids) {
    const mappedId = await deps.externalIdMappingService.lookupLocalId(
      CALCOM_INTEGRATION_ID,
      CALCOM_INTERACTION_ENTITY,
      uid,
      scope,
    )
    const mapped = mappedId ? await loadInteraction(deps.em, scope, mappedId) : null
    if (mapped) return { interaction: mapped, matchedUid: uid }
    const deterministicId = calcomInteractionId(scope.tenantId, scope.organizationId, uid)
    if (deterministicId === mappedId) continue
    const deterministic = await loadInteraction(deps.em, scope, deterministicId)
    if (deterministic) return { interaction: deterministic, matchedUid: uid }
  }
  return { interaction: null, matchedUid: null }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { name?: unknown; code?: unknown }
  return record.name === 'UniqueConstraintViolationException' || record.code === UNIQUE_VIOLATION_CODE
}

async function storeMappings(
  runtime: CalcomInteractionCreateRuntime,
  interactionId: string,
  uids: string[],
): Promise<void> {
  for (const uid of uids) {
    await runtime.externalIdMappingService.storeExternalIdMapping(
      CALCOM_INTEGRATION_ID,
      CALCOM_INTERACTION_ENTITY,
      interactionId,
      uid,
      runtime.scope,
    )
  }
}

async function buildOrganizerParticipant(
  runtime: CalcomInteractionCreateRuntime,
): Promise<{ participant: CalcomInteractionParticipant; ownerUserId: string | null }> {
  const email = nonEmpty(runtime.booking.organizer?.email)
  const user = email ? await resolveOrganizerUser(runtime.em, runtime.scope, email) : null
  const name = (nonEmpty(runtime.booking.organizer?.name) ?? nonEmpty(user?.name))?.slice(0, MAX_ORGANIZER_NAME_LENGTH)
  const participant: CalcomInteractionParticipant = {
    ...(user ? { userId: user.id } : {}),
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  }
  return { participant, ownerUserId: user?.id ?? null }
}

async function buildInteractionFields(
  runtime: CalcomInteractionCreateRuntime,
  entityId: string,
  linkedEntities: CalcomLinkedEntity[],
): Promise<CalcomInteractionFields> {
  const { participant, ownerUserId } = await buildOrganizerParticipant(runtime)
  const fields = mapBookingToInteraction(runtime.booking, {
    entityId,
    linkedEntities,
    ownerUserId,
    organizerParticipant: participant,
    fallbackTitle: runtime.fallbackTitle,
  })
  return {
    ...fields,
    participants: fields.participants.filter((entry) => Boolean(entry.userId || entry.email)),
  }
}

async function updateScheduling(
  runtime: SyncRuntime,
  interaction: CalcomResolvedInteraction,
): Promise<void> {
  const fields = await buildInteractionFields(runtime, interaction.entityId, [])
  const scheduling = pickSchedulingFields(fields)
  const input: InteractionUpdateInput = {
    id: interaction.id,
    organizationId: runtime.scope.organizationId,
    tenantId: runtime.scope.tenantId,
    participants: scheduling.participants,
    ...(scheduling.scheduledAt !== null ? { scheduledAt: scheduling.scheduledAt } : {}),
    ...(scheduling.durationMinutes !== null ? { durationMinutes: scheduling.durationMinutes } : {}),
    ...(scheduling.timezone !== null ? { timezone: scheduling.timezone } : {}),
    ...(scheduling.location !== null ? { location: scheduling.location } : {}),
  }
  await runtime.commandBus.execute<InteractionUpdateInput, { interactionId: string }>(
    'customers.interactions.update',
    { input, ctx: runtime.commandCtx },
  )
}

async function updateExisting(
  runtime: SyncRuntime,
  interaction: CalcomResolvedInteraction,
  uids: string[],
): Promise<CalcomSyncOutcome> {
  if (interaction.deletedAt) return { action: 'skipped', interactionId: interaction.id, reason: 'soft_deleted' }
  await updateScheduling(runtime, interaction)
  await storeMappings(runtime, interaction.id, uids)
  return { action: 'updated', interactionId: interaction.id }
}

async function insertInteraction(
  runtime: CalcomInteractionCreateRuntime,
  { keyUid, uids, entityId, linkedEntities }: CalcomInteractionCreateInput,
): Promise<{ interactionId: string; existing: CalcomResolvedInteraction | null }> {
  const fields = await buildInteractionFields(runtime, entityId, linkedEntities)
  const interactionId = calcomInteractionId(runtime.scope.tenantId, runtime.scope.organizationId, keyUid)
  const input: InteractionCreateInput = {
    ...fields,
    id: interactionId,
    organizationId: runtime.scope.organizationId,
    tenantId: runtime.scope.tenantId,
  }
  try {
    await runtime.commandBus.execute<InteractionCreateInput, { interactionId: string; entityId: string }>(
      'customers.interactions.create',
      { input, ctx: runtime.commandCtx },
    )
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const existing = await loadInteraction(runtime.em, runtime.scope, interactionId)
    if (!existing) throw error
    return { interactionId, existing }
  }
  await storeMappings(runtime, interactionId, uids)
  return { interactionId, existing: null }
}

export async function createCalcomInteraction(
  runtime: CalcomInteractionCreateRuntime,
  input: CalcomInteractionCreateInput,
): Promise<CalcomInteractionCreateResult> {
  const { interactionId, existing } = await insertInteraction(runtime, input)
  if (!existing) return { interactionId, existing: false }
  if (!existing.deletedAt) await storeMappings(runtime, interactionId, input.uids)
  return { interactionId, existing: true }
}

async function createInteraction(
  runtime: SyncRuntime,
  keyUid: string,
  uids: string[],
): Promise<CalcomSyncOutcome> {
  const attendees = await excludeStaffAttendees(runtime.em, runtime.scope, runtime.booking.attendees ?? [])
  const customers = await resolveCalcomCustomers(
    { em: runtime.em, commandBus: runtime.commandBus, commandCtx: runtime.commandCtx },
    runtime.scope,
    attendees,
    runtime.credentials.unmatchedAttendeePolicy,
  )
  if (!customers.primaryEntityId) {
    return { action: 'skipped', interactionId: null, reason: 'no_matching_attendee' }
  }
  const { interactionId, existing } = await insertInteraction(runtime, {
    keyUid,
    uids,
    entityId: customers.primaryEntityId,
    linkedEntities: customers.linkedEntities,
  })
  if (existing) return updateExisting(runtime, existing, uids)
  return { action: 'created', interactionId }
}

async function upsertBooking(
  runtime: SyncRuntime,
  lookupUids: string[],
  keyUid: string,
  mapUids: string[],
): Promise<{ outcome: CalcomSyncOutcome; interaction: CalcomResolvedInteraction | null }> {
  const { interaction } = await resolveCalcomInteraction(
    runtime,
    runtime.scope,
    lookupUids,
  )
  if (interaction) return { outcome: await updateExisting(runtime, interaction, mapUids), interaction }
  const outcome = await createInteraction(runtime, keyUid, mapUids)
  return { outcome, interaction: null }
}

async function cancelBooking(runtime: SyncRuntime, uid: string): Promise<CalcomSyncOutcome> {
  const resolution = await resolveCalcomInteraction(
    runtime,
    runtime.scope,
    [uid],
  )
  let interactionId: string
  if (resolution.interaction) {
    const { interaction } = resolution
    if (interaction.deletedAt) return { action: 'skipped', interactionId: interaction.id, reason: 'soft_deleted' }
    if (interaction.status === INTERACTION_STATUS_CANCELED) {
      return { action: 'skipped', interactionId: interaction.id, reason: 'already_canceled' }
    }
    if (isTerminalInteractionStatus(interaction.status)) {
      return { action: 'skipped', interactionId: interaction.id, reason: 'already_terminal' }
    }
    interactionId = interaction.id
  } else {
    const created = await createInteraction(runtime, uid, [uid])
    if (created.action === 'skipped' || !created.interactionId) return created
    interactionId = created.interactionId
  }
  const input: InteractionCancelInput = { id: interactionId }
  await runtime.commandBus.execute<InteractionCancelInput, { interactionId: string }>(
    'customers.interactions.cancel',
    { input, ctx: runtime.commandCtx },
  )
  return { action: 'canceled', interactionId }
}

function resolveOccurredAt(booking: CalcomBooking): string {
  const end = booking.endTime ? new Date(booking.endTime) : null
  return end && !Number.isNaN(end.getTime()) ? end.toISOString() : new Date().toISOString()
}

async function completeBooking(runtime: SyncRuntime, uid: string): Promise<CalcomSyncOutcome> {
  const { interaction } = await resolveCalcomInteraction(
    runtime,
    runtime.scope,
    [uid],
  )
  if (!interaction) return { action: 'skipped', interactionId: null, reason: 'booking_not_found' }
  if (interaction.deletedAt) return { action: 'skipped', interactionId: interaction.id, reason: 'soft_deleted' }
  if (isTerminalInteractionStatus(interaction.status)) {
    return { action: 'skipped', interactionId: interaction.id, reason: 'already_terminal' }
  }
  const input: InteractionCompleteInput = { id: interaction.id, occurredAt: resolveOccurredAt(runtime.booking) }
  await runtime.commandBus.execute<InteractionCompleteInput, { interactionId: string }>(
    'customers.interactions.complete',
    { input, ctx: runtime.commandCtx },
  )
  return { action: 'completed', interactionId: interaction.id }
}

async function dispatchTrigger(runtime: SyncRuntime, trigger: string, uid: string): Promise<CalcomSyncOutcome> {
  if (CREATE_TRIGGERS.has(trigger)) {
    return (await upsertBooking(runtime, [uid], uid, [uid])).outcome
  }
  if (trigger === RESCHEDULE_TRIGGER) {
    const previousUid = nonEmpty(runtime.booking.rescheduleUid)
    const lookupUids = previousUid && previousUid !== uid ? [previousUid, uid] : [uid]
    return (await upsertBooking(runtime, lookupUids, uid, lookupUids)).outcome
  }
  if (CANCEL_TRIGGERS.has(trigger)) return cancelBooking(runtime, uid)
  if (trigger === MEETING_ENDED_TRIGGER) return completeBooking(runtime, uid)
  return { action: 'skipped', interactionId: null, reason: 'ignored' }
}

async function writeOutcomeLog(
  logService: Pick<IntegrationLogService, 'write'>,
  scope: CalcomSyncScope,
  trigger: string,
  uid: string | null,
  outcome: CalcomSyncOutcome,
): Promise<void> {
  const reasonSuffix = outcome.reason ? ` (${outcome.reason})` : ''
  await logService.write(
    {
      integrationId: CALCOM_INTEGRATION_ID,
      scopeEntityType: outcome.interactionId ? CALCOM_INTERACTION_ENTITY : null,
      scopeEntityId: outcome.interactionId,
      level: 'info',
      message: `Cal.com ${trigger} webhook ${outcome.action}${reasonSuffix}`,
      code: `calcom.booking.${outcome.action}`,
      payload: {
        trigger,
        bookingUid: uid,
        action: outcome.action,
        reason: outcome.reason ?? null,
        interactionId: outcome.interactionId,
      },
    },
    scope,
  )
}

export async function syncCalcomBooking(
  container: AwilixContainer,
  input: CalcomBookingSyncInput,
): Promise<CalcomSyncOutcome> {
  const { scope, booking } = input
  const trigger = input.trigger.trim().toUpperCase()
  const em = container.resolve('em') as EntityManager
  const commandBus = container.resolve('commandBus') as CommandBus
  const externalIdMappingService = container.resolve('externalIdMappingService') as SyncRuntime['externalIdMappingService']
  const stateService = container.resolve('integrationStateService') as Pick<IntegrationStateService, 'isEnabled'>
  const logService = container.resolve('integrationLogService') as Pick<IntegrationLogService, 'write'>
  const uid = extractBookingUid(booking)

  const run = async (): Promise<CalcomSyncOutcome> => {
    if (!(await stateService.isEnabled(CALCOM_INTEGRATION_ID, scope))) {
      return { action: 'skipped', interactionId: null, reason: 'integration_disabled' }
    }
    if (!uid) return { action: 'skipped', interactionId: null, reason: 'missing_uid' }
    const runtime: SyncRuntime = {
      em,
      commandBus,
      commandCtx: buildCalcomCommandContext(container, scope),
      externalIdMappingService,
      scope,
      booking,
      credentials: input.credentials,
      fallbackTitle: input.fallbackTitle,
    }
    return withCalcomLock(em, scope, () => dispatchTrigger(runtime, trigger, uid))
  }

  try {
    const outcome = await run()
    await writeOutcomeLog(logService, scope, trigger, uid, outcome)
    return outcome
  } catch (error) {
    await logService.write(
      {
        integrationId: CALCOM_INTEGRATION_ID,
        level: 'error',
        message: `Cal.com ${trigger} webhook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        code: 'calcom.booking.failed',
        payload: { trigger, bookingUid: uid },
      },
      scope,
    )
    throw error
  }
}
