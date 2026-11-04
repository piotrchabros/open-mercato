import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { loadCustomFieldValues } from '@open-mercato/shared/lib/crud/custom-fields'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { TranslateWithFallbackFn } from '@open-mercato/shared/lib/i18n/translate'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { isValidPhoneNumber } from '@open-mercato/shared/lib/phone'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import {
  CustomerDeal,
  CustomerEntity,
  CustomerInteraction,
  CustomerPersonProfile,
} from '@open-mercato/core/modules/customers/data/entities'
import {
  CUSTOMER_ENTITY_ID,
  PERSON_ENTITY_ID,
} from '@open-mercato/core/modules/customers/lib/customFieldRouting'
import { MetaForm, type MetaLeadEvent } from '../data/entities'
import {
  CRM_SOURCE,
  DEDUP_SCAN_LIMIT,
  INTERACTION_TYPE,
  type MetaMatchType,
  type MetaScope,
} from './constants'
import type { DedupResult } from './dedup'
import { computeInteractionId } from './ids'
import { buildInteractionBody, resolvePersonNames, splitFullName, type MappedLeadData } from './mapping'
import { assignOwner } from './owner-assignment'
import { normalizePhoneToE164, type PhoneNormalizationResult } from './phone'
import { buildSystemCommandContext, decryptionScope } from './scope'

const logger = createLogger('meta_lead_ads')

const INTERACTION_STATUS_DONE = 'done'
const NAME_MAX = 120
const DISPLAY_NAME_MAX = 200
const JOB_TITLE_MAX = 150
const DOMAIN_MAX = 200
const ADDRESS_LINE_MAX = 300
const CITY_MAX = 150
const DEAL_TITLE_MAX = 200
const emailSchema = z.string().email().max(320)

const BODY_LABEL_FALLBACKS: Record<string, string> = {
  answers: 'Answers',
  source: 'Source',
  campaign: 'Campaign',
  adset: 'Ad set',
  ad: 'Ad',
  form: 'Form',
  platform: 'Platform',
  organic: 'Organic',
  conflict: 'Phone number matches another person',
  differing: 'Values that differ from the CRM record',
  notMatched: 'No email or phone was present, so the lead could not be matched to an existing person',
}

export type CrmWriteSource = {
  campaignName: string | null
  adsetName: string | null
  adName: string | null
  formName: string | null
  platform: string | null
  isOrganic: boolean | null
  submittedAt: Date | null
}

export type CrmWriteInput = {
  container: AwilixContainer
  em: EntityManager
  scope: MetaScope
  event: MetaLeadEvent
  form: MetaForm
  mapped: MappedLeadData
  phone: PhoneNormalizationResult | null
  match: DedupResult
  source: CrmWriteSource
  translate: TranslateWithFallbackFn
  persist(patch: Partial<MetaLeadEvent>): Promise<void>
}

export type CrmWriteResult = {
  personId: string
  companyId: string | null
  interactionId: string
  dealId: string | null
  ownerUserId: string | null
  matchType: MetaMatchType
  dealStepFailed: boolean
  personCreated: boolean
}

type DifferingValue = { field: string; value: string }

type PersonStepResult = {
  personId: string
  personName: string
  matchType: MetaMatchType
  personCreated: boolean
  differing: DifferingValue[]
}

type CommandExecutor = <TResult>(commandId: string, input: Record<string, unknown>) => Promise<TResult>

function createExecutor(input: CrmWriteInput): CommandExecutor {
  const commandBus = input.container.resolve<CommandBus>('commandBus')
  const ctx = buildSystemCommandContext(input.container, input.scope)
  return async <TResult>(commandId: string, payload: Record<string, unknown>): Promise<TResult> => {
    const { result } = await commandBus.execute<Record<string, unknown>, TResult>(commandId, {
      input: { ...payload, tenantId: input.scope.tenantId, organizationId: input.scope.organizationId },
      ctx,
    })
    return result
  }
}

function clip(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.every((item) => isEmpty(item))
  return false
}

function displayValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(', ') : value
}

function sameText(left: unknown, right: string | string[]): boolean {
  const normalize = (value: unknown): string =>
    (Array.isArray(value) ? value.map((item) => String(item)).join(',') : String(value ?? '')).trim().toLowerCase()
  return normalize(left) === normalize(right)
}

function resolveLeadEmail(mapped: MappedLeadData): string | null {
  const email = mapped.person.primaryEmail?.trim().toLowerCase()
  if (!email) return null
  return emailSchema.safeParse(email).success ? email : null
}

function resolveLeadPhone(phone: PhoneNormalizationResult | null): string | null {
  if (!phone || !phone.usableForMatching || !phone.e164) return null
  return isValidPhoneNumber(phone.e164) ? phone.e164 : null
}

function hasContactKeys(mapped: MappedLeadData, phone: PhoneNormalizationResult | null): boolean {
  return Boolean(mapped.person.primaryEmail?.trim()) || Boolean(phone?.usableForMatching && phone.e164)
}

function explicitLeadNames(mapped: MappedLeadData): { firstName: string | null; lastName: string | null } {
  const firstName = mapped.person.firstName?.trim() || null
  const lastName = mapped.person.lastName?.trim() || null
  if (firstName && lastName) return { firstName, lastName }
  const combined = mapped.person.fullName ?? mapped.person.displayName
  const split = combined ? splitFullName(combined) : { firstName: null, lastName: null }
  return { firstName: firstName ?? split.firstName, lastName: lastName ?? split.lastName }
}

function hasCustomFields(values: Record<string, string | string[]>): boolean {
  return Object.keys(values).length > 0
}

async function loadExistingPersonCustomFields(
  em: EntityManager,
  scope: MetaScope,
  entityId: string,
  profileId: string | null,
): Promise<Record<string, unknown>> {
  const load = async (customEntityId: string, recordId: string) => {
    const values = await loadCustomFieldValues({
      em,
      entityId: customEntityId,
      recordIds: [recordId],
      tenantIdByRecord: { [recordId]: scope.tenantId },
      organizationIdByRecord: { [recordId]: scope.organizationId },
      tenantFallbacks: [scope.tenantId],
    })
    return values[recordId] ?? {}
  }
  const entityValues = await load(CUSTOMER_ENTITY_ID, entityId)
  const profileValues = profileId ? await load(PERSON_ENTITY_ID, profileId) : {}
  return { ...entityValues, ...profileValues }
}

async function createPerson(
  input: CrmWriteInput,
  execute: CommandExecutor,
  email: string | null,
  phoneE164: string | null,
): Promise<PersonStepResult> {
  const { mapped, translate } = input
  const names = resolvePersonNames(
    mapped,
    email,
    translate('meta_lead_ads.person.fallbackLastName', 'Unknown'),
  )
  const firstName = clip(names.firstName, NAME_MAX) ?? names.firstName
  const lastName = clip(names.lastName, NAME_MAX) ?? names.lastName
  const displayName = clip(mapped.person.displayName, DISPLAY_NAME_MAX)
  const jobTitle = clip(mapped.person.jobTitle, JOB_TITLE_MAX)
  const result = await execute<{ entityId: string; personId: string }>('customers.people.create', {
    firstName,
    lastName,
    ...(displayName ? { displayName } : {}),
    ...(email ? { primaryEmail: email } : {}),
    ...(phoneE164 ? { primaryPhone: phoneE164 } : {}),
    ...(jobTitle ? { jobTitle } : {}),
    source: CRM_SOURCE,
    ...(hasCustomFields(mapped.personCustomFields) ? { customFields: mapped.personCustomFields } : {}),
  })
  return {
    personId: result.entityId,
    personName: displayName ?? `${firstName} ${lastName}`,
    matchType: hasContactKeys(mapped, input.phone) ? 'created' : 'none',
    personCreated: true,
    differing: [],
  }
}

async function fillEmptyPersonFields(
  input: CrmWriteInput,
  execute: CommandExecutor,
  personId: string,
  matchType: MetaMatchType,
  email: string | null,
  phoneE164: string | null,
): Promise<PersonStepResult | null> {
  const { em, scope, mapped } = input
  const entity = await findOneWithDecryption(
    em,
    CustomerEntity,
    { id: personId, kind: 'person', tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
  if (!entity) return null
  const profile = await findOneWithDecryption(
    em,
    CustomerPersonProfile,
    { entity: personId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    decryptionScope(scope),
  )

  const patch: Record<string, unknown> = {}
  const differing: DifferingValue[] = []
  const consider = (field: string, current: unknown, next: string | null, isSame: () => boolean) => {
    if (!next) return
    if (isEmpty(current)) patch[field] = next
    else if (!isSame()) differing.push({ field, value: next })
  }

  const leadNames = explicitLeadNames(mapped)
  const firstName = clip(leadNames.firstName, NAME_MAX)
  const lastName = clip(leadNames.lastName, NAME_MAX)
  const jobTitle = clip(mapped.person.jobTitle, JOB_TITLE_MAX)
  consider('primaryEmail', entity.primaryEmail, email, () => sameText(entity.primaryEmail, email ?? ''))
  consider('primaryPhone', entity.primaryPhone, phoneE164, () => {
    const current = entity.primaryPhone ? normalizePhoneToE164(entity.primaryPhone) : null
    return Boolean(current?.e164 && current.e164 === phoneE164) || sameText(entity.primaryPhone, phoneE164 ?? '')
  })
  if (profile) {
    consider('firstName', profile.firstName, firstName, () => sameText(profile.firstName, firstName ?? ''))
    consider('lastName', profile.lastName, lastName, () => sameText(profile.lastName, lastName ?? ''))
    consider('jobTitle', profile.jobTitle, jobTitle, () => sameText(profile.jobTitle, jobTitle ?? ''))
  }

  if (hasCustomFields(mapped.personCustomFields)) {
    const existing = await loadExistingPersonCustomFields(em, scope, entity.id, profile?.id ?? null)
    const customFields: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(mapped.personCustomFields)) {
      const current = existing[`cf_${key}`]
      if (isEmpty(current)) customFields[key] = value
      else if (!sameText(current, value)) differing.push({ field: `cf:${key}`, value: displayValue(value) })
    }
    if (hasCustomFields(customFields)) patch.customFields = customFields
  }

  if (Object.keys(patch).length > 0) {
    await execute('customers.people.update', { id: entity.id, ...patch })
  }
  return { personId: entity.id, personName: entity.displayName, matchType, personCreated: false, differing }
}

async function writePerson(input: CrmWriteInput, execute: CommandExecutor): Promise<PersonStepResult> {
  const { event, match, em, scope } = input
  const email = resolveLeadEmail(input.mapped)
  const phoneE164 = resolveLeadPhone(input.phone)

  if (event.personId && (event.matchType === 'created' || event.matchType === 'none')) {
    const entity = await findOneWithDecryption(
      em,
      CustomerEntity,
      { id: event.personId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      undefined,
      decryptionScope(scope),
    )
    return {
      personId: event.personId,
      personName: entity?.displayName ?? '',
      matchType: event.matchType,
      personCreated: false,
      differing: [],
    }
  }

  const matchedPersonId = event.personId ?? match.personId
  const matchedType: MetaMatchType =
    event.personId && event.matchType ? event.matchType : match.matchType
  if (matchedPersonId && (matchedType === 'email' || matchedType === 'phone')) {
    const filled = await fillEmptyPersonFields(input, execute, matchedPersonId, matchedType, email, phoneE164)
    if (filled) return filled
  }
  return createPerson(input, execute, email, phoneE164)
}

async function findCompanyByName(input: CrmWriteInput, name: string): Promise<string | null> {
  const { em, scope } = input
  const companies = await findWithDecryption(
    em,
    CustomerEntity,
    { kind: 'company', tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    { limit: DEDUP_SCAN_LIMIT, orderBy: { createdAt: 'DESC' } },
    decryptionScope(scope),
  )
  const wanted = name.trim().toLowerCase()
  const found = companies.find((company) => (company.displayName ?? '').trim().toLowerCase() === wanted)
  return found ? found.id : null
}

async function writeCompany(
  input: CrmWriteInput,
  execute: CommandExecutor,
  personId: string,
): Promise<string | null> {
  const { event, mapped } = input
  const name = clip(mapped.company.displayName, DISPLAY_NAME_MAX)
  let companyId = event.companyId ?? null
  if (!companyId) {
    if (!name) return null
    companyId = await findCompanyByName(input, name)
    if (!companyId) {
      const domain = clip(mapped.company.domain, DOMAIN_MAX)
      const created = await execute<{ entityId: string; companyId: string }>('customers.companies.create', {
        displayName: name,
        ...(domain ? { domain } : {}),
        source: CRM_SOURCE,
        ...(hasCustomFields(mapped.companyCustomFields) ? { customFields: mapped.companyCustomFields } : {}),
      })
      companyId = created.entityId
    }
    await input.persist({ companyId })
  }
  await execute<{ linkId: string }>('customers.personCompanyLinks.create', {
    personEntityId: personId,
    companyEntityId: companyId,
  })
  return companyId
}

async function writeAddress(input: CrmWriteInput, execute: CommandExecutor, personId: string): Promise<void> {
  const city = input.mapped.person.city?.trim()
  if (!city) return
  await execute<{ addressId: string }>('customers.addresses.create', {
    entityId: personId,
    addressLine1: city.slice(0, ADDRESS_LINE_MAX),
    city: city.slice(0, CITY_MAX),
  })
}

function buildBodyLabels(translate: TranslateWithFallbackFn): Record<string, string> {
  return Object.fromEntries(
    Object.entries(BODY_LABEL_FALLBACKS).map(([key, fallback]) => [
      key,
      translate(`meta_lead_ads.interaction.body.${key}`, fallback),
    ]),
  )
}

async function writeInteraction(
  input: CrmWriteInput,
  execute: CommandExecutor,
  person: PersonStepResult,
): Promise<string> {
  const { event, em, scope, mapped, source, translate, match } = input
  const interactionId = computeInteractionId(event.metaLeadId)
  if (event.interactionId) return event.interactionId
  const existing = await findOneWithDecryption(
    em,
    CustomerInteraction,
    { id: interactionId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    decryptionScope(scope),
  )
  if (!existing) {
    const title = translate('meta_lead_ads.interaction.title', 'Lead from Meta')
    const body = buildInteractionBody({
      title,
      answers: mapped.answers,
      source: {
        campaignName: source.campaignName,
        adsetName: source.adsetName,
        adName: source.adName,
        formName: source.formName,
        platform: source.platform,
        isOrganic: source.isOrganic,
      },
      notes: mapped.notes,
      conflictNote: match.conflictPersonId ?? null,
      differing: person.differing,
      notMatched: person.matchType === 'none',
      labels: buildBodyLabels(translate),
    })
    await execute<{ interactionId: string }>('customers.interactions.create', {
      id: interactionId,
      entityId: person.personId,
      interactionType: INTERACTION_TYPE,
      title,
      body,
      status: INTERACTION_STATUS_DONE,
      ...(source.submittedAt ? { occurredAt: source.submittedAt } : {}),
      source: CRM_SOURCE,
    })
  }
  await input.persist({ interactionId })
  return interactionId
}

async function flagDealStepFailed(input: CrmWriteInput): Promise<void> {
  const { em, scope, form } = input
  await em.nativeUpdate(
    MetaForm,
    { id: form.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { needsAttention: true, attentionReason: 'deal_step_failed' },
  )
}

async function loadDealOwner(input: CrmWriteInput, dealId: string): Promise<string | null> {
  const { em, scope } = input
  const deal = await findOneWithDecryption(
    em,
    CustomerDeal,
    { id: dealId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    decryptionScope(scope),
  )
  return deal?.ownerUserId ?? null
}

async function writeDeal(
  input: CrmWriteInput,
  execute: CommandExecutor,
  person: PersonStepResult,
  companyId: string | null,
): Promise<{ dealId: string | null; ownerUserId: string | null; dealStepFailed: boolean }> {
  const { event, form, em, scope, translate } = input
  if (event.dealId) {
    return { dealId: event.dealId, ownerUserId: await loadDealOwner(input, event.dealId), dealStepFailed: false }
  }

  if (!form.createDeal) {
    if (form.ownerMode === 'none') return { dealId: null, ownerUserId: null, dealStepFailed: false }
    try {
      const owner = await assignOwner(em, scope, form.id)
      return { dealId: null, ownerUserId: owner.ownerUserId, dealStepFailed: false }
    } catch (error) {
      logger.warn('meta_lead_ads owner assignment failed', { formId: form.id })
      getTelemetryRuntime()?.reportError(error, {
        module: 'meta_lead_ads',
        code: 'meta_lead_ads.owner_assignment_failed',
        attributes: { formId: form.id },
      })
      return { dealId: null, ownerUserId: null, dealStepFailed: false }
    }
  }

  let ownerUserId: string | null = null
  try {
    const owner = await assignOwner(em, scope, form.id)
    ownerUserId = owner.ownerUserId
    const name = person.personName.trim() || event.metaLeadId
    const title = translate('meta_lead_ads.deal.title', 'Lead: {name}', { name }).slice(0, DEAL_TITLE_MAX)
    const created = await execute<{ dealId: string }>('customers.deals.create', {
      title,
      ...(form.pipelineId ? { pipelineId: form.pipelineId } : {}),
      ...(form.pipelineStageId ? { pipelineStageId: form.pipelineStageId } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
      personIds: [person.personId],
      ...(companyId ? { companyIds: [companyId] } : {}),
      primaryPersonEntityId: person.personId,
      source: CRM_SOURCE,
    })
    await input.persist({ dealId: created.dealId })
    return { dealId: created.dealId, ownerUserId, dealStepFailed: false }
  } catch (error) {
    logger.warn('meta_lead_ads deal step failed', { formId: form.id, leadEventId: event.id })
    getTelemetryRuntime()?.reportError(error, {
      module: 'meta_lead_ads',
      code: 'meta_lead_ads.deal_step_failed',
      attributes: { formId: form.id, leadEventId: event.id },
    })
    await flagDealStepFailed(input)
    return { dealId: null, ownerUserId, dealStepFailed: true }
  }
}

export async function writeLeadToCrm(input: CrmWriteInput): Promise<CrmWriteResult> {
  const execute = createExecutor(input)

  const person = await writePerson(input, execute)
  await input.persist({ personId: person.personId, matchType: person.matchType })

  const companyId = await writeCompany(input, execute, person.personId)

  if (person.personCreated) await writeAddress(input, execute, person.personId)

  const interactionId = await writeInteraction(input, execute, person)

  const deal = await writeDeal(input, execute, person, companyId)

  return {
    personId: person.personId,
    companyId,
    interactionId,
    dealId: deal.dealId,
    ownerUserId: deal.ownerUserId,
    matchType: person.matchType,
    dealStepFailed: deal.dealStepFailed,
    personCreated: person.personCreated,
  }
}
