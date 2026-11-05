import type { Offer, OfferGenerationRun, OfferRevision } from '../data/entities'
import type {
  OfferCustomerKind,
  OfferGenerationRunKind,
  OfferGenerationRunStatus,
  OfferGenerationStatus,
  OfferLanguage,
  OfferRevisionSource,
  OfferStatus,
} from '../data/validators'
import type { OfferGeneratorSettingsValues } from './settings'
import { buildOfferSegment, buildPublicOfferUrl } from './slug'

type DateLike = Date | string | null | undefined

export type OfferDto = {
  id: string
  title: string
  clientName: string
  customerEntityId: string | null
  customerKind: OfferCustomerKind | null
  dealId: string | null
  ownerUserId: string | null
  language: OfferLanguage
  status: OfferStatus
  slug: string
  publicUrl: string
  valueAmount: string | null
  currencyCode: string | null
  validUntil: string | null
  sentAt: string | null
  viewedAt: string | null
  respondedAt: string | null
  viewCount: number
  lastViewedAt: string | null
  hasHtml: boolean
  htmlUpdatedAt: string | null
  generationStatus: OfferGenerationStatus
  lastGenerationRunId: string | null
  createdAt: string | null
  updatedAt: string | null
  prompt?: string | null
  notes?: string | null
}

export type OfferHtmlDto = {
  html: string | null
  updatedAt: string | null
}

export type RevisionDto = {
  id: string
  source: OfferRevisionSource
  feedback: string | null
  generationRunId: string | null
  createdByUserId: string | null
  createdAt: string | null
  sizeBytes: number
}

export type GenerationRunDto = {
  id: string
  offerId: string
  kind: OfferGenerationRunKind
  status: OfferGenerationRunStatus
  providerId: string | null
  modelId: string | null
  language: OfferLanguage
  bytesReceived: number
  errorCode: string | null
  progressJobId: string | null
  resultRevisionId: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string | null
}

export type SettingsDto = {
  companyName: string
  templateHtml: string
  extraInstructions: string | null
  defaultLanguage: OfferLanguage
  defaultCurrency: string
  defaultModel: string | null
  alternateModels: string[]
  updatedAt: string | null
}

export type OfferSerializable = Pick<
  Offer,
  | 'id'
  | 'title'
  | 'clientName'
  | 'language'
  | 'status'
  | 'slug'
  | 'accessToken'
  | 'viewCount'
  | 'generationStatus'
> &
  Partial<
    Pick<
      Offer,
      | 'customerEntityId'
      | 'customerKind'
      | 'dealId'
      | 'ownerUserId'
      | 'prompt'
      | 'notes'
      | 'html'
      | 'currencyCode'
      | 'lastGenerationRunId'
    >
  > & {
    valueAmount?: string | number | null
    validUntil?: DateLike
    htmlUpdatedAt?: DateLike
    sentAt?: DateLike
    viewedAt?: DateLike
    respondedAt?: DateLike
    lastViewedAt?: DateLike
    createdAt?: DateLike
    updatedAt?: DateLike
  }

export type RevisionSerializable = Pick<OfferRevision, 'id' | 'source'> &
  Partial<Pick<OfferRevision, 'feedback' | 'generationRunId' | 'createdByUserId' | 'html'>> & {
    createdAt?: DateLike
  }

export type GenerationRunSerializable = Pick<
  OfferGenerationRun,
  'id' | 'offerId' | 'kind' | 'status' | 'language' | 'bytesReceived'
> &
  Partial<
    Pick<OfferGenerationRun, 'providerId' | 'modelId' | 'errorCode' | 'progressJobId' | 'resultRevisionId'>
  > & {
    startedAt?: DateLike
    finishedAt?: DateLike
    createdAt?: DateLike
  }

export type SerializeOfferOptions = {
  detail: boolean
  baseUrl?: string
}

export function toIsoString(value: DateLike): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function toIsoDate(value: DateLike): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const iso = toIsoString(value)
  return iso ? iso.slice(0, 10) : null
}

function toAmountString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'number' ? value.toFixed(2) : String(value)
}

export function serializeOffer(entity: OfferSerializable, opts: SerializeOfferOptions): OfferDto {
  const segment = buildOfferSegment(entity.slug, entity.accessToken)
  const dto: OfferDto = {
    id: entity.id,
    title: entity.title,
    clientName: entity.clientName,
    customerEntityId: entity.customerEntityId ?? null,
    customerKind: entity.customerKind ?? null,
    dealId: entity.dealId ?? null,
    ownerUserId: entity.ownerUserId ?? null,
    language: entity.language,
    status: entity.status,
    slug: entity.slug,
    publicUrl: opts.baseUrl === undefined ? buildPublicOfferUrl(segment) : buildPublicOfferUrl(segment, opts.baseUrl),
    valueAmount: toAmountString(entity.valueAmount),
    currencyCode: entity.currencyCode ?? null,
    validUntil: toIsoDate(entity.validUntil),
    sentAt: toIsoString(entity.sentAt),
    viewedAt: toIsoString(entity.viewedAt),
    respondedAt: toIsoString(entity.respondedAt),
    viewCount: Number(entity.viewCount ?? 0),
    lastViewedAt: toIsoString(entity.lastViewedAt),
    hasHtml: Boolean(entity.htmlUpdatedAt) || Boolean(entity.html && entity.html.length > 0),
    htmlUpdatedAt: toIsoString(entity.htmlUpdatedAt),
    generationStatus: entity.generationStatus,
    lastGenerationRunId: entity.lastGenerationRunId ?? null,
    createdAt: toIsoString(entity.createdAt),
    updatedAt: toIsoString(entity.updatedAt),
  }
  if (opts.detail) {
    dto.prompt = entity.prompt ?? null
    dto.notes = entity.notes ?? null
  }
  return dto
}

export function serializeOfferHtml(entity: Pick<OfferSerializable, 'html' | 'updatedAt'>): OfferHtmlDto {
  return {
    html: entity.html ?? null,
    updatedAt: toIsoString(entity.updatedAt),
  }
}

export function serializeRevision(entity: RevisionSerializable, sizeBytes?: number): RevisionDto {
  return {
    id: entity.id,
    source: entity.source,
    feedback: entity.feedback ?? null,
    generationRunId: entity.generationRunId ?? null,
    createdByUserId: entity.createdByUserId ?? null,
    createdAt: toIsoString(entity.createdAt),
    sizeBytes: sizeBytes ?? Buffer.byteLength(entity.html ?? '', 'utf8'),
  }
}

export function serializeRun(entity: GenerationRunSerializable): GenerationRunDto {
  return {
    id: entity.id,
    offerId: entity.offerId,
    kind: entity.kind,
    status: entity.status,
    providerId: entity.providerId ?? null,
    modelId: entity.modelId ?? null,
    language: entity.language,
    bytesReceived: Number(entity.bytesReceived ?? 0),
    errorCode: entity.errorCode ?? null,
    progressJobId: entity.progressJobId ?? null,
    resultRevisionId: entity.resultRevisionId ?? null,
    startedAt: toIsoString(entity.startedAt),
    finishedAt: toIsoString(entity.finishedAt),
    createdAt: toIsoString(entity.createdAt),
  }
}

export function serializeSettings(values: OfferGeneratorSettingsValues): SettingsDto {
  return {
    companyName: values.companyName,
    templateHtml: values.templateHtml,
    extraInstructions: values.extraInstructions ?? null,
    defaultLanguage: values.defaultLanguage,
    defaultCurrency: values.defaultCurrency,
    defaultModel: values.defaultModel ?? null,
    alternateModels: [...values.alternateModels],
    updatedAt: toIsoString(values.updatedAt),
  }
}
