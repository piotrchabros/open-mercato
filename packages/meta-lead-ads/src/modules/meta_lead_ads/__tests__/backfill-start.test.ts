import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'

const findOneWithDecryptionMock = jest.fn()
const enqueueBackfillMock = jest.fn()
const enqueueProcessLeadMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))
jest.mock('../lib/queue', () => ({
  enqueueBackfill: (...args: unknown[]) => enqueueBackfillMock(...args),
  enqueueProcessLead: (...args: unknown[]) => enqueueProcessLeadMock(...args),
}))

import { MetaForm, MetaPage, MetaSyncRun } from '../data/entities'
import { startBackfill } from '../lib/backfill'

type RunRow = { id: string; progressJobId: string | null; status?: string }

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const input = {
  formId: 'form-1',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-02T00:00:00.000Z',
}
const form = { id: 'form-1', pageId: 'page-1', name: 'Lead form' }
const page = { id: 'page-1', subscriptionStatus: 'active' }

function setup(options: { runningRun: RunRow | null }) {
  const created: RunRow[] = []
  const transactionEm = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const row: RunRow = { id: 'run-1', ...data, progressJobId: (data.progressJobId as string | null) ?? null }
      created.push(row)
      return row
    }),
    persist: jest.fn(() => ({ flush: async () => undefined })),
  }
  const transactional = jest.fn(async (callback: (em: typeof transactionEm) => Promise<unknown>) =>
    callback(transactionEm),
  )
  const flush = jest.fn(async () => undefined)
  const forkEm = { transactional, flush }
  const em = { fork: () => forkEm } as unknown as EntityManager
  const lockCalls: unknown[][] = []
  findOneWithDecryptionMock.mockImplementation(async (...args: unknown[]) => {
    const [emArg, entity] = args
    if (entity === MetaForm) {
      if (emArg === transactionEm) lockCalls.push(args)
      return { ...form }
    }
    if (entity === MetaPage) return { ...page }
    if (entity === MetaSyncRun) return options.runningRun
    return null
  })
  const createJob = jest.fn(async () => ({ id: 'progress-1' }))
  const failJob = jest.fn(async () => undefined)
  const container = {
    resolve: (name: string) => (name === 'progressService' ? { createJob, failJob } : undefined),
  } as unknown as AwilixContainer
  return { em, container, transactional, transactionEm, flush, createJob, created, lockCalls }
}

describe('startBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enqueueBackfillMock.mockResolvedValue(undefined)
  })

  it('locks the form row inside a transaction', async () => {
    const env = setup({ runningRun: null })
    await startBackfill({ container: env.container, em: env.em, scope, userId: 'user-1' }, input)
    expect(env.transactional).toHaveBeenCalledTimes(1)
    expect(env.lockCalls).toHaveLength(1)
    const [, , where, findOptions] = env.lockCalls[0]
    expect(where).toEqual({ id: 'form-1', ...scope, deletedAt: null })
    expect(findOptions).toEqual({ lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
  })

  it('rejects with 409 when a backfill is already running', async () => {
    const env = setup({ runningRun: { id: 'run-0', progressJobId: null, status: 'running' } })
    await expect(
      startBackfill({ container: env.container, em: env.em, scope, userId: 'user-1' }, input),
    ).rejects.toMatchObject({ status: 409, body: { code: 'backfill_already_running' } })
    expect(env.createJob).not.toHaveBeenCalled()
    expect(enqueueBackfillMock).not.toHaveBeenCalled()
    expect(env.created).toHaveLength(0)
  })

  it('creates the run, attaches the progress job and enqueues the backfill', async () => {
    const env = setup({ runningRun: null })
    const result = await startBackfill({ container: env.container, em: env.em, scope, userId: 'user-1' }, input)
    expect(env.created).toHaveLength(1)
    expect(env.transactionEm.create).toHaveBeenCalledWith(
      MetaSyncRun,
      expect.objectContaining({ kind: 'backfill', formId: 'form-1', progressJobId: null, ...scope }),
    )
    expect(env.created[0].progressJobId).toBe('progress-1')
    expect(env.flush).toHaveBeenCalled()
    expect(enqueueBackfillMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', formId: 'form-1', progressJobId: 'progress-1', ...scope }),
    )
    expect(result).toEqual({ runId: 'run-1', progressJobId: 'progress-1' })
  })
})
