import type { ApiVersionDefinition } from '@open-mercato/shared/modules/integrations/types'

export const MODULE_ID = 'meta_lead_ads'
export const INTEGRATION_ID = 'meta_lead_ads'
export const OAUTH_PROVIDER_KEY = 'meta'

export const WEBHOOK_PATH = '/api/meta_lead_ads/webhook'
export const OAUTH_CALLBACK_PATH = '/api/meta_lead_ads/oauth/callback'
export const DATA_DELETION_PATH = '/api/meta_lead_ads/data-deletion'
export const BACKEND_PATH = '/backend/meta-lead-ads'

export const OAUTH_STATE_COOKIE = 'meta_lead_ads_oauth_state'

export const META_GRAPH_API_VERSION_DEFAULT = 'v24.0'
export const META_GRAPH_API_VERSION =
  process.env.OM_META_LEAD_ADS_GRAPH_VERSION?.trim() || META_GRAPH_API_VERSION_DEFAULT

export function resolveGraphApiVersion(credentialsVersion?: string | null): string {
  const fromCredentials = credentialsVersion?.trim()
  if (fromCredentials) return fromCredentials
  return META_GRAPH_API_VERSION
}

export const META_GRAPH_API_VERSIONS: ApiVersionDefinition[] = [
  {
    id: 'v22.0',
    label: 'Graph API v22.0',
    status: 'deprecated',
    deprecatedAt: '2026-01-21T00:00:00.000Z',
    sunsetAt: '2027-02-21T00:00:00.000Z',
  },
  {
    id: 'v23.0',
    label: 'Graph API v23.0',
    status: 'stable',
    sunsetAt: '2027-05-29T00:00:00.000Z',
  },
  {
    id: 'v24.0',
    label: 'Graph API v24.0',
    status: 'stable',
    default: true,
    sunsetAt: '2028-10-08T00:00:00.000Z',
  },
]

export const GRAPH_DEFAULT_BASE_URL = 'https://graph.facebook.com'
export const META_DIALOG_BASE_URL = 'https://www.facebook.com'
export const GRAPH_LEAD_FIELDS =
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,field_data'
export const GRAPH_TIMEOUT_MS = 10_000

export const QUEUES = {
  process: 'meta-lead-ads-process',
  backfill: 'meta-lead-ads-backfill',
  reconcile: 'meta-lead-ads-reconcile',
  tokenHealth: 'meta-lead-ads-token-health',
  retentionPurge: 'meta-lead-ads-retention-purge',
} as const

export const WORKER_IDS = {
  process: 'meta_lead_ads:process-lead',
  backfill: 'meta_lead_ads:backfill',
  reconcile: 'meta_lead_ads:reconcile',
  tokenHealth: 'meta_lead_ads:token-health',
  retentionPurge: 'meta_lead_ads:retention-purge',
} as const

export const SCHEDULES = {
  reconcile: '0 2 * * *',
  tokenHealth: '0 6 * * *',
  retentionPurge: '30 3 * * *',
} as const

export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 2_400_000] as const
export const MAX_AUTOMATIC_ATTEMPTS = 5
export const FETCH_FAILED_ALERT_ATTEMPT = 3

export const STUCK_EVENT_MS = 2 * 60 * 60 * 1000
export const RECONCILE_WINDOW_MS = 48 * 60 * 60 * 1000
export const BACKFILL_MAX_RANGE_DAYS = 90
export const GRAPH_PAGE_LIMIT = 100
export const PURGE_BATCH = 500
export const DEDUP_SCAN_LIMIT = 500

export const INTERACTION_BODY_MAX = 10_000
export const FIELD_MAPPING_MAX = 200
export const OWNER_USER_IDS_MAX = 50

export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_COUNTRY = 'PL'
export const API_VERSION_ALERT_DAYS = 90

export const INTERACTION_ID_NAMESPACE = '3b7e9c1a-4d2f-4e8b-9a6c-5f0d1e2c3b4a'
export const INTERACTION_TYPE = 'meta_lead'
export const CRM_SOURCE = 'meta_lead_ads'
export const EXTERNAL_ENTITY_TYPES = {
  person: 'customers.person',
  company: 'customers.company',
  deal: 'customers.deal',
} as const

export const REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'leads_retrieval',
] as const

export const RATE_LIMITS = {
  webhookGet: 120,
  webhookPost: 600,
  dataDeletion: 60,
} as const

export const CONNECTION_STATUSES = ['active', 'token_expired', 'invalid', 'disconnected'] as const
export type MetaConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const PAGE_SUBSCRIPTION_STATUSES = [
  'active',
  'missing_permissions',
  'token_expired',
  'no_leads_access',
  'unsubscribed',
] as const
export type MetaPageSubscriptionStatus = (typeof PAGE_SUBSCRIPTION_STATUSES)[number]

export const LEAD_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'duplicate',
  'skipped',
  'retrying',
  'failed',
  'dead_lettered',
  'unrouted',
] as const
export type MetaLeadEventStatus = (typeof LEAD_EVENT_STATUSES)[number]

export const LEAD_EVENT_SOURCES = ['webhook', 'backfill', 'reconciliation', 'test'] as const
export type MetaLeadEventSource = (typeof LEAD_EVENT_SOURCES)[number]

export const MATCH_TYPES = ['email', 'phone', 'none', 'created'] as const
export type MetaMatchType = (typeof MATCH_TYPES)[number]

export const OWNER_MODES = ['none', 'fixed', 'round_robin'] as const
export type MetaOwnerMode = (typeof OWNER_MODES)[number]

export const ATTENTION_REASONS = [
  'questions_changed',
  'deal_step_failed',
  'owner_unavailable',
  'form_archived',
] as const
export type MetaAttentionReason = (typeof ATTENTION_REASONS)[number]

export const SYNC_RUN_KINDS = ['backfill', 'reconciliation'] as const
export type MetaSyncRunKind = (typeof SYNC_RUN_KINDS)[number]

export const SYNC_RUN_STATUSES = ['running', 'completed', 'failed'] as const
export type MetaSyncRunStatus = (typeof SYNC_RUN_STATUSES)[number]

export const DELETION_REQUEST_STATUSES = ['pending', 'completed'] as const
export type MetaDeletionRequestStatus = (typeof DELETION_REQUEST_STATUSES)[number]

export const PLATFORMS = ['fb', 'ig'] as const
export type MetaPlatform = (typeof PLATFORMS)[number]

export const LEAD_ERROR_CODES = [
  'token_invalid',
  'no_leads_access',
  'page_unassigned',
  'form_disabled',
  'form_missing',
  'validation',
  'graph_transient',
  'graph_rate_limited',
  'network',
  'deal_step_failed',
  'unknown',
] as const
export type MetaLeadErrorCode = (typeof LEAD_ERROR_CODES)[number]

export const CONNECT_FAILURE_CODES = [
  'state_mismatch',
  'access_denied',
  'exchange_failed',
  'missing_scopes',
  'app_not_configured',
] as const
export type MetaConnectFailureCode = (typeof CONNECT_FAILURE_CODES)[number]

export const API_ERROR_CODES = [
  'validation_error',
  'not_found',
  'organization_scope_required',
  'verify_token_mismatch',
  'invalid_signature',
  'payload_too_large',
  'invalid_signed_request',
  'app_not_configured',
  'connection_unusable',
  'graph_error',
  'page_already_assigned',
  'organization_not_visible',
  'page_not_active',
  'form_disabled',
  'backfill_already_running',
  'optimistic_lock_conflict',
  'rate_limited',
] as const
export type MetaApiErrorCode = (typeof API_ERROR_CODES)[number]

export type MetaScope = { tenantId: string; organizationId: string }
