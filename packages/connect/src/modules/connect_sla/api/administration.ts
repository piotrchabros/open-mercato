import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { makeCrudRoute, type CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { BusinessCalendar, BusinessCalendarVersion, BusinessHoliday, BusinessWindow, Policy } from '../data/entities'
import {
  businessCalendarCreateSchema,
  businessCalendarListQuerySchema,
  businessCalendarUpdateSchema,
  policyCreateSchema,
  policyListQuerySchema,
  policyUpdateSchema,
} from '../data/validators'

const rawBodySchema = z.object({}).passthrough()

function requireScope(ctx: CrudCtx) {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? resolveActiveOrganizationId(ctx.auth)
  if (!tenantId || !organizationId) throw new CrudHttpError(400, { error: 'Organization context is required', code: 'organization_scope_required' })
  return { tenantId, organizationId }
}

function stripScope(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const copy = { ...raw } as Record<string, unknown>; delete copy.tenantId; delete copy.organizationId; return copy
}

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value

export const calendarMetadata = {
  GET: { requireAuth: true, requireFeatures: ['connect_sla.calendar.view'] },
  POST: { requireAuth: true, requireFeatures: ['connect_sla.calendar.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['connect_sla.calendar.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['connect_sla.calendar.manage'] },
}

export const calendarCrud = makeCrudRoute({
  metadata: calendarMetadata,
  orm: { entity: BusinessCalendar, idField: 'id', tenantField: 'tenantId', orgField: 'organizationId', softDeleteField: 'deletedAt' },
  indexer: { entityType: 'connect_sla:business_calendar' },
  list: {
    schema: businessCalendarListQuerySchema,
    entityId: 'connect_sla:business_calendar',
    fields: ['id', 'name', 'is_default', 'current_version', 'created_at', 'updated_at', 'deleted_at'],
    sortFieldMap: { name: 'name', createdAt: 'created_at', updatedAt: 'updated_at' },
    buildFilters: (query) => ({ ...(query.id ? { id: { $eq: query.id } } : {}), ...(query.includeDeleted === 'true' ? {} : { deleted_at: { $eq: null } }) }),
    transformItem: (item) => { const row = item as Record<string, unknown>; return { id: row.id, name: row.name, isDefault: row.is_default, currentVersion: row.current_version ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: iso(row.deleted_at) ?? null } },
  },
  actions: {
    create: { commandId: 'connect_sla.calendar.create', schema: rawBodySchema, mapInput: ({ raw, ctx }) => ({ ...businessCalendarCreateSchema.parse(stripScope(raw)), ...requireScope(ctx) }), response: ({ result }) => ({ id: result?.entityId, updatedAt: iso(result?.updatedAt) }), status: 201 },
    update: { commandId: 'connect_sla.calendar.update', schema: rawBodySchema, mapInput: ({ raw, ctx }) => ({ ...businessCalendarUpdateSchema.parse(stripScope(raw)), ...requireScope(ctx) }), response: ({ result }) => ({ id: result?.entityId, updatedAt: iso(result?.updatedAt) }) },
    delete: { commandId: 'connect_sla.calendar.delete', schema: rawBodySchema, mapInput: ({ ctx }) => { const id = ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null; return { id: z.string().uuid().parse(id), ...requireScope(ctx) } }, response: () => ({ ok: true }) },
  },
  hooks: {
    afterList: async (payload, ctx) => {
      const id = typeof ctx.query.id === 'string' ? ctx.query.id : null
      if (!id) return
      const scope = requireScope(ctx); const em = (ctx.container.resolve('em') as EntityManager).fork(); const calendar = await em.findOne(BusinessCalendar, { id, ...scope })
      if (!calendar?.currentVersion) return
      const version = await em.findOne(BusinessCalendarVersion, { calendarId: calendar.id, version: calendar.currentVersion, ...scope }); if (!version) return
      const where = { calendarVersionId: version.id, ...scope }
      const [windows, holidays] = await Promise.all([em.find(BusinessWindow, where), findWithDecryption(em, BusinessHoliday, where, {}, scope)])
      const item = Array.isArray(payload?.items) ? payload.items[0] as Record<string, unknown> | undefined : undefined
      if (item) item.currentDefinition = { id: version.id, version: version.version, timezone: version.timezone, publishedAt: version.publishedAt.toISOString(), windows: windows.map((window) => ({ weekday: window.weekday, localStart: window.localStart, localEnd: window.localEnd })), holidays: holidays.map((holiday) => ({ localDate: holiday.localDate, label: holiday.label })) }
    },
  },
})

export const policyMetadata = {
  GET: { requireAuth: true, requireFeatures: ['connect_sla.policy.view'] },
  POST: { requireAuth: true, requireFeatures: ['connect_sla.policy.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['connect_sla.policy.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['connect_sla.policy.manage'] },
}

export const policyCrud = makeCrudRoute({
  metadata: policyMetadata,
  orm: { entity: Policy, idField: 'id', tenantField: 'tenantId', orgField: 'organizationId', softDeleteField: 'deletedAt' },
  indexer: { entityType: 'connect_sla:policy' },
  list: {
    schema: policyListQuerySchema,
    entityId: 'connect_sla:policy',
    fields: ['id', 'name', 'priority', 'is_active', 'current_version', 'created_at', 'updated_at'],
    sortFieldMap: { name: 'name', priority: 'priority', createdAt: 'created_at', updatedAt: 'updated_at' },
    buildFilters: (query) => ({ ...(query.id ? { id: { $eq: query.id } } : {}), ...(query.isActive ? { is_active: { $eq: query.isActive === 'true' } } : {}), deleted_at: { $eq: null } }),
    transformItem: (item) => { const row = item as Record<string, unknown>; return { id: row.id, name: row.name, priority: row.priority, isActive: row.is_active, currentVersion: row.current_version ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } },
  },
  actions: {
    create: { commandId: 'connect_sla.policy.create', schema: rawBodySchema, mapInput: ({ raw, ctx }) => ({ ...policyCreateSchema.parse(stripScope(raw)), ...requireScope(ctx) }), response: ({ result }) => ({ id: result?.entityId, updatedAt: iso(result?.updatedAt) }), status: 201 },
    update: { commandId: 'connect_sla.policy.update', schema: rawBodySchema, mapInput: ({ raw, ctx }) => ({ ...policyUpdateSchema.parse(stripScope(raw)), ...requireScope(ctx) }), response: ({ result }) => ({ id: result?.entityId, updatedAt: iso(result?.updatedAt) }) },
    delete: { commandId: 'connect_sla.policy.delete', schema: rawBodySchema, mapInput: ({ ctx }) => { const id = ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null; return { id: z.string().uuid().parse(id), ...requireScope(ctx) } }, response: () => ({ ok: true }) },
  },
})
