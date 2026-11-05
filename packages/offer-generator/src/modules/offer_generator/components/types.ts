export type {
  GenerationRunDto,
  OfferDto,
  OfferHtmlDto,
  RevisionDto,
  SettingsDto,
} from '../lib/serializers'
export type {
  OfferInsightsDto,
  OfferInsightsStats,
  OfferSectionInsight,
  OfferViewRow,
} from '../lib/views-repository'
export type {
  OfferCustomerKind,
  OfferGenerationErrorCode,
  OfferGenerationRunKind,
  OfferGenerationRunStatus,
  OfferGenerationStatus,
  OfferLanguage,
  OfferRevisionSource,
  OfferStatus,
} from '../data/validators'

export type PagedResponse<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type OfferCreateResponse = { id: string | null }

export type GenerationStartResponse = { runId: string; progressJobId: string | null }
