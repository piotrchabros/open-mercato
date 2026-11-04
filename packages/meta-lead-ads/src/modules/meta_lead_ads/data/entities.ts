import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'
import type {
  MetaAttentionReason,
  MetaConnectionStatus,
  MetaDeletionRequestStatus,
  MetaLeadErrorCode,
  MetaLeadEventSource,
  MetaLeadEventStatus,
  MetaMatchType,
  MetaOwnerMode,
  MetaPageSubscriptionStatus,
  MetaPlatform,
  MetaSyncRunStatus,
  MetaSyncRunKind,
} from '../lib/constants'

export type MetaFieldMappingRow = { questionKey: string; target: string }
export type MetaFormQuestionRow = {
  key: string
  label: string
  type: string
  options?: string[]
}

export const DEFAULT_FIELD_MAPPING: MetaFieldMappingRow[] = [
  { questionKey: 'email', target: 'person.primaryEmail' },
  { questionKey: 'phone_number', target: 'person.primaryPhone' },
  { questionKey: 'full_name', target: 'person.fullName' },
  { questionKey: 'first_name', target: 'person.firstName' },
  { questionKey: 'last_name', target: 'person.lastName' },
  { questionKey: 'company_name', target: 'company.displayName' },
  { questionKey: 'job_title', target: 'person.jobTitle' },
  { questionKey: 'city', target: 'person.city' },
]

const DEFAULT_FIELD_MAPPING_SQL = JSON.stringify(DEFAULT_FIELD_MAPPING)

@Entity({ tableName: 'meta_lead_ads_connections' })
@Index({
  name: 'meta_lead_ads_connections_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Index({
  name: 'meta_lead_ads_connections_scope_user_uq',
  expression:
    'create unique index "meta_lead_ads_connections_scope_user_uq" on "meta_lead_ads_connections" ("tenant_id","organization_id","meta_user_id") where deleted_at is null',
})
@Index({ name: 'meta_lead_ads_connections_status_idx', properties: ['status'] })
export class MetaConnection {
  [OptionalProps]?: 'grantedScopes' | 'status' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'meta_user_id', type: 'text' })
  metaUserId!: string

  @Property({ name: 'meta_user_name', type: 'text', nullable: true })
  metaUserName?: string | null

  @Property({ name: 'user_access_token', type: 'text', nullable: true })
  userAccessToken?: string | null

  @Property({ name: 'token_expires_at', type: Date, nullable: true })
  tokenExpiresAt?: Date | null

  @Property({ name: 'granted_scopes', type: 'json', default: '[]' })
  grantedScopes: string[] = []

  @Property({ name: 'status', type: 'text', default: 'active' })
  status: MetaConnectionStatus = 'active'

  @Property({ name: 'last_health_check_at', type: Date, nullable: true })
  lastHealthCheckAt?: Date | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'connected_by_user_id', type: 'uuid' })
  connectedByUserId!: string

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

@Entity({ tableName: 'meta_lead_ads_pages' })
@Index({
  name: 'meta_lead_ads_pages_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Index({
  name: 'meta_lead_ads_pages_meta_page_id_uq',
  expression:
    'create unique index "meta_lead_ads_pages_meta_page_id_uq" on "meta_lead_ads_pages" ("meta_page_id") where deleted_at is null',
})
@Index({
  name: 'meta_lead_ads_pages_connection_idx',
  properties: ['connectionId'],
})
@Index({
  name: 'meta_lead_ads_pages_subscription_status_idx',
  properties: ['subscriptionStatus'],
})
export class MetaPage {
  [OptionalProps]?: 'subscriptionStatus' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'connection_id', type: 'uuid' })
  connectionId!: string

  @Property({ name: 'meta_page_id', type: 'text' })
  metaPageId!: string

  @Property({ name: 'name', type: 'text' })
  name!: string

  @Property({ name: 'page_access_token', type: 'text', nullable: true })
  pageAccessToken?: string | null

  @Property({
    name: 'subscription_status',
    type: 'text',
    default: 'unsubscribed',
  })
  subscriptionStatus: MetaPageSubscriptionStatus = 'unsubscribed'

  @Property({ name: 'status_checked_at', type: Date, nullable: true })
  statusCheckedAt?: Date | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

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

@Entity({ tableName: 'meta_lead_ads_forms' })
@Index({
  name: 'meta_lead_ads_forms_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Index({
  name: 'meta_lead_ads_forms_page_form_uq',
  expression:
    'create unique index "meta_lead_ads_forms_page_form_uq" on "meta_lead_ads_forms" ("page_id","meta_form_id") where deleted_at is null',
})
@Index({
  name: 'meta_lead_ads_forms_scope_enabled_idx',
  properties: ['tenantId', 'organizationId', 'isEnabled'],
})
@Index({ name: 'meta_lead_ads_forms_page_idx', properties: ['pageId'] })
export class MetaForm {
  [OptionalProps]?:
    | 'isEnabled'
    | 'questions'
    | 'needsAttention'
    | 'fieldMapping'
    | 'createDeal'
    | 'ownerMode'
    | 'ownerUserIds'
    | 'roundRobinCursor'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'page_id', type: 'uuid' })
  pageId!: string

  @Property({ name: 'meta_form_id', type: 'text' })
  metaFormId!: string

  @Property({ name: 'name', type: 'text' })
  name!: string

  @Property({ name: 'locale', type: 'text', nullable: true })
  locale?: string | null

  @Property({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled: boolean = true

  @Property({ name: 'questions', type: 'json', default: '[]' })
  questions: MetaFormQuestionRow[] = []

  @Property({ name: 'questions_fingerprint', type: 'text' })
  questionsFingerprint!: string

  @Property({ name: 'needs_attention', type: 'boolean', default: false })
  needsAttention: boolean = false

  @Property({ name: 'attention_reason', type: 'text', nullable: true })
  attentionReason?: MetaAttentionReason | null

  @Property({
    name: 'field_mapping',
    type: 'json',
    default: DEFAULT_FIELD_MAPPING_SQL,
  })
  fieldMapping: MetaFieldMappingRow[] = DEFAULT_FIELD_MAPPING.map((row) => ({
    ...row,
  }))

  @Property({ name: 'create_deal', type: 'boolean', default: false })
  createDeal: boolean = false

  @Property({ name: 'pipeline_id', type: 'uuid', nullable: true })
  pipelineId?: string | null

  @Property({ name: 'pipeline_stage_id', type: 'uuid', nullable: true })
  pipelineStageId?: string | null

  @Property({ name: 'owner_mode', type: 'text', default: 'none' })
  ownerMode: MetaOwnerMode = 'none'

  @Property({ name: 'owner_user_id', type: 'uuid', nullable: true })
  ownerUserId?: string | null

  @Property({ name: 'owner_user_ids', type: 'json', default: '[]' })
  ownerUserIds: string[] = []

  @Property({ name: 'round_robin_cursor', type: 'integer', default: 0 })
  roundRobinCursor: number = 0

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

@Entity({ tableName: 'meta_lead_ads_lead_events' })
@Check({
  name: 'meta_lead_ads_lead_events_scope_chk',
  expression: `("tenant_id" is not null and "organization_id" is not null) or "status" = 'unrouted'`,
})
@Index({
  name: 'meta_lead_ads_lead_events_scope_idx',
  properties: ['tenantId', 'organizationId'],
})
@Unique({
  name: 'meta_lead_ads_lead_events_meta_lead_id_uq',
  properties: ['metaLeadId'],
})
@Index({
  name: 'meta_lead_ads_lead_events_org_status_created_idx',
  expression:
    'create index "meta_lead_ads_lead_events_org_status_created_idx" on "meta_lead_ads_lead_events" ("organization_id","status","created_at" desc)',
})
@Index({
  name: 'meta_lead_ads_lead_events_person_idx',
  properties: ['personId'],
})
@Index({
  name: 'meta_lead_ads_lead_events_form_submitted_idx',
  properties: ['formId', 'submittedAt'],
})
@Index({
  name: 'meta_lead_ads_lead_events_status_next_attempt_idx',
  properties: ['status', 'nextAttemptAt'],
})
@Index({
  name: 'meta_lead_ads_lead_events_meta_user_idx',
  expression:
    'create index "meta_lead_ads_lead_events_meta_user_idx" on "meta_lead_ads_lead_events" ("meta_user_id") where "meta_user_id" is not null',
})
export class MetaLeadEvent {
  [OptionalProps]?: 'status' | 'attemptCount' | 'manualRetryCount' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'meta_lead_id', type: 'text' })
  metaLeadId!: string

  @Property({ name: 'meta_page_id', type: 'text' })
  metaPageId!: string

  @Property({ name: 'page_id', type: 'uuid', nullable: true })
  pageId?: string | null

  @Property({ name: 'form_id', type: 'uuid', nullable: true })
  formId?: string | null

  @Property({ name: 'meta_form_id', type: 'text' })
  metaFormId!: string

  @Property({ name: 'ad_id', type: 'text', nullable: true })
  adId?: string | null

  @Property({ name: 'adset_id', type: 'text', nullable: true })
  adsetId?: string | null

  @Property({ name: 'campaign_id', type: 'text', nullable: true })
  campaignId?: string | null

  @Property({ name: 'ad_name', type: 'text', nullable: true })
  adName?: string | null

  @Property({ name: 'adset_name', type: 'text', nullable: true })
  adsetName?: string | null

  @Property({ name: 'campaign_name', type: 'text', nullable: true })
  campaignName?: string | null

  @Property({ name: 'platform', type: 'text', nullable: true })
  platform?: MetaPlatform | null

  @Property({ name: 'is_organic', type: 'boolean', nullable: true })
  isOrganic?: boolean | null

  @Property({ name: 'submitted_at', type: Date, nullable: true })
  submittedAt?: Date | null

  @Property({ name: 'source', type: 'text' })
  source!: MetaLeadEventSource

  @Property({ name: 'raw_notification', type: 'json', nullable: true })
  rawNotification?: Record<string, unknown> | null

  @Property({ name: 'raw_payload', type: 'json', nullable: true })
  rawPayload?: Record<string, unknown> | null

  @Property({ name: 'payload_purged_at', type: Date, nullable: true })
  payloadPurgedAt?: Date | null

  @Property({ name: 'status', type: 'text', default: 'received' })
  status: MetaLeadEventStatus = 'received'

  @Property({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount: number = 0

  @Property({ name: 'manual_retry_count', type: 'integer', default: 0 })
  manualRetryCount: number = 0

  @Property({ name: 'next_attempt_at', type: Date, nullable: true })
  nextAttemptAt?: Date | null

  @Property({ name: 'last_error_code', type: 'text', nullable: true })
  lastErrorCode?: MetaLeadErrorCode | null

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'person_id', type: 'uuid', nullable: true })
  personId?: string | null

  @Property({ name: 'company_id', type: 'uuid', nullable: true })
  companyId?: string | null

  @Property({ name: 'interaction_id', type: 'uuid', nullable: true })
  interactionId?: string | null

  @Property({ name: 'deal_id', type: 'uuid', nullable: true })
  dealId?: string | null

  @Property({ name: 'match_type', type: 'text', nullable: true })
  matchType?: MetaMatchType | null

  @Property({ name: 'email_hash', type: 'text', nullable: true })
  emailHash?: string | null

  @Property({ name: 'phone_hash', type: 'text', nullable: true })
  phoneHash?: string | null

  @Property({ name: 'meta_user_id', type: 'text', nullable: true })
  metaUserId?: string | null

  @Property({ name: 'processed_at', type: Date, nullable: true })
  processedAt?: Date | null

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

@Entity({ tableName: 'meta_lead_ads_person_keys' })
@Index({
  name: 'meta_lead_ads_person_keys_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Index({
  name: 'meta_lead_ads_person_keys_org_email_idx',
  expression:
    'create index "meta_lead_ads_person_keys_org_email_idx" on "meta_lead_ads_person_keys" ("organization_id","email_hash")',
})
@Index({
  name: 'meta_lead_ads_person_keys_org_phone_idx',
  expression:
    'create index "meta_lead_ads_person_keys_org_phone_idx" on "meta_lead_ads_person_keys" ("organization_id","phone_hash")',
})
@Index({
  name: 'meta_lead_ads_person_keys_org_person_uq',
  expression:
    'create unique index "meta_lead_ads_person_keys_org_person_uq" on "meta_lead_ads_person_keys" ("organization_id","person_id") where deleted_at is null',
})
export class MetaPersonKey {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'person_id', type: 'uuid' })
  personId!: string

  @Property({ name: 'email_hash', type: 'text', nullable: true })
  emailHash?: string | null

  @Property({ name: 'phone_hash', type: 'text', nullable: true })
  phoneHash?: string | null

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

@Entity({ tableName: 'meta_lead_ads_consents' })
@Index({
  name: 'meta_lead_ads_consents_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Unique({
  name: 'meta_lead_ads_consents_lead_key_uq',
  properties: ['leadEventId', 'consentKey'],
})
@Index({ name: 'meta_lead_ads_consents_person_idx', properties: ['personId'] })
export class MetaConsent {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'person_id', type: 'uuid' })
  personId!: string

  @Property({ name: 'lead_event_id', type: 'uuid' })
  leadEventId!: string

  @Property({ name: 'consent_key', type: 'text' })
  consentKey!: string

  @Property({ name: 'consent_text', type: 'text' })
  consentText!: string

  @Property({ name: 'given_at', type: Date })
  givenAt!: Date

  @Property({ name: 'is_checked', type: 'boolean' })
  isChecked!: boolean

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

@Entity({ tableName: 'meta_lead_ads_settings' })
@Check({
  name: 'meta_lead_ads_settings_retention_days_chk',
  expression: '"retention_days" between 1 and 365',
})
@Unique({
  name: 'meta_lead_ads_settings_scope_uq',
  properties: ['tenantId', 'organizationId'],
})
export class MetaSettings {
  [OptionalProps]?: 'retentionDays' | 'defaultCountry' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'retention_days', type: 'integer', default: 30 })
  retentionDays: number = 30

  @Property({ name: 'default_country', type: 'text', default: 'PL' })
  defaultCountry: string = 'PL'

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

@Entity({ tableName: 'meta_lead_ads_sync_runs' })
@Index({
  name: 'meta_lead_ads_sync_runs_tenant_org_idx',
  properties: ['tenantId', 'organizationId'],
})
@Index({
  name: 'meta_lead_ads_sync_runs_org_started_idx',
  expression:
    'create index "meta_lead_ads_sync_runs_org_started_idx" on "meta_lead_ads_sync_runs" ("organization_id","started_at" desc)',
})
@Index({ name: 'meta_lead_ads_sync_runs_status_idx', properties: ['status'] })
export class MetaSyncRun {
  [OptionalProps]?:
    | 'status'
    | 'checked'
    | 'imported'
    | 'duplicates'
    | 'failed'
    | 'startedAt'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'kind', type: 'text' })
  kind!: MetaSyncRunKind

  @Property({ name: 'form_id', type: 'uuid', nullable: true })
  formId?: string | null

  @Property({ name: 'range_from', type: Date })
  rangeFrom!: Date

  @Property({ name: 'range_to', type: Date })
  rangeTo!: Date

  @Property({ name: 'status', type: 'text', default: 'running' })
  status: MetaSyncRunStatus = 'running'

  @Property({ name: 'checked', type: 'integer', default: 0 })
  checked: number = 0

  @Property({ name: 'imported', type: 'integer', default: 0 })
  imported: number = 0

  @Property({ name: 'duplicates', type: 'integer', default: 0 })
  duplicates: number = 0

  @Property({ name: 'failed', type: 'integer', default: 0 })
  failed: number = 0

  @Property({ name: 'progress_job_id', type: 'uuid', nullable: true })
  progressJobId?: string | null

  @Property({ name: 'error', type: 'text', nullable: true })
  error?: string | null

  @Property({ name: 'started_at', type: Date, onCreate: () => new Date() })
  startedAt: Date = new Date()

  @Property({ name: 'finished_at', type: Date, nullable: true })
  finishedAt?: Date | null

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

@Entity({ tableName: 'meta_lead_ads_deletion_requests' })
@Index({
  name: 'meta_lead_ads_deletion_requests_scope_idx',
  properties: ['tenantId', 'organizationId'],
})
@Unique({
  name: 'meta_lead_ads_deletion_requests_code_uq',
  properties: ['confirmationCode'],
})
@Index({
  name: 'meta_lead_ads_deletion_requests_meta_user_idx',
  properties: ['metaUserId'],
})
export class MetaDeletionRequest {
  [OptionalProps]?: 'status' | 'purgedCount' | 'createdAt' | 'updatedAt' | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string | null

  @Property({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId?: string | null

  @Property({ name: 'confirmation_code', type: 'text' })
  confirmationCode!: string

  @Property({ name: 'meta_user_id', type: 'text' })
  metaUserId!: string

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: MetaDeletionRequestStatus = 'pending'

  @Property({ name: 'purged_count', type: 'integer', default: 0 })
  purgedCount: number = 0

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
