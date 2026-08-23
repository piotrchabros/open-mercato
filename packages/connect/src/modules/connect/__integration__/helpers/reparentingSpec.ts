import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { FixtureLedger, newFixtureChannelId, type ReparentingScope } from './reparentingFixtures'

/**
 * Shared bootstrap for the reparenting specs.
 *
 * Deliberately not a Playwright fixture: each `TC-CONNECT-REP-*.spec.ts` file
 * must stay independently discoverable and runnable, so they share a plain
 * function rather than a config-level fixture that would couple them.
 *
 * Imports nothing from `../data/entities` — see the note in
 * `reparentingFixtures.ts` about decorator transforms aborting collection for
 * the entire repository.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

export type ReparentingSpecContext = {
  token: string
  scope: ReparentingScope
  em: EntityManager
  ledger: FixtureLedger
  channelId: string
  /** A per-run customer id, so two specs never share a customer by accident. */
  customerId: string
  authHeaders: Record<string, string>
}

export async function openReparentingSpec(request: APIRequestContext): Promise<ReparentingSpecContext> {
  const token = await getAuthToken(request)
  const { tenantId, organizationId } = getTokenContext(token)
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  const em = container.resolve<EntityManager>('em')

  return {
    token,
    scope: { tenantId, organizationId },
    em,
    ledger: new FixtureLedger(),
    channelId: newFixtureChannelId(),
    customerId: randomUUID(),
    authHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
}

export function commandKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export function splitUrl(caseId: string): string {
  return `/api/connect/cases/${caseId}/split`
}

export function mergeUrl(caseId: string): string {
  return `/api/connect/cases/${caseId}/merge`
}

export function lineageUrl(caseId: string): string {
  return `/api/connect/cases/${caseId}/lineage`
}

export const UNDO_URL = '/api/audit_logs/audit-logs/actions/undo'
