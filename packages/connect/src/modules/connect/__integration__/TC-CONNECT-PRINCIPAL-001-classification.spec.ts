import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createUserFixture,
  deleteUserIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { ConnectPrincipalClassification } from '../data/entities'
import type { ConnectPrincipalKindReader } from '../lib/principal-classification'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

test.describe('TC-CONNECT-PRINCIPAL-001: scoped classification evidence', () => {
  test('returns explicit active kinds while absence remains unknown', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let humanUserId: string | null = null
    let integrationUserId: string | null = null
    let absentUserId: string | null = null

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const reader = container.resolve<ConnectPrincipalKindReader>('connectPrincipalKindReader')

    try {
      humanUserId = await createUserFixture(request, token, {
        email: `connect-human-${suffix}@example.test`,
        password: 'Valid1!Pass',
        organizationId,
        roles: ['employee'],
      })
      integrationUserId = await createUserFixture(request, token, {
        email: `connect-integration-${suffix}@example.test`,
        password: 'Valid1!Pass',
        organizationId,
        roles: ['employee'],
      })
      absentUserId = await createUserFixture(request, token, {
        email: `connect-absent-${suffix}@example.test`,
        password: 'Valid1!Pass',
        organizationId,
        roles: ['employee'],
      })
      em.persist([
        em.create(ConnectPrincipalClassification, {
          tenantId,
          organizationId,
          userId: humanUserId,
          kind: 'human',
        }),
        em.create(ConnectPrincipalClassification, {
          tenantId,
          organizationId,
          userId: integrationUserId,
          kind: 'integration',
        }),
      ])
      await em.flush()

      const records = await reader.resolve({
        tenantId,
        organizationId,
        userIds: [humanUserId, integrationUserId, absentUserId],
      })

      expect(records).toEqual([
        { userId: humanUserId, kind: 'human' },
        { userId: integrationUserId, kind: 'integration' },
      ])
      expect(records.filter((record) => record.kind === 'human').map((record) => record.userId))
        .toEqual([humanUserId])
    } finally {
      if (humanUserId || integrationUserId || absentUserId) {
        const userIds = [humanUserId, integrationUserId, absentUserId]
          .filter((userId): userId is string => typeof userId === 'string')
        await em.nativeDelete(ConnectPrincipalClassification, {
          tenantId,
          organizationId,
          userId: { $in: userIds },
        })
      }
      await deleteUserIfExists(request, token, absentUserId)
      await deleteUserIfExists(request, token, integrationUserId)
      await deleteUserIfExists(request, token, humanUserId)
      await container.dispose()
    }
  })
})
