import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands/types'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaPage } from '../data/entities'
import type { MetaScope } from './constants'

export function decryptionScope(scope: MetaScope): { tenantId: string; organizationId: string } {
  return { tenantId: scope.tenantId, organizationId: scope.organizationId }
}

export function scopeOfPage(page: Pick<MetaPage, 'tenantId' | 'organizationId'>): MetaScope {
  return { tenantId: page.tenantId, organizationId: page.organizationId }
}

export async function findRoutedPageByMetaPageId(
  em: EntityManager,
  metaPageId: string,
): Promise<MetaPage | null> {
  const trimmed = metaPageId.trim()
  if (!trimmed) return null
  const routing = await em
    .fork()
    .findOne(
      MetaPage,
      { metaPageId: trimmed, deletedAt: null },
      { fields: ['id', 'tenantId', 'organizationId'] },
    )
  if (!routing) return null
  const scope = scopeOfPage(routing)
  return findOneWithDecryption(
    em,
    MetaPage,
    { id: routing.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
}

export function buildSystemCommandContext(container: AwilixContainer, scope: MetaScope): CommandRuntimeContext {
  return {
    container,
    auth: null,
    organizationScope: null,
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    systemActor: true,
  }
}
