import { NextResponse } from 'next/server'
import type { z } from 'zod'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { serializeOperationMetadata } from '@open-mercato/shared/lib/commands/operationMetadata'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { getAllMutationGuardInstances } from '@open-mercato/shared/lib/crud/mutation-guard-store'
import { bridgeLegacyGuard, runMutationGuards } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('connect_sla').child({ component: 'publish-route' })

export async function publishResource<TSchema extends z.ZodTypeAny>(args: {
  req: Request
  id: string
  schema: TSchema
  commandId: string
  resourceKind: string
}): Promise<Response> {
  try {
    const auth = await getAuthFromRequest(args.req)
    if (!auth?.sub || !auth.tenantId) throw new CrudHttpError(401, { error: 'Unauthorized' })
    const organizationId = auth.orgId ?? null
    if (!organizationId) throw new CrudHttpError(400, { error: 'Organization context is required', code: 'organization_scope_required' })
    const container = await createRequestContainer()
    const rawBody = await readJsonSafe(args.req, {})
    const parsed = args.schema.parse({ ...(rawBody as Record<string, unknown>), id: args.id }) as Record<string, unknown>
    const guardInput = { tenantId: auth.tenantId, organizationId, userId: auth.sub, resourceKind: args.resourceKind, resourceId: args.id, operation: 'update' as const, requestMethod: args.req.method, requestHeaders: args.req.headers, mutationPayload: parsed as Record<string, unknown> }
    const legacy = bridgeLegacyGuard(container)
    const guardResult = await runMutationGuards([...getAllMutationGuardInstances(), ...(legacy ? [legacy] : [])], guardInput, { userFeatures: Array.isArray(auth.features) ? auth.features : [] })
    if (!guardResult.ok) return NextResponse.json(guardResult.errorBody ?? { error: 'Operation blocked' }, { status: guardResult.errorStatus ?? 422 })
    const input = { ...parsed, ...(guardResult.modifiedPayload ?? {}), tenantId: auth.tenantId, organizationId }
    const ctx: CommandRuntimeContext = { container, auth, organizationScope: null, selectedOrganizationId: organizationId, organizationIds: [organizationId], request: args.req }
    const { result, logEntry } = await (container.resolve('commandBus') as CommandBus).execute(args.commandId, { input, ctx })
    const body = result as { entityId?: string; updatedAt?: Date }
    const response = NextResponse.json({ id: body.entityId ?? args.id, updatedAt: body.updatedAt?.toISOString() ?? null })
    if (logEntry?.undoToken && logEntry.id && logEntry.commandId) response.headers.set('x-om-operation', serializeOperationMetadata({ id: logEntry.id, undoToken: logEntry.undoToken, commandId: logEntry.commandId, actionLabel: logEntry.actionLabel ?? null, resourceKind: logEntry.resourceKind ?? args.resourceKind, resourceId: logEntry.resourceId ?? args.id, executedAt: logEntry.createdAt instanceof Date ? logEntry.createdAt.toISOString() : String(logEntry.createdAt) }))
    for (const callback of guardResult.afterSuccessCallbacks) {
      try { await callback.guard.afterSuccess?.({ ...guardInput, metadata: callback.metadata ?? null }) } catch (err) { logger.warn('Mutation guard afterSuccess callback failed', { err }) }
    }
    return response
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    if (err && typeof err === 'object' && 'issues' in err) return NextResponse.json({ error: 'Invalid publish request', code: 'invalid_publish_request' }, { status: 400 })
    logger.error('Publish request failed', { err, commandId: args.commandId })
    return NextResponse.json({ error: 'Publish failed' }, { status: 500 })
  }
}
