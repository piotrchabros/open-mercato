import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { resolveSingleOrganizationIdOrDeny } from '@open-mercato/shared/lib/auth/organizationScope'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { resolveOrganizationScopeForRequest } from '@open-mercato/core/modules/directory/utils/organizationScope'
import { CalcomUnassignedTranscript } from '../../../data/entities'
import { calcomUnassignedTranscriptSources, calcomUnassignedTranscriptStatuses } from '../../../data/validators'
import { toUnassignedTranscriptDto } from '../../../lib/unassigned-transcripts'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['webhook_calcom.transcripts.view'] },
}

const TRANSCRIPT_PREVIEW_MAX_LINES = 200

const paramsSchema = z.object({ id: z.string().uuid() })

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { translate } = await resolveTranslations()
  const notFoundResponse = () =>
    NextResponse.json({ error: translate('webhook_calcom.inbox.errors.notFound', 'Transcript not found') }, { status: 404 })
  try {
    const params = paramsSchema.safeParse(await context.params)
    if (!params.success) return notFoundResponse()

    const auth = await getAuthFromRequest(req)
    if (!auth?.tenantId) {
      return NextResponse.json({ error: translate('webhook_calcom.inbox.errors.unauthorized', 'Unauthorized') }, { status: 401 })
    }
    const container = await createRequestContainer()
    const scope = await resolveOrganizationScopeForRequest({ container, auth, request: req })
    const organizationId = resolveSingleOrganizationIdOrDeny(scope, auth)
    if (!organizationId) return notFoundResponse()

    const em = (container.resolve('em') as EntityManager).fork()
    const row = await findOneWithDecryption(
      em,
      CalcomUnassignedTranscript,
      { id: params.data.id, tenantId: auth.tenantId, organizationId, deletedAt: null },
      undefined,
      { tenantId: auth.tenantId, organizationId },
    )
    if (!row) return notFoundResponse()

    return NextResponse.json(
      toUnassignedTranscriptDto(row, { includePreview: true, translate, maxLines: TRANSCRIPT_PREVIEW_MAX_LINES }),
    )
  } catch (err) {
    if (isCrudHttpError(err)) return NextResponse.json(err.body, { status: err.status })
    throw err
  }
}

const participantSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
})

const unassignedTranscriptDetailSchema = z.object({
  id: z.string().uuid(),
  bookingUid: z.string(),
  transcriptId: z.string(),
  sessionId: z.string(),
  source: z.enum(calcomUnassignedTranscriptSources).nullable(),
  title: z.string(),
  meetingStartedAt: z.string(),
  meetingEndedAt: z.string(),
  organizerEmail: z.string().nullable(),
  organizerUserId: z.string().nullable(),
  participants: z.array(participantSchema),
  language: z.string().nullable(),
  completeness: z.string().nullable(),
  durationMs: z.number().nullable(),
  passageCount: z.number().nullable(),
  summaryStatus: z.string().nullable(),
  summaryText: z.string().nullable(),
  reason: z.enum(['no_attendees', 'no_matching_attendee']),
  status: z.enum(calcomUnassignedTranscriptStatuses),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedEntityId: z.string().nullable(),
  resolvedToInteractionId: z.string().nullable(),
  resolvedAttachmentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  transcriptPreview: z.string().optional(),
  transcriptPreviewTruncated: z.boolean().optional(),
})

const errorSchema = z.object({ error: z.string() })

export const openApi: OpenApiRouteDoc = {
  tag: 'Cal.com',
  summary: 'Unassigned Cal.com transcript',
  pathParams: paramsSchema,
  methods: {
    GET: {
      summary: 'Get unassigned transcript',
      description:
        'Returns a single unassigned transcript with its summary and the first 200 lines of the rendered transcript. The raw webhook payload is never returned.',
      responses: [{ status: 200, description: 'Unassigned transcript', schema: unassignedTranscriptDetailSchema }],
      errors: [
        { status: 401, description: 'Unauthorized', schema: errorSchema },
        { status: 403, description: 'Insufficient organization access', schema: errorSchema },
        { status: 404, description: 'Transcript not found in the caller organization', schema: errorSchema },
      ],
    },
  },
}
