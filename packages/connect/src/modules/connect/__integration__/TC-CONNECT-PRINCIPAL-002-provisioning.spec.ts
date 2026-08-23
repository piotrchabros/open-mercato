import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createUserFixture, deleteUserIfExists } from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  ConnectPrincipalClassification,
  ConnectPrincipalClassificationChange,
} from '../data/entities'
import type { ConnectPrincipalClassificationProvisioningService } from '../lib/principal-classification-provisioning'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

test.describe('TC-CONNECT-PRINCIPAL-002: provisioning lifecycle', () => {
  test('creates, replays, changes, and undoes without mutating Auth', async ({ request }) => {
    const token = await getAuthToken(request)
    const scope = getTokenContext(token)
    let userId: string | null = null
    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const service = container.resolve<ConnectPrincipalClassificationProvisioningService>(
      'connectPrincipalClassificationProvisioningService',
    )

    try {
      userId = await createUserFixture(request, token, {
        email: `connect-provision-${Date.now()}@example.test`,
        password: 'Valid1!Pass',
        organizationId: scope.organizationId,
        roles: ['employee'],
      })
      const createOperationId = randomUUID()
      const created = await service.ensure({
        ...scope,
        operationId: createOperationId,
        userId,
        kind: 'human',
        source: 'connect.integration',
        reasonCode: 'test.provision',
      })
      expect(created).toMatchObject({ userId, kind: 'human', created: true, changed: false, replayed: false })
      await expect(service.ensure({
        ...scope,
        operationId: createOperationId,
        userId,
        kind: 'human',
        source: 'connect.integration',
        reasonCode: 'test.provision',
      })).resolves.toMatchObject({ replayed: true, classificationId: created.classificationId })

      const changed = await service.ensure({
        ...scope,
        operationId: randomUUID(),
        userId,
        kind: 'integration',
        source: 'connect.integration',
        reasonCode: 'test.rotation',
        expectedUpdatedAt: created.updatedAt,
      })
      expect(changed).toMatchObject({ created: false, changed: true, kind: 'integration' })
      const change = await em.findOneOrFail(ConnectPrincipalClassificationChange, {
        classificationId: created.classificationId,
        afterKind: 'integration',
      })
      await expect(service.undo({
        ...scope,
        operationId: randomUUID(),
        source: 'connect.integration',
        originalChangeId: change.id,
        expectedUpdatedAt: changed.updatedAt,
        reasonCode: 'test.undo',
      })).resolves.toMatchObject({ kind: 'human', tombstoned: false, replayed: false })
    } finally {
      if (userId) {
        await em.nativeDelete(ConnectPrincipalClassificationChange, { ...scope, userId })
        await em.nativeDelete(ConnectPrincipalClassification, { ...scope, userId })
      }
      await deleteUserIfExists(request, token, userId)
      await container.dispose()
    }
  })
})
