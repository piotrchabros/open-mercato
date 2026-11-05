import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { organizationScopeRequiredResponse } from '@open-mercato/shared/lib/auth/organizationScope'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readOptimisticLockExpected } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  SETTINGS_COMMAND_IDS,
  SETTINGS_RESOURCE_KIND,
  type SettingsUpsertCommandInput,
  type SettingsUpsertResult,
} from '../../commands/settings'
import { settingsUpsertSchema } from '../../data/validators'
import {
  authenticateRequest,
  buildCommandContext,
  handleRouteError,
  knownErrorResponse,
  noStoreJson,
  resolveRequestScope,
  unauthorizedResponse,
  validationErrorResponse,
} from '../../lib/http'
import { serializeSettings } from '../../lib/serializers'
import { getOfferGeneratorSettings } from '../../lib/settings'
import { errorBodySchema, optimisticLockConflictSchema, settingsDtoSchema } from '../openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.settings.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['offer_generator.settings.manage'] },
}

const logger = createLogger('offer_generator').child({ component: 'settings' })

const settingsBodySchema = settingsUpsertSchema.omit({ tenantId: true, organizationId: true })

function handleError(error: unknown, translate: TranslateWithFallbackFn, code: string): Response {
  const known = knownErrorResponse(error, translate)
  if (known) return known
  if (error instanceof z.ZodError) return validationErrorResponse(translate, error.issues)
  return handleRouteError(error, translate, { logger, message: 'Offer generator settings request failed', code })
}

export async function GET(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()

    const settings = await getOfferGeneratorSettings(scope.em, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    return noStoreJson(serializeSettings(settings))
  } catch (error) {
    return handleError(error, translate, 'offer_generator.settings_read_failed')
  }
}

export async function PUT(req: Request): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const auth = await authenticateRequest(req)
    if (!auth) return unauthorizedResponse(translate)
    const body = settingsBodySchema.safeParse(await readJsonSafe(req, null))
    if (!body.success) return validationErrorResponse(translate, body.error.issues)

    const scope = await resolveRequestScope(req, auth)
    if (!scope) return organizationScopeRequiredResponse()
    const tenantScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }

    const current = await getOfferGeneratorSettings(scope.em, tenantScope)

    const guarded = await runRouteMutationGuards({
      container: scope.container,
      req,
      auth: { userId: scope.userId, ...tenantScope },
      input: {
        resourceKind: SETTINGS_RESOURCE_KIND,
        resourceId: current.id,
        operation: current.id ? 'update' : 'create',
        mutationPayload: body.data,
      },
    })
    if (!guarded.ok) return guarded.response

    const payload = guarded.modifiedPayload ? { ...body.data, ...guarded.modifiedPayload } : body.data
    const input: SettingsUpsertCommandInput = {
      ...settingsBodySchema.parse(payload),
      ...tenantScope,
      expectedUpdatedAt: readOptimisticLockExpected(req),
    }
    const commandBus = scope.container.resolve<CommandBus>('commandBus')
    await commandBus.execute<SettingsUpsertCommandInput, SettingsUpsertResult>(SETTINGS_COMMAND_IDS.upsert, {
      input,
      ctx: buildCommandContext(scope, req),
    })
    await guarded.runAfterSuccess()

    const saved = await getOfferGeneratorSettings(scope.em.fork(), tenantScope)
    return noStoreJson(serializeSettings(saved))
  } catch (error) {
    return handleError(error, translate, 'offer_generator.settings_update_failed')
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Offer Generator',
  summary: 'Offer generator settings',
  methods: {
    GET: {
      summary: 'Get offer generator settings',
      description:
        'Returns the company name, offer template, prompt instructions, defaults and allowed AI models of the active organization. Defaults are returned with a null `updatedAt` when no row exists.',
      responses: [{ status: 200, description: 'Settings', schema: settingsDtoSchema }],
      errors: [
        { status: 400, description: 'Organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
      ],
    },
    PUT: {
      summary: 'Update offer generator settings',
      description:
        'Upserts the settings of the active organization. Send the optimistic-lock header with the settings `updatedAt` when a row exists.',
      requestBody: { contentType: 'application/json', schema: settingsBodySchema },
      responses: [{ status: 200, description: 'Updated settings', schema: settingsDtoSchema }],
      errors: [
        { status: 400, description: 'Validation error or organization scope required', schema: errorBodySchema },
        { status: 401, description: 'Unauthorized', schema: errorBodySchema },
        { status: 409, description: 'Optimistic lock conflict', schema: optimisticLockConflictSchema },
      ],
    },
  },
}
