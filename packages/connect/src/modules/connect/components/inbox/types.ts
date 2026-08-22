/**
 * Wire shapes for the Connect Inbox.
 *
 * None of these carry message content beyond what the thread endpoint returns:
 * the list and detail projections expose a masked display label, never the
 * customer's subject or body.
 */

export type ConnectCaseStatus = 'new' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed'
export type ConnectCasePriority = 'low' | 'normal' | 'high' | 'urgent'

export type InboxCaseRow = {
  id: string
  number: number
  displayLabel: string | null
  status: ConnectCaseStatus
  priority: ConnectCasePriority
  assigneeUserId: string | null
  customerId: string | null
  lastInboundAt: string | null
  unread: boolean
  updatedAt: string
}

export type InboxListResponse = {
  items?: InboxCaseRow[]
  total?: number
  page?: number
  pageSize?: number
}

export type ThreadAttachment = {
  fileName: string
  mimeType: string
  fileSize: number | null
}

export type ThreadItem =
  | {
      kind: 'message'
      id: string
      externalConversationId: string
      direction: 'inbound' | 'outbound'
      text: string
      truncated: boolean
      attachments: ThreadAttachment[]
      deliveryStatus: string
      channelType: string
      occurredAt: string
    }
  | {
      kind: 'unavailable'
      id: string
      externalConversationId: string
      code: 'content_unavailable'
      retryable: boolean
      occurredAt: string
    }

export type ThreadResponse = {
  items?: ThreadItem[]
  nextCursor?: string | null
  accessEpoch?: string
  binding?: 'bound' | 'missing'
}

/** Delivery states an agent sees. `unknown` deliberately disables retry. */
export type OutboundStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown'

export type ComposerSubmission = {
  messageId: string
  attemptId: string
  status: 'queued'
  duplicate: boolean
  maskedRecipientLabel: string | null
}

export type InboxFilter = 'triage' | 'mine' | 'unassigned' | 'all'
