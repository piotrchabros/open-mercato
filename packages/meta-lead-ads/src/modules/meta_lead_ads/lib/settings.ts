import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaSettings } from '../data/entities'
import { DEFAULT_COUNTRY, DEFAULT_RETENTION_DAYS, type MetaScope } from './constants'
import { decryptionScope } from './scope'

export type OrgSettings = {
  id: string | null
  retentionDays: number
  defaultCountry: string
  updatedAt: Date | null
}

function findSettingsRow(em: EntityManager, scope: MetaScope): Promise<MetaSettings | null> {
  return findOneWithDecryption(
    em,
    MetaSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
}

export async function getOrgSettings(em: EntityManager, scope: MetaScope): Promise<OrgSettings> {
  const row = await findSettingsRow(em, scope)
  if (!row) {
    return {
      id: null,
      retentionDays: DEFAULT_RETENTION_DAYS,
      defaultCountry: DEFAULT_COUNTRY,
      updatedAt: null,
    }
  }
  return {
    id: row.id,
    retentionDays: row.retentionDays,
    defaultCountry: row.defaultCountry,
    updatedAt: row.updatedAt ?? null,
  }
}

export async function ensureSettingsRow(em: EntityManager, scope: MetaScope): Promise<MetaSettings> {
  const existing = await findSettingsRow(em, scope)
  if (existing) return existing
  const fork = em.fork()
  fork.create(MetaSettings, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    retentionDays: DEFAULT_RETENTION_DAYS,
    defaultCountry: DEFAULT_COUNTRY,
  })
  try {
    await fork.flush()
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
  }
  const created = await findSettingsRow(em, scope)
  if (created) return created
  const softDeleted = await findOneWithDecryption(
    em,
    MetaSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    decryptionScope(scope),
  )
  if (!softDeleted) throw new Error('[internal] meta_lead_ads settings row could not be created')
  softDeleted.deletedAt = null
  await em.flush()
  return softDeleted
}
