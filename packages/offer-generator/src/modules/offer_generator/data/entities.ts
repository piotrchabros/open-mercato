import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type {
  OfferCustomerKind,
  OfferGenerationRunKind,
  OfferGenerationRunStatus,
  OfferGenerationStatus,
  OfferLanguage,
  OfferRevisionSource,
  OfferStatus,
} from './validators'

export type OfferViewSections = Record<string, { l: string; ms: number }>

@Entity({ tableName: 'offer_generator_offers' })
@Unique({ name: 'offer_generator_offers_slug_uq', properties: ['slug'] })
@Index({
  name: 'offer_generator_offers_scope_created_idx',
  properties: ['tenantId', 'organizationId', 'createdAt'],
})
@Index({
  name: 'offer_generator_offers_scope_customer_idx',
  properties: ['tenantId', 'organizationId', 'customerEntityId'],
})
@Index({
  name: 'offer_generator_offers_scope_deal_idx',
  properties: ['tenantId', 'organizationId', 'dealId'],
})
@Index({
  name: 'offer_generator_offers_scope_status_idx',
  properties: ['tenantId', 'organizationId', 'status'],
})
export class Offer {
  [OptionalProps]?:
    | 'status'
    | 'viewCount'
    | 'generationStatus'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'title', type: 'text' })
  title!: string

  @Property({ name: 'client_name', type: 'text' })
  clientName!: string

  @Property({ name: 'language', type: 'text' })
  language!: OfferLanguage

  @Property({ name: 'status', type: 'text', default: 'draft' })
  status: OfferStatus = 'draft'

  @Property({ name: 'customer_entity_id', type: 'uuid', nullable: true })
  customerEntityId?: string | null

  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: OfferCustomerKind | null

  @Property({ name: 'deal_id', type: 'uuid', nullable: true })
  dealId?: string | null

  @Property({ name: 'slug', type: 'text' })
  slug!: string

  @Property({ name: 'access_token', type: 'varchar', length: 12 })
  accessToken!: string

  @Property({ name: 'prompt', type: 'text', nullable: true })
  prompt?: string | null

  @Property({ name: 'notes', type: 'text', nullable: true })
  notes?: string | null

  @Property({ name: 'html', type: 'text', nullable: true })
  html?: string | null

  @Property({ name: 'html_updated_at', type: Date, nullable: true })
  htmlUpdatedAt?: Date | null

  @Property({ name: 'value_amount', type: 'numeric', precision: 14, scale: 2, nullable: true })
  valueAmount?: string | null

  @Property({ name: 'currency_code', type: 'text', nullable: true })
  currencyCode?: string | null

  @Property({ name: 'valid_until', type: 'date', nullable: true })
  validUntil?: string | null

  @Property({ name: 'sent_at', type: Date, nullable: true })
  sentAt?: Date | null

  @Property({ name: 'viewed_at', type: Date, nullable: true })
  viewedAt?: Date | null

  @Property({ name: 'responded_at', type: Date, nullable: true })
  respondedAt?: Date | null

  @Property({ name: 'view_count', type: 'integer', default: 0 })
  viewCount: number = 0

  @Property({ name: 'last_viewed_at', type: Date, nullable: true })
  lastViewedAt?: Date | null

  @Property({ name: 'generation_status', type: 'text', default: 'idle' })
  generationStatus: OfferGenerationStatus = 'idle'

  @Property({ name: 'last_generation_run_id', type: 'uuid', nullable: true })
  lastGenerationRunId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({
    name: 'updated_at',
    type: Date,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

@Entity({ tableName: 'offer_generator_offer_revisions' })
@Index({
  name: 'offer_generator_offer_revisions_offer_created_idx',
  expression:
    'create index "offer_generator_offer_revisions_offer_created_idx" on "offer_generator_offer_revisions" ("offer_id","created_at" desc)',
})
export class OfferRevision {
  [OptionalProps]?: 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'offer_id', type: 'uuid' })
  offerId!: string

  @Property({ name: 'html', type: 'text' })
  html!: string

  @Property({ name: 'source', type: 'text' })
  source!: OfferRevisionSource

  @Property({ name: 'feedback', type: 'text', nullable: true })
  feedback?: string | null

  @Property({ name: 'generation_run_id', type: 'uuid', nullable: true })
  generationRunId?: string | null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'offer_generator_generation_runs' })
@Index({
  name: 'offer_generator_generation_runs_scope_offer_created_idx',
  expression:
    'create index "offer_generator_generation_runs_scope_offer_created_idx" on "offer_generator_generation_runs" ("tenant_id","organization_id","offer_id","created_at" desc)',
})
@Index({
  name: 'offer_generator_generation_runs_offer_status_idx',
  properties: ['offerId', 'status'],
})
export class OfferGenerationRun {
  [OptionalProps]?: 'status' | 'bytesReceived' | 'chunks' | 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'offer_id', type: 'uuid' })
  offerId!: string

  @Property({ name: 'kind', type: 'text' })
  kind!: OfferGenerationRunKind

  @Property({ name: 'input_text', type: 'text' })
  inputText!: string

  @Property({ name: 'language', type: 'text' })
  language!: OfferLanguage

  @Property({ name: 'status', type: 'text', default: 'queued' })
  status: OfferGenerationRunStatus = 'queued'

  @Property({ name: 'progress_job_id', type: 'uuid', nullable: true })
  progressJobId?: string | null

  @Property({ name: 'provider_id', type: 'text', nullable: true })
  providerId?: string | null

  @Property({ name: 'model_id', type: 'text', nullable: true })
  modelId?: string | null

  @Property({ name: 'bytes_received', type: 'integer', default: 0 })
  bytesReceived: number = 0

  @Property({ name: 'chunks', type: 'integer', default: 0 })
  chunks: number = 0

  @Property({ name: 'error_code', type: 'text', nullable: true })
  errorCode?: string | null

  @Property({ name: 'result_revision_id', type: 'uuid', nullable: true })
  resultRevisionId?: string | null

  @Property({ name: 'started_at', type: Date, nullable: true })
  startedAt?: Date | null

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

  @Property({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({
    name: 'updated_at',
    type: Date,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'offer_generator_offer_views' })
@Unique({ name: 'offer_generator_offer_views_view_key_uq', properties: ['viewKey'] })
@Index({
  name: 'offer_generator_offer_views_offer_started_idx',
  expression:
    'create index "offer_generator_offer_views_offer_started_idx" on "offer_generator_offer_views" ("offer_id","started_at" desc)',
})
@Index({
  name: 'offer_generator_offer_views_offer_ip_started_idx',
  properties: ['offerId', 'ipHash', 'startedAt'],
})
export class OfferView {
  [OptionalProps]?: 'isInternal' | 'activeMs' | 'maxScrollPct' | 'beats' | 'sections' | 'createdAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'view_key', type: 'uuid' })
  viewKey!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'offer_id', type: 'uuid' })
  offerId!: string

  @Property({ name: 'visitor_id', type: 'uuid' })
  visitorId!: string

  @Property({ name: 'ip_hash', type: 'varchar', length: 64, nullable: true })
  ipHash?: string | null

  @Property({ name: 'country', type: 'varchar', length: 2, nullable: true })
  country?: string | null

  @Property({ name: 'device', type: 'varchar', length: 16 })
  device!: string

  @Property({ name: 'browser', type: 'varchar', length: 32 })
  browser!: string

  @Property({ name: 'os', type: 'varchar', length: 32 })
  os!: string

  @Property({ name: 'referrer', type: 'varchar', length: 300, nullable: true })
  referrer?: string | null

  @Property({ name: 'is_internal', type: 'boolean', default: false })
  isInternal: boolean = false

  @Property({ name: 'started_at', type: Date })
  startedAt!: Date

  @Property({ name: 'last_seen_at', type: Date })
  lastSeenAt!: Date

  @Property({ name: 'active_ms', type: 'integer', default: 0 })
  activeMs: number = 0

  @Property({ name: 'max_scroll_pct', type: 'integer', default: 0 })
  maxScrollPct: number = 0

  @Property({ name: 'beats', type: 'integer', default: 0 })
  beats: number = 0

  @Property({ name: 'sections', type: 'json', default: '{}' })
  sections: OfferViewSections = {}

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

@Entity({ tableName: 'offer_generator_settings' })
@Unique({
  name: 'offer_generator_settings_scope_uq',
  properties: ['tenantId', 'organizationId'],
})
export class OfferGeneratorSettings {
  [OptionalProps]?:
    | 'companyName'
    | 'defaultLanguage'
    | 'defaultCurrency'
    | 'alternateModels'
    | 'createdAt'
    | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'company_name', type: 'text', default: '' })
  companyName: string = ''

  @Property({ name: 'template_html', type: 'text' })
  templateHtml!: string

  @Property({ name: 'extra_instructions', type: 'text', nullable: true })
  extraInstructions?: string | null

  @Property({ name: 'default_language', type: 'text', default: 'pl' })
  defaultLanguage: OfferLanguage = 'pl'

  @Property({ name: 'default_currency', type: 'text', default: 'PLN' })
  defaultCurrency: string = 'PLN'

  @Property({ name: 'default_model', type: 'text', nullable: true })
  defaultModel?: string | null

  @Property({ name: 'alternate_models', type: 'json', default: '[]' })
  alternateModels: string[] = []

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({
    name: 'updated_at',
    type: Date,
    onCreate: () => new Date(),
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date()
}
