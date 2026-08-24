import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand, type CommandHandler } from '@open-mercato/shared/lib/commands'
import { emitCrudUndoSideEffects } from '@open-mercato/shared/lib/commands/helpers'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { assertOptimisticLock, enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  BusinessCalendar,
  BusinessCalendarVersion,
  BusinessHoliday,
  BusinessWindow,
  CaseClock,
  Policy,
  PolicyVersion,
} from '../data/entities'
import {
  businessCalendarCreateSchema,
  businessCalendarDeleteSchema,
  businessCalendarPublishSchema,
  businessCalendarUpdateSchema,
  policyCreateSchema,
  policyDeleteSchema,
  policyPublishSchema,
  policyUpdateSchema,
} from '../data/validators'
import { normalizeBusinessWindows } from '../lib/business-time'

type Scope = { tenantId: string; organizationId: string }
type Result = { entityId: string; updatedAt: Date }
type CalendarSnapshot = { id: string; name: string; isDefault: boolean; currentVersion: number | null; updatedAt: string; deletedAt: string | null }
type PolicySnapshot = { id: string; name: string; priority: number; isActive: boolean; currentVersion: number | null; updatedAt: string; deletedAt: string | null }
type CrudUndo<T> = { scope: Scope; before?: T | null; after?: T | null }
type PublishUndo = { scope: Scope; id: string; previousVersion: number | null; publishedVersion: number }

async function emitSideEffects(ctx: { container: { resolve: (name: string) => unknown } }, action: 'created' | 'updated' | 'deleted', record: BusinessCalendar | Policy, entityType: string): Promise<void> {
  await emitCrudUndoSideEffects({
    dataEngine: ctx.container.resolve('dataEngine') as DataEngine,
    action,
    entity: record,
    identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
    indexer: { entityType },
  })
}

function timeToSeconds(value: string): number {
  const [hours, minutes, seconds = '0'] = value.split(':')
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

function secondsToTime(value: number): string {
  const hours = Math.floor(value / 3600).toString().padStart(2, '0')
  const minutes = Math.floor((value % 3600) / 60).toString().padStart(2, '0')
  const seconds = (value % 60).toString().padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

function scopeFrom(rawInput: unknown, ctx: { auth: { tenantId?: string | null } | null; selectedOrganizationId: string | null }): Scope {
  const raw = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
  const tenantId = typeof raw.tenantId === 'string' ? raw.tenantId : ctx.auth?.tenantId ?? null
  const organizationId = typeof raw.organizationId === 'string' ? raw.organizationId : ctx.selectedOrganizationId
  if (!tenantId || !organizationId) throw new CrudHttpError(400, { error: 'Organization context is required', code: 'organization_scope_required' })
  ensureTenantScope(ctx as never, tenantId)
  ensureOrganizationScope(ctx as never, organizationId)
  return { tenantId, organizationId }
}

function withoutScope(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return rawInput
  const copy = { ...rawInput } as Record<string, unknown>
  delete copy.tenantId
  delete copy.organizationId
  return copy
}

const calendarSnapshot = (record: BusinessCalendar): CalendarSnapshot => ({
  id: record.id,
  name: record.name,
  isDefault: record.isDefault,
  currentVersion: record.currentVersion,
  updatedAt: record.updatedAt.toISOString(),
  deletedAt: record.deletedAt?.toISOString() ?? null,
})

const policySnapshot = (record: Policy): PolicySnapshot => ({
  id: record.id,
  name: record.name,
  priority: record.priority,
  isActive: record.isActive,
  currentVersion: record.currentVersion,
  updatedAt: record.updatedAt.toISOString(),
  deletedAt: record.deletedAt?.toISOString() ?? null,
})

function logFor<T>(actionLabel: string, resourceKind: string, snapshot: T & { id: string }, scope: Scope, undo: CrudUndo<T>) {
  return { actionLabel, resourceKind, resourceId: snapshot.id, tenantId: scope.tenantId, organizationId: scope.organizationId, payload: { undo } }
}

async function restoreCalendar(em: EntityManager, scope: Scope, snapshot: CalendarSnapshot): Promise<BusinessCalendar> {
  let record = await em.findOne(BusinessCalendar, { id: snapshot.id, ...scope })
  if (!record) {
    record = em.create(BusinessCalendar, { id: snapshot.id, ...scope, name: snapshot.name, isDefault: snapshot.isDefault, currentVersion: snapshot.currentVersion })
    em.persist(record)
  }
  record.name = snapshot.name
  record.isDefault = snapshot.isDefault
  record.currentVersion = snapshot.currentVersion
  record.deletedAt = snapshot.deletedAt ? new Date(snapshot.deletedAt) : null
  record.updatedAt = new Date()
  await em.flush()
  return record
}

async function restorePolicy(em: EntityManager, scope: Scope, snapshot: PolicySnapshot): Promise<Policy> {
  let record = await em.findOne(Policy, { id: snapshot.id, ...scope })
  if (!record) {
    record = em.create(Policy, { id: snapshot.id, ...scope, name: snapshot.name, priority: snapshot.priority, isActive: snapshot.isActive, currentVersion: snapshot.currentVersion })
    em.persist(record)
  }
  record.name = snapshot.name
  record.priority = snapshot.priority
  record.isActive = snapshot.isActive
  record.currentVersion = snapshot.currentVersion
  record.deletedAt = snapshot.deletedAt ? new Date(snapshot.deletedAt) : null
  record.updatedAt = new Date()
  await em.flush()
  return record
}

const createCalendar: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.calendar.create',
  async execute(raw, ctx) {
    const input = businessCalendarCreateSchema.parse(withoutScope(raw))
    const scope = scopeFrom(raw, ctx)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = em.create(BusinessCalendar, { ...scope, name: input.name, isDefault: input.isDefault })
    em.persist(record)
    await em.flush()
    await emitSideEffects(ctx, 'created', record, 'connect_sla:business_calendar')
    return { entityId: record.id, updatedAt: record.updatedAt }
  },
  async captureAfter(raw, result, ctx) {
    const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: result.entityId, ...scopeFrom(raw, ctx) })
    return record ? calendarSnapshot(record) : null
  },
  buildLog: ({ snapshots, input }) => {
    const after = snapshots.after as CalendarSnapshot | undefined
    if (!after) return null
    const scope = input as unknown as Scope
    return logFor('Create SLA calendar', 'connect_sla.business_calendar', after, scope, { scope, after })
  },
  async undo({ logEntry, ctx }) {
    const undo = extractUndoPayload<CrudUndo<CalendarSnapshot>>(logEntry)
    if (!undo?.after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await em.findOne(BusinessCalendar, { id: undo.after.id, ...undo.scope })
    if (record) { assertOptimisticLock({ resourceKind: 'connect_sla.business_calendar', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); record.deletedAt = new Date(); await em.flush() }
  },
}

const updateCalendar: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.calendar.update',
  async prepare(raw, ctx) {
    const input = businessCalendarUpdateSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx)
    const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null })
    return { before: record ? calendarSnapshot(record) : null }
  },
  async execute(raw, ctx) {
    const input = businessCalendarUpdateSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await em.findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null })
    if (!record) throw new CrudHttpError(404, { error: 'Calendar not found', code: 'calendar_not_found' })
    await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.business_calendar', resourceId: record.id, current: record.updatedAt, request: ctx.request })
    record.name = input.name; record.isDefault = input.isDefault; await em.flush(); await emitSideEffects(ctx, 'updated', record, 'connect_sla:business_calendar')
    return { entityId: record.id, updatedAt: record.updatedAt }
  },
  async captureAfter(raw, result, ctx) { const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: result.entityId, ...scopeFrom(raw, ctx) }); return record ? calendarSnapshot(record) : null },
  buildLog: ({ snapshots, input }) => { const before = snapshots.before as CalendarSnapshot | undefined; if (!before) return null; const scope = input as unknown as Scope; return logFor('Update SLA calendar', 'connect_sla.business_calendar', before, scope, { scope, before, after: snapshots.after as CalendarSnapshot }) },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<CrudUndo<CalendarSnapshot>>(logEntry); if (!undo?.before) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); await em.transactional(async (transactionalEm) => { const record = await transactionalEm.findOne(BusinessCalendar, { id: undo.before!.id, ...undo.scope }); if (record && undo.after) assertOptimisticLock({ resourceKind: 'connect_sla.business_calendar', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); await restoreCalendar(transactionalEm, undo.scope, undo.before!) }) },
}

const deleteCalendar: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.calendar.delete',
  async prepare(raw, ctx) { const input = businessCalendarDeleteSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null }); return { before: record ? calendarSnapshot(record) : null } },
  async execute(raw, ctx) {
    const input = businessCalendarDeleteSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null })
    if (!record) throw new CrudHttpError(404, { error: 'Calendar not found', code: 'calendar_not_found' })
    await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.business_calendar', resourceId: record.id, current: record.updatedAt, request: ctx.request })
    const versions = await em.find(BusinessCalendarVersion, { calendarId: record.id, ...scope }); const versionIds = versions.map((version) => version.id)
    if (versionIds.length && (await em.count(PolicyVersion, { calendarVersionId: { $in: versionIds }, ...scope }) || await em.count(CaseClock, { calendarVersionId: { $in: versionIds }, ...scope }))) throw new CrudHttpError(409, { error: 'Calendar version is referenced', code: 'calendar_version_referenced' })
    record.deletedAt = new Date(); await em.flush(); await emitSideEffects(ctx, 'deleted', record, 'connect_sla:business_calendar'); return { entityId: record.id, updatedAt: record.updatedAt }
  },
  async captureAfter(raw, result, ctx) { const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: result.entityId, ...scopeFrom(raw, ctx) }); return record ? calendarSnapshot(record) : null },
  buildLog: ({ snapshots, input }) => { const before = snapshots.before as CalendarSnapshot | undefined; if (!before) return null; const scope = input as unknown as Scope; return logFor('Delete SLA calendar', 'connect_sla.business_calendar', before, scope, { scope, before, after: snapshots.after as CalendarSnapshot }) },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<CrudUndo<CalendarSnapshot>>(logEntry); if (!undo?.before) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(BusinessCalendar, { id: undo.before.id, ...undo.scope }); if (record && undo.after) assertOptimisticLock({ resourceKind: 'connect_sla.business_calendar', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); await restoreCalendar(em, undo.scope, undo.before) },
}

const createPolicy: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.policy.create',
  async execute(raw, ctx) { const input = policyCreateSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = em.create(Policy, { ...scope, ...input }); em.persist(record); await em.flush(); await emitSideEffects(ctx, 'created', record, 'connect_sla:policy'); return { entityId: record.id, updatedAt: record.updatedAt } },
  async captureAfter(raw, result, ctx) { const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: result.entityId, ...scopeFrom(raw, ctx) }); return record ? policySnapshot(record) : null },
  buildLog: ({ snapshots, input }) => { const after = snapshots.after as PolicySnapshot | undefined; if (!after) return null; const scope = input as unknown as Scope; return logFor('Create SLA policy', 'connect_sla.policy', after, scope, { scope, after }) },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<CrudUndo<PolicySnapshot>>(logEntry); if (!undo?.after) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(Policy, { id: undo.after.id, ...undo.scope }); if (record) { assertOptimisticLock({ resourceKind: 'connect_sla.policy', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); record.deletedAt = new Date(); await em.flush() } },
}

const updatePolicy: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.policy.update',
  async prepare(raw, ctx) { const input = policyUpdateSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: input.id, ...scope, deletedAt: null }); return { before: record ? policySnapshot(record) : null } },
  async execute(raw, ctx) { const input = policyUpdateSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(Policy, { id: input.id, ...scope, deletedAt: null }); if (!record) throw new CrudHttpError(404, { error: 'Policy not found', code: 'policy_not_found' }); await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.policy', resourceId: record.id, current: record.updatedAt, request: ctx.request }); record.name = input.name; record.priority = input.priority; record.isActive = input.isActive; await em.flush(); await emitSideEffects(ctx, 'updated', record, 'connect_sla:policy'); return { entityId: record.id, updatedAt: record.updatedAt } },
  async captureAfter(raw, result, ctx) { const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: result.entityId, ...scopeFrom(raw, ctx) }); return record ? policySnapshot(record) : null },
  buildLog: ({ snapshots, input }) => { const before = snapshots.before as PolicySnapshot | undefined; if (!before) return null; const scope = input as unknown as Scope; return logFor('Update SLA policy', 'connect_sla.policy', before, scope, { scope, before, after: snapshots.after as PolicySnapshot }) },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<CrudUndo<PolicySnapshot>>(logEntry); if (!undo?.before) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); await em.transactional(async (transactionalEm) => { const record = await transactionalEm.findOne(Policy, { id: undo.before!.id, ...undo.scope }); if (record && undo.after) assertOptimisticLock({ resourceKind: 'connect_sla.policy', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); await restorePolicy(transactionalEm, undo.scope, undo.before!) }) },
}

const deletePolicy: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.policy.delete',
  async prepare(raw, ctx) { const input = policyDeleteSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: input.id, ...scope, deletedAt: null }); return { before: record ? policySnapshot(record) : null } },
  async execute(raw, ctx) { const input = policyDeleteSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(Policy, { id: input.id, ...scope, deletedAt: null }); if (!record) throw new CrudHttpError(404, { error: 'Policy not found', code: 'policy_not_found' }); await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.policy', resourceId: record.id, current: record.updatedAt, request: ctx.request }); const versionIds = (await em.find(PolicyVersion, { policyId: record.id, ...scope })).map((version) => version.id); if (versionIds.length && await em.count(CaseClock, { policyVersionId: { $in: versionIds }, ...scope })) throw new CrudHttpError(409, { error: 'Policy version is referenced', code: 'policy_version_referenced' }); record.deletedAt = new Date(); await em.flush(); await emitSideEffects(ctx, 'deleted', record, 'connect_sla:policy'); return { entityId: record.id, updatedAt: record.updatedAt } },
  async captureAfter(raw, result, ctx) { const record = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: result.entityId, ...scopeFrom(raw, ctx) }); return record ? policySnapshot(record) : null },
  buildLog: ({ snapshots, input }) => { const before = snapshots.before as PolicySnapshot | undefined; if (!before) return null; const scope = input as unknown as Scope; return logFor('Delete SLA policy', 'connect_sla.policy', before, scope, { scope, before, after: snapshots.after as PolicySnapshot }) },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<CrudUndo<PolicySnapshot>>(logEntry); if (!undo?.before) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); const record = await em.findOne(Policy, { id: undo.before.id, ...undo.scope }); if (record && undo.after) assertOptimisticLock({ resourceKind: 'connect_sla.policy', resourceId: record.id, expected: undo.after.updatedAt, current: record.updatedAt }); await restorePolicy(em, undo.scope, undo.before) },
}

async function copyCalendarVersion(em: EntityManager, scope: Scope, source: BusinessCalendarVersion, calendar: BusinessCalendar, actorUserId: string | null): Promise<number> {
  const version = calendar.currentVersion === null ? 1 : calendar.currentVersion + 1
  const copy = em.create(BusinessCalendarVersion, { ...scope, calendarId: calendar.id, version, timezone: source.timezone, publishedByUserId: actorUserId, publishedAt: new Date() }); em.persist(copy); await em.flush()
  const where = { ...scope, calendarVersionId: source.id }
  for (const window of await em.find(BusinessWindow, where)) em.persist(em.create(BusinessWindow, { ...scope, calendarVersionId: copy.id, weekday: window.weekday, localStart: window.localStart, localEnd: window.localEnd }))
  for (const holiday of await findWithDecryption(em, BusinessHoliday, where, {}, scope)) em.persist(em.create(BusinessHoliday, { ...scope, calendarVersionId: copy.id, localDate: holiday.localDate, label: holiday.label }))
  calendar.currentVersion = version; await em.flush(); return version
}

const publishCalendar: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.calendar.publish',
  async prepare(raw, ctx) {
    const input = businessCalendarPublishSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx)
    const calendar = await (ctx.container.resolve('em') as EntityManager).fork().findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null })
    return { before: calendar ? calendarSnapshot(calendar) : null }
  },
  async execute(raw, ctx) {
    const input = businessCalendarPublishSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork()
    const calendar = await em.transactional(async (transactionalEm) => {
      const record = await transactionalEm.findOne(BusinessCalendar, { id: input.id, ...scope, deletedAt: null })
      if (!record) throw new CrudHttpError(404, { error: 'Calendar not found', code: 'calendar_not_found' }); await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.business_calendar', resourceId: record.id, current: record.updatedAt, request: ctx.request })
      const previousVersion = record.currentVersion; const version = previousVersion === null ? 1 : previousVersion + 1; const publishedAt = new Date(); const publishedByUserId = ctx.auth?.sub ?? null
      const definition = transactionalEm.create(BusinessCalendarVersion, { ...scope, calendarId: record.id, version, timezone: input.timezone, publishedByUserId, publishedAt }); transactionalEm.persist(definition); await transactionalEm.flush()
      const windows = normalizeBusinessWindows(input.windows.map((window) => ({ weekday: window.weekday, startSecond: timeToSeconds(window.localStart), endSecond: timeToSeconds(window.localEnd) })))
      windows.filter((window) => window.endSecond > window.startSecond).forEach((window) => transactionalEm.persist(transactionalEm.create(BusinessWindow, { ...scope, calendarVersionId: definition.id, weekday: window.weekday, localStart: secondsToTime(window.startSecond), localEnd: secondsToTime(window.endSecond) })))
      input.holidays.forEach((holiday) => transactionalEm.persist(transactionalEm.create(BusinessHoliday, { ...scope, calendarVersionId: definition.id, localDate: holiday.localDate, label: holiday.label ?? null })))
      record.currentVersion = version; await transactionalEm.flush(); return record
    })
    await emitSideEffects(ctx, 'updated', calendar, 'connect_sla:business_calendar'); return { entityId: calendar.id, updatedAt: calendar.updatedAt }
  },
  buildLog: ({ input, result, snapshots }) => { const raw = input as Record<string, unknown>; const scope = raw as unknown as Scope; const before = snapshots.before as CalendarSnapshot | undefined; const publishedVersion = (before?.currentVersion ?? 0) + 1; return { actionLabel: 'Publish SLA calendar', resourceKind: 'connect_sla.business_calendar', resourceId: result.entityId, tenantId: scope.tenantId, organizationId: scope.organizationId, payload: { undo: { scope, id: result.entityId, previousVersion: before?.currentVersion ?? null, publishedVersion } satisfies PublishUndo } } },
  async undo({ logEntry, ctx }) { const undo = extractUndoPayload<PublishUndo>(logEntry); if (!undo) return; const em = (ctx.container.resolve('em') as EntityManager).fork(); await em.transactional(async (transactionalEm) => { const calendar = await transactionalEm.findOne(BusinessCalendar, { id: undo.id, ...undo.scope }); if (!calendar) return; if (calendar.currentVersion !== undo.publishedVersion) throw new CrudHttpError(409, { error: 'Calendar has a newer publication', code: 'calendar_publication_changed' }); if (undo.previousVersion === null) { calendar.currentVersion = null; await transactionalEm.flush(); return } const source = await transactionalEm.findOne(BusinessCalendarVersion, { calendarId: calendar.id, version: undo.previousVersion, ...undo.scope }); if (source) await copyCalendarVersion(transactionalEm, undo.scope, source, calendar, ctx.auth?.sub ?? null) }) },
}

const publishPolicy: CommandHandler<Record<string, unknown>, Result> = {
  id: 'connect_sla.policy.publish',
  async prepare(raw, ctx) { const input = policyPublishSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const policy = await (ctx.container.resolve('em') as EntityManager).fork().findOne(Policy, { id: input.id, ...scope, deletedAt: null }); return { before: policy ? policySnapshot(policy) : null } },
  async execute(raw, ctx) { const input = policyPublishSchema.parse(withoutScope(raw)); const scope = scopeFrom(raw, ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const policy = await em.transactional(async (transactionalEm) => { const record = await transactionalEm.findOne(Policy, { id: input.id, ...scope, deletedAt: null }); if (!record) throw new CrudHttpError(404, { error: 'Policy not found', code: 'policy_not_found' }); await enforceCommandOptimisticLockWithGuards(ctx.container, { resourceKind: 'connect_sla.policy', resourceId: record.id, current: record.updatedAt, request: ctx.request }); const calendarVersion = await transactionalEm.findOne(BusinessCalendarVersion, { id: input.calendarVersionId, ...scope }); if (!calendarVersion) throw new CrudHttpError(404, { error: 'Calendar version not found', code: 'calendar_version_not_found' }); const version = record.currentVersion === null ? 1 : record.currentVersion + 1; transactionalEm.persist(transactionalEm.create(PolicyVersion, { ...scope, policyId: record.id, version, channelId: input.channelId ?? null, responseTargetMinutes: input.responseTargetMinutes, resolutionTargetMinutes: input.resolutionTargetMinutes, responseWarningMinutes: input.responseWarningMinutes, resolutionWarningMinutes: input.resolutionWarningMinutes, calendarVersionId: input.calendarVersionId, effectiveFrom: new Date(input.effectiveFrom), publishedByUserId: ctx.auth?.sub ?? null, publishedAt: new Date() })); record.currentVersion = version; await transactionalEm.flush(); return record }); await emitSideEffects(ctx, 'updated', policy, 'connect_sla:policy'); return { entityId: policy.id, updatedAt: policy.updatedAt } },
  buildLog: ({ input, result, snapshots }) => { const raw = input as Record<string, unknown>; const scope = raw as unknown as Scope; const before = snapshots.before as PolicySnapshot | undefined; return { actionLabel: 'Publish SLA policy', resourceKind: 'connect_sla.policy', resourceId: result.entityId, tenantId: scope.tenantId, organizationId: scope.organizationId, payload: { undo: { scope, id: result.entityId, previousVersion: before?.currentVersion ?? null, publishedVersion: (before?.currentVersion ?? 0) + 1 } satisfies PublishUndo } } },
  async undo({ logEntry, ctx }) {
    const undo = extractUndoPayload<PublishUndo>(logEntry); if (!undo) return
    const em = (ctx.container.resolve('em') as EntityManager).fork(); await em.transactional(async (transactionalEm) => { const policy = await transactionalEm.findOne(Policy, { id: undo.id, ...undo.scope }); if (!policy) return
      if (policy.currentVersion !== undo.publishedVersion) throw new CrudHttpError(409, { error: 'Policy has a newer publication', code: 'policy_publication_changed' })
      if (undo.previousVersion === null) { policy.currentVersion = null; await transactionalEm.flush(); return }
      const source = await transactionalEm.findOne(PolicyVersion, { policyId: policy.id, version: undo.previousVersion, ...undo.scope }); if (!source) return
      const version = (policy.currentVersion ?? 0) + 1
      transactionalEm.persist(transactionalEm.create(PolicyVersion, { ...undo.scope, policyId: policy.id, version, channelId: source.channelId, responseTargetMinutes: source.responseTargetMinutes, resolutionTargetMinutes: source.resolutionTargetMinutes, responseWarningMinutes: source.responseWarningMinutes, resolutionWarningMinutes: source.resolutionWarningMinutes, calendarVersionId: source.calendarVersionId, effectiveFrom: source.effectiveFrom, publishedByUserId: ctx.auth?.sub ?? null, publishedAt: new Date() }))
      policy.currentVersion = version; await transactionalEm.flush()
    })
  },
}

for (const command of [createCalendar, updateCalendar, deleteCalendar, createPolicy, updatePolicy, deletePolicy, publishCalendar, publishPolicy]) registerCommand(command)

export { createCalendar, updateCalendar, deleteCalendar, createPolicy, updatePolicy, deletePolicy, publishCalendar, publishPolicy }
