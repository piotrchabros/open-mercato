import { createModuleEvents } from '@open-mercato/shared/modules/events'
import type { CalcomUnassignedTranscriptReason } from './data/entities'

const events = [
  {
    id: 'webhook_calcom.unassigned_transcript.created',
    label: 'Unassigned Cal.com Transcript Created',
    entity: 'unassigned_transcript',
    category: 'lifecycle' as const,
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text' as const },
        { path: 'tenantId', type: 'text' as const },
        { path: 'organizationId', type: 'text' as const },
        { path: 'transcriptId', type: 'text' as const },
        { path: 'reason', type: 'select' as const },
      ],
    },
  },
  {
    id: 'webhook_calcom.unassigned_transcript.resolved',
    label: 'Unassigned Cal.com Transcript Resolved',
    entity: 'unassigned_transcript',
    category: 'lifecycle' as const,
    payloadSchema: {
      fields: [
        { path: 'id', type: 'text' as const },
        { path: 'tenantId', type: 'text' as const },
        { path: 'organizationId', type: 'text' as const },
        { path: 'transcriptId', type: 'text' as const },
        { path: 'resolvedEntityId', type: 'text' as const },
      ],
    },
  },
] as const

export type CalcomUnassignedTranscriptCreatedPayload = {
  id: string
  tenantId: string
  organizationId: string
  transcriptId: string
  reason: CalcomUnassignedTranscriptReason
}

export type CalcomUnassignedTranscriptResolvedPayload = {
  id: string
  tenantId: string
  organizationId: string
  transcriptId: string
  resolvedEntityId: string
}

export const eventsConfig = createModuleEvents({ moduleId: 'webhook_calcom', events })
export const emitWebhookCalcomEvent = eventsConfig.emit
export type WebhookCalcomEventId = typeof events[number]['id']
export default eventsConfig
