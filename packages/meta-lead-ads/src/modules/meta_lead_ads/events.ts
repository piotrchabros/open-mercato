import { createModuleEvents } from '@open-mercato/shared/modules/events'

export const META_LEAD_ADS_EVENTS = {
  leadReceived: 'meta_lead_ads.lead.received',
  leadFailed: 'meta_lead_ads.lead.failed',
  leadDeadLettered: 'meta_lead_ads.lead.dead_lettered',
  pageStatusChanged: 'meta_lead_ads.page.status_changed',
  connectionTokenInvalid: 'meta_lead_ads.connection.token_invalid',
} as const

export const events = [
  {
    id: 'meta_lead_ads.lead.received',
    label: 'Meta Lead Received',
    entity: 'lead_event',
    category: 'custom',
    clientBroadcast: true,
  },
  {
    id: 'meta_lead_ads.lead.failed',
    label: 'Meta Lead Failed',
    entity: 'lead_event',
    category: 'custom',
    clientBroadcast: true,
  },
  {
    id: 'meta_lead_ads.lead.dead_lettered',
    label: 'Meta Lead Dead-Lettered',
    entity: 'lead_event',
    category: 'custom',
    clientBroadcast: true,
  },
  {
    id: 'meta_lead_ads.page.status_changed',
    label: 'Meta Page Status Changed',
    entity: 'page',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'meta_lead_ads.connection.token_invalid',
    label: 'Meta Connection Token Invalid',
    entity: 'connection',
    category: 'lifecycle',
    clientBroadcast: true,
  },
] as const

export type LeadReceivedPayload = {
  leadEventId: string
  metaLeadId: string
  tenantId: string
  organizationId: string
  personId: string | null
  companyId: string | null
  interactionId: string | null
  dealId: string | null
  formId: string
  metaFormId: string
  pageId: string
  campaignId: string | null
  adId: string | null
  platform: 'fb' | 'ig' | null
  isOrganic: boolean
  submittedAt: string
  matchType: 'email' | 'phone' | 'none' | 'created'
  ownerUserId: string | null
}

export type LeadFailedPayload = {
  leadEventId: string
  metaLeadId: string
  tenantId: string
  organizationId: string
  formId: string | null
  pageId: string | null
  errorCode: string
  attemptCount: number
  manualRetryCount: number
}

export type LeadDeadLetteredPayload = {
  leadEventId: string
  metaLeadId: string
  tenantId: string
  organizationId: string
  formId: string | null
  pageId: string | null
  errorCode: string
  attemptCount: number
  firstFailedAt: string
  lastFailedAt: string
}

export type PageStatusChangedPayload = {
  pageId: string
  metaPageId: string
  tenantId: string
  organizationId: string
  connectionId: string
  previousStatus: string
  status: string
  checkedAt: string
}

export type ConnectionTokenInvalidPayload = {
  connectionId: string
  metaUserId: string
  tenantId: string
  organizationId: string
  previousStatus: string
  status: string
  reason: 'expired' | 'revoked' | 'password_changed' | 'unknown'
  detectedAt: string
}

export const eventsConfig = createModuleEvents({ moduleId: 'meta_lead_ads', events })
export const emitMetaLeadAdsEvent = eventsConfig.emit
export type MetaLeadAdsEventId = (typeof events)[number]['id']

export default eventsConfig
