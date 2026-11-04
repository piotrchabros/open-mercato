import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandBus, CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { requireId } from '@open-mercato/shared/lib/commands/helpers'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { conflict, forbidden, notFound } from '@open-mercato/shared/lib/crud/errors'
import {
  enforceCommandOptimisticLockWithGuards,
  enforceRecordGoneIsConflict,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { CreateAttachmentFromBufferInput } from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import type { ExternalIdMappingService } from '@open-mercato/core/modules/data_sync/lib/id-mapping'
import { CalcomUnassignedTranscript } from '../data/entities'
import {
  unassignedTranscriptAssignSchema,
  unassignedTranscriptDismissSchema,
  type UnassignedTranscriptAssignInput,
  type UnassignedTranscriptDismissInput,
} from '../data/validators'
import { emitWebhookCalcomEvent, type CalcomUnassignedTranscriptResolvedPayload } from '../events'
import {
  createCalcomInteraction,
  resolveCalcomInteraction,
  type CalcomResolvedInteraction,
  type CalcomSyncScope,
} from '../lib/booking-sync'
import { withCalcomLock } from '../lib/locking'
import { calcomBookingSchema, calcomNotetakerSchema } from '../lib/payload'
import { projectCalcomTranscript, type CalcomTranslate } from '../lib/transcript-sync'

export const UNASSIGNED_TRANSCRIPT_RESOURCE_KIND = 'webhook_calcom.unassigned_transcript'
export const UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID = 'webhook_calcom.unassigned_transcripts.assign'
export const UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID = 'webhook_calcom.unassigned_transcripts.dismiss'

export type UnassignedTranscriptAssignResult = {
  id: string
  interactionId: string
  attachmentId: string
  resolvedEntityId: string
  transcriptId: string
}

export type UnassignedTranscriptDismissResult = { id: string }

type DismissCommandInput = UnassignedTranscriptDismissInput | { body?: Record<string, unknown>; query?: Record<string, unknown> }

type Mappings = Pick<ExternalIdMappingService, 'lookupLocalId' | 'storeExternalIdMapping'>

function resolveCommandScope(ctx: CommandRuntimeContext): CalcomSyncScope {
  const tenantId = ctx.auth?.tenantId ?? ctx.organizationScope?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null
  if (!tenantId || !organizationId) throw forbidden()
  return { tenantId, organizationId }
}

function resolveDataEngine(ctx: CommandRuntimeContext): CreateAttachmentFromBufferInput['dataEngine'] {
  try {
    return ctx.container.resolve<CreateAttachmentFromBufferInput['dataEngine']>('dataEngine')
  } catch {
    return undefined
  }
}

function buildNestedCommandContext(ctx: CommandRuntimeContext): CommandRuntimeContext {
  return { ...ctx, request: undefined }
}

async function loadPendingTranscript(
  em: EntityManager,
  scope: CalcomSyncScope,
  id: string,
  ctx: CommandRuntimeContext,
  translate: CalcomTranslate,
): Promise<CalcomUnassignedTranscript> {
  const row = await findOneWithDecryption(
    em,
    CalcomUnassignedTranscript,
    { id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (!row) {
    enforceRecordGoneIsConflict({ resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND, resourceId: id, request: ctx.request ?? null })
    throw notFound(translate('webhook_calcom.inbox.errors.notFound', 'Transcript not found'))
  }
  ensureTenantScope(ctx, row.tenantId)
  ensureOrganizationScope(ctx, row.organizationId)
  await enforceCommandOptimisticLockWithGuards(ctx.container, {
    resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
    resourceId: row.id,
    current: row.updatedAt,
    request: ctx.request ?? null,
  })
  if (row.status !== 'pending') {
    throw conflict(translate('webhook_calcom.inbox.errors.notPending', 'This transcript has already been handled'))
  }
  return row
}

async function requirePerson(
  em: EntityManager,
  scope: CalcomSyncScope,
  personId: string,
  translate: CalcomTranslate,
): Promise<void> {
  const person = await findOneWithDecryption(
    em,
    CustomerEntity,
    { id: personId, tenantId: scope.tenantId, organizationId: scope.organizationId, kind: 'person', deletedAt: null },
    undefined,
    scope,
  )
  if (!person) throw notFound(translate('webhook_calcom.inbox.errors.personNotFound', 'Person not found'))
}

async function resolveTargetInteraction(
  em: EntityManager,
  ctx: CommandRuntimeContext,
  scope: CalcomSyncScope,
  row: CalcomUnassignedTranscript,
  personId: string,
  translate: CalcomTranslate,
): Promise<CalcomResolvedInteraction> {
  const mappings = ctx.container.resolve('externalIdMappingService') as Mappings
  const bookingUid = row.bookingUid
  if (!bookingUid) throw new Error('[internal] Unassigned Cal.com transcript has no booking uid')
  const lookup = { em, externalIdMappingService: mappings }
  const found = await resolveCalcomInteraction(lookup, scope, [bookingUid])
  if (found.interaction && !found.interaction.deletedAt) return found.interaction

  if (!found.interaction) {
    await createCalcomInteraction(
      {
        em,
        commandBus: ctx.container.resolve('commandBus') as CommandBus,
        commandCtx: buildNestedCommandContext(ctx),
        externalIdMappingService: mappings,
        scope,
        booking: calcomBookingSchema.parse(row.payload.booking),
        fallbackTitle: translate('webhook_calcom.interaction.defaultTitle', 'Meeting'),
      },
      { keyUid: bookingUid, uids: [bookingUid], entityId: personId, linkedEntities: [] },
    )
  }
  const { interaction } = await resolveCalcomInteraction(lookup, scope, [bookingUid])
  if (!interaction) throw new Error('[internal] Cal.com interaction missing after create')
  if (interaction.deletedAt) {
    throw conflict(translate('webhook_calcom.inbox.errors.interactionDeleted', 'The meeting for this transcript was deleted'))
  }
  return interaction
}

async function emitResolved(scope: CalcomSyncScope, result: UnassignedTranscriptAssignResult): Promise<void> {
  const payload: CalcomUnassignedTranscriptResolvedPayload = {
    id: result.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    transcriptId: result.transcriptId,
    resolvedEntityId: result.resolvedEntityId,
  }
  await emitWebhookCalcomEvent('webhook_calcom.unassigned_transcript.resolved', payload, {
    persistent: true,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}

const assignUnassignedTranscriptCommand: CommandHandler<UnassignedTranscriptAssignInput, UnassignedTranscriptAssignResult> = {
  id: UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID,
  isUndoable: false,

  async execute(rawInput, ctx) {
    const input = unassignedTranscriptAssignSchema.parse(rawInput)
    const scope = resolveCommandScope(ctx)
    const { translate } = await resolveTranslations()
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const result = await withCalcomLock(em, scope, async () => {
      const row = await loadPendingTranscript(em, scope, input.id, ctx, translate)
      await requirePerson(em, scope, input.personId, translate)
      const interaction = await resolveTargetInteraction(em, ctx, scope, row, input.personId, translate)
      const projection = await projectCalcomTranscript(
        {
          em,
          commandBus: ctx.container.resolve('commandBus') as CommandBus,
          commandCtx: buildNestedCommandContext(ctx),
          mappings: ctx.container.resolve('externalIdMappingService') as Mappings,
          dataEngine: resolveDataEngine(ctx),
          scope,
        },
        interaction,
        {
          booking: calcomBookingSchema.parse(row.payload.booking),
          notetaker: calcomNotetakerSchema.parse(row.payload.notetaker),
          translate,
        },
      )
      row.status = 'resolved'
      row.resolvedAt = new Date()
      row.resolvedBy = ctx.auth?.sub ?? null
      row.resolvedEntityId = interaction.entityId
      row.resolvedToInteractionId = interaction.id
      row.resolvedAttachmentId = projection.attachmentId
      await em.flush()
      return {
        id: row.id,
        interactionId: interaction.id,
        attachmentId: projection.attachmentId,
        resolvedEntityId: interaction.entityId,
        transcriptId: row.transcriptId,
      }
    })

    await emitResolved(scope, result)
    return result
  },

  async buildLog({ result, ctx }) {
    const { translate } = await resolveTranslations()
    const scope = resolveCommandScope(ctx)
    return {
      actionLabel: translate('webhook_calcom.audit.unassignedTranscripts.assign', 'Assign meeting transcript'),
      resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      relatedResourceKind: 'customers.interaction',
      relatedResourceId: result.interactionId,
    }
  },
}

const dismissUnassignedTranscriptCommand: CommandHandler<DismissCommandInput, UnassignedTranscriptDismissResult> = {
  id: UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID,
  isUndoable: false,

  async execute(rawInput, ctx) {
    const input = unassignedTranscriptDismissSchema.parse({ id: requireId(rawInput, '[internal] Transcript id required') })
    const scope = resolveCommandScope(ctx)
    const { translate } = await resolveTranslations()
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    return withCalcomLock(em, scope, async () => {
      const row = await loadPendingTranscript(em, scope, input.id, ctx, translate)
      const now = new Date()
      row.status = 'dismissed'
      row.resolvedAt = now
      row.resolvedBy = ctx.auth?.sub ?? null
      row.deletedAt = now
      await em.flush()
      return { id: row.id }
    })
  },

  async buildLog({ result, ctx }) {
    const { translate } = await resolveTranslations()
    const scope = resolveCommandScope(ctx)
    return {
      actionLabel: translate('webhook_calcom.audit.unassignedTranscripts.dismiss', 'Dismiss meeting transcript'),
      resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
      resourceId: result.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    }
  },
}

registerCommand(assignUnassignedTranscriptCommand)
registerCommand(dismissUnassignedTranscriptCommand)
