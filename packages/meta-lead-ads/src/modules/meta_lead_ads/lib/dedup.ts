import type { EntityManager } from '@mikro-orm/postgresql'
import { UniqueConstraintViolationException } from '@mikro-orm/core'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CustomerEntity } from '@open-mercato/core/modules/customers/data/entities'
import { findPeopleByAddresses } from '@open-mercato/core/modules/customers/lib/findPeopleByAddresses'
import { MetaPersonKey } from '../data/entities'
import { DEDUP_SCAN_LIMIT, type MetaScope } from './constants'
import { normalizePhoneToE164, type PhoneNormalizationResult } from './phone'

export const EMAIL_HASH_CONTEXT = 'meta_lead_ads:email'
export const PHONE_HASH_CONTEXT = 'meta_lead_ads:phone'

export type LeadContactKeys = {
  email: string | null
  phoneE164: string | null
  emailHash: string | null
  phoneHash: string | null
}

export type DedupResult = {
  personId: string | null
  matchType: 'email' | 'phone' | 'none'
  conflictPersonId: string | null
}

export type DedupLookups = {
  findByEmailHash(emailHash: string): Promise<string | null>
  findByPhoneHash(phoneHash: string): Promise<string | null>
  findPeopleByEmails(emails: string[]): Promise<string[]>
  scanRecentPeopleForPhone(e164: string): Promise<string | null>
}

export type DedupLookupOptions = {
  defaultCountry?: string | null
}

export function buildContactKeys(email: string | null, phone: PhoneNormalizationResult | null): LeadContactKeys {
  const normalizedEmail = email ? email.trim().toLowerCase() : ''
  const phoneE164 = phone && phone.usableForMatching && phone.e164 ? phone.e164 : null
  return {
    email: normalizedEmail || null,
    phoneE164,
    emailHash: normalizedEmail ? hashForLookup(normalizedEmail, EMAIL_HASH_CONTEXT) : null,
    phoneHash: phoneE164 ? hashForLookup(phoneE164, PHONE_HASH_CONTEXT) : null,
  }
}

export function hasContactKeys(keys: LeadContactKeys): boolean {
  return Boolean(keys.emailHash || keys.phoneHash)
}

export function createDedupLookups(
  em: EntityManager,
  scope: MetaScope,
  options: DedupLookupOptions = {},
): DedupLookups {
  const decryptionScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }

  const findPersonKey = async (where: { emailHash: string } | { phoneHash: string }): Promise<string | null> => {
    const row = await findOneWithDecryption(
      em,
      MetaPersonKey,
      { ...where, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { orderBy: { updatedAt: 'DESC' } },
      decryptionScope,
    )
    return row ? row.personId : null
  }

  return {
    findByEmailHash: (emailHash) => findPersonKey({ emailHash }),
    findByPhoneHash: (phoneHash) => findPersonKey({ phoneHash }),
    async findPeopleByEmails(emails) {
      const matches = await findPeopleByAddresses(em, emails, scope.tenantId, scope.organizationId)
      return matches.map((match) => match.id)
    },
    async scanRecentPeopleForPhone(e164) {
      const candidates = (await findWithDecryption(
        em,
        CustomerEntity,
        { kind: 'person', tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
        { limit: DEDUP_SCAN_LIMIT, orderBy: { createdAt: 'DESC' } },
        decryptionScope,
      )) as Array<{ id: string; primaryPhone?: string | null }>
      for (const candidate of candidates) {
        if (!candidate.primaryPhone) continue
        const normalized = normalizePhoneToE164(candidate.primaryPhone, options.defaultCountry)
        if (normalized.usableForMatching && normalized.e164 === e164) return candidate.id
      }
      return null
    },
  }
}

export async function resolveDedupMatch(lookups: DedupLookups, keys: LeadContactKeys): Promise<DedupResult> {
  if (!hasContactKeys(keys)) return { personId: null, matchType: 'none', conflictPersonId: null }

  let emailPersonId = keys.emailHash ? await lookups.findByEmailHash(keys.emailHash) : null
  let phonePersonId = keys.phoneHash ? await lookups.findByPhoneHash(keys.phoneHash) : null

  if (!emailPersonId && keys.email) {
    const [firstMatch] = await lookups.findPeopleByEmails([keys.email])
    emailPersonId = firstMatch ?? null
  }
  if (!phonePersonId && keys.phoneE164) {
    phonePersonId = await lookups.scanRecentPeopleForPhone(keys.phoneE164)
  }

  if (emailPersonId) {
    const conflictPersonId = phonePersonId && phonePersonId !== emailPersonId ? phonePersonId : null
    return { personId: emailPersonId, matchType: 'email', conflictPersonId }
  }
  if (phonePersonId) return { personId: phonePersonId, matchType: 'phone', conflictPersonId: null }
  return { personId: null, matchType: 'none', conflictPersonId: null }
}

export async function upsertPersonKeys(
  em: EntityManager,
  scope: MetaScope,
  personId: string,
  keys: LeadContactKeys,
): Promise<void> {
  if (!hasContactKeys(keys)) return
  const decryptionScope = { tenantId: scope.tenantId, organizationId: scope.organizationId }

  const updateExisting = async (fork: EntityManager): Promise<boolean> => {
    const existing = await findOneWithDecryption(
      fork,
      MetaPersonKey,
      { tenantId: scope.tenantId, organizationId: scope.organizationId, personId, deletedAt: null },
      undefined,
      decryptionScope,
    )
    if (!existing) return false
    const nextEmailHash = keys.emailHash ?? existing.emailHash ?? null
    const nextPhoneHash = keys.phoneHash ?? existing.phoneHash ?? null
    if (existing.emailHash === nextEmailHash && existing.phoneHash === nextPhoneHash) return true
    existing.emailHash = nextEmailHash
    existing.phoneHash = nextPhoneHash
    await fork.flush()
    return true
  }

  if (await updateExisting(em.fork())) return

  const insertFork = em.fork()
  try {
    insertFork.persist(
      insertFork.create(MetaPersonKey, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        personId,
        emailHash: keys.emailHash,
        phoneHash: keys.phoneHash,
      }),
    )
    await insertFork.flush()
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
    await updateExisting(em.fork())
  }
}
