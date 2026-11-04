const claimLeadEventForProcessingMock = jest.fn()
const processLeadEventMock = jest.fn()
const applyTransientFailureMock = jest.fn()
const reportErrorMock = jest.fn()

jest.mock('../lib/lead-processor', () => ({
  claimLeadEventForProcessing: (...args: unknown[]) => claimLeadEventForProcessingMock(...args),
  processLeadEvent: (...args: unknown[]) => processLeadEventMock(...args),
}))

jest.mock('../lib/retry-policy', () => ({
  applyTransientFailure: (...args: unknown[]) => applyTransientFailureMock(...args),
}))

jest.mock('@open-mercato/shared/lib/telemetry/runtime', () => ({
  getTelemetryRuntime: () => ({ reportError: (...args: unknown[]) => reportErrorMock(...args) }),
}))

import { MetaLeadEvent } from '../data/entities'
import { TransientLeadError } from '../lib/errors'
import handle, { metadata } from '../workers/process-lead'

const job = {
  id: 'job-1',
  payload: { leadEventId: 'event-1', tenantId: 'tenant-1', organizationId: 'org-1' },
  createdAt: new Date().toISOString(),
}
const SCOPE = { tenantId: 'tenant-1', organizationId: 'org-1' }
const jobContext = { jobId: 'job-1', attemptNumber: 1, queueName: 'meta-lead-ads-process' }

function buildContext() {
  const em = { fork: jest.fn(), nativeUpdate: jest.fn().mockResolvedValue(1) }
  em.fork.mockReturnValue(em)
  const graph = { getLead: jest.fn() }
  const resolve = jest.fn((name: string) => {
    if (name === 'em') return em
    if (name === 'metaGraphClient') return graph
    throw new Error(`unexpected resolve ${name}`)
  })
  return { em, graph, resolve, ctx: { ...jobContext, resolve } }
}

describe('meta_lead_ads process-lead worker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('declares the process queue with concurrency 5', () => {
    expect(metadata.queue).toBe('meta-lead-ads-process')
    expect(metadata.concurrency).toBe(5)
  })

  it('processes a claimed event', async () => {
    const { em, graph, ctx } = buildContext()
    claimLeadEventForProcessingMock.mockResolvedValue({ id: 'event-1', tenantId: 'tenant-1', organizationId: 'org-1' })
    processLeadEventMock.mockResolvedValue({ status: 'processed' })
    await handle(job, ctx)
    expect(claimLeadEventForProcessingMock).toHaveBeenCalledWith(em, 'event-1', SCOPE)
    expect(processLeadEventMock).toHaveBeenCalledWith(expect.objectContaining({ em, graph }), 'event-1', SCOPE)
  })

  it('ignores jobs without a tenant and organization scope', async () => {
    const { ctx } = buildContext()
    await handle({ ...job, payload: { leadEventId: 'event-1', tenantId: null, organizationId: null } }, ctx)
    expect(claimLeadEventForProcessingMock).not.toHaveBeenCalled()
    expect(processLeadEventMock).not.toHaveBeenCalled()
  })

  it('does nothing when the claim returns null', async () => {
    const { ctx } = buildContext()
    claimLeadEventForProcessingMock.mockResolvedValue(null)
    await handle(job, ctx)
    expect(processLeadEventMock).not.toHaveBeenCalled()
    expect(applyTransientFailureMock).not.toHaveBeenCalled()
  })

  it('delegates transient errors to applyTransientFailure', async () => {
    const { em, ctx } = buildContext()
    const error = new TransientLeadError('graph_transient', 'boom')
    claimLeadEventForProcessingMock.mockResolvedValue({ id: 'event-1' })
    processLeadEventMock.mockRejectedValue(error)
    await handle(job, ctx)
    expect(applyTransientFailureMock).toHaveBeenCalledWith(expect.objectContaining({ em }), 'event-1', error, SCOPE)
    expect(em.nativeUpdate).not.toHaveBeenCalled()
  })

  it('routes unexpected errors through the retry policy as transient unknown errors', async () => {
    const { em, ctx } = buildContext()
    const original = new Error('db blip')
    claimLeadEventForProcessingMock.mockResolvedValue({ id: 'event-1' })
    processLeadEventMock.mockRejectedValue(original)
    await expect(handle(job, ctx)).resolves.toBeUndefined()
    expect(reportErrorMock).toHaveBeenCalledWith(original, expect.anything())
    const wrapped = applyTransientFailureMock.mock.calls[0][2]
    expect(wrapped).toBeInstanceOf(TransientLeadError)
    expect(wrapped.leadErrorCode).toBe('unknown')
    expect(wrapped.cause).toBe(original)
    expect(em.nativeUpdate).not.toHaveBeenCalled()
  })

  it('marks the event failed only when applyTransientFailure throws', async () => {
    const { em, ctx } = buildContext()
    claimLeadEventForProcessingMock.mockResolvedValue({ id: 'event-1' })
    processLeadEventMock.mockRejectedValue(new Error('secret detail'))
    applyTransientFailureMock.mockRejectedValue(new Error('retry failed'))
    await expect(handle(job, ctx)).resolves.toBeUndefined()
    expect(em.nativeUpdate).toHaveBeenCalledWith(
      MetaLeadEvent,
      { id: 'event-1', tenantId: 'tenant-1', organizationId: 'org-1', status: 'processing' },
      expect.objectContaining({ status: 'failed', lastErrorCode: 'unknown', lastError: 'Lead processing failed unexpectedly' }),
    )
  })
})
