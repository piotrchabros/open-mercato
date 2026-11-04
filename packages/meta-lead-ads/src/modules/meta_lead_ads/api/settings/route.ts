import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { enforceCommandOptimisticLockWithGuards } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { ActionLogService } from '@open-mercato/core/modules/audit_logs/services/actionLogService'
import { settingsSchema } from '../../data/validators'
import { getOrgSettings, ensureSettingsRow } from '../../lib/settings'
import { serializeSettings } from '../../lib/serializers'
import {
  handleRouteError,
  jsonResponse,
  parseJsonBody,
  resolveRouteContext,
  runGuards,
  tryResolve,
} from '../../lib/http'
import { errorBodySchema, optimisticLockConflictSchema, settingsDtoSchema, type SettingsDto } from '../openapi'

const SETTINGS_RESOURCE_KIND = 'meta_lead_ads.meta_settings'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['meta_lead_ads.view_logs'] },
  PUT: { requireAuth: true, requireFeatures: ['meta_lead_ads.manage'] },
}

export async function GET(req: Request) {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const settings = await getOrgSettings(ctx.em, { tenantId: ctx.tenantId, organizationId: ctx.organizationId })
    const body: SettingsDto = {
      id: settings.id,
      retentionDays: settings.retentionDays,
      defaultCountry: settings.defaultCountry,
      updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
    }
    return jsonResponse(body)
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export async function PUT(req: Request) {
  const ctx = await resolveRouteContext(req)
  if (ctx instanceof Response) return ctx
  try {
    const input = await parseJsonBody(req, settingsSchema)
    const scope = { tenantId: ctx.tenantId, organizationId: ctx.organizationId }
    const current = await getOrgSettings(ctx.em, scope)
    if (current.id) {
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: SETTINGS_RESOURCE_KIND,
        resourceId: current.id,
        current: current.updatedAt,
        request: req,
      })
    }

    const guard = await runGuards(ctx, req, {
      resourceKind: SETTINGS_RESOURCE_KIND,
      resourceId: current.id,
      operation: current.id ? 'update' : 'create',
      mutationPayload: input,
    })
    if (!guard.ok) return guard.response

    const row = await ensureSettingsRow(ctx.em, scope)
    const snapshotBefore = { retentionDays: row.retentionDays, defaultCountry: row.defaultCountry }
    row.retentionDays = input.retentionDays
    row.defaultCountry = input.defaultCountry
    await ctx.em.flush()

    await guard.runAfterSuccess()
    const actionLogService = tryResolve<ActionLogService>(ctx.container, 'actionLogService')
    if (actionLogService) {
      await actionLogService.log({
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        commandId: 'meta_lead_ads.settings.update',
        resourceKind: SETTINGS_RESOURCE_KIND,
        resourceId: row.id,
        snapshotBefore,
        snapshotAfter: { retentionDays: row.retentionDays, defaultCountry: row.defaultCountry },
      })
    }

    return jsonResponse(serializeSettings(row))
  } catch (err) {
    return handleRouteError(err, ctx.translate)
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'meta_lead_ads',
  summary: 'Meta Lead Ads organization settings',
  methods: {
    GET: {
      summary: 'Get Meta Lead Ads settings',
      description: 'Returns the retention and default country settings of the active organization. Defaults are returned with a null id when no row exists.',
      responses: [{ status: 200, description: 'Settings', schema: settingsDtoSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
      ],
    },
    PUT: {
      summary: 'Update Meta Lead Ads settings',
      description: 'Upserts the settings row of the active organization. Send the optimistic lock header when a row exists.',
      requestBody: { contentType: 'application/json', schema: settingsSchema },
      responses: [{ status: 200, description: 'Updated settings', schema: settingsDtoSchema }],
      errors: [
        { status: 400, description: 'Validation error or organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
