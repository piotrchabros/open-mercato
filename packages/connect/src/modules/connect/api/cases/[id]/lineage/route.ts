import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase } from '../../../../data/entities'
import { evaluateCaseAccess } from '../../../../lib/case-access'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'
import { createConnectCaseReparentingReader } from '../../../../lib/case-reparenting-reader'

/**
 * Where this Case came from and where its work went.
 *
 * Behind ORDINARY Case read access rather than the audit feature: knowing that
 * the Case you are looking at was merged into another is what lets an agent
 * navigate to the live one, and withholding it would leave them stuck. The
 * projection carries identifiers and timestamps only — the operator's reason
 * stays behind `connect.cases.reparent.audit`.
 *
 * `canUndo` is deliberately absent. The action log and its undo token are
 * authoritative about what may still be reversed, and a guess computed here
 * would be a button that fails.
 */

export const metadata = {
  path: '/connect/cases/[id]/lineage',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const em = (container.resolve('em') as EntityManager).fork()
  const row = await em.findOne(ConnectCase, {
    id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    deletedAt: null,
  })
  // Visibility first. The reader itself only enforces tenant and organization,
  // so reading lineage without this check would widen Case visibility to anyone
  // holding the handle feature.
  if (!row || !evaluateCaseAccess(row, actor).canRead) return inboxNotFound()

  const reader = createConnectCaseReparentingReader(em)
  const lineage = await reader.getCaseLineage(
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
    id,
  )
  if (!lineage) return inboxNotFound()

  return NextResponse.json(lineage)
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read a case’s reparenting lineage',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Case lineage projection' },
        { status: 400, description: 'No organization selected, or an invalid case id' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Case not found or not readable' },
      ],
    },
  },
}
