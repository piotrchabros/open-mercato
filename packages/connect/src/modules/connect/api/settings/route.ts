import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { normalizeIsoToken } from '@open-mercato/shared/lib/crud/optimistic-lock'
import { ConnectSettings } from '../../data/entities'
import { connectSettingsSchema } from '../../data/validators'

/**
 * Per-organization Connect ingestion settings.
 *
 * API-only in this capability: the values here change how customer traffic is
 * classified and grouped, and an administrator UI for them belongs with the
 * rest of the Connect operator experience rather than shipping half-formed
 * alongside ingest.
 *
 * Reading returns the seeded defaults when no row exists yet, so a caller never
 * has to distinguish "unconfigured" from "configured to the defaults" — and the
 * absent `updatedAt` correctly signals that the first write creates the row.
 */

export const metadata = {
  path: '/connect/settings',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.settings.view'],
  },
  PUT: {
    requireAuth: true,
    requireFeatures: ['connect.settings.manage'],
  },
}

const DEFAULTS = {
  attachWindowHours: 72,
  reopenWindowDays: 7,
  autoCloseAfterDays: 14,
  identityMatchThreshold: 80,
  suppressionCount: 3,
  suppressionWindowMinutes: 60,
}

const EXPECTED_VERSION_HEADER = 'x-om-expected-updated-at'

function requireScope(auth: Record<string, unknown> | null): { tenantId: string; organizationId: string } | null {
  const tenantId = typeof auth?.tenantId === 'string' ? auth.tenantId : null
  const organizationId = typeof (auth as { orgId?: unknown })?.orgId === 'string'
    ? ((auth as { orgId: string }).orgId)
    : null
  // Connect settings are per organization; a caller with no selected
  // organization has no scope to read or write, and defaulting to the tenant
  // would silently apply one organization's ingest policy to another's traffic.
  if (!tenantId || !organizationId) return null
  return { tenantId, organizationId }
}

export async function GET(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = requireScope(auth as never)
  if (!scope) {
    return NextResponse.json(
      { error: 'Select an organization to view Connect settings.', code: 'organization_required' },
      { status: 400 },
    )
  }

  const container = await createRequestContainer()
  const em = (container.resolve('em') as EntityManager).fork()
  const row = await em.findOne(ConnectSettings, scope)

  return NextResponse.json({
    ...DEFAULTS,
    ...(row
      ? {
          attachWindowHours: row.attachWindowHours,
          reopenWindowDays: row.reopenWindowDays,
          autoCloseAfterDays: row.autoCloseAfterDays,
          identityMatchThreshold: row.identityMatchThreshold,
          suppressionCount: row.suppressionCount,
          suppressionWindowMinutes: row.suppressionWindowMinutes,
        }
      : {}),
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  })
}

export async function PUT(req: Request): Promise<Response> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = requireScope(auth as never)
  if (!scope) {
    return NextResponse.json(
      { error: 'Select an organization to change Connect settings.', code: 'organization_required' },
      { status: 400 },
    )
  }

  let body: ReturnType<typeof connectSettingsSchema.parse>
  try {
    body = connectSettingsSchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const container = await createRequestContainer()
  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: auth.sub as string, tenantId: scope.tenantId, organizationId: scope.organizationId },
    input: {
      resourceKind: 'connect.settings',
      resourceId: scope.organizationId,
      operation: 'update',
      mutationPayload: body as unknown as Record<string, unknown>,
    },
  })
  if (!guard.ok) return guard.response

  const em = (container.resolve('em') as EntityManager).fork()
  const existing = await em.findOne(ConnectSettings, scope)

  // Optimistic locking, hand-wired because this is not a `makeCrudRoute`
  // resource. Two administrators tuning suppression at once would otherwise
  // silently overwrite each other, and the losing change would look applied.
  const expectedRaw = req.headers.get(EXPECTED_VERSION_HEADER)
  if (expectedRaw && existing) {
    const expected = normalizeIsoToken(expectedRaw)
    const current = existing.updatedAt.toISOString()
    if (!expected || expected !== current) {
      return NextResponse.json(
        {
          error: 'This record changed since you loaded it.',
          code: 'optimistic_lock_conflict',
          currentUpdatedAt: current,
          expectedUpdatedAt: expected ?? expectedRaw,
        },
        { status: 409 },
      )
    }
  }

  const target = existing ?? em.create(ConnectSettings, { ...scope, ...body })
  if (existing) Object.assign(target, body)
  else em.persist(target)
  await em.flush()

  await guard.runAfterSuccess()

  return NextResponse.json({
    attachWindowHours: target.attachWindowHours,
    reopenWindowDays: target.reopenWindowDays,
    autoCloseAfterDays: target.autoCloseAfterDays,
    identityMatchThreshold: target.identityMatchThreshold,
    suppressionCount: target.suppressionCount,
    suppressionWindowMinutes: target.suppressionWindowMinutes,
    updatedAt: target.updatedAt.toISOString(),
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read Connect ingestion settings for the selected organization',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Settings (seeded defaults when unconfigured)' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
    PUT: {
      summary: 'Update Connect ingestion settings',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Settings updated' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 409, description: 'Settings changed since they were loaded' },
        { status: 422, description: 'Invalid body or window relationship' },
      ],
    },
  },
}
