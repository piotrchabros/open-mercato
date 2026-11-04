import type { EntityManager } from '@mikro-orm/postgresql'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { calcomLockKey } from './constants'

export async function withCalcomLock<T>(
  em: EntityManager,
  scope: IntegrationScope,
  run: () => Promise<T>,
): Promise<T> {
  const key = calcomLockKey(scope)
  return em.transactional(async (tx) => {
    await tx.getConnection().execute('select pg_advisory_xact_lock(hashtext(?::text))', [key])
    return run()
  })
}
