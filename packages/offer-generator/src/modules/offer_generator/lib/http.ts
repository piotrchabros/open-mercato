import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest, type AuthContext } from '@open-mercato/shared/lib/auth/server'
import { resolveSingleOrganizationIdOrDeny } from '@open-mercato/shared/lib/auth/organizationScope'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { isCrudHttpError, translateCrudErrorBody } from '@open-mercato/shared/lib/crud/errors'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'
import type { Logger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import {
  resolveOrganizationScopeForRequest,
  type OrganizationScope,
} from '@open-mercato/core/modules/directory/utils/organizationScope'

export type AuthenticatedAuth = NonNullable<AuthContext> & { sub: string; tenantId: string }

export type RequestScope = {
  auth: AuthenticatedAuth
  userId: string
  tenantId: string
  organizationId: string
  organizationScope: OrganizationScope
  container: AppContainer
  em: EntityManager
}

export type RouteErrorReport = {
  logger: Logger
  message: string
  code: string
}

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

export async function authenticateRequest(req: Request): Promise<AuthenticatedAuth | null> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) return null
  return { ...auth, sub: auth.sub, tenantId: auth.tenantId }
}

export async function resolveRequestScope(req: Request, auth: AuthenticatedAuth): Promise<RequestScope | null> {
  const container = await createRequestContainer()
  const organizationScope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
  const organizationId = resolveSingleOrganizationIdOrDeny(organizationScope, auth)
  if (!organizationId) return null
  return {
    auth,
    userId: auth.sub,
    tenantId: auth.tenantId,
    organizationId,
    organizationScope,
    container,
    em: container.resolve<EntityManager>('em').fork(),
  }
}

export function buildCommandContext(scope: RequestScope, req: Request): CommandRuntimeContext {
  return {
    container: scope.container,
    auth: scope.auth,
    organizationScope: scope.organizationScope,
    selectedOrganizationId: scope.organizationId,
    organizationIds: scope.organizationScope?.filterIds ?? [scope.organizationId],
    request: req,
  }
}

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS })
}

export function errorResponse(
  status: number,
  message: string,
  code?: string,
  extra?: Record<string, unknown>,
): Response {
  const body = code ? { error: message, code, ...(extra ?? {}) } : { error: message, ...(extra ?? {}) }
  return Response.json(body, { status })
}

export function unauthorizedResponse(translate: TranslateWithFallbackFn): Response {
  return errorResponse(401, translate('offer_generator.errors.unauthorized', 'Unauthorized'))
}

export function notFoundResponse(message: string): Response {
  return errorResponse(404, message, 'not_found')
}

export function validationErrorResponse(translate: TranslateWithFallbackFn, details: unknown): Response {
  return errorResponse(400, translate('offer_generator.errors.validation', 'Invalid input'), 'validation_error', {
    details,
  })
}

export function internalErrorResponse(translate: TranslateWithFallbackFn): Response {
  return errorResponse(500, translate('offer_generator.errors.internal', 'Something went wrong.'))
}

export function reportRouteError(error: unknown, report: RouteErrorReport): void {
  const errorName = error instanceof Error ? error.name : 'unknown'
  report.logger.error(report.message, { errorName, code: report.code })
  getTelemetryRuntime()?.reportError(error, {
    module: 'offer_generator',
    code: report.code,
    attributes: { errorName },
  })
}

export function knownErrorResponse(error: unknown, translate: TranslateWithFallbackFn): Response | null {
  if (isCrudHttpError(error)) {
    return Response.json(translateCrudErrorBody(error.body, translate), { status: error.status })
  }
  const interceptorRejection = getCommandInterceptorHttpRejection(error)
  if (interceptorRejection) {
    return Response.json(interceptorRejection.body, { status: interceptorRejection.status })
  }
  return null
}

export function handleRouteError(
  error: unknown,
  translate: TranslateWithFallbackFn,
  report: RouteErrorReport,
): Response {
  const known = knownErrorResponse(error, translate)
  if (known) return known
  reportRouteError(error, report)
  return internalErrorResponse(translate)
}
