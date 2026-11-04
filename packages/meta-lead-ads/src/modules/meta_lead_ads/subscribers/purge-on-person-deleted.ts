import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { MetaConsent, MetaPersonKey } from '../data/entities'
import { purgeLeadEventPayloads } from '../lib/purge'

const logger = createLogger('meta_lead_ads').child({ component: 'purge-on-person-deleted' })

export const metadata = {
  event: 'customers.person.deleted',
  persistent: true,
  id: 'meta_lead_ads:purge-on-person-deleted',
}

export default async function handle(
  payload: unknown,
  ctx: { resolve: <T = unknown>(name: string) => T; eventName?: string },
): Promise<void> {
  const data = (payload ?? {}) as Record<string, unknown>
  const personId = (data.entityId as string | undefined) ?? (data.id as string | undefined)
  const tenantId = data.tenantId as string | undefined
  const organizationId = data.organizationId as string | undefined
  if (!personId || !tenantId || !organizationId) return

  const em = ctx.resolve<EntityManager>('em')
  const scope = { tenantId, organizationId, personId }

  try {
    await purgeLeadEventPayloads(em, scope, { clearHashes: true })
    await em.nativeDelete(MetaPersonKey, scope)
    await em.nativeDelete(MetaConsent, scope)
  } catch (err) {
    logger.error('Failed to purge lead data for deleted person', {
      errorName: err instanceof Error ? err.name : 'unknown',
    })
    throw err
  }
}
