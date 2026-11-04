export type ConnectionStatus = 'active' | 'token_expired' | 'invalid' | 'disconnected'
export type PageSubscriptionStatus = 'active' | 'missing_permissions' | 'token_expired' | 'no_leads_access' | 'unsubscribed'
export type LeadEventStatus =
  | 'received'
  | 'processing'
  | 'processed'
  | 'duplicate'
  | 'skipped'
  | 'retrying'
  | 'failed'
  | 'dead_lettered'
  | 'unrouted'
export type LeadEventSource = 'webhook' | 'backfill' | 'reconciliation' | 'test'
export type MatchType = 'email' | 'phone' | 'none' | 'created'
export type OwnerMode = 'none' | 'fixed' | 'round_robin'
export type AttentionReason = 'questions_changed' | 'deal_step_failed' | 'owner_unavailable' | 'form_archived'
export type SyncRunKind = 'backfill' | 'reconciliation'
export type SyncRunStatus = 'running' | 'completed' | 'failed'
export type LeadErrorCode =
  | 'token_invalid'
  | 'no_leads_access'
  | 'page_unassigned'
  | 'form_disabled'
  | 'form_missing'
  | 'validation'
  | 'graph_transient'
  | 'graph_rate_limited'
  | 'network'
  | 'deal_step_failed'
  | 'unknown'

export type PagedResponse<T> = {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export type ConnectionDto = {
  id: string
  metaUserId: string
  metaUserName: string | null
  status: ConnectionStatus
  grantedScopes: string[]
  tokenExpiresAt: string | null
  lastHealthCheckAt: string | null
  lastError: string | null
  pageCount: number
  connectedByUserId: string | null
  createdAt: string
  updatedAt: string
}

export type PageDto = {
  id: string
  connectionId: string
  metaPageId: string
  name: string
  subscriptionStatus: PageSubscriptionStatus
  statusCheckedAt: string | null
  lastError: string | null
  formCount: number
  createdAt: string
  updatedAt: string
}

export type AvailablePageDto = {
  metaPageId: string
  name: string
  assignedOrganizationId: string | null
  assignedConnectionId: string | null
  assignable: boolean
  assignedElsewhere?: boolean
}

export type FormQuestionDto = {
  key: string
  label: string
  type: string
  options?: string[]
}

export type FieldMappingEntryDto = {
  questionKey: string
  target: string
}

export type FormDto = {
  id: string
  pageId: string
  metaFormId: string
  name: string
  locale: string | null
  isEnabled: boolean
  questions: FormQuestionDto[]
  questionsFingerprint: string | null
  needsAttention: boolean
  attentionReason: AttentionReason | null
  fieldMapping: FieldMappingEntryDto[]
  createDeal: boolean
  pipelineId: string | null
  pipelineStageId: string | null
  ownerMode: OwnerMode
  ownerUserId: string | null
  ownerUserIds: string[]
  createdAt: string
  updatedAt: string
}

export type FormUpdateInput = {
  id: string
  isEnabled?: boolean
  fieldMapping?: FieldMappingEntryDto[]
  createDeal?: boolean
  pipelineId?: string | null
  pipelineStageId?: string | null
  ownerMode?: OwnerMode
  ownerUserId?: string | null
  ownerUserIds?: string[]
  acknowledgeAttention?: boolean
}

export type LeadEventSummaryDto = {
  id: string
  metaLeadId: string
  pageId: string | null
  pageName: string | null
  formId: string | null
  formName: string | null
  source: LeadEventSource
  status: LeadEventStatus
  platform: string | null
  isOrganic: boolean | null
  campaignName: string | null
  submittedAt: string | null
  receivedAt: string
  processedAt: string | null
  attemptCount: number
  manualRetryCount: number
  nextAttemptAt: string | null
  lastErrorCode: LeadErrorCode | null
  lastError: string | null
  personId: string | null
  companyId: string | null
  interactionId: string | null
  dealId: string | null
  matchType: MatchType | null
  payloadPurgedAt: string | null
}

export type LeadAnswerDto = {
  name: string
  values: string[]
  target: string | null
}

export type LeadConsentDto = {
  consentKey: string
  consentText: string | null
  isChecked: boolean
  givenAt: string | null
}

export type LeadAttemptDto = {
  at: string
  errorCode: LeadErrorCode | null
  error: string | null
}

export type LeadEventDetailDto = LeadEventSummaryDto & {
  adId: string | null
  adsetId: string | null
  campaignId: string | null
  adName: string | null
  adsetName: string | null
  metaFormId: string | null
  metaPageId: string | null
  answers?: LeadAnswerDto[] | null
  consents?: LeadConsentDto[]
  payloadPurged?: boolean
  attempts: LeadAttemptDto[]
}

export type RetryResponse = {
  enqueued: number
  skipped: { id: string; reason: 'not_retryable' | 'not_found' }[]
}

export type BackfillInput = {
  formId: string
  from: string
  to: string
}

export type BackfillResponse = {
  runId: string
  progressJobId: string | null
}

export type SyncRunDto = {
  id: string
  kind: SyncRunKind
  formId: string | null
  formName: string | null
  rangeFrom: string | null
  rangeTo: string | null
  status: SyncRunStatus
  checked: number
  imported: number
  duplicates: number
  failed: number
  progressJobId: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  createdAt: string
}

export type SettingsDto = {
  id: string | null
  retentionDays: number
  defaultCountry: string
  updatedAt: string | null
}

export type SettingsInput = {
  retentionDays: number
  defaultCountry: string
}

export type PersonSubmissionDto = {
  leadEventId: string
  submittedAt: string | null
  formId: string | null
  formName: string | null
  campaignName: string | null
  adsetName: string | null
  adName: string | null
  platform: string | null
  isOrganic: boolean | null
  status: LeadEventStatus
  matchType: MatchType | null
  interactionId: string | null
  dealId: string | null
}

export type PersonConsentDto = LeadConsentDto & {
  leadEventId: string
}

export type SubmissionsResponse = {
  items: PersonSubmissionDto[]
  consents: PersonConsentDto[]
}

export type PageAssignInput = {
  connectionId: string
  metaPageId: string
  organizationId: string
}

export type PageCheckResponse = {
  id: string
  subscriptionStatus: PageSubscriptionStatus
  statusCheckedAt: string | null
  lastError: string | null
  updatedAt: string
}

export type SyncFormsResponse = {
  created: number
  updated: number
  flagged: number
  total: number
}

export type DisconnectResponse = {
  ok: true
  unsubscribedPages: number
}

export type TestLeadResponse = {
  leadEventId: string
}
