import type { FilterQuery } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { z } from 'zod'
import {
  ConnectPrincipalClassification,
  type ConnectPrincipalKind,
} from '../data/entities'

export type { ConnectPrincipalKind } from '../data/entities'

export const CONNECT_PRINCIPAL_KINDS = ['human', 'system_bot', 'integration'] as const

export type ConnectPrincipalKindRecord = {
  userId: string
  kind: ConnectPrincipalKind
}

export type ResolveConnectPrincipalKindsInput = {
  tenantId: string
  organizationId: string
  userIds: string[]
}

export interface ConnectPrincipalKindReader {
  resolve(input: ResolveConnectPrincipalKindsInput): Promise<ConnectPrincipalKindRecord[]>
}

type AuthPrincipalService = {
  principalExists(input: {
    type: 'user'
    id: string
    scope: { tenantId: string; organizationId: string }
  }): Promise<boolean>
}

type PrincipalClassificationRow = {
  userId: string
  kind: string
}

type PrincipalClassificationDependencies = {
  listClassifications(input: ResolveConnectPrincipalKindsInput): Promise<PrincipalClassificationRow[]>
  resolveAuthPrincipalService(): AuthPrincipalService | null
}

const uuidSchema = z.string().uuid()
const kindSchema = z.enum(CONNECT_PRINCIPAL_KINDS)
const MAX_PRINCIPAL_IDS = 100
const PRINCIPAL_CHECK_CONCURRENCY = 10
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

function normalizeUserIds(userIds: readonly unknown[]): string[] {
  const normalized = new Set<string>()
  for (const rawId of userIds) {
    if (typeof rawId !== 'string') continue
    const parsed = uuidSchema.safeParse(rawId.trim().toLowerCase())
    if (parsed.success && parsed.data !== ZERO_UUID) normalized.add(parsed.data)
  }
  return Array.from(normalized)
}

async function filterActiveUsers(
  records: readonly ConnectPrincipalKindRecord[],
  input: ResolveConnectPrincipalKindsInput,
  authPrincipalService: AuthPrincipalService,
): Promise<Set<string>> {
  const activeIds = new Set<string>()
  for (let offset = 0; offset < records.length; offset += PRINCIPAL_CHECK_CONCURRENCY) {
    const batch = records.slice(offset, offset + PRINCIPAL_CHECK_CONCURRENCY)
    const results = await Promise.all(batch.map(async (record) => {
      try {
        const active = await authPrincipalService.principalExists({
          type: 'user',
          id: record.userId,
          scope: { tenantId: input.tenantId, organizationId: input.organizationId },
        })
        return active ? record.userId : null
      } catch {
        return null
      }
    }))
    for (const userId of results) {
      if (userId) activeIds.add(userId)
    }
  }
  return activeIds
}

export function createConnectPrincipalKindReader(
  dependencies: PrincipalClassificationDependencies,
): ConnectPrincipalKindReader {
  return {
    async resolve(input) {
      const userIds = normalizeUserIds(input.userIds)
      if (userIds.length === 0) return []
      if (userIds.length > MAX_PRINCIPAL_IDS) {
        throw new Error('[internal] connect_principal_kind_limit_exceeded')
      }

      let rows: PrincipalClassificationRow[]
      try {
        rows = await dependencies.listClassifications({ ...input, userIds })
      } catch {
        return []
      }

      const recordsByUserId = new Map<string, ConnectPrincipalKindRecord>()
      for (const row of rows) {
        if (typeof row.userId !== 'string') continue
        const parsedUserId = uuidSchema.safeParse(row.userId.trim().toLowerCase())
        if (!parsedUserId.success) continue
        const userId = parsedUserId.data
        if (!userIds.includes(userId) || recordsByUserId.has(userId)) continue
        const parsedKind = kindSchema.safeParse(row.kind)
        if (parsedKind.success) recordsByUserId.set(userId, { userId, kind: parsedKind.data })
      }
      const records = userIds.flatMap((userId) => {
        const record = recordsByUserId.get(userId)
        return record ? [record] : []
      })

      const authPrincipalService = dependencies.resolveAuthPrincipalService()
      if (!authPrincipalService) return []
      const activeIds = await filterActiveUsers(records, input, authPrincipalService)
      return records.filter((record) => activeIds.has(record.userId))
    },
  }
}

function resolveAuthPrincipalService(container: AppContainer): AuthPrincipalService | null {
  try {
    const candidate = container.resolve<unknown>('authPrincipalService')
    if (!candidate || typeof candidate !== 'object') return null
    const principalExists = (candidate as { principalExists?: unknown }).principalExists
    if (typeof principalExists !== 'function') return null
    return candidate as AuthPrincipalService
  } catch {
    return null
  }
}

export function createDefaultConnectPrincipalKindReader(
  em: EntityManager,
  container: AppContainer,
): ConnectPrincipalKindReader {
  return createConnectPrincipalKindReader({
    async listClassifications(input) {
      const rows = await findWithDecryption(
        em,
        ConnectPrincipalClassification,
        {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          userId: { $in: input.userIds },
        } as FilterQuery<ConnectPrincipalClassification>,
        { fields: ['userId', 'kind'] as const },
        { tenantId: input.tenantId, organizationId: input.organizationId },
      )
      return rows.map((row) => ({ userId: row.userId, kind: row.kind }))
    },
    resolveAuthPrincipalService: () => resolveAuthPrincipalService(container),
  })
}
