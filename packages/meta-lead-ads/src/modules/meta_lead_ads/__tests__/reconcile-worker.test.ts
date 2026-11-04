const findWithDecryptionMock = jest.fn()
const importListedLeadsMock = jest.fn()
const applyGraphErrorSideEffectsMock = jest.fn()
const enqueueProcessLeadMock = jest.fn()
const resolveAppCredentialsMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('../lib/backfill', () => ({
  importListedLeads: (...args: unknown[]) => importListedLeadsMock(...args),
}))

jest.mock('../lib/page-service', () => ({
  applyGraphErrorSideEffects: (...args: unknown[]) => applyGraphErrorSideEffectsMock(...args),
}))

jest.mock('../lib/preset', () => ({
  resolveAppCredentials: (...args: unknown[]) => resolveAppCredentialsMock(...args),
  graphOptionsFromCredentials: (credentials: { graphBaseUrl: string | null }) => ({
    graphVersion: 'v24.0',
    baseUrl: credentials.graphBaseUrl,
  }),
}))

jest.mock('../lib/queue', () => {
  const actual = jest.requireActual('../lib/queue')
  return {
    resolveJobScope: actual.resolveJobScope,
    enqueueProcessLead: (...args: unknown[]) => enqueueProcessLeadMock(...args),
  }
})

import { MetaForm, MetaPage, MetaSyncRun } from '../data/entities'
import { MetaGraphError, classifyGraphError, type MetaGraphClient } from '../lib/graph-client'
import handle, { metadata, sweepStuckLeadEvents } from '../workers/reconcile'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

function buildPage(overrides: Partial<MetaPage> = {}): MetaPage {
  return Object.assign(new MetaPage(), {
    id: 'page-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    connectionId: 'connection-1',
    metaPageId: 'meta-page-1',
    name: 'Acme Page',
    pageAccessToken: 'page-token',
    subscriptionStatus: 'active',
    ...overrides,
  })
}

function buildForm(overrides: Partial<MetaForm> = {}): MetaForm {
  return Object.assign(new MetaForm(), {
    id: 'form-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    pageId: 'page-1',
    metaFormId: 'meta-form-1',
    name: 'Form',
    isEnabled: true,
    ...overrides,
  })
}

function createStubEm(stuckBatches: { id: string }[][] = []) {
  const created: Record<string, unknown>[] = []
  const pending = [...stuckBatches]
  const em = {
    created,
    fork: jest.fn(),
    find: jest.fn(async () => pending.shift() ?? []),
    nativeUpdate: jest.fn(async (_entity: unknown, where: { $and: [{ id: { $in: string[] } }] }) => where.$and[0].id.$in.length),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const run = Object.assign(new MetaSyncRun(), data)
      created.push(run as unknown as Record<string, unknown>)
      return run
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  }
  em.fork.mockReturnValue(em)
  em.persist.mockReturnValue(em)
  return em
}

function createGraph(listFormLeads: jest.Mock): MetaGraphClient {
  return { listFormLeads } as unknown as MetaGraphClient
}

function createContext(em: ReturnType<typeof createStubEm>, graph: MetaGraphClient) {
  const services: Record<string, unknown> = { em, metaGraphClient: graph }
  return {
    resolve: jest.fn((name: string) => services[name]),
  } as never
}

function buildJob(payload: Record<string, unknown>) {
  return { id: 'job-1', payload, createdAt: new Date().toISOString() } as never
}

function mockPagesAndForms(pages: MetaPage[], forms: MetaForm[]) {
  findWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === MetaPage) return pages
    if (entity === MetaForm) return forms
    return []
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  resolveAppCredentialsMock.mockResolvedValue({ graphBaseUrl: 'http://127.0.0.1:9999', graphVersion: null })
  importListedLeadsMock.mockImplementation(async ({ leads }: { leads: unknown[] }) => ({
    checked: leads.length,
    imported: leads.length,
    duplicates: 0,
  }))
  enqueueProcessLeadMock.mockResolvedValue('job')
})

describe('reconcile worker', () => {
  it('declares the reconcile queue with concurrency 1', () => {
    expect(metadata).toEqual({
      queue: 'meta-lead-ads-reconcile',
      id: 'meta_lead_ads:reconcile',
      concurrency: 1,
    })
  })

  it('ignores jobs without a scope', async () => {
    const em = createStubEm()
    await handle(buildJob({}), createContext(em, createGraph(jest.fn())))
    expect(em.create).not.toHaveBeenCalled()
  })

  it('paginates leads per enabled form with org graph options and records a completed run', async () => {
    const em = createStubEm()
    mockPagesAndForms([buildPage()], [buildForm()])
    const listFormLeads = jest
      .fn()
      .mockResolvedValueOnce({ leads: [{ id: 'l1' }, { id: 'l2' }], paging: { after: 'cursor-1', hasNext: true } })
      .mockResolvedValueOnce({ leads: [{ id: 'l3' }], paging: { after: null, hasNext: false } })
    importListedLeadsMock
      .mockResolvedValueOnce({ checked: 2, imported: 1, duplicates: 1 })
      .mockResolvedValueOnce({ checked: 1, imported: 1, duplicates: 0 })

    await handle(buildJob({ scope }), createContext(em, createGraph(listFormLeads)))

    expect(listFormLeads).toHaveBeenCalledTimes(2)
    const [firstInput, firstOptions] = listFormLeads.mock.calls[0]
    expect(firstInput).toMatchObject({ metaFormId: 'meta-form-1', pageToken: 'page-token', after: null, limit: 100 })
    expect(firstInput.toUnix - firstInput.fromUnix).toBe(48 * 60 * 60)
    expect(firstOptions).toEqual({ graphVersion: 'v24.0', baseUrl: 'http://127.0.0.1:9999' })
    expect(listFormLeads.mock.calls[1][0].after).toBe('cursor-1')
    expect(importListedLeadsMock.mock.calls[0][0]).toMatchObject({ source: 'reconciliation' })
    const run = em.created[0] as unknown as MetaSyncRun
    expect(run).toMatchObject({
      kind: 'reconciliation',
      status: 'completed',
      checked: 3,
      imported: 2,
      duplicates: 1,
      failed: 0,
    })
    expect(run.finishedAt).toBeInstanceOf(Date)
  })

  it('reads the scope from tenantId/organizationId when scope is absent', async () => {
    const em = createStubEm()
    mockPagesAndForms([], [])
    await handle(buildJob(scope), createContext(em, createGraph(jest.fn())))
    expect(em.created[0]).toMatchObject({ organizationId: 'org-1', status: 'completed' })
  })

  it('applies graph error side effects and continues with other pages', async () => {
    const em = createStubEm()
    const brokenPage = buildPage({ id: 'page-1', metaPageId: 'meta-page-1', pageAccessToken: 'broken-token' })
    const healthyPage = buildPage({ id: 'page-2', metaPageId: 'meta-page-2', pageAccessToken: 'good-token' })
    mockPagesAndForms(
      [brokenPage, healthyPage],
      [
        buildForm({ id: 'form-1', pageId: 'page-1', metaFormId: 'meta-form-1' }),
        buildForm({ id: 'form-2', pageId: 'page-1', metaFormId: 'meta-form-2' }),
        buildForm({ id: 'form-3', pageId: 'page-2', metaFormId: 'meta-form-3' }),
      ],
    )
    const graphError = new MetaGraphError({
      status: 400,
      code: 190,
      classification: classifyGraphError({ status: 400, body: { error: { code: 190 } } }),
    })
    const listFormLeads = jest.fn(async (input: { pageToken: string }) => {
      if (input.pageToken === 'broken-token') throw graphError
      return { leads: [{ id: 'l1' }], paging: { after: null, hasNext: false } }
    })

    await handle(buildJob({ scope }), createContext(em, createGraph(listFormLeads)))

    expect(applyGraphErrorSideEffectsMock).toHaveBeenCalledTimes(1)
    const [sideEffectCtx, target, classification] = applyGraphErrorSideEffectsMock.mock.calls[0]
    expect(sideEffectCtx.em).toBe(em)
    expect(target).toEqual({ page: brokenPage, connectionId: 'connection-1' })
    expect(classification).toBe(graphError.classification)
    expect(listFormLeads).toHaveBeenCalledTimes(2)
    expect(em.created[0]).toMatchObject({ status: 'completed', checked: 1, imported: 1, failed: 2 })
  })

  it('counts forms of a page without an access token as failed', async () => {
    const em = createStubEm()
    mockPagesAndForms([buildPage({ pageAccessToken: null })], [buildForm()])
    const listFormLeads = jest.fn()
    await handle(buildJob({ scope }), createContext(em, createGraph(listFormLeads)))
    expect(listFormLeads).not.toHaveBeenCalled()
    expect(em.created[0]).toMatchObject({ status: 'completed', failed: 1 })
  })

  it('marks the run failed and rethrows on unexpected errors', async () => {
    const em = createStubEm()
    mockPagesAndForms([buildPage()], [buildForm()])
    const listFormLeads = jest.fn(async () => ({ leads: [{ id: 'l1' }], paging: { after: null, hasNext: false } }))
    importListedLeadsMock.mockRejectedValueOnce(new Error('db down'))

    await expect(handle(buildJob({ scope }), createContext(em, createGraph(listFormLeads)))).rejects.toThrow('db down')

    const run = em.created[0] as unknown as MetaSyncRun
    expect(run.status).toBe('failed')
    expect(run.error).toBe('Reconciliation failed')
    expect(run.finishedAt).toBeInstanceOf(Date)
  })

  it('sweeps stuck events back to received and re-enqueues them during the run', async () => {
    const em = createStubEm([[{ id: 'event-1' }, { id: 'event-2' }]])
    mockPagesAndForms([], [])

    await handle(buildJob({ scope }), createContext(em, createGraph(jest.fn())))

    expect(em.nativeUpdate).toHaveBeenCalledTimes(1)
    expect(em.nativeUpdate.mock.calls[0][2]).toMatchObject({ status: 'received', nextAttemptAt: null })
    expect(enqueueProcessLeadMock).toHaveBeenCalledWith({
      leadEventId: 'event-1',
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
    expect(enqueueProcessLeadMock).toHaveBeenCalledTimes(2)
  })
})

describe('sweepStuckLeadEvents', () => {
  it('filters received/processing/retrying events older than two hours in scope', async () => {
    const em = createStubEm([[{ id: 'event-1' }]])
    const now = new Date('2026-11-04T12:00:00.000Z')

    const swept = await sweepStuckLeadEvents(em as never, scope, now)

    expect(swept).toBe(1)
    const filter = (em.find.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    expect(filter).toMatchObject({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      status: { $in: ['received', 'processing', 'retrying'] },
      updatedAt: { $lt: new Date('2026-11-04T10:00:00.000Z') },
      deletedAt: null,
    })
  })

  it('returns zero when nothing is stuck', async () => {
    const em = createStubEm()
    expect(await sweepStuckLeadEvents(em as never, scope, new Date())).toBe(0)
    expect(em.nativeUpdate).not.toHaveBeenCalled()
    expect(enqueueProcessLeadMock).not.toHaveBeenCalled()
  })
})
