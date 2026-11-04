import type { EntityManager } from '@mikro-orm/postgresql'

type FormRow = {
  id: string
  ownerMode: 'none' | 'fixed' | 'round_robin'
  ownerUserId: string | null
  ownerUserIds: string[]
  roundRobinCursor: number
}

const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('@open-mercato/core/modules/auth/data/entities', () => ({
  User: class User {},
}))

import { assignOwner, pickNextRoundRobin } from '../lib/owner-assignment'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const always = () => true

function createFakeEm(form: FormRow | null, activeUserIds: string[]) {
  const nativeUpdate = jest.fn(async () => 1)
  const transactionEm = { nativeUpdate }
  const transactional = jest.fn(async (callback: (em: typeof transactionEm) => Promise<unknown>) =>
    callback(transactionEm),
  )
  findOneWithDecryptionMock.mockImplementation(async () => (form ? { ...form } : null))
  findWithDecryptionMock.mockImplementation(async (_em: unknown, _entity: unknown, where: { id: { $in: string[] } }) =>
    where.id.$in.filter((id) => activeUserIds.includes(id)).map((id) => ({ id })),
  )
  return { em: { transactional } as unknown as EntityManager, nativeUpdate, transactional }
}

function buildForm(overrides: Partial<FormRow>): FormRow {
  return {
    id: 'form-1',
    ownerMode: 'round_robin',
    ownerUserId: null,
    ownerUserIds: [],
    roundRobinCursor: 0,
    ...overrides,
  }
}

describe('pickNextRoundRobin', () => {
  it('rotates through the users in order and wraps around', () => {
    const users = ['user-a', 'user-b', 'user-c']
    const owners: Array<string | null> = []
    let cursor = 0
    for (let step = 0; step < 4; step += 1) {
      const pick = pickNextRoundRobin(users, cursor, always)
      owners.push(pick.ownerUserId)
      cursor = pick.nextCursor
    }
    expect(owners).toEqual(['user-a', 'user-b', 'user-c', 'user-a'])
    expect(cursor).toBe(1)
  })

  it('skips inactive users', () => {
    const users = ['user-a', 'user-b', 'user-c']
    const isActive = (id: string) => id !== 'user-b'
    const first = pickNextRoundRobin(users, 1, isActive)
    expect(first).toEqual({ ownerUserId: 'user-c', nextCursor: 0 })
    const second = pickNextRoundRobin(users, first.nextCursor, isActive)
    expect(second).toEqual({ ownerUserId: 'user-a', nextCursor: 1 })
  })

  it('normalizes cursors that are out of range', () => {
    expect(pickNextRoundRobin(['user-a', 'user-b'], 5, always)).toEqual({ ownerUserId: 'user-b', nextCursor: 0 })
    expect(pickNextRoundRobin(['user-a', 'user-b'], -1, always)).toEqual({ ownerUserId: 'user-b', nextCursor: 0 })
  })

  it('returns no owner for an empty rotation', () => {
    expect(pickNextRoundRobin([], 3, always)).toEqual({ ownerUserId: null, nextCursor: 0 })
  })

  it('returns no owner and keeps the cursor when every user is inactive', () => {
    expect(pickNextRoundRobin(['user-a', 'user-b'], 1, () => false)).toEqual({ ownerUserId: null, nextCursor: 1 })
  })
})

describe('assignOwner', () => {
  beforeEach(() => {
    findOneWithDecryptionMock.mockReset()
    findWithDecryptionMock.mockReset()
  })

  it('locks the form row and advances the cursor for round-robin', async () => {
    const form = buildForm({ ownerUserIds: ['user-a', 'user-b'], roundRobinCursor: 1 })
    const { em, nativeUpdate, transactional } = createFakeEm(form, ['user-a', 'user-b'])

    const result = await assignOwner(em, scope, 'form-1')

    expect(result).toEqual({ ownerUserId: 'user-b', unavailable: false })
    expect(transactional).toHaveBeenCalledTimes(1)
    const lockOptions = findOneWithDecryptionMock.mock.calls[0][3] as { lockMode: unknown }
    expect(lockOptions.lockMode).toBeDefined()
    expect(findOneWithDecryptionMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ id: 'form-1', tenantId: 'tenant-1', organizationId: 'org-1', deletedAt: null }),
    )
    expect(nativeUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'form-1', tenantId: 'tenant-1', organizationId: 'org-1' }),
      { roundRobinCursor: 0 },
    )
  })

  it('looks users up by id within the tenant and skips deleted or missing ones', async () => {
    const form = buildForm({ ownerUserIds: ['user-a', 'user-gone', 'user-c'], roundRobinCursor: 1 })
    const { em } = createFakeEm(form, ['user-a', 'user-c'])

    const result = await assignOwner(em, scope, 'form-1')

    expect(result).toEqual({ ownerUserId: 'user-c', unavailable: false })
    expect(findWithDecryptionMock.mock.calls[0][2]).toEqual(
      expect.objectContaining({ tenantId: 'tenant-1', deletedAt: null }),
    )
  })

  it('flags the form with owner_unavailable when the rotation is empty', async () => {
    const form = buildForm({ ownerUserIds: [] })
    const { em, nativeUpdate } = createFakeEm(form, [])

    const result = await assignOwner(em, scope, 'form-1')

    expect(result).toEqual({ ownerUserId: null, unavailable: true })
    expect(nativeUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'form-1' }), {
      needsAttention: true,
      attentionReason: 'owner_unavailable',
    })
  })

  it('flags the form when every user in the rotation is inactive', async () => {
    const form = buildForm({ ownerUserIds: ['user-a', 'user-b'] })
    const { em, nativeUpdate } = createFakeEm(form, [])

    const result = await assignOwner(em, scope, 'form-1')

    expect(result).toEqual({ ownerUserId: null, unavailable: true })
    expect(nativeUpdate).toHaveBeenCalledTimes(1)
  })

  it('returns the fixed owner when that user is active', async () => {
    const form = buildForm({ ownerMode: 'fixed', ownerUserId: 'user-fixed' })
    const { em, nativeUpdate } = createFakeEm(form, ['user-fixed'])

    await expect(assignOwner(em, scope, 'form-1')).resolves.toEqual({ ownerUserId: 'user-fixed', unavailable: false })
    expect(nativeUpdate).not.toHaveBeenCalled()
  })

  it('flags the form when the fixed owner is deleted', async () => {
    const form = buildForm({ ownerMode: 'fixed', ownerUserId: 'user-fixed' })
    const { em } = createFakeEm(form, [])

    await expect(assignOwner(em, scope, 'form-1')).resolves.toEqual({ ownerUserId: null, unavailable: true })
  })

  it('assigns nobody without flagging when owner mode is none or the form is missing', async () => {
    const noneForm = createFakeEm(buildForm({ ownerMode: 'none' }), [])
    await expect(assignOwner(noneForm.em, scope, 'form-1')).resolves.toEqual({ ownerUserId: null, unavailable: false })
    expect(noneForm.nativeUpdate).not.toHaveBeenCalled()

    const missing = createFakeEm(null, [])
    await expect(assignOwner(missing.em, scope, 'form-1')).resolves.toEqual({ ownerUserId: null, unavailable: false })
  })
})
