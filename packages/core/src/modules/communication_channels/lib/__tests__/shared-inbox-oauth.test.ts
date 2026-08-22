import type { EntityManager } from '@mikro-orm/postgresql'
import { SharedInboxOAuthState } from '../../data/entities'
import { consumeSharedInboxOAuthState, hashOAuthState } from '../shared-inbox-oauth'

/**
 * The shared-mailbox OAuth state must be single-use: a replayed callback URL, a
 * double-submitted redirect, or a browser prefetch must provision at most one
 * inbox. The claim is one conditional UPDATE, so this fake models that UPDATE's
 * semantics rather than the ORM's.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const ADMIN = '55555555-5555-4555-8555-555555555555'
const RAW_STATE = 'state-value-abc'

type StateRow = {
  id: string
  tenant_id: string
  organization_id: string
  state_hash: string
  nonce: string
  initiated_by_user_id: string
  provider_key: string
  display_name: string | null
  return_url: string | null
  expiresAt: Date
  consumedAt: Date | null
}

function createEm(rows: StateRow[]): EntityManager {
  return {
    execute: jest.fn(async (_sql: string, params: unknown[]) => {
      const [now, stateHash] = params as [Date, string]
      const row = rows.find((candidate) => candidate.state_hash === stateHash)
      if (!row) return []
      if (row.consumedAt) return []
      if (row.expiresAt.getTime() <= now.getTime()) return []
      row.consumedAt = now
      return [
        {
          id: row.id,
          tenant_id: row.tenant_id,
          organization_id: row.organization_id,
          nonce: row.nonce,
          initiated_by_user_id: row.initiated_by_user_id,
          provider_key: row.provider_key,
          display_name: row.display_name,
          return_url: row.return_url,
        },
      ]
    }),
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== SharedInboxOAuthState) return null
      const row = rows.find((candidate) => candidate.state_hash === where.stateHash)
      if (!row) return null
      return { consumedAt: row.consumedAt, expiresAt: row.expiresAt }
    }),
  } as unknown as EntityManager
}

function stateRow(overrides: Partial<StateRow> = {}): StateRow {
  return {
    id: 'state-1',
    tenant_id: TENANT,
    organization_id: ORG,
    state_hash: hashOAuthState(RAW_STATE),
    nonce: 'nonce-1',
    initiated_by_user_id: ADMIN,
    provider_key: 'gmail',
    display_name: 'Support',
    return_url: '/backend/communication_channels/shared-inboxes',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  }
}

describe('hashOAuthState', () => {
  // Only the hash is persisted, so a database read cannot be replayed as a
  // valid callback `state`.
  it('is deterministic and never returns the raw state', () => {
    const hash = hashOAuthState(RAW_STATE)
    expect(hash).toBe(hashOAuthState(RAW_STATE))
    expect(hash).not.toContain(RAW_STATE)
    expect(hash).toHaveLength(64)
  })
})

describe('consumeSharedInboxOAuthState', () => {
  it('claims a fresh state and returns the server-held scope', async () => {
    const rows = [stateRow()]
    const result = await consumeSharedInboxOAuthState(createEm(rows), RAW_STATE)
    expect(result).toEqual({
      status: 'consumed',
      state: {
        id: 'state-1',
        tenantId: TENANT,
        organizationId: ORG,
        nonce: 'nonce-1',
        initiatedByUserId: ADMIN,
        providerKey: 'gmail',
        displayName: 'Support',
        returnUrl: '/backend/communication_channels/shared-inboxes',
      },
    })
  })

  it('lets exactly one of two concurrent callbacks win', async () => {
    const rows = [stateRow()]
    const em = createEm(rows)
    const [first, second] = await Promise.all([
      consumeSharedInboxOAuthState(em, RAW_STATE),
      consumeSharedInboxOAuthState(em, RAW_STATE),
    ])
    const consumed = [first, second].filter((result) => result.status === 'consumed')
    expect(consumed).toHaveLength(1)
    expect([first, second].map((result) => result.status)).toContain('already_consumed')
  })

  it('reports an already consumed state', async () => {
    const rows = [stateRow({ consumedAt: new Date() })]
    const result = await consumeSharedInboxOAuthState(createEm(rows), RAW_STATE)
    expect(result).toEqual({ status: 'already_consumed' })
  })

  it('reports an expired state', async () => {
    const rows = [stateRow({ expiresAt: new Date(Date.now() - 1_000) })]
    const result = await consumeSharedInboxOAuthState(createEm(rows), RAW_STATE)
    expect(result).toEqual({ status: 'expired' })
  })

  it('reports an unknown state without revealing anything about it', async () => {
    const result = await consumeSharedInboxOAuthState(createEm([]), RAW_STATE)
    expect(result).toEqual({ status: 'not_found' })
  })

  it('does not claim a state issued for a different value', async () => {
    const rows = [stateRow({ state_hash: hashOAuthState('a-different-state') })]
    const result = await consumeSharedInboxOAuthState(createEm(rows), RAW_STATE)
    expect(result).toEqual({ status: 'not_found' })
  })
})
