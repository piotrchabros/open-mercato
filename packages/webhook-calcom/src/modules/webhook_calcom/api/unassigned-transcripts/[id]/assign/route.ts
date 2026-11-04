import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import {
  organizationScopeRequiredResponse,
  resolveSingleOrganizationIdOrDeny,
} from '@open-mercato/shared/lib/auth/organizationScope'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { getCommandInterceptorHttpRejection } from '@open-mercato/shared/lib/commands/errors'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import {
  UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID,
  UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
  type UnassignedTranscriptAssignResult,
} from '../../../../commands/unassigned-transcripts'
import {
  unassignedTranscriptAssignBodySchema,
  type UnassignedTranscriptAssignInput,
} from '../../../../data/validators'

const logger = createLogger('webhook_calcom')

const PEOPLE_VIEW_FEATURE = 'customers.people.view'

export const metadata = {
  POST: {
    requireAuth: true,
    requireFeatures: ['webhook_calcom.transcripts.manage', 'customers.interactions.manage'],
  },
}

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

type RbacService = {
  userHasAllFeatures: (
    userId: string,
    required: string[],
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<boolean>
}

async function callerHasFeature(
  container: { resolve: (name: string) => unknown },
  userId: string,
  feature: string,
  scope: { tenantId: string; organizationId: string },
): Promise<boolean> {
  try {
    const rbac = container.resolve('rbacService') as RbacService | undefined
    if (typeof rbac?.userHasAllFeatures !== 'function') return false
    return await rbac.userHasAllFeatures(userId, [feature], scope)
  } catch {
    return false
  }
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  try {
    const params = paramsSchema.safeParse(await context.params)
    if (!params.success) {
      return NextResponse.json(
        { error: translate('webhook_calcom.inbox.errors.notFound', 'Transcript not found') },
        { status: 404 },
      )
    }

    const auth = await getAuthFromRequest(req)
    if (!auth?.sub || !auth.tenantId) {
      return NextResponse.json({ error: translate('webhook_calcom.inbox.errors.unauthorized', 'Unauthorized') }, { status: 401 })
    }

    const body = unassignedTranscriptAssignBodySchema.safeParse(await readJsonSafe(req, null))
    if (!body.success) {
      return NextResponse.json(
        {
          error: translate('webhook_calcom.inbox.errors.invalidRequest', 'Invalid request'),
          details: body.error.issues,
        },
        { status: 400 },
      )
    }

    const container = await createRequestContainer()
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = resolveSingleOrganizationIdOrDeny(scope, auth)
    if (!organizationId) return organizationScopeRequiredResponse()
    const tenantId = auth.tenantId

    const canViewPeople = await callerHasFeature(container, auth.sub, PEOPLE_VIEW_FEATURE, { tenantId, organizationId })
    if (!canViewPeople) {
      return NextResponse.json(
        { error: translate('webhook_calcom.inbox.errors.forbidden', 'You do not have permission to assign transcripts to people') },
        { status: 403 },
      )
    }

    const input: UnassignedTranscriptAssignInput = { id: params.data.id, personId: body.data.personId }
    const guarded = await runRouteMutationGuards({
      container,
      req,
      auth: { userId: auth.sub, tenantId, organizationId },
      input: {
        resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
        resourceId: input.id,
        operation: 'custom',
        mutationPayload: input,
      },
    })
    if (!guarded.ok) return guarded.response

    const ctx: CommandRuntimeContext = {
      container,
      auth,
      organizationScope: scope,
      selectedOrganizationId: organizationId,
      organizationIds: scope?.filterIds ?? [organizationId],
      request: req,
    }
    const commandBus = container.resolve('commandBus') as CommandBus
    const { result } = await commandBus.execute<UnassignedTranscriptAssignInput, UnassignedTranscriptAssignResult>(
      UNASSIGNED_TRANSCRIPT_ASSIGN_COMMAND_ID,
      { input, ctx },
    )
    await guarded.runAfterSuccess()

    return NextResponse.json({
      interactionId: result.interactionId,
      attachmentId: result.attachmentId,
      resolvedEntityId: result.resolvedEntityId,
      assignedToDifferentPerson: result.resolvedEntityId !== input.personId,
    })
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    const interceptorRejection = getCommandInterceptorHttpRejection(err)
    if (interceptorRejection) {
      return NextResponse.json(interceptorRejection.body, { status: interceptorRejection.status })
    }
    logger.error('webhook_calcom.unassigned_transcripts.assign failed', { err })
    return NextResponse.json(
      { error: translate('webhook_calcom.inbox.errors.assignFailed', 'Failed to assign the transcript') },
      { status: 500 },
    )
  }
}

const assignResponseSchema = z.object({
  interactionId: z.string().uuid(),
  attachmentId: z.string().uuid(),
  resolvedEntityId: z.string().uuid(),
  assignedToDifferentPerson: z.boolean(),
})

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Cal.com',
  summary: 'Assign unassigned Cal.com transcript',
  pathParams: paramsSchema,
  methods: {
    POST: {
      summary: 'Assign transcript to a person',
      description:
        'Attaches a pending unassigned transcript to a CRM person by creating or reusing the meeting interaction. When the booking was meanwhile synced to another person, the transcript lands on that interaction and assignedToDifferentPerson is true. Honors the optimistic-lock header.',
      requestBody: {
        contentType: 'application/json',
        schema: unassignedTranscriptAssignBodySchema,
      },
      responses: [{ status: 200, description: 'Transcript assigned', schema: assignResponseSchema }],
      errors: [
        { status: 400, description: 'Invalid request body or missing organization scope', schema: errorSchema },
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Caller cannot view people or access the organization', schema: errorSchema },
        { status: 404, description: 'Transcript or person not found', schema: errorSchema },
        { status: 409, description: 'Transcript changed concurrently or was already handled', schema: errorSchema },
      ],
    },
  },
}
