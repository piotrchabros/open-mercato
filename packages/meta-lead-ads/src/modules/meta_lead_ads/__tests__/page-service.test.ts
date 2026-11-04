const emitMock = jest.fn()
const notifyPageNoLeadsAccessMock = jest.fn()
const notifyConnectionTokenInvalidMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const findWithDecryptionMock = jest.fn()

jest.mock('../events', () => ({
  META_LEAD_ADS_EVENTS: {
    pageStatusChanged: 'meta_lead_ads.page.status_changed',
    connectionTokenInvalid: 'meta_lead_ads.connection.token_invalid',
  },
  emitMetaLeadAdsEvent: (...args: unknown[]) => emitMock(...args),
}))

jest.mock('../lib/notifier', () => ({
  notifyPageNoLeadsAccess: (...args: unknown[]) => notifyPageNoLeadsAccessMock(...args),
  notifyConnectionTokenInvalid: (...args: unknown[]) => notifyConnectionTokenInvalidMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))

import { MetaConnection, MetaForm, MetaPage } from '../data/entities'
import {
  MetaGraphError,
  classifyGraphError,
  type GraphForm,
  type MetaGraphClient,
} from '../lib/graph-client'
import { computeQuestionsFingerprint } from '../lib/mapping'
import {
  applyConnectionStatus,
  applyGraphErrorSideEffects,
  applyPageStatus,
  syncPageForms,
  verifyPageSubscription,
} from '../lib/page-service'

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }

function createStubEm() {
  const created: Record<string, unknown>[] = []
  const em = {
    flush: jest.fn(async () => undefined),
    persist: jest.fn(),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      created.push(data)
      return data
    }),
  }
  return { em, created }
}

function createContext() {
  const { em, created } = createStubEm()
  return { ctx: { em: em as never, resolve: jest.fn() as never }, em, created }
}

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

function buildConnection(overrides: Partial<MetaConnection> = {}): MetaConnection {
  return Object.assign(new MetaConnection(), {
    id: 'connection-1',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    metaUserId: 'meta-user-1',
    metaUserName: 'Jane Admin',
    status: 'active',
    connectedByUserId: 'user-1',
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
    name: 'Old name',
    ...overrides,
  })
}

function createGraphStub(overrides: Partial<MetaGraphClient> = {}): MetaGraphClient {
  return {
    getPageSubscription: jest.fn(async () => ({ subscribed: true, fields: ['leadgen'] })),
    probeLeadsAccess: jest.fn(async () => undefined),
    listPageForms: jest.fn(async () => ({ forms: [], paging: { after: null, hasNext: false } })),
    ...overrides,
  } as unknown as MetaGraphClient
}

beforeEach(() => {
  emitMock.mockReset()
  notifyPageNoLeadsAccessMock.mockReset()
  notifyConnectionTokenInvalidMock.mockReset()
  findOneWithDecryptionMock.mockReset()
  findWithDecryptionMock.mockReset()
})

describe('verifyPageSubscription', () => {
  it('returns active when subscribed and leads access works', async () => {
    const graph = createGraphStub()
    await expect(
      verifyPageSubscription(graph, { metaPageId: 'meta-page-1', pageAccessToken: 'page-token' }),
    ).resolves.toEqual({ status: 'active', lastError: null })
  })

  it('returns unsubscribed when leadgen is not among the subscribed fields', async () => {
    const graph = createGraphStub({
      getPageSubscription: jest.fn(async () => ({ subscribed: true, fields: ['feed'] })),
    })
    const result = await verifyPageSubscription(graph, { metaPageId: 'meta-page-1', pageAccessToken: 'page-token' })
    expect(result.status).toBe('unsubscribed')
  })

  it('maps a leads access error to no_leads_access', async () => {
    const graph = createGraphStub({
      probeLeadsAccess: jest.fn(async () => {
        throw new MetaGraphError({ status: 403, code: 10, classification: classifyGraphError({ status: 403, body: { error: { code: 10 } } }) })
      }),
    })
    const result = await verifyPageSubscription(graph, { metaPageId: 'meta-page-1', pageAccessToken: 'page-token' })
    expect(result.status).toBe('no_leads_access')
    expect(result.lastError).not.toContain('page-token')
  })

  it('rethrows transient Graph errors', async () => {
    const error = new MetaGraphError({ status: 500, classification: classifyGraphError({ status: 500 }) })
    const graph = createGraphStub({ getPageSubscription: jest.fn(async () => { throw error }) })
    await expect(
      verifyPageSubscription(graph, { metaPageId: 'meta-page-1', pageAccessToken: 'page-token' }),
    ).rejects.toBe(error)
  })

  it('reports token_expired when the page token is missing', async () => {
    const graph = createGraphStub()
    const result = await verifyPageSubscription(graph, { metaPageId: 'meta-page-1', pageAccessToken: null })
    expect(result.status).toBe('token_expired')
    expect(graph.getPageSubscription).not.toHaveBeenCalled()
  })
})

describe('applyPageStatus', () => {
  it('emits page.status_changed and notifies on a transition to no_leads_access', async () => {
    const { ctx, em } = createContext()
    const page = buildPage()
    const changed = await applyPageStatus(ctx, page, { status: 'no_leads_access', lastError: 'Graph API error' })
    expect(changed).toBe(true)
    expect(page.subscriptionStatus).toBe('no_leads_access')
    expect(page.statusCheckedAt).toBeInstanceOf(Date)
    expect(em.flush).toHaveBeenCalled()
    expect(emitMock).toHaveBeenCalledTimes(1)
    const [eventId, payload, options] = emitMock.mock.calls[0]
    expect(eventId).toBe('meta_lead_ads.page.status_changed')
    expect(payload).toMatchObject({ pageId: 'page-1', previousStatus: 'active', status: 'no_leads_access' })
    expect(options).toEqual({ persistent: true, ...scope })
    expect(notifyPageNoLeadsAccessMock).toHaveBeenCalledWith(ctx, { scope, pageId: 'page-1', pageName: 'Acme Page' })
  })

  it('does not emit when the status is unchanged', async () => {
    const { ctx, em } = createContext()
    const page = buildPage({ subscriptionStatus: 'no_leads_access' })
    const changed = await applyPageStatus(ctx, page, { status: 'no_leads_access', lastError: null })
    expect(changed).toBe(false)
    expect(em.flush).toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
    expect(notifyPageNoLeadsAccessMock).not.toHaveBeenCalled()
  })

  it('emits without notifying for other transitions', async () => {
    const { ctx } = createContext()
    const page = buildPage({ subscriptionStatus: 'unsubscribed' })
    await expect(applyPageStatus(ctx, page, { status: 'active', lastError: null })).resolves.toBe(true)
    expect(emitMock).toHaveBeenCalledTimes(1)
    expect(notifyPageNoLeadsAccessMock).not.toHaveBeenCalled()
  })
})

describe('applyConnectionStatus', () => {
  it('emits token_invalid and alerts on a transition to token_expired', async () => {
    const { ctx } = createContext()
    const connection = buildConnection()
    const changed = await applyConnectionStatus(ctx, connection, {
      status: 'token_expired',
      lastError: 'Graph API error',
      reason: 'expired',
    })
    expect(changed).toBe(true)
    expect(connection.status).toBe('token_expired')
    const [eventId, payload, options] = emitMock.mock.calls[0]
    expect(eventId).toBe('meta_lead_ads.connection.token_invalid')
    expect(payload).toMatchObject({ connectionId: 'connection-1', previousStatus: 'active', status: 'token_expired', reason: 'expired' })
    expect(options).toEqual({ persistent: true, ...scope })
    expect(notifyConnectionTokenInvalidMock).toHaveBeenCalledWith(ctx, {
      scope,
      connectionId: 'connection-1',
      metaUserName: 'Jane Admin',
      reason: 'expired',
    })
  })

  it('emits only once per transition', async () => {
    const { ctx } = createContext()
    const connection = buildConnection({ status: 'invalid' })
    const changed = await applyConnectionStatus(ctx, connection, { status: 'invalid', lastError: null, reason: 'revoked' })
    expect(changed).toBe(false)
    expect(emitMock).not.toHaveBeenCalled()
    expect(notifyConnectionTokenInvalidMock).not.toHaveBeenCalled()
  })

  it('does not alert on recovery to active', async () => {
    const { ctx } = createContext()
    const connection = buildConnection({ status: 'token_expired' })
    await expect(applyConnectionStatus(ctx, connection, { status: 'active', lastError: null, reason: null })).resolves.toBe(true)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('leaves a disconnected connection untouched', async () => {
    const { ctx } = createContext()
    const connection = buildConnection({ status: 'disconnected' })
    await expect(applyConnectionStatus(ctx, connection, { status: 'invalid', lastError: null, reason: null })).resolves.toBe(false)
    expect(connection.status).toBe('disconnected')
  })
})

describe('applyGraphErrorSideEffects', () => {
  it('updates the page and the connection on a token error', async () => {
    const { ctx } = createContext()
    const page = buildPage()
    const connection = buildConnection()
    findOneWithDecryptionMock.mockResolvedValue(connection)
    const classification = classifyGraphError({ status: 400, body: { error: { code: 190, error_subcode: 463 } } })
    await applyGraphErrorSideEffects(ctx, { page, connectionId: null }, classification)
    expect(page.subscriptionStatus).toBe('token_expired')
    expect(connection.status).toBe('token_expired')
    const [, , where] = findOneWithDecryptionMock.mock.calls[0]
    expect(where).toMatchObject({ id: 'connection-1', ...scope })
    expect(emitMock.mock.calls.map((call) => call[0])).toEqual([
      'meta_lead_ads.page.status_changed',
      'meta_lead_ads.connection.token_invalid',
    ])
  })

  it('does nothing for transient errors', async () => {
    const { ctx, em } = createContext()
    const page = buildPage()
    await applyGraphErrorSideEffects(ctx, { page }, classifyGraphError({ status: 503 }))
    expect(em.flush).not.toHaveBeenCalled()
    expect(findOneWithDecryptionMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('syncPageForms', () => {
  const questions = [
    { key: 'email', label: 'Email', type: 'EMAIL' },
    { key: 'full_name', label: 'Name', type: 'FULL_NAME' },
  ]

  it('creates new forms enabled with the default mapping', async () => {
    const { em, created } = createStubEm()
    findWithDecryptionMock.mockResolvedValue([])
    const graphForm: GraphForm = { id: 'meta-form-1', name: 'Spring', locale: 'pl_PL', status: 'ACTIVE', questions }
    const graph = createGraphStub({
      listPageForms: jest.fn(async () => ({ forms: [graphForm], paging: { after: null, hasNext: false } })),
    })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(result).toEqual({ created: 1, updated: 0, flagged: 0, total: 1 })
    expect(created[0]).toMatchObject({
      pageId: 'page-1',
      metaFormId: 'meta-form-1',
      isEnabled: true,
      questionsFingerprint: computeQuestionsFingerprint(questions),
      fieldMapping: [
        { questionKey: 'email', target: 'person.primaryEmail' },
        { questionKey: 'full_name', target: 'person.fullName' },
      ],
      ...scope,
    })
    expect(em.flush).toHaveBeenCalled()
  })

  it('flags fingerprint drift with questions_changed and appends new keys as notes', async () => {
    const { em } = createStubEm()
    const existing = buildForm({
      questions: [questions[0]],
      questionsFingerprint: computeQuestionsFingerprint([questions[0]]),
      fieldMapping: [{ questionKey: 'email', target: 'person.primaryEmail' }],
    })
    findWithDecryptionMock.mockResolvedValue([existing])
    const graphForm: GraphForm = { id: 'meta-form-1', name: 'Renamed', locale: null, status: 'ACTIVE', questions }
    const graph = createGraphStub({
      listPageForms: jest.fn(async () => ({ forms: [graphForm], paging: { after: null, hasNext: false } })),
    })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(result).toEqual({ created: 0, updated: 1, flagged: 1, total: 1 })
    expect(existing.needsAttention).toBe(true)
    expect(existing.attentionReason).toBe('questions_changed')
    expect(existing.name).toBe('Renamed')
    expect(existing.questionsFingerprint).toBe(computeQuestionsFingerprint(questions))
    expect(existing.fieldMapping).toEqual([
      { questionKey: 'email', target: 'person.primaryEmail' },
      { questionKey: 'full_name', target: 'note' },
    ])
  })

  it('does not flag a form whose fingerprint is unchanged', async () => {
    const { em } = createStubEm()
    const existing = buildForm({ questions, questionsFingerprint: computeQuestionsFingerprint(questions) })
    findWithDecryptionMock.mockResolvedValue([existing])
    const graphForm: GraphForm = { id: 'meta-form-1', name: 'Old name', locale: null, status: 'ACTIVE', questions }
    const graph = createGraphStub({
      listPageForms: jest.fn(async () => ({ forms: [graphForm], paging: { after: null, hasNext: false } })),
    })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(result).toEqual({ created: 0, updated: 1, flagged: 0, total: 1 })
    expect(existing.needsAttention).toBe(false)
  })

  it('silently adopts Graph questions for a lazily created form with the same keys', async () => {
    const { em } = createStubEm()
    const lazyQuestions = [
      { key: 'full_name', label: 'full_name', type: 'CUSTOM' },
      { key: 'email', label: 'email', type: 'CUSTOM' },
    ]
    const existing = buildForm({
      questions: lazyQuestions,
      questionsFingerprint: computeQuestionsFingerprint(lazyQuestions),
      fieldMapping: [{ questionKey: 'email', target: 'person.primaryEmail' }],
    })
    findWithDecryptionMock.mockResolvedValue([existing])
    const graphForm: GraphForm = { id: 'meta-form-1', name: 'Spring', locale: null, status: 'ACTIVE', questions }
    const graph = createGraphStub({
      listPageForms: jest.fn(async () => ({ forms: [graphForm], paging: { after: null, hasNext: false } })),
    })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(result).toEqual({ created: 0, updated: 1, flagged: 0, total: 1 })
    expect(existing.needsAttention).toBe(false)
    expect(existing.attentionReason).toBeUndefined()
    expect(existing.questions).toEqual(questions)
    expect(existing.questionsFingerprint).toBe(computeQuestionsFingerprint(questions))
    expect(existing.fieldMapping).toEqual([{ questionKey: 'email', target: 'person.primaryEmail' }])
  })

  it('flags a lazily created form when Graph keys differ', async () => {
    const { em } = createStubEm()
    const lazyQuestions = [{ key: 'email', label: 'email', type: 'CUSTOM' }]
    const existing = buildForm({
      questions: lazyQuestions,
      questionsFingerprint: computeQuestionsFingerprint(lazyQuestions),
      fieldMapping: [{ questionKey: 'email', target: 'person.primaryEmail' }],
    })
    findWithDecryptionMock.mockResolvedValue([existing])
    const graphForm: GraphForm = { id: 'meta-form-1', name: 'Spring', locale: null, status: 'ACTIVE', questions }
    const graph = createGraphStub({
      listPageForms: jest.fn(async () => ({ forms: [graphForm], paging: { after: null, hasNext: false } })),
    })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(result).toEqual({ created: 0, updated: 1, flagged: 1, total: 1 })
    expect(existing.needsAttention).toBe(true)
    expect(existing.attentionReason).toBe('questions_changed')
    expect(existing.questions).toEqual(questions)
    expect(existing.fieldMapping).toEqual([
      { questionKey: 'email', target: 'person.primaryEmail' },
      { questionKey: 'full_name', target: 'note' },
    ])
  })

  it('flags forms missing from Meta as form_archived and follows paging', async () => {
    const { em } = createStubEm()
    const missing = buildForm({ id: 'form-2', metaFormId: 'meta-form-gone', questionsFingerprint: 'x' })
    findWithDecryptionMock.mockResolvedValue([missing])
    const listPageForms = jest
      .fn()
      .mockResolvedValueOnce({
        forms: [{ id: 'meta-form-1', name: 'A', locale: null, status: 'ACTIVE', questions }],
        paging: { after: 'cursor-1', hasNext: true },
      })
      .mockResolvedValueOnce({
        forms: [{ id: 'meta-form-2', name: 'B', locale: null, status: 'ACTIVE', questions }],
        paging: { after: null, hasNext: false },
      })
    const graph = createGraphStub({ listPageForms })
    const result = await syncPageForms({ em: em as never, graph }, buildPage())
    expect(listPageForms).toHaveBeenCalledTimes(2)
    expect(listPageForms.mock.calls[1][0]).toMatchObject({ after: 'cursor-1' })
    expect(result).toEqual({ created: 2, updated: 0, flagged: 1, total: 2 })
    expect(missing.needsAttention).toBe(true)
    expect(missing.attentionReason).toBe('form_archived')
  })
})
