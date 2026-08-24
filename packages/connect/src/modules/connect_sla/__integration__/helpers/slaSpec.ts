import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

export type SlaScope = { tenantId: string; organizationId: string }

export class SlaFixtureLedger {
  readonly calendarIds = new Set<string>()
  readonly policyIds = new Set<string>()
  readonly clockIds = new Set<string>()
  readonly rebuildRunIds = new Set<string>()

  async cleanup(em: EntityManager, scope: SlaScope): Promise<void> {
    const connection = em.getConnection()
    const run = async (table: string, column: string, ids: Set<string>) => {
      if (!ids.size) return
      const values = [...ids]
      const placeholders = values.map(() => '?').join(', ')
      await connection.execute(`delete from ${table} where tenant_id = ? and organization_id = ? and ${column} in (${placeholders})`, [scope.tenantId, scope.organizationId, ...values])
    }

    await run('connect_sla_clock_revisions', 'clock_id', this.clockIds)
    await run('connect_sla_case_clocks', 'id', this.clockIds)
    await run('connect_sla_rebuild_runs', 'id', this.rebuildRunIds)

    if (this.policyIds.size) {
      const values = [...this.policyIds]
      const placeholders = values.map(() => '?').join(', ')
      await connection.execute(`delete from connect_sla_policy_versions where tenant_id = ? and organization_id = ? and policy_id in (${placeholders})`, [scope.tenantId, scope.organizationId, ...values])
      await connection.execute(`delete from connect_sla_policies where tenant_id = ? and organization_id = ? and id in (${placeholders})`, [scope.tenantId, scope.organizationId, ...values])
    }
    if (this.calendarIds.size) {
      const values = [...this.calendarIds]
      const placeholders = values.map(() => '?').join(', ')
      const versionRows = await connection.execute<Array<{ id: string }>>(`select id from connect_sla_business_calendar_versions where tenant_id = ? and organization_id = ? and calendar_id in (${placeholders})`, [scope.tenantId, scope.organizationId, ...values])
      const versionIds = versionRows.map((row) => row.id)
      if (versionIds.length) {
        const versionPlaceholders = versionIds.map(() => '?').join(', ')
        await connection.execute(`delete from connect_sla_business_holidays where tenant_id = ? and organization_id = ? and calendar_version_id in (${versionPlaceholders})`, [scope.tenantId, scope.organizationId, ...versionIds])
        await connection.execute(`delete from connect_sla_business_windows where tenant_id = ? and organization_id = ? and calendar_version_id in (${versionPlaceholders})`, [scope.tenantId, scope.organizationId, ...versionIds])
        await connection.execute(`delete from connect_sla_business_calendar_versions where tenant_id = ? and organization_id = ? and id in (${versionPlaceholders})`, [scope.tenantId, scope.organizationId, ...versionIds])
      }
      await connection.execute(`delete from connect_sla_business_calendars where tenant_id = ? and organization_id = ? and id in (${placeholders})`, [scope.tenantId, scope.organizationId, ...values])
    }
  }
}

export async function openSlaSpec(request: APIRequestContext) {
  const token = await getAuthToken(request)
  const scope = getTokenContext(token)
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  return {
    token,
    scope,
    em: container.resolve<EntityManager>('em'),
    ledger: new SlaFixtureLedger(),
    authHeaders: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
}

export function fixtureName(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

export const optimisticHeader = (updatedAt: string) => ({
  'x-om-ext-optimistic-lock-expected-updated-at': updatedAt,
})
