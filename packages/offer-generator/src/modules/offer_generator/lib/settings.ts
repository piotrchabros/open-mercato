import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { OfferGeneratorSettings } from '../data/entities'
import type { OfferLanguage } from '../data/validators'
import { DEFAULT_OFFER_TEMPLATE } from './default-template'

export type OfferGeneratorScope = { tenantId: string; organizationId: string }

export type OfferGeneratorSettingsValues = {
  id: string | null
  companyName: string
  templateHtml: string
  extraInstructions: string | null
  defaultLanguage: OfferLanguage
  defaultCurrency: string
  defaultModel: string | null
  alternateModels: string[]
  updatedAt: Date | null
}

export const DEFAULT_COMPANY_NAME = 'BlueBee'
export const DEFAULT_LANGUAGE: OfferLanguage = 'pl'
export const DEFAULT_CURRENCY = 'PLN'

function findSettingsRow(em: EntityManager, scope: OfferGeneratorScope): Promise<OfferGeneratorSettings | null> {
  return findOneWithDecryption(
    em,
    OfferGeneratorSettings,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
}

export function buildDefaultSettingsValues(): OfferGeneratorSettingsValues {
  return {
    id: null,
    companyName: DEFAULT_COMPANY_NAME,
    templateHtml: DEFAULT_OFFER_TEMPLATE,
    extraInstructions: null,
    defaultLanguage: DEFAULT_LANGUAGE,
    defaultCurrency: DEFAULT_CURRENCY,
    defaultModel: null,
    alternateModels: [],
    updatedAt: null,
  }
}

export function toSettingsValues(row: OfferGeneratorSettings): OfferGeneratorSettingsValues {
  return {
    id: row.id,
    companyName: row.companyName ?? DEFAULT_COMPANY_NAME,
    templateHtml: row.templateHtml && row.templateHtml.trim().length > 0 ? row.templateHtml : DEFAULT_OFFER_TEMPLATE,
    extraInstructions: row.extraInstructions ?? null,
    defaultLanguage: row.defaultLanguage ?? DEFAULT_LANGUAGE,
    defaultCurrency: row.defaultCurrency ?? DEFAULT_CURRENCY,
    defaultModel: row.defaultModel ?? null,
    alternateModels: Array.isArray(row.alternateModels) ? row.alternateModels : [],
    updatedAt: row.updatedAt ?? null,
  }
}

export async function getOfferGeneratorSettings(
  em: EntityManager,
  scope: OfferGeneratorScope,
): Promise<OfferGeneratorSettingsValues> {
  const row = await findSettingsRow(em, scope)
  if (!row) return buildDefaultSettingsValues()
  return toSettingsValues(row)
}

export async function ensureSettingsRow(
  em: EntityManager,
  scope: OfferGeneratorScope,
): Promise<OfferGeneratorSettings> {
  const existing = await findSettingsRow(em, scope)
  if (existing) return existing
  const fork = em.fork()
  fork.create(OfferGeneratorSettings, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    companyName: DEFAULT_COMPANY_NAME,
    templateHtml: DEFAULT_OFFER_TEMPLATE,
    defaultLanguage: DEFAULT_LANGUAGE,
    defaultCurrency: DEFAULT_CURRENCY,
    alternateModels: [],
  })
  try {
    await fork.flush()
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
  }
  const created = await findSettingsRow(em, scope)
  if (!created) throw new Error('[internal] offer_generator settings row could not be created')
  return created
}
