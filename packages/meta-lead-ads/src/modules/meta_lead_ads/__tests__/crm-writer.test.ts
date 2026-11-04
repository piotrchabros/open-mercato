import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import {
  CustomerDeal,
  CustomerEntity,
  CustomerInteraction,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { MetaForm, type MetaLeadEvent } from '../data/entities'
import { writeLeadToCrm, type CrmWriteInput } from '../lib/crm-writer'
import { computeInteractionId } from '../lib/ids'
import type { MappedLeadData } from '../lib/mapping'
import { assignOwner } from '../lib/owner-assignment'
import { normalizePhoneToE164 } from '../lib/phone'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/crud/custom-fields', () => ({
  loadCustomFieldValues: jest.fn(),
}))

jest.mock('../lib/owner-assignment', () => ({
  assignOwner: jest.fn(),
}))

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const FORM_ID = '33333333-3333-4333-8333-333333333333'
const PERSON_ID = '44444444-4444-4444-8444-444444444444'
const PROFILE_ID = '55555555-5555-4555-8555-555555555555'
const COMPANY_ID = '66666666-6666-4666-8666-666666666666'
const DEAL_ID = '77777777-7777-4777-8777-777777777777'
const OWNER_ID = '88888888-8888-4888-8888-888888888888'
const PIPELINE_ID = '99999999-9999-4999-8999-999999999999'
const STAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const META_LEAD_ID = 'lead-123'

const findOneMock = findOneWithDecryption as jest.MockedFunction<typeof findOneWithDecryption>
const findManyMock = findWithDecryption as jest.MockedFunction<typeof findWithDecryption>
const loadCustomFieldsMock = loadCustomFieldValues as jest.MockedFunction<typeof loadCustomFieldValues>
const assignOwnerMock = assignOwner as jest.MockedFunction<typeof assignOwner>

type ExecutedCommand = { commandId: string; input: Record<string, unknown> }

type StoredRecords = {
  person?: Record<string, unknown> | null
  profile?: Record<string, unknown> | null
  interaction?: Record<string, unknown> | null
  deal?: Record<string, unknown> | null
  companies?: Record<string, unknown>[]
}

function createCommandBus(failingCommands: string[] = []) {
  const executed: ExecutedCommand[] = []
  const results: Record<string, Record<string, unknown>> = {
    'customers.people.create': { entityId: PERSON_ID, personId: PROFILE_ID },
    'customers.people.update': { entityId: PERSON_ID },
    'customers.companies.create': { entityId: COMPANY_ID, companyId: 'company-profile' },
    'customers.personCompanyLinks.create': { linkId: 'link-1', created: true, undeleted: false },
    'customers.addresses.create': { addressId: 'address-1' },
    'customers.interactions.create': { interactionId: computeInteractionId(META_LEAD_ID), entityId: PERSON_ID },
    'customers.deals.create': { dealId: DEAL_ID },
  }
  const bus = {
    async execute(commandId: string, options: { input: Record<string, unknown> }) {
      executed.push({ commandId, input: options.input })
      if (failingCommands.includes(commandId)) throw new Error('[internal] command failed')
      return { result: results[commandId], logEntry: null }
    },
  }
  return { bus, executed }
}

function mockStoredRecords(records: StoredRecords) {
  findOneMock.mockImplementation((async (_em: unknown, entity: unknown) => {
    if (entity === CustomerEntity) return records.person ?? null
    if (entity === CustomerPersonProfile) return records.profile ?? null
    if (entity === CustomerInteraction) return records.interaction ?? null
    if (entity === CustomerDeal) return records.deal ?? null
    return null
  }) as unknown as typeof findOneWithDecryption)
  findManyMock.mockImplementation((async () => records.companies ?? []) as unknown as typeof findWithDecryption)
}

function buildMapped(overrides: Partial<MappedLeadData> = {}): MappedLeadData {
  return {
    person: {
      fullName: 'Anna Kowalska',
      primaryEmail: 'anna@example.com',
      primaryPhoneRaw: '600 700 800',
      jobTitle: 'CTO',
      city: 'Warsaw',
    },
    company: { displayName: 'Acme' },
    personCustomFields: { budget: '10k' },
    companyCustomFields: {},
    notes: [{ label: 'Comment', value: 'Call me' }],
    consents: [],
    answers: [
      { name: 'full_name', label: 'Full name', values: ['Anna Kowalska'], target: 'person.fullName' },
      { name: 'email', label: 'Email', values: ['anna@example.com'], target: 'person.primaryEmail' },
      { name: 'comment', label: 'Comment', values: ['Call me'], target: 'note' },
    ],
    ...overrides,
  }
}

function buildInput(options: {
  bus: ReturnType<typeof createCommandBus>['bus']
  event?: Partial<MetaLeadEvent>
  form?: Partial<MetaForm>
  mapped?: MappedLeadData
  match?: CrmWriteInput['match']
}) {
  const persisted: Partial<MetaLeadEvent>[] = []
  const nativeUpdate = jest.fn(async () => 1)
  const container = {
    resolve: (name: string) => (name === 'commandBus' ? options.bus : undefined),
  } as unknown as AwilixContainer
  const em = { nativeUpdate } as unknown as EntityManager
  const event = {
    id: 'event-1',
    metaLeadId: META_LEAD_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    personId: null,
    companyId: null,
    interactionId: null,
    dealId: null,
    matchType: null,
    ...options.event,
  } as MetaLeadEvent
  const form = {
    id: FORM_ID,
    tenantId: TENANT_ID,
    organizationId: ORGANIZATION_ID,
    createDeal: false,
    ownerMode: 'none',
    pipelineId: null,
    pipelineStageId: null,
    ...options.form,
  } as MetaForm
  const input: CrmWriteInput = {
    container,
    em,
    scope: { tenantId: TENANT_ID, organizationId: ORGANIZATION_ID },
    event,
    form,
    mapped: options.mapped ?? buildMapped(),
    phone: normalizePhoneToE164('600 700 800', 'PL'),
    match: options.match ?? { personId: null, matchType: 'none', conflictPersonId: null },
    source: {
      campaignName: 'Spring',
      adsetName: 'Set A',
      adName: 'Ad 1',
      formName: 'Contact form',
      platform: 'fb',
      isOrganic: false,
      submittedAt: new Date('2026-11-01T10:00:00Z'),
    },
    translate: (key, fallback, params) => {
      const template = fallback ?? key
      return params ? template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? '')) : template
    },
    persist: async (patch) => {
      persisted.push(patch)
    },
  }
  return { input, persisted, nativeUpdate }
}

function commandIds(executed: ExecutedCommand[]): string[] {
  return executed.map((entry) => entry.commandId)
}

function findCommand(executed: ExecutedCommand[], commandId: string): Record<string, unknown> {
  const entry = executed.find((item) => item.commandId === commandId)
  if (!entry) throw new Error(`[internal] command ${commandId} was not executed`)
  return entry.input
}

describe('writeLeadToCrm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    loadCustomFieldsMock.mockResolvedValue({})
    assignOwnerMock.mockResolvedValue({ ownerUserId: OWNER_ID, unavailable: false })
  })

  it('creates person, company, link, address, interaction and deal in order', async () => {
    mockStoredRecords({ companies: [] })
    const { bus, executed } = createCommandBus()
    const { input, persisted } = buildInput({
      bus,
      form: { createDeal: true, ownerMode: 'fixed', pipelineId: PIPELINE_ID, pipelineStageId: STAGE_ID },
    })

    const result = await writeLeadToCrm(input)

    expect(commandIds(executed)).toEqual([
      'customers.people.create',
      'customers.companies.create',
      'customers.personCompanyLinks.create',
      'customers.addresses.create',
      'customers.interactions.create',
      'customers.deals.create',
    ])
    const personInput = findCommand(executed, 'customers.people.create')
    expect(personInput).toMatchObject({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      firstName: 'Anna',
      lastName: 'Kowalska',
      primaryEmail: 'anna@example.com',
      primaryPhone: '+48600700800',
      jobTitle: 'CTO',
      source: 'meta_lead_ads',
      customFields: { budget: '10k' },
    })
    expect(findCommand(executed, 'customers.addresses.create')).toMatchObject({
      entityId: PERSON_ID,
      addressLine1: 'Warsaw',
      city: 'Warsaw',
    })
    const interactionInput = findCommand(executed, 'customers.interactions.create')
    expect(interactionInput).toMatchObject({
      id: computeInteractionId(META_LEAD_ID),
      entityId: PERSON_ID,
      interactionType: 'meta_lead',
      status: 'done',
      source: 'meta_lead_ads',
      title: 'Lead from Meta',
    })
    expect(String(interactionInput.body)).toContain('Comment: Call me')
    expect(String(interactionInput.body)).toContain('Campaign: Spring')
    expect(findCommand(executed, 'customers.deals.create')).toMatchObject({
      title: 'Lead: Anna Kowalska',
      pipelineId: PIPELINE_ID,
      pipelineStageId: STAGE_ID,
      ownerUserId: OWNER_ID,
      personIds: [PERSON_ID],
      companyIds: [COMPANY_ID],
      primaryPersonEntityId: PERSON_ID,
    })
    expect(persisted).toEqual([
      { personId: PERSON_ID, matchType: 'created' },
      { companyId: COMPANY_ID },
      { interactionId: computeInteractionId(META_LEAD_ID) },
      { dealId: DEAL_ID },
    ])
    expect(result).toEqual({
      personId: PERSON_ID,
      companyId: COMPANY_ID,
      interactionId: computeInteractionId(META_LEAD_ID),
      dealId: DEAL_ID,
      ownerUserId: OWNER_ID,
      matchType: 'created',
      dealStepFailed: false,
      personCreated: true,
    })
  })

  it('fills only empty fields on a matched person and notes differing values', async () => {
    mockStoredRecords({
      person: {
        id: PERSON_ID,
        displayName: 'Anna K.',
        primaryEmail: 'anna@example.com',
        primaryPhone: null,
      },
      profile: { id: PROFILE_ID, firstName: 'Anna', lastName: 'Kowalska', jobTitle: 'CEO' },
      companies: [{ id: COMPANY_ID, displayName: 'ACME ' }],
    })
    loadCustomFieldsMock.mockResolvedValue({})
    const { bus, executed } = createCommandBus()
    const { input, persisted } = buildInput({
      bus,
      match: { personId: PERSON_ID, matchType: 'email', conflictPersonId: null },
    })

    const result = await writeLeadToCrm(input)

    expect(commandIds(executed)).toEqual([
      'customers.people.update',
      'customers.personCompanyLinks.create',
      'customers.interactions.create',
    ])
    const updateInput = findCommand(executed, 'customers.people.update')
    expect(updateInput).toEqual({
      id: PERSON_ID,
      primaryPhone: '+48600700800',
      customFields: { budget: '10k' },
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
    })
    expect(String(findCommand(executed, 'customers.interactions.create').body)).toContain('jobTitle: CTO')
    expect(persisted[0]).toEqual({ personId: PERSON_ID, matchType: 'email' })
    expect(result.matchType).toBe('email')
    expect(result.personCreated).toBe(false)
    expect(result.companyId).toBe(COMPANY_ID)
  })

  it('skips steps already recorded on a resumed event', async () => {
    mockStoredRecords({ person: { id: PERSON_ID, displayName: 'Anna Kowalska' } })
    const { bus, executed } = createCommandBus()
    const { input, persisted } = buildInput({
      bus,
      event: {
        personId: PERSON_ID,
        matchType: 'created',
        companyId: COMPANY_ID,
        interactionId: computeInteractionId(META_LEAD_ID),
      },
      form: { createDeal: true, ownerMode: 'none', pipelineId: PIPELINE_ID, pipelineStageId: STAGE_ID },
    })
    assignOwnerMock.mockResolvedValue({ ownerUserId: null, unavailable: false })

    const result = await writeLeadToCrm(input)

    expect(commandIds(executed)).toEqual(['customers.personCompanyLinks.create', 'customers.deals.create'])
    expect(persisted).toEqual([{ personId: PERSON_ID, matchType: 'created' }, { dealId: DEAL_ID }])
    expect(result).toMatchObject({
      personId: PERSON_ID,
      companyId: COMPANY_ID,
      interactionId: computeInteractionId(META_LEAD_ID),
      dealId: DEAL_ID,
      personCreated: false,
      matchType: 'created',
    })
  })

  it('keeps the existing deal owner on a resumed event without reassigning', async () => {
    mockStoredRecords({ person: { id: PERSON_ID, displayName: 'Anna Kowalska' }, deal: { id: DEAL_ID, ownerUserId: OWNER_ID } })
    const { bus, executed } = createCommandBus()
    const { input } = buildInput({
      bus,
      event: {
        personId: PERSON_ID,
        matchType: 'created',
        companyId: COMPANY_ID,
        interactionId: computeInteractionId(META_LEAD_ID),
        dealId: DEAL_ID,
      },
      form: { createDeal: true, ownerMode: 'round_robin', pipelineId: PIPELINE_ID, pipelineStageId: STAGE_ID },
    })

    const result = await writeLeadToCrm(input)

    expect(commandIds(executed)).not.toContain('customers.deals.create')
    expect(assignOwnerMock).not.toHaveBeenCalled()
    expect(result.ownerUserId).toBe(OWNER_ID)
    expect(result.dealId).toBe(DEAL_ID)
  })

  it('returns a null owner on a resumed event when the stored deal is missing', async () => {
    mockStoredRecords({ person: { id: PERSON_ID, displayName: 'Anna Kowalska' }, deal: null })
    const { bus } = createCommandBus()
    const { input } = buildInput({
      bus,
      event: {
        personId: PERSON_ID,
        matchType: 'created',
        companyId: COMPANY_ID,
        interactionId: computeInteractionId(META_LEAD_ID),
        dealId: DEAL_ID,
      },
      form: { createDeal: true, ownerMode: 'round_robin', pipelineId: PIPELINE_ID, pipelineStageId: STAGE_ID },
    })

    const result = await writeLeadToCrm(input)

    expect(assignOwnerMock).not.toHaveBeenCalled()
    expect(result.ownerUserId).toBeNull()
    expect(result.dealId).toBe(DEAL_ID)
  })

  it('skips interaction creation when the deterministic interaction already exists', async () => {
    mockStoredRecords({ interaction: { id: computeInteractionId(META_LEAD_ID) }, companies: [] })
    const { bus, executed } = createCommandBus()
    const { input, persisted } = buildInput({ bus, mapped: buildMapped({ company: {} }) })

    await writeLeadToCrm(input)

    expect(commandIds(executed)).not.toContain('customers.interactions.create')
    expect(persisted).toContainEqual({ interactionId: computeInteractionId(META_LEAD_ID) })
  })

  it('notes in the interaction body when the lead had no match key', async () => {
    mockStoredRecords({ companies: [] })
    const { bus, executed } = createCommandBus()
    const mapped = buildMapped({
      person: { fullName: 'Anna Kowalska' },
      company: {},
    })
    const { input, persisted } = buildInput({ bus, mapped })
    input.phone = null

    const result = await writeLeadToCrm(input)

    expect(result.matchType).toBe('none')
    expect(persisted[0]).toEqual({ personId: PERSON_ID, matchType: 'none' })
    expect(String(findCommand(executed, 'customers.interactions.create').body)).toContain(
      'No email or phone was present',
    )
  })

  it('omits the not-matched note when a contact key was present', async () => {
    mockStoredRecords({ companies: [] })
    const { bus, executed } = createCommandBus()
    const { input } = buildInput({ bus })

    await writeLeadToCrm(input)

    expect(String(findCommand(executed, 'customers.interactions.create').body)).not.toContain(
      'No email or phone was present',
    )
  })

  it('flags the form and keeps earlier records when the deal step fails', async () => {
    mockStoredRecords({ companies: [] })
    const { bus, executed } = createCommandBus(['customers.deals.create'])
    const { input, persisted, nativeUpdate } = buildInput({
      bus,
      form: { createDeal: true, ownerMode: 'fixed', pipelineId: PIPELINE_ID, pipelineStageId: STAGE_ID },
    })

    const result = await writeLeadToCrm(input)

    expect(result.dealStepFailed).toBe(true)
    expect(result.dealId).toBeNull()
    expect(result.interactionId).toBe(computeInteractionId(META_LEAD_ID))
    expect(commandIds(executed)).toContain('customers.interactions.create')
    expect(persisted).not.toContainEqual(expect.objectContaining({ dealId: expect.anything() }))
    expect(nativeUpdate).toHaveBeenCalledWith(
      MetaForm,
      { id: FORM_ID, tenantId: TENANT_ID, organizationId: ORGANIZATION_ID },
      { needsAttention: true, attentionReason: 'deal_step_failed' },
    )
  })
})
