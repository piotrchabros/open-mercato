const findOneWithDecryptionMock = jest.fn()
const enqueueBackfillMock = jest.fn()
const importListedLeadsMock = jest.fn()
const listFormLeadsMock = jest.fn()
const applySideEffectsMock = jest.fn()
const resolveAppCredentialsMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))
jest.mock('../lib/queue', () => ({
  enqueueBackfill: (...args: unknown[]) => enqueueBackfillMock(...args),
  resolveJobScope: (payload: { tenantId: string; organizationId: string }) => ({
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  }),
}))
jest.mock('../lib/backfill', () => ({
  importListedLeads: (...args: unknown[]) => importListedLeadsMock(...args),
}))
jest.mock('../lib/preset', () => ({
  resolveAppCredentials: (...args: unknown[]) => resolveAppCredentialsMock(...args),
  graphOptionsFromCredentials: (credentials: { graphVersion: string; graphBaseUrl: string | null }) => ({
    graphVersion: credentials.graphVersion,
    baseUrl: credentials.graphBaseUrl,
  }),
}))
jest.mock('../lib/page-service', () => ({
  applyGraphErrorSideEffects: (...args: unknown[]) => applySideEffectsMock(...args),
  describeGraphError: () => 'Graph API error (token_invalid)',
}))

import { MetaForm, MetaPage, MetaSyncRun } from '../data/entities'
import { MetaGraphError, classifyGraphError, setMetaGraphClient, type MetaGraphClient } from '../lib/graph-client'
import handle from '../workers/backfill'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const payload = {
  runId: 'run-1',
  formId: 'form-1',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-02T00:00:00.000Z',
  after: null as string | null,
  progressJobId: 'progress-1',
  ...scope,
}

function buildRun() {
  return {
    id: 'run-1',
    status: 'running',
    checked: 0,
    imported: 0,
    duplicates: 0,
    rangeFrom: new Date('2026-01-01T00:00:00.000Z'),
    rangeTo: new Date('2026-01-02T00:00:00.000Z'),
    startedAt: new Date(),
  }
}

function buildHarness() {
  const run = buildRun()
  const em = {
    fork: () => em,
    findOne: jest.fn(async () => run),
    nativeUpdate: jest.fn(async () => 1),
  }
  const progressService = {
    startJob: jest.fn(async () => ({})),
    updateProgress: jest.fn(async () => ({})),
    completeJob: jest.fn(async () => ({})),
    failJob: jest.fn(async () => ({})),
  }
  const ctx = {
    jobId: 'job-1',
    attemptNumber: 1,
    queueName: 'meta-lead-ads-backfill',
    resolve: (name: string) => (name === 'em' ? em : progressService),
  }
  return { em, run, progressService, ctx }
}

function runUpdates(em: { nativeUpdate: jest.Mock }) {
  return em.nativeUpdate.mock.calls.map((call) => call[2] as Record<string, unknown>)
}

describe('meta_lead_ads backfill worker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === MetaForm) return { id: 'form-1', pageId: 'page-1', metaFormId: 'meta-form-1' }
      if (entity === MetaPage) return { id: 'page-1', metaPageId: 'meta-page-1', pageAccessToken: 'token' }
      return null
    })
    resolveAppCredentialsMock.mockResolvedValue({ graphVersion: 'v24.0', graphBaseUrl: 'http://fake-graph' })
    importListedLeadsMock.mockResolvedValue({ checked: 2, imported: 1, duplicates: 1 })
  })

  afterEach(() => setMetaGraphClient(null))

  function installGraph(listFormLeads: MetaGraphClient['listFormLeads']) {
    setMetaGraphClient({ listFormLeads } as MetaGraphClient)
  }

  it('imports one page and completes the run when there is no next cursor', async () => {
    const { em, progressService, ctx } = buildHarness()
    listFormLeadsMock.mockResolvedValue({ leads: [], paging: { after: null, hasNext: false } })
    installGraph(listFormLeadsMock)

    await handle({ payload } as never, ctx as never)

    expect(listFormLeadsMock).toHaveBeenCalledWith(
      expect.objectContaining({ metaFormId: 'meta-form-1', pageToken: 'token', after: null }),
      { graphVersion: 'v24.0', baseUrl: 'http://fake-graph' },
    )
    expect(enqueueBackfillMock).not.toHaveBeenCalled()
    expect(runUpdates(em)).toEqual([
      { checked: 2, imported: 1, duplicates: 1 },
      expect.objectContaining({ status: 'completed', error: null }),
    ])
    expect(em.nativeUpdate.mock.calls[0][0]).toBe(MetaSyncRun)
    expect(progressService.startJob).toHaveBeenCalledTimes(1)
    expect(progressService.completeJob).toHaveBeenCalledTimes(1)
  })

  it('re-enqueues the next cursor instead of completing', async () => {
    const { em, progressService, ctx } = buildHarness()
    listFormLeadsMock.mockResolvedValue({ leads: [], paging: { after: 'cursor-2', hasNext: true } })
    installGraph(listFormLeadsMock)

    await handle({ payload } as never, ctx as never)

    expect(enqueueBackfillMock).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', after: 'cursor-2' }))
    expect(runUpdates(em)).toEqual([{ checked: 2, imported: 1, duplicates: 1 }])
    expect(progressService.completeJob).not.toHaveBeenCalled()
  })

  it('fails the run with a sanitized error on a permanent Graph error', async () => {
    const { em, progressService, ctx } = buildHarness()
    listFormLeadsMock.mockRejectedValue(
      new MetaGraphError({ status: 401, classification: classifyGraphError({ status: 401, body: { error: { code: 190 } } }) }),
    )
    installGraph(listFormLeadsMock)

    await handle({ payload } as never, ctx as never)

    expect(applySideEffectsMock).toHaveBeenCalledTimes(1)
    expect(runUpdates(em)).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Graph API error (token_invalid)' }),
    ])
    expect(progressService.failJob).toHaveBeenCalledWith(
      'progress-1',
      { errorMessage: 'Graph API error (token_invalid)' },
      expect.objectContaining(scope),
    )
    expect(enqueueBackfillMock).not.toHaveBeenCalled()
  })

  it('re-enqueues the same cursor with a delay on a transient Graph error', async () => {
    const { em, ctx } = buildHarness()
    listFormLeadsMock.mockRejectedValue(
      new MetaGraphError({ status: 503, classification: classifyGraphError({ status: 503 }) }),
    )
    installGraph(listFormLeadsMock)

    await handle({ payload: { ...payload, after: 'cursor-1' } } as never, ctx as never)

    expect(enqueueBackfillMock).toHaveBeenCalledWith(
      expect.objectContaining({ after: 'cursor-1' }),
      { delayMs: 60_000 },
    )
    expect(em.nativeUpdate).not.toHaveBeenCalled()
  })

  it('does nothing when the run is no longer running', async () => {
    const { em, run, ctx } = buildHarness()
    run.status = 'failed'
    await handle({ payload } as never, ctx as never)
    expect(listFormLeadsMock).not.toHaveBeenCalled()
    expect(em.nativeUpdate).not.toHaveBeenCalled()
  })
})
