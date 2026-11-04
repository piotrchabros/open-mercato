import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { User } from '@open-mercato/core/modules/auth/data/entities'
import { MetaForm } from '../data/entities'
import type { MetaScope } from './constants'
import { decryptionScope } from './scope'

export type RoundRobinPick = { ownerUserId: string | null; nextCursor: number }

export type OwnerAssignmentResult = { ownerUserId: string | null; unavailable: boolean }

export function pickNextRoundRobin(
  userIds: string[],
  cursor: number,
  isAvailable: (id: string) => boolean,
): RoundRobinPick {
  const total = userIds.length
  if (total === 0) return { ownerUserId: null, nextCursor: 0 }
  const safeCursor = Number.isFinite(cursor) ? Math.trunc(cursor) : 0
  const start = ((safeCursor % total) + total) % total
  for (let offset = 0; offset < total; offset += 1) {
    const index = (start + offset) % total
    const candidate = userIds[index]
    if (candidate && isAvailable(candidate)) {
      return { ownerUserId: candidate, nextCursor: (index + 1) % total }
    }
  }
  return { ownerUserId: null, nextCursor: start }
}

async function loadActiveUserIds(
  em: EntityManager,
  scope: MetaScope,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const users = await findWithDecryption(
    em,
    User,
    { id: { $in: userIds }, tenantId: scope.tenantId, deletedAt: null },
    { fields: ['id'] },
    decryptionScope(scope),
  )
  return new Set(users.map((user) => user.id))
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

export async function assignOwner(
  em: EntityManager,
  scope: MetaScope,
  formId: string,
): Promise<OwnerAssignmentResult> {
  return em.transactional(async (transaction) => {
    const form = await findOneWithDecryption(
      transaction,
      MetaForm,
      { id: formId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      decryptionScope(scope),
    )
    if (!form || form.ownerMode === 'none') return { ownerUserId: null, unavailable: false }

    const candidates =
      form.ownerMode === 'fixed' ? uniqueIds([form.ownerUserId]) : uniqueIds(form.ownerUserIds ?? [])
    const activeIds = await loadActiveUserIds(transaction, scope, candidates)
    const pick = pickNextRoundRobin(
      candidates,
      form.ownerMode === 'round_robin' ? form.roundRobinCursor : 0,
      (id) => activeIds.has(id),
    )

    const formWhere = { id: form.id, tenantId: scope.tenantId, organizationId: scope.organizationId }
    if (!pick.ownerUserId) {
      await transaction.nativeUpdate(MetaForm, formWhere, {
        needsAttention: true,
        attentionReason: 'owner_unavailable',
      })
      return { ownerUserId: null, unavailable: true }
    }

    if (form.ownerMode === 'round_robin' && pick.nextCursor !== form.roundRobinCursor) {
      await transaction.nativeUpdate(MetaForm, formWhere, { roundRobinCursor: pick.nextCursor })
    }
    return { ownerUserId: pick.ownerUserId, unavailable: false }
  })
}
