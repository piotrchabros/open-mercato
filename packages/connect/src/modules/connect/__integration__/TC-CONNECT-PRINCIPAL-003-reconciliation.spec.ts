import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createUserFixture, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { createConnectPrincipalClassificationManifestService } from '../lib/principal-classification-manifest'
import {
  clearPrincipalScope,
  countPrincipalChanges,
  countPrincipalClassifications,
  deletePrincipalRows,
  readPrincipalManifestEntry,
} from './principal-classification-sql'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

test.describe('TC-CONNECT-PRINCIPAL-003: durable reconciliation', () => {
  test('persists exact desired state, converges, and retires a dropped entry', async ({ request }) => {
    const token = await getAuthToken(request)
    const scope = getTokenContext(token)
    let userId: string | null = null
    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const service = container.resolve<ReturnType<typeof createConnectPrincipalClassificationManifestService>>(
      'connectPrincipalClassificationManifestService',
    )

    try {
      await clearPrincipalScope(em, scope)
      userId = await createUserFixture(request, token, {
        email: `connect-reconcile-${Date.now()}@example.test`,
        password: 'Valid1!Pass',
        organizationId: scope.organizationId,
        roles: ['employee'],
      })
      const manifest = {
        entries: [{
          externalKey: 'integration.qa',
          userId,
          kind: 'integration' as const,
          reasonCode: 'test.reconcile',
        }],
      }
      await expect(service.reconcile({ ...scope, manifest, apply: true })).resolves.toMatchObject({
        desired: 1,
        created: 1,
        reconciled: 1,
        unavailable: 0,
      })
      await expect(service.reconcile({ ...scope, manifest, apply: true })).resolves.toMatchObject({
        desired: 1,
        created: 0,
        updated: 0,
        unchanged: 1,
        reconciled: 1,
        unavailable: 0,
      })
      await expect(countPrincipalClassifications(em, { ...scope, userId })).resolves.toBe(1)
      await expect(countPrincipalChanges(em, { ...scope, userId })).resolves.toBe(1)

      await expect(service.reconcile({ ...scope, manifest: { entries: [] }, apply: true })).resolves.toMatchObject({
        desired: 0,
        retired: 1,
        reconciled: 0,
        unavailable: 0,
      })
      await expect(countPrincipalClassifications(em, { ...scope, userId })).resolves.toBe(0)
      await expect(countPrincipalChanges(em, { ...scope, userId, tombstonedOnly: true })).resolves.toBe(1)
      await expect(readPrincipalManifestEntry(em, { ...scope, userId }))
        .resolves.toMatchObject({ active: false, lastResultCode: 'retired' })

      await expect(service.reconcile({ ...scope, manifest, apply: true })).resolves.toMatchObject({
        desired: 1,
        updated: 1,
        reconciled: 1,
        unavailable: 0,
      })
      await expect(countPrincipalClassifications(em, { ...scope, userId })).resolves.toBe(1)
      await expect(readPrincipalManifestEntry(em, { ...scope, userId }))
        .resolves.toMatchObject({ active: true, revision: 2 })
    } finally {
      await deletePrincipalRows(em, { ...scope, userIds: userId ? [userId] : [] })
      await deleteUserIfExists(request, token, userId)
      await container.dispose()
    }
  })
})
