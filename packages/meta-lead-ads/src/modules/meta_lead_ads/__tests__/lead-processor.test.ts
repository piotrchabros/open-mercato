import type { EntityManager } from '@mikro-orm/postgresql'
import { MetaConsent, MetaForm, MetaLeadEvent, MetaPage } from '../data/entities'
import type { GraphLead } from '../data/validators'
import { TransientLeadError } from '../lib/errors'
import { classifyGraphError, MetaGraphError, type MetaGraphClient } from '../lib/graph-client'
import { claimLeadEventForProcessing, processLeadEvent, type LeadProcessorDeps } from '../lib/lead-processor'

const emitMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()
const writeLeadToCrmMock = jest.fn()
const resolveDedupMatchMock = jest.fn()
const upsertPersonKeysMock = jest.fn()
const applyGraphErrorSideEffectsMock = jest.fn()

jest.mock('../events', () => ({
  META_LEAD_ADS_EVENTS: {
    leadReceived: 'meta_lead_ads.lead.received',
    leadFailed: 'meta_lead_ads.lead.failed',
  },
  emitMetaLeadAdsEvent: (...args: unknown[]) => emitMock(...args),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (key: string, fallback?: string) => fallback ?? key }),
}))

jest.mock('../lib/crm-writer', () => ({
  writeLeadToCrm: (...args: unknown[]) => writeLeadToCrmMock(...args),
}))

jest.mock('../lib/dedup', () => ({
  ...jest.requireActual('../lib/dedup'),
  createDedupLookups: () => ({}),
  resolveDedupMatch: (...args: unknown[]) => resolveDedupMatchMock(...args),
  upsertPersonKeys: (...args: unknown[]) => upsertPersonKeysMock(...args),
}))

jest.mock('../lib/settings', () => ({
  getOrgSettings: async () => ({ id: null, retentionDays: 30, defaultCountry: 'PL', updatedAt: null }),
}))

jest.mock('../lib/preset', () => ({
  isTestOverrideAllowed: () => true,
  resolveAppCredentials: async () => ({ graphVersion: 'v24.0', graphBaseUrl: 'http://127.0.0.1:9999' }),
  graphOptionsFromCredentials: (credentials: { graphVersion: string; graphBaseUrl: string }) => ({
    graphVersion: credentials.graphVersion,
    baseUrl: credentials.graphBaseUrl,
  }),
}))

jest.mock('../lib/page-service', () => ({
  applyGraphErrorSideEffects: (...args: unknown[]) => applyGraphErrorSideEffectsMock(...args),
}))

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const EVENT_ID = '33333333-3333-4333-8333-333333333333'
const PAGE_ID = '44444444-4444-4444-8444-444444444444'
const FORM_ID = '55555555-5555-4555-8555-555555555555'
const PERSON_ID = '66666666-6666-4666-8666-666666666666'
const INTERACTION_ID = '77777777-7777-4777-8777-777777777777'
const OWNER_ID = '88888888-8888-4888-8888-888888888888'
const META_LEAD_ID = '724501983112233'
const META_FORM_ID = '551200347890123'
const SCOPE = { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID }

type Row = Record<string, unknown>

function buildEvent(overrides: Row = {}): Row {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    metaLeadId: META_LEAD_ID,
    metaPageId: 'page-1',
    metaFormId: META_FORM_ID,
    pageId: PAGE_ID,
    formId: null,
    source: 'webhook',
    status: 'processing',
    attemptCount: 0,
    manualRetryCount: 0,
    personId: null,
    matchType: null,
    rawPayload: null,
    ...overrides,
  }
}

function buildPage(): Row {
  return {
    id: PAGE_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    connectionId: 'connection-1',
    metaPageId: 'page-1',
    pageAccessToken: 'page-token',
  }
}

function buildForm(overrides: Row = {}): Row {
  return {
    id: FORM_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    pageId: PAGE_ID,
    metaFormId: META_FORM_ID,
    name: 'Spring campaign',
    isEnabled: true,
    questions: [
      { key: 'email', label: 'Email', type: 'EMAIL' },
      { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
      { key: 'marketing', label: 'I agree to marketing', type: 'CUSTOM' },
    ],
    questionsFingerprint: 'fp',
    fieldMapping: [
      { questionKey: 'email', target: 'person.primaryEmail' },
      { questionKey: 'full_name', target: 'person.fullName' },
      { questionKey: 'marketing', target: 'consent' },
    ],
    needsAttention: false,
    attentionReason: null,
    ...overrides,
  }
}

function buildLead(overrides: Row = {}): GraphLead {
  return {
    id: META_LEAD_ID,
    created_time: '2026-11-04T10:19:58+0000',
    ad_id: 'ad-1',
    ad_name: 'Ad name',
    adset_id: 'adset-1',
    adset_name: 'Adset name',
    campaign_id: 'campaign-1',
    campaign_name: 'Campaign name',
    form_id: META_FORM_ID,
    platform: 'ig',
    is_organic: false,
    field_data: [
      { name: 'email', values: ['Jane@Example.com'] },
      { name: 'full_name', values: ['Jane Doe'] },
      { name: 'marketing', values: ['true'] },
    ],
    ...overrides,
  } as GraphLead
}

type Harness = {
  deps: LeadProcessorDeps
  graph: { getLead: jest.Mock }
  created: { entity: unknown; data: Row }[]
  flush: jest.Mock
  externalIds: jest.Mock
  actionLog: jest.Mock
}

function setup(input: { event: Row | null; page?: Row | null; form?: Row | null; routing?: Row | null }): Harness {
  const created: { entity: unknown; data: Row }[] = []
  const flush = jest.fn(async () => undefined)
  const routing = input.routing === undefined ? input.event : input.routing
  const fork = {
    findOne: jest.fn(async () => routing),
    create: jest.fn((entity: unknown, data: Row) => {
      created.push({ entity, data })
      return data
    }),
    persist: jest.fn(),
    flush,
  }
  const em = {
    fork: () => fork,
    flush,
    findOne: jest.fn(async () => input.event),
    nativeUpdate: jest.fn(async () => 1),
  }
  findOneWithDecryptionMock.mockImplementation(async (_em: unknown, entity: unknown) => {
    if (entity === MetaLeadEvent) return input.event
    if (entity === MetaPage) return input.page ?? null
    if (entity === MetaForm) return input.form ?? null
    return null
  })
  const externalIds = jest.fn(async () => undefined)
  const actionLog = jest.fn(async () => undefined)
  const services: Record<string, unknown> = {
    externalIdMappingService: { storeExternalIdMapping: externalIds },
    actionLogService: { log: actionLog },
  }
  const container = {
    resolve: <T = unknown>(name: string): T => {
      if (!(name in services)) throw new Error(`[internal] missing ${name}`)
      return services[name] as T
    },
  }
  const graph = { getLead: jest.fn() }
  return {
    deps: {
      container,
      em: em as unknown as EntityManager,
      graph: graph as unknown as MetaGraphClient,
      now: () => new Date('2026-11-04T10:30:00.000Z'),
    },
    graph,
    created,
    flush,
    externalIds,
    actionLog,
  }
}

function graphError(status: number, code: number): MetaGraphError {
  const body = { error: { code } }
  return new MetaGraphError({ status, code, classification: classifyGraphError({ status, body }) })
}

beforeEach(() => {
  jest.clearAllMocks()
  resolveDedupMatchMock.mockResolvedValue({ personId: null, matchType: 'none', conflictPersonId: null })
  writeLeadToCrmMock.mockResolvedValue({
    personId: PERSON_ID,
    companyId: null,
    interactionId: INTERACTION_ID,
    dealId: null,
    ownerUserId: OWNER_ID,
    matchType: 'created',
    dealStepFailed: false,
    personCreated: true,
  })
})

describe('claimLeadEventForProcessing', () => {
  it('returns null when no claimable row was updated', async () => {
    const harness = setup({ event: buildEvent() })
    ;(harness.deps.em.nativeUpdate as jest.Mock).mockResolvedValueOnce(0)
    await expect(claimLeadEventForProcessing(harness.deps.em, EVENT_ID, SCOPE)).resolves.toBeNull()
    expect(harness.deps.em.nativeUpdate).toHaveBeenCalledWith(
      MetaLeadEvent,
      { id: EVENT_ID, tenantId: TENANT_ID, organizationId: ORGANIZATION_ID, status: { $in: ['received', 'retrying'] } },
      expect.objectContaining({ status: 'processing' }),
    )
  })
})

describe('processLeadEvent', () => {
  it('returns early for unrouted events', async () => {
    const event = buildEvent({ tenantId: null, organizationId: null, status: 'unrouted', pageId: null })
    const harness = setup({ event })
    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)
    expect(result).toEqual({ status: 'unrouted' })
    expect(harness.graph.getLead).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('fails with page_unassigned when the page is missing', async () => {
    const event = buildEvent()
    const harness = setup({ event, page: null })
    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)
    expect(result).toEqual({ status: 'failed', errorCode: 'page_unassigned' })
    expect(event.status).toBe('failed')
    expect(event.lastErrorCode).toBe('page_unassigned')
    expect(emitMock).toHaveBeenCalledWith(
      'meta_lead_ads.lead.failed',
      expect.objectContaining({ leadEventId: EVENT_ID, errorCode: 'page_unassigned' }),
      expect.objectContaining({ persistent: true, tenantId: TENANT_ID, organizationId: ORGANIZATION_ID }),
    )
  })

  it('skips leads of disabled forms', async () => {
    const event = buildEvent()
    const harness = setup({ event, page: buildPage(), form: buildForm({ isEnabled: false }) })
    harness.graph.getLead.mockResolvedValue(buildLead())
    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)
    expect(result).toEqual({ status: 'skipped', errorCode: 'form_disabled' })
    expect(event.status).toBe('skipped')
    expect(event.formId).toBe(FORM_ID)
    expect(writeLeadToCrmMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('processes a lead end to end and emits lead.received', async () => {
    const event = buildEvent()
    const harness = setup({ event, page: buildPage(), form: buildForm() })
    harness.graph.getLead.mockResolvedValue(buildLead())

    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)

    expect(result).toEqual({ status: 'processed' })
    expect(harness.graph.getLead).toHaveBeenCalledWith(META_LEAD_ID, 'page-token', {
      graphVersion: 'v24.0',
      baseUrl: 'http://127.0.0.1:9999',
    })
    expect(event).toEqual(
      expect.objectContaining({
        status: 'processed',
        adName: 'Ad name',
        adsetName: 'Adset name',
        campaignName: 'Campaign name',
        campaignId: 'campaign-1',
        platform: 'ig',
        isOrganic: false,
        formId: FORM_ID,
        lastErrorCode: null,
      }),
    )
    expect(event.processedAt).toEqual(new Date('2026-11-04T10:30:00.000Z'))
    expect(event.submittedAt).toEqual(new Date('2026-11-04T10:19:58.000Z'))
    expect(typeof event.emailHash).toBe('string')
    expect(writeLeadToCrmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ campaignName: 'Campaign name', formName: 'Spring campaign' }),
      }),
    )
    expect(upsertPersonKeysMock).toHaveBeenCalledWith(
      harness.deps.em,
      { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID },
      PERSON_ID,
      expect.objectContaining({ email: 'jane@example.com' }),
    )
    const consent = harness.created.find((entry) => entry.entity === MetaConsent)
    expect(consent?.data).toEqual(
      expect.objectContaining({ leadEventId: EVENT_ID, consentKey: 'marketing', isChecked: true, personId: PERSON_ID }),
    )
    expect(harness.externalIds).toHaveBeenCalledWith(
      'meta_lead_ads',
      'customers.person',
      PERSON_ID,
      META_LEAD_ID,
      { organizationId: ORGANIZATION_ID, tenantId: TENANT_ID },
    )
    expect(harness.actionLog).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'meta_lead_ads.lead.import', resourceKind: 'meta_lead_ads.lead_event' }),
    )
    expect(emitMock).toHaveBeenCalledTimes(1)
    const [eventId, payload, options] = emitMock.mock.calls[0]
    expect(eventId).toBe('meta_lead_ads.lead.received')
    expect(payload).toEqual(
      expect.objectContaining({
        leadEventId: EVENT_ID,
        personId: PERSON_ID,
        interactionId: INTERACTION_ID,
        formId: FORM_ID,
        pageId: PAGE_ID,
        matchType: 'created',
        ownerUserId: OWNER_ID,
        submittedAt: '2026-11-04T10:19:58.000Z',
      }),
    )
    expect(JSON.stringify(payload)).not.toContain('example.com')
    expect(options).toEqual({ persistent: true, tenantId: TENANT_ID, organizationId: ORGANIZATION_ID })
  })

  it('uses the stored payload of a backfill event without calling Graph', async () => {
    const storedLead = { ...buildLead() }
    const event = buildEvent({ source: 'backfill', rawPayload: storedLead })
    const harness = setup({ event, page: buildPage(), form: buildForm() })

    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)

    expect(result).toEqual({ status: 'processed' })
    expect(harness.graph.getLead).not.toHaveBeenCalled()
    expect(event.rawPayload).toBe(storedLead)
    expect(event.campaignName).toBe('Campaign name')
    expect(emitMock).toHaveBeenCalledWith(
      'meta_lead_ads.lead.received',
      expect.objectContaining({ leadEventId: EVENT_ID }),
      expect.objectContaining({ persistent: true }),
    )
  })

  it('fails with validation when the stored payload is invalid', async () => {
    const event = buildEvent({ source: 'backfill', rawPayload: { id: META_LEAD_ID } })
    const harness = setup({ event, page: buildPage(), form: buildForm() })

    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)

    expect(result).toEqual({ status: 'failed', errorCode: 'validation' })
    expect(harness.graph.getLead).not.toHaveBeenCalled()
  })

  it('marks the event failed and emits lead.failed on a permanent Graph error', async () => {
    const event = buildEvent()
    const harness = setup({ event, page: buildPage(), form: buildForm() })
    harness.graph.getLead.mockRejectedValue(graphError(401, 190))

    const result = await processLeadEvent(harness.deps, EVENT_ID, SCOPE)

    expect(result).toEqual({ status: 'failed', errorCode: 'token_invalid' })
    expect(event.status).toBe('failed')
    expect(applyGraphErrorSideEffectsMock).toHaveBeenCalledWith(
      expect.objectContaining({ em: harness.deps.em }),
      { page: expect.objectContaining({ id: PAGE_ID }) },
      expect.objectContaining({ errorClass: 'token_invalid' }),
    )
    expect(emitMock).toHaveBeenCalledWith(
      'meta_lead_ads.lead.failed',
      expect.objectContaining({ errorCode: 'token_invalid' }),
      expect.objectContaining({ persistent: true }),
    )
    expect(writeLeadToCrmMock).not.toHaveBeenCalled()
  })

  it('propagates transient Graph errors', async () => {
    const event = buildEvent()
    const harness = setup({ event, page: buildPage(), form: buildForm() })
    harness.graph.getLead.mockRejectedValue(graphError(500, 2))

    await expect(processLeadEvent(harness.deps, EVENT_ID, SCOPE)).rejects.toBeInstanceOf(TransientLeadError)
    expect(event.status).toBe('processing')
    expect(emitMock).not.toHaveBeenCalled()
  })
})
