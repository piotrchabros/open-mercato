const findWithDecryptionMock = jest.fn()
const applyConnectionStatusMock = jest.fn()
const applyPageStatusMock = jest.fn()
const verifyPageSubscriptionMock = jest.fn()
const notifyApiVersionDeprecatedMock = jest.fn()
const resolveAppCredentialsMock = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

jest.mock('../lib/page-service', () => ({
  applyConnectionStatus: (...args: unknown[]) => applyConnectionStatusMock(...args),
  applyPageStatus: (...args: unknown[]) => applyPageStatusMock(...args),
  verifyPageSubscription: (...args: unknown[]) => verifyPageSubscriptionMock(...args),
  describeGraphError: (classification: { errorClass: string }) => `Graph API error (${classification.errorClass})`,
}))

jest.mock('../lib/notifier', () => ({
  notifyApiVersionDeprecated: (...args: unknown[]) => notifyApiVersionDeprecatedMock(...args),
}))

jest.mock('../lib/preset', () => ({
  resolveAppCredentials: (...args: unknown[]) => resolveAppCredentialsMock(...args),
  graphOptionsFromCredentials: (credentials: { graphVersion: string | null; graphBaseUrl: string | null }) => ({
    graphVersion: credentials.graphVersion ?? 'v24.0',
    baseUrl: credentials.graphBaseUrl,
  }),
}))

import type { QueuedJob } from '@open-mercato/queue'
import { MetaConnection, MetaPage } from '../data/entities'
import { MetaGraphError, classifyGraphError, type GraphTokenInfo, type MetaGraphClient } from '../lib/graph-client'
import type { ScopedJob } from '../lib/queue'
import handle, { findApproachingSunset, metadata, statusFromTokenInfo } from '../workers/token-health'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const graphOptions = { graphVersion: 'v24.0', baseUrl: 'http://127.0.0.1:9999' }

function buildConnection(overrides: Partial<MetaConnection> = {}): MetaConnection {
  return Object.assign(new MetaConnection(), {
    id: 'connection-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    metaUserId: 'meta-user-1',
    metaUserName: 'Jane',
    userAccessToken: 'user-token',
    status: 'active',
    connectedByUserId: 'user-1',
    ...overrides,
  })
}

function buildPage(overrides: Partial<MetaPage> = {}): MetaPage {
  return Object.assign(new MetaPage(), {
    id: 'page-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    connectionId: 'connection-1',
    metaPageId: 'meta-page-1',
    name: 'Acme',
    pageAccessToken: 'page-token',
    subscriptionStatus: 'active',
    ...overrides,
  })
}

function tokenInfo(overrides: Partial<GraphTokenInfo> = {}): GraphTokenInfo {
  return {
    isValid: true,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    scopes: [],
    userId: 'meta-user-1',
    errorCode: null,
    errorSubcode: null,
    ...overrides,
  }
}

function createHarness(options: { notificationCount?: number; graphVersion?: string } = {}) {
  const em = {
    flush: jest.fn(async () => undefined),
    count: jest.fn(async () => options.notificationCount ?? 0),
  }
  const rootEm = { fork: () => em }
  const graph = { debugToken: jest.fn() } as unknown as jest.Mocked<Pick<MetaGraphClient, 'debugToken'>>
  const resolve = jest.fn((name: string) => {
    if (name === 'em') return rootEm
    if (name === 'metaGraphClient') return graph
    throw new Error(`[internal] unexpected resolve ${name}`)
  })
  resolveAppCredentialsMock.mockResolvedValue({
    appId: 'app-id',
    appSecret: 'app-secret',
    graphVersion: options.graphVersion ?? 'v24.0',
    graphBaseUrl: graphOptions.baseUrl,
  })
  const ctx = { resolve } as never
  const job = { id: 'job-1', payload: { scope }, createdAt: new Date().toISOString() } as unknown as QueuedJob<ScopedJob>
  return { em, graph, ctx, job }
}

describe('token-health worker', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('declares the queue and concurrency', () => {
    expect(metadata).toMatchObject({ queue: 'meta-lead-ads-token-health', concurrency: 2 })
  })

  it('ignores jobs without scope', async () => {
    const { ctx } = createHarness()
    await handle({ id: 'job', payload: {} } as unknown as QueuedJob<ScopedJob>, ctx)
    expect(findWithDecryptionMock).not.toHaveBeenCalled()
  })

  it('marks a valid connection active and re-checks its pages with org graph options', async () => {
    const connection = buildConnection({ status: 'token_expired' })
    const page = buildPage()
    findWithDecryptionMock.mockResolvedValueOnce([connection]).mockResolvedValueOnce([page])
    const { graph, ctx, job } = createHarness()
    const info = tokenInfo()
    graph.debugToken.mockResolvedValue(info)
    verifyPageSubscriptionMock.mockResolvedValue({ status: 'active', lastError: null })

    await handle(job, ctx)

    expect(graph.debugToken).toHaveBeenCalledWith(
      'user-token',
      { appId: 'app-id', appSecret: 'app-secret' },
      graphOptions,
    )
    expect(connection.lastHealthCheckAt).toBeInstanceOf(Date)
    expect(connection.tokenExpiresAt).toBe(info.expiresAt)
    expect(applyConnectionStatusMock).toHaveBeenCalledWith(expect.anything(), connection, {
      status: 'active',
      lastError: null,
      reason: null,
    })
    expect(verifyPageSubscriptionMock).toHaveBeenCalledWith(
      graph,
      { metaPageId: 'meta-page-1', pageAccessToken: 'page-token' },
      graphOptions,
    )
    expect(applyPageStatusMock).toHaveBeenCalledWith(expect.anything(), page, { status: 'active', lastError: null })
    const connectionWhere = findWithDecryptionMock.mock.calls[0][2]
    expect(connectionWhere).toMatchObject({ ...scope, deletedAt: null, status: { $ne: 'disconnected' } })
  })

  it('applies token_expired when debug_token reports an expired token', async () => {
    const connection = buildConnection()
    findWithDecryptionMock.mockResolvedValueOnce([connection]).mockResolvedValueOnce([])
    const { graph, ctx, job } = createHarness()
    graph.debugToken.mockResolvedValue(tokenInfo({ isValid: false, errorCode: 190, errorSubcode: 463 }))

    await handle(job, ctx)

    expect(applyConnectionStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      connection,
      expect.objectContaining({ status: 'token_expired', reason: 'expired' }),
    )
  })

  it('applies the classified status when debug_token throws a token error', async () => {
    const connection = buildConnection()
    findWithDecryptionMock.mockResolvedValueOnce([connection]).mockResolvedValueOnce([])
    const { graph, ctx, job } = createHarness()
    const classification = classifyGraphError({ status: 400, body: { error: { code: 190, error_subcode: 460 } } })
    graph.debugToken.mockRejectedValue(
      new MetaGraphError({ status: 400, code: 190, subcode: 460, fbtraceId: null, classification }),
    )

    await handle(job, ctx)

    expect(applyConnectionStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      connection,
      expect.objectContaining({ status: 'invalid', reason: 'password_changed' }),
    )
  })

  it('marks a connection without a stored token invalid without calling Graph', async () => {
    const connection = buildConnection({ userAccessToken: null })
    findWithDecryptionMock.mockResolvedValueOnce([connection]).mockResolvedValueOnce([])
    const { graph, ctx, job } = createHarness()

    await handle(job, ctx)

    expect(graph.debugToken).not.toHaveBeenCalled()
    expect(applyConnectionStatusMock).toHaveBeenCalledWith(
      expect.anything(),
      connection,
      expect.objectContaining({ status: 'invalid' }),
    )
  })

  it('keeps checking other pages when one page check fails', async () => {
    const connection = buildConnection()
    const failing = buildPage({ id: 'page-1' })
    const healthy = buildPage({ id: 'page-2', metaPageId: 'meta-page-2' })
    findWithDecryptionMock.mockResolvedValueOnce([connection]).mockResolvedValueOnce([failing, healthy])
    const { graph, ctx, job } = createHarness()
    graph.debugToken.mockResolvedValue(tokenInfo())
    verifyPageSubscriptionMock
      .mockRejectedValueOnce(new Error('[internal] boom'))
      .mockResolvedValueOnce({ status: 'no_leads_access', lastError: 'Graph API error (no_leads_access)' })

    await handle(job, ctx)

    expect(applyPageStatusMock).toHaveBeenCalledTimes(1)
    expect(applyPageStatusMock).toHaveBeenCalledWith(expect.anything(), healthy, {
      status: 'no_leads_access',
      lastError: 'Graph API error (no_leads_access)',
    })
  })

  it('sends the API version alert once when the configured version nears sunset', async () => {
    findWithDecryptionMock.mockResolvedValueOnce([])
    const nearSunset = findApproachingSunset('v22.0', new Date('2027-01-01T00:00:00.000Z'))
    expect(nearSunset).not.toBeNull()
    jest.useFakeTimers({ now: new Date('2027-01-01T00:00:00.000Z'), doNotFake: ['setTimeout', 'setImmediate'] })
    try {
      const { em, ctx, job } = createHarness({ graphVersion: 'v22.0' })
      await handle(job, ctx)
      expect(em.count).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          ...scope,
          type: 'meta_lead_ads.api_version.deprecated',
          groupKey: 'meta_api_version_deprecated:v22.0',
        }),
      )
      expect(notifyApiVersionDeprecatedMock).toHaveBeenCalledWith(expect.anything(), {
        scope,
        version: 'v22.0',
        sunsetAt: '2027-02-21T00:00:00.000Z',
      })

      notifyApiVersionDeprecatedMock.mockClear()
      findWithDecryptionMock.mockResolvedValueOnce([])
      const second = createHarness({ graphVersion: 'v22.0', notificationCount: 1 })
      await handle(second.job, second.ctx)
      expect(notifyApiVersionDeprecatedMock).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('findApproachingSunset', () => {
  it('returns null for versions far from sunset or unknown', () => {
    expect(findApproachingSunset('v24.0', new Date('2026-11-04T00:00:00.000Z'))).toBeNull()
    expect(findApproachingSunset('v1.0', new Date('2026-11-04T00:00:00.000Z'))).toBeNull()
  })

  it('returns the version within 90 days of sunset', () => {
    expect(findApproachingSunset('v23.0', new Date('2027-03-15T00:00:00.000Z'))).toEqual({
      version: 'v23.0',
      sunsetAt: '2027-05-29T00:00:00.000Z',
    })
  })
})

describe('statusFromTokenInfo', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')

  it('treats a valid unexpired token as active', () => {
    expect(statusFromTokenInfo(tokenInfo({ expiresAt: null }), now)).toEqual({
      status: 'active',
      lastError: null,
      reason: null,
    })
  })

  it('treats a past expiry without an error code as token_expired', () => {
    expect(statusFromTokenInfo(tokenInfo({ expiresAt: new Date('2026-01-01T00:00:00.000Z') }), now)).toMatchObject({
      status: 'token_expired',
      reason: 'expired',
    })
  })

  it('treats an invalid token without details as invalid', () => {
    expect(statusFromTokenInfo(tokenInfo({ isValid: false, expiresAt: null }), now)).toMatchObject({
      status: 'invalid',
      reason: 'unknown',
    })
  })
})
