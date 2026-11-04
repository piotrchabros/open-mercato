import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { getAuthFromRequest, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import {
  organizationScopeRequiredResponse,
  resolveActiveOrganizationId,
} from '@open-mercato/shared/lib/auth/organizationScope'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { CrudHttpError, isCrudHttpError, translateCrudErrorBody } from '@open-mercato/shared/lib/crud/errors'
import {
  runRouteMutationGuards,
  type RouteMutationGuardInput,
  type RouteMutationGuardResult,
} from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import type { MetaApiErrorCode } from './constants'
import { MetaGraphError } from './graph-client'

type NonNullAuth = NonNullable<AuthContext>

export type RouteContext = {
  container: AppContainer
  em: EntityManager
  auth: NonNullAuth
  userId: string
  tenantId: string
  organizationId: string
  allowedOrganizationIds: string[] | null
  translate: TranslateWithFallbackFn
}

export type PagedResult<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const logger = createLogger('meta_lead_ads').child({ component: 'http' })

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers })
}

export function errorResponse(
  status: number,
  code: MetaApiErrorCode,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return jsonResponse({ ...(extra ?? {}), error: message, code }, status)
}

export function tryResolve<T>(container: AppContainer, name: string): T | null {
  try {
    if (typeof container.hasRegistration === 'function' && !container.hasRegistration(name)) return null
    return container.resolve<T>(name)
  } catch {
    return null
  }
}

export async function resolveRouteContext(req: Request): Promise<RouteContext | Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }
  const organizationId = resolveActiveOrganizationId(auth)
  if (!organizationId) return organizationScopeRequiredResponse()

  const container = await createRequestContainer()
  const { translate } = await resolveTranslations()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const allowedOrganizationIds = organizationScope.allowedIds ? [...organizationScope.allowedIds] : null

  return {
    container,
    em: container.resolve<EntityManager>('em').fork(),
    auth,
    userId: auth.sub,
    tenantId: auth.tenantId,
    organizationId,
    allowedOrganizationIds,
    translate,
  }
}

export async function callerHasFeature(ctx: RouteContext, feature: string): Promise<boolean> {
  const rbacService = tryResolve<RbacService>(ctx.container, 'rbacService')
  if (!rbacService) return false
  return rbacService.userHasAllFeatures(ctx.userId, [feature], {
    tenantId: ctx.tenantId,
    organizationId: ctx.organizationId,
  })
}

export async function runGuards(
  ctx: RouteContext,
  req: Request,
  input: RouteMutationGuardInput,
): Promise<RouteMutationGuardResult> {
  return runRouteMutationGuards({
    container: ctx.container,
    req,
    auth: { userId: ctx.userId, tenantId: ctx.tenantId, organizationId: ctx.organizationId },
    input,
  })
}

function buildFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '_root'
    if (!fieldErrors[path]) fieldErrors[path] = issue.message
  }
  return fieldErrors
}

function validationError(error: z.ZodError): CrudHttpError {
  return new CrudHttpError(400, {
    error: 'meta_lead_ads.errors.validation_error',
    code: 'validation_error',
    fieldErrors: buildFieldErrors(error),
  })
}

export async function parseJsonBody<Schema extends z.ZodTypeAny>(
  req: Request,
  schema: Schema,
): Promise<z.infer<Schema>> {
  let raw: unknown
  try {
    const text = await req.text()
    raw = text.trim().length > 0 ? JSON.parse(text) : {}
  } catch {
    throw new CrudHttpError(400, {
      error: 'meta_lead_ads.errors.validation_error',
      code: 'validation_error',
      fieldErrors: { _root: 'Invalid JSON body' },
    })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

export function parseQuery<Schema extends z.ZodTypeAny>(req: Request, schema: Schema): z.infer<Schema> {
  const url = new URL(req.url)
  const raw: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    raw[key] = value
  })
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw validationError(parsed.error)
  return parsed.data
}

export function paged<T>(items: T[], total: number, page: number, pageSize: number): PagedResult<T> {
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1,
  }
}

export function handleRouteError(err: unknown, translate: TranslateWithFallbackFn): Response {
  if (isCrudHttpError(err)) {
    return jsonResponse(translateCrudErrorBody(err.body, translate), err.status)
  }
  if (err instanceof z.ZodError) {
    return errorResponse(
      400,
      'validation_error',
      translate('meta_lead_ads.errors.validation_error', 'Invalid input'),
      { fieldErrors: buildFieldErrors(err) },
    )
  }
  if (err instanceof MetaGraphError) {
    logger.warn('Graph API call failed', {
      status: err.status,
      graphCode: err.code,
      graphSubcode: err.subcode,
      fbtraceId: err.fbtraceId,
      errorClass: err.classification.errorClass,
    })
    return errorResponse(
      502,
      'graph_error',
      translate('meta_lead_ads.errors.graph_error', 'Meta returned an error. Try again later.'),
      { leadErrorCode: err.classification.leadErrorCode },
    )
  }
  const errorName = err instanceof Error ? err.name : 'unknown'
  logger.error('Unexpected route error', { errorName })
  getTelemetryRuntime()?.reportError(err, {
    module: 'meta_lead_ads',
    code: 'meta_lead_ads.route_unexpected_error',
    attributes: { errorName },
  })
  return jsonResponse(
    { error: translate('meta_lead_ads.errors.internal', 'Something went wrong. Please try again later.') },
    500,
  )
}
