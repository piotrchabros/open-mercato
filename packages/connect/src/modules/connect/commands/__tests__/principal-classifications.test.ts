import {
  ensureConnectPrincipalClassificationCommand,
  undoConnectPrincipalClassificationCommand,
} from '../principal-classifications'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  kind: 'human' as const,
  source: 'connect.test',
  reasonCode: 'test.fixture',
}

function context(options?: { systemActor?: boolean; auth?: object | null; resolve?: (name: string) => unknown }) {
  return {
    container: { resolve: options?.resolve ?? (() => null) },
    auth: options?.auth ?? null,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    systemActor: options?.systemActor,
  } as never
}

describe('principal classification commands', () => {
  it('rejects non-system and authenticated command contexts before resolving storage', async () => {
    const resolve = jest.fn()
    await expect(ensureConnectPrincipalClassificationCommand.execute(INPUT, context({ resolve })))
      .rejects.toThrow('[internal] connect_principal_system_actor_required')
    await expect(ensureConnectPrincipalClassificationCommand.execute(
      INPUT,
      context({ systemActor: true, auth: { sub: 'user' }, resolve }),
    )).rejects.toThrow('[internal] connect_principal_system_actor_required')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed before storage when the Auth facade is unavailable', async () => {
    const transactionEm = {
      execute: jest.fn(),
      findOne: jest.fn(async () => null),
    }
    const resolve = jest.fn((name: string) => {
      if (name === 'em') {
        return { fork: () => ({ transactional: (callback: (em: unknown) => unknown) => callback(transactionEm) }) }
      }
      throw new Error('missing')
    })
    await expect(ensureConnectPrincipalClassificationCommand.execute(
      INPUT,
      context({ systemActor: true, resolve }),
    )).rejects.toThrow('[internal] connect_principal_target_unavailable')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('replays a completed operation without requiring the Auth facade', async () => {
    const updatedAt = new Date('2026-08-22T12:00:00.000Z')
    const transactionEm = {
      execute: jest.fn(),
      findOne: jest.fn(async () => ({
        requestFingerprint: 'placeholder',
      })),
    }
    const rootEm = {
      transactional: jest.fn(async (callback: (em: unknown) => unknown) => callback(transactionEm)),
    }
    const resolve = jest.fn((name: string) => {
      if (name === 'em') return { fork: () => rootEm }
      throw new Error('Auth must not resolve during replay')
    })
    const crypto = await import('node:crypto')
    const canonical = Object.keys(INPUT).sort().map((key) => [key, INPUT[key as keyof typeof INPUT]])
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
    transactionEm.findOne.mockResolvedValueOnce({
      requestFingerprint,
      tombstonedClassification: false,
      afterKind: 'human',
      resultUpdatedAt: updatedAt,
      classificationId: '55555555-5555-4555-8555-555555555555',
      userId: INPUT.userId,
      createdClassification: true,
      changedClassification: false,
    })

    await expect(ensureConnectPrincipalClassificationCommand.execute(
      INPUT,
      context({ systemActor: true, resolve }),
    )).resolves.toEqual({
      classificationId: '55555555-5555-4555-8555-555555555555',
      userId: INPUT.userId,
      kind: 'human',
      created: true,
      changed: false,
      replayed: true,
      updatedAt: updatedAt.toISOString(),
    })
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('applies the same system-only boundary to undo', async () => {
    await expect(undoConnectPrincipalClassificationCommand.execute({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      operationId: INPUT.operationId,
      source: INPUT.source,
      originalChangeId: INPUT.userId,
      expectedUpdatedAt: new Date().toISOString(),
      reasonCode: INPUT.reasonCode,
    }, context())).rejects.toThrow('[internal] connect_principal_system_actor_required')
  })

  it('replays a reconcile pass that now observes a version for the same operation', async () => {
    const updatedAt = new Date('2026-08-22T12:00:00.000Z')
    const firstPass = { ...INPUT, referenceId: undefined, expectedUpdatedAt: undefined }
    const secondPass = { ...INPUT, referenceId: undefined, expectedUpdatedAt: updatedAt.toISOString() }
    const crypto = await import('node:crypto')
    const canonical = Object.keys(firstPass)
      .filter((key) => key !== 'expectedUpdatedAt' && firstPass[key as keyof typeof firstPass] !== undefined)
      .sort()
      .map((key) => [key, firstPass[key as keyof typeof firstPass]])
    const storedFingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')

    const transactionEm = {
      execute: jest.fn(),
      findOne: jest.fn(async () => ({
        requestFingerprint: storedFingerprint,
        tombstonedClassification: false,
        afterKind: 'human',
        resultUpdatedAt: updatedAt,
        classificationId: '55555555-5555-4555-8555-555555555555',
        userId: INPUT.userId,
        createdClassification: true,
        changedClassification: false,
      })),
    }
    const resolve = jest.fn((name: string) => {
      if (name === 'em') {
        return { fork: () => ({ transactional: (callback: (em: unknown) => unknown) => callback(transactionEm) }) }
      }
      throw new Error('Auth must not resolve during replay')
    })

    await expect(ensureConnectPrincipalClassificationCommand.execute(
      secondPass,
      context({ systemActor: true, resolve }),
    )).resolves.toMatchObject({ replayed: true, kind: 'human', created: true })
  })

  it('tombstones the classification when undoing a create', async () => {
    const updatedAt = new Date('2026-08-22T12:00:00.000Z')
    const original = {
      id: '66666666-6666-4666-8666-666666666666',
      classificationId: '55555555-5555-4555-8555-555555555555',
      userId: INPUT.userId,
      beforeKind: null,
      afterKind: 'human',
      createdClassification: true,
      changedClassification: false,
      resultUpdatedAt: updatedAt,
      createdAt: updatedAt,
      outcome: 'completed',
    }
    const classification = { id: original.classificationId, kind: 'human', updatedAt }
    const created: Record<string, unknown>[] = []
    const removed: unknown[] = []
    const transactionEm = {
      execute: jest.fn(),
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(classification),
      remove: jest.fn((entity: unknown) => { removed.push(entity) }),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
      persist: jest.fn((data: Record<string, unknown>) => { created.push(data) }),
      flush: jest.fn(),
    }
    const resolve = jest.fn((name: string) => {
      if (name === 'em') {
        return { fork: () => ({ transactional: (callback: (em: unknown) => unknown) => callback(transactionEm) }) }
      }
      throw new Error('missing')
    })

    await expect(undoConnectPrincipalClassificationCommand.execute({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      operationId: INPUT.operationId,
      source: INPUT.source,
      originalChangeId: original.id,
      expectedUpdatedAt: updatedAt.toISOString(),
      reasonCode: 'test.retire',
    }, context({ systemActor: true, resolve }))).resolves.toEqual({
      classificationId: original.classificationId,
      userId: INPUT.userId,
      kind: null,
      tombstoned: true,
      replayed: false,
      updatedAt: null,
    })

    expect(removed).toEqual([classification])
    expect(original.outcome).toBe('undone')
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      beforeKind: 'human',
      afterKind: null,
      tombstonedClassification: true,
      resultUpdatedAt: null,
      inverseOfId: original.id,
    })
  })

  it('refuses to undo a no-op that neither created nor changed the classification', async () => {
    const updatedAt = new Date('2026-08-22T12:00:00.000Z')
    const transactionEm = {
      execute: jest.fn(),
      findOne: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: '66666666-6666-4666-8666-666666666666',
          createdClassification: false,
          changedClassification: false,
        }),
      remove: jest.fn(),
      create: jest.fn(),
      persist: jest.fn(),
      flush: jest.fn(),
    }
    const resolve = jest.fn((name: string) => {
      if (name === 'em') {
        return { fork: () => ({ transactional: (callback: (em: unknown) => unknown) => callback(transactionEm) }) }
      }
      throw new Error('missing')
    })

    await expect(undoConnectPrincipalClassificationCommand.execute({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      operationId: INPUT.operationId,
      source: INPUT.source,
      originalChangeId: '66666666-6666-4666-8666-666666666666',
      expectedUpdatedAt: updatedAt.toISOString(),
      reasonCode: 'test.retire',
    }, context({ systemActor: true, resolve })))
      .rejects.toThrow('[internal] connect_principal_undo_conflict')
    expect(transactionEm.remove).not.toHaveBeenCalled()
  })

  it('never sends the sensitive command input to the generic action log', () => {
    expect(ensureConnectPrincipalClassificationCommand.buildLog?.({} as never)).toEqual({ skipLog: true })
    expect(undoConnectPrincipalClassificationCommand.buildLog?.({} as never)).toEqual({ skipLog: true })
  })
})
