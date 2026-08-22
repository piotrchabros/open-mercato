import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

/**
 * Mercato Connect data model — the Case aggregate and inbound ingest state.
 *
 * `communication_channels` stores transport conversations; Connect needs a
 * separate aggregate with ownership and lifecycle semantics. Two rules shape
 * every entity here:
 *
 *   1. **Every row is organization-scoped, never tenant-wide.** The vertical
 *      spike proved a nullable-organization Case is a CRUD visibility black
 *      hole: ordinary listings cannot safely expose it, and every candidate
 *      predicate loses half its isolation. The owning channel's non-null
 *      `organization_id` is copied onto every row and is an authorization
 *      predicate, not a label.
 *   2. **No cross-module ORM relationships.** Peer identifiers
 *      (`external_conversation_id`, `channel_id`, `customer_id`) are plain
 *      columns; Connect never imports peer entities or queries peer tables.
 */

// ── Case ──────────────────────────────────────────────────────

/**
 * Case lifecycle states. `closed` is terminal: a later inbound opens a
 * successor Case carrying `previousCaseId` rather than reviving it, so a
 * customer's history stays an append-only chain.
 */
export type ConnectCaseStatus =
  | 'new'
  | 'in_progress'
  | 'waiting_customer'
  | 'resolved'
  | 'closed'

export type ConnectCasePriority = 'low' | 'normal' | 'high' | 'urgent'

export type ConnectPrincipalKind = 'human' | 'system_bot' | 'integration'

@Entity({ tableName: 'connect_principal_classifications' })
@Unique({
  name: 'connect_principal_classifications_scope_user_uq',
  properties: ['tenantId', 'organizationId', 'userId'],
})
@Index({
  name: 'connect_principal_classifications_scope_user_idx',
  properties: ['tenantId', 'organizationId', 'userId'],
})
@Check({
  name: 'connect_principal_classifications_kind_chk',
  expression: `"kind" in ('human', 'system_bot', 'integration')`,
})
export class ConnectPrincipalClassification {
  [OptionalProps]?: 'createdAt' | 'updatedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'kind', type: 'text' })
  kind!: ConnectPrincipalKind

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

@Entity({ tableName: 'connect_cases' })
@Unique({ name: 'connect_cases_number_uq', properties: ['tenantId', 'organizationId', 'number'] })
// The attach rule enumerates eligible legacy candidates by
// (tenant, organization, customer) ordered by last inbound — index exactly that.
@Index({
  name: 'connect_cases_candidate_idx',
  properties: ['tenantId', 'organizationId', 'customerId', 'status', 'lastInboundAt'],
})
@Index({
  name: 'connect_cases_assignee_idx',
  properties: ['tenantId', 'organizationId', 'assigneeUserId', 'status'],
})
@Check({
  name: 'connect_cases_status_chk',
  expression: `"status" in ('new', 'in_progress', 'waiting_customer', 'resolved', 'closed')`,
})
@Check({
  name: 'connect_cases_priority_chk',
  expression: `"priority" in ('low', 'normal', 'high', 'urgent')`,
})
export class ConnectCase {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'
    | 'status'
    | 'priority'
    | 'subject'
    | 'displayLabel'
    | 'assigneeUserId'
    | 'customerKind'
    | 'customerId'
    | 'firstInboundAt'
    | 'lastInboundAt'
    | 'resolvedAt'
    | 'closedAt'
    | 'wrapUp'
    | 'previousCaseId'
    | 'firstAssignedAt'
    | 'firstOutboundSentAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** Copied from the owning shared channel. NOT NULL by construction. */
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Human-facing per-organization sequence number. */
  @Property({ name: 'number', type: 'int' })
  number!: number

  /**
   * Encrypted at rest (`data/encryption.ts`). Excluded from search documents,
   * logs and analytics, and erased by retention — an email subject routinely
   * contains the customer's own words about their problem.
   */
  @Property({ name: 'subject', type: 'text', nullable: true })
  subject?: string | null

  /**
   * Source-minimized non-PII label safe for lists, search and logs, e.g. a
   * masked handle. Never derived from the subject or body.
   */
  @Property({ name: 'display_label', type: 'text', nullable: true })
  displayLabel?: string | null

  @Property({ name: 'status', type: 'text', default: 'new' })
  status: ConnectCaseStatus = 'new'

  @Property({ name: 'priority', type: 'text', default: 'normal' })
  priority: ConnectCasePriority = 'normal'

  /** Logical link to auth.user.id (no DB FK — cross-module). */
  @Property({ name: 'assignee_user_id', type: 'uuid', nullable: true })
  assigneeUserId?: string | null

  /** Logical link to customers.customer_entity (kind + id, no DB FK). */
  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: 'person' | 'company' | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** Owning shared channel. Logical link to communication_channels.id. */
  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'first_inbound_at', type: Date, nullable: true })
  firstInboundAt?: Date | null

  @Property({ name: 'last_inbound_at', type: Date, nullable: true })
  lastInboundAt?: Date | null

  /**
   * When this Case was FIRST picked up. Never overwritten by a later transfer,
   * because the operator question is "how long until someone owned this", and a
   * reassignment three hours in must not reset that to zero.
   */
  @Property({ name: 'first_assigned_at', type: Date, nullable: true })
  firstAssignedAt?: Date | null

  /**
   * When the first outbound reply was CONFIRMED sent. Queued and failed
   * attempts do not count — a first-response metric that fires on enqueue
   * measures how fast an agent typed, not when the customer heard back.
   */
  @Property({ name: 'first_outbound_sent_at', type: Date, nullable: true })
  firstOutboundSentAt?: Date | null

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'closed_at', type: Date, nullable: true })
  closedAt?: Date | null

  /** Encrypted at rest — an agent's wrap-up note describes the customer. */
  @Property({ name: 'wrap_up', type: 'text', nullable: true })
  wrapUp?: string | null

  /** Set on a successor Case opened after its predecessor closed. */
  @Property({ name: 'previous_case_id', type: 'uuid', nullable: true })
  previousCaseId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  /** Optimistic-lock version. Returned as `updatedAt` by every Case API. */
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

// ── Conversation ──────────────────────────────────────────────

/**
 * One row per hub conversation.
 *
 * `externalConversationId` is the hub-owned `ExternalConversation.id` carried by
 * `communication_channels.message.received` as `conversationId`. It is NOT the
 * provider's thread ref and NOT the command return field
 * `externalConversationId` — substituting either would bind Connect to a key the
 * event does not actually publish.
 */
@Entity({ tableName: 'connect_conversations' })
@Unique({
  name: 'connect_conversations_external_uq',
  properties: ['tenantId', 'organizationId', 'externalConversationId'],
})
@Index({ name: 'connect_conversations_case_idx', properties: ['tenantId', 'currentCaseId'] })
export class ConnectConversation {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'currentCaseId'
    | 'lastExternalMessageId'
    | 'lastMessageAt'
    | 'replyTargetRef'
    | 'replyTargetMaskedLabel'
    | 'replyTargetSourceVersion'
    | 'replyTargetMessageId'
    | 'replyTargetExternalMessageId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** `communication_channels.external_conversations.id`. */
  @Property({ name: 'external_conversation_id', type: 'uuid' })
  externalConversationId!: string

  @Property({ name: 'current_case_id', type: 'uuid', nullable: true })
  currentCaseId?: string | null

  @Property({ name: 'last_external_message_id', type: 'uuid', nullable: true })
  lastExternalMessageId?: string | null

  @Property({ name: 'last_message_at', type: Date, nullable: true })
  lastMessageAt?: Date | null

  /**
   * Latest source-issued opaque reply-target reference (Contract D) plus its
   * masked label and provenance. Only a NEWER accepted inbound for this
   * conversation may replace it, so a late-arriving older message cannot
   * re-point replies at a stale address.
   *
   * The reference carries no address; resolution happens at send time.
   */
  @Property({ name: 'reply_target_ref', type: 'text', nullable: true })
  replyTargetRef?: string | null

  @Property({ name: 'reply_target_masked_label', type: 'text', nullable: true })
  replyTargetMaskedLabel?: string | null

  @Property({ name: 'reply_target_source_version', type: 'int', nullable: true })
  replyTargetSourceVersion?: number | null

  /** Exact provenance of the reference: which message issued it. */
  @Property({ name: 'reply_target_message_id', type: 'uuid', nullable: true })
  replyTargetMessageId?: string | null

  @Property({ name: 'reply_target_external_message_id', type: 'uuid', nullable: true })
  replyTargetExternalMessageId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Append-only conversation-to-Case intervals.
 *
 * A conversation can move between Cases (a closed Case's successor, an agent
 * transfer). Overwriting `currentCaseId` alone would lose which Case a given
 * message belonged to at the time, so the interval history is kept beside it.
 */
@Entity({ tableName: 'connect_conversation_case_bindings' })
@Index({
  name: 'connect_conversation_case_bindings_conv_idx',
  properties: ['tenantId', 'conversationId', 'boundAt'],
})
@Index({
  name: 'connect_conversation_case_bindings_case_idx',
  properties: ['tenantId', 'caseId'],
})
export class ConnectConversationCaseBinding {
  [OptionalProps]?: 'createdAt' | 'unboundAt' | 'reason'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'bound_at', type: Date })
  boundAt!: Date

  @Property({ name: 'unbound_at', type: Date, nullable: true })
  unboundAt?: Date | null

  @Property({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── Contact identity ──────────────────────────────────────────

export type ConnectIdentityLinkState = 'unresolved' | 'linked' | 'rejected'

/**
 * A contact handle seen on a channel, and what Connect believes it maps to.
 *
 * The handle VALUE is encrypted at rest and never appears in a search document.
 * Equality matching goes through `handleHash`, which is written even when
 * tenant data encryption is disabled — otherwise enabling encryption later
 * would silently make every existing identity invisible to lookup.
 */
@Entity({ tableName: 'connect_contact_identities' })
@Unique({
  name: 'connect_contact_identities_hash_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'handleHash'],
})
@Index({
  name: 'connect_contact_identities_customer_idx',
  properties: ['tenantId', 'organizationId', 'customerId'],
})
@Check({
  name: 'connect_contact_identities_link_state_chk',
  expression: `"link_state" in ('unresolved', 'linked', 'rejected')`,
})
export class ConnectContactIdentity {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'linkState'
    | 'customerKind'
    | 'customerId'
    | 'confidence'
    | 'matchMethod'
    | 'handleDisplayLabel'
    | 'associationEpoch'
    | 'unlinkPendingSagaId'
    | 'unlinkPendingEpoch'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  @Property({ name: 'handle_type', type: 'text' })
  handleType!: string

  /** Encrypted at rest. Never rendered into a search document. */
  @Property({ name: 'handle_value', type: 'text' })
  handleValue!: string

  /** Deterministic blind index. Always written; the only lookup path. */
  @Property({ name: 'handle_hash', type: 'text' })
  handleHash!: string

  /** Masked, non-PII label safe for lists and logs. */
  @Property({ name: 'handle_display_label', type: 'text', nullable: true })
  handleDisplayLabel?: string | null

  @Property({ name: 'link_state', type: 'text', default: 'unresolved' })
  linkState: ConnectIdentityLinkState = 'unresolved'

  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: 'person' | 'company' | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** 0–100 match confidence. */
  @Property({ name: 'confidence', type: 'int', nullable: true })
  confidence?: number | null

  @Property({ name: 'match_method', type: 'text', nullable: true })
  matchMethod?: string | null

  /**
   * Association epoch. Bumped on every link, so a projection created under one
   * link belongs to a retraction group a LATER link's unlink cannot reach.
   */
  @Property({ name: 'association_epoch', type: 'int', default: 0 })
  associationEpoch: number = 0

  /**
   * Unlink fence. While set, every ingest, link, resolve and projection writer
   * refuses under the shared identity lock — otherwise a projection admitted
   * mid-unlink would fall outside the inventory the saga already committed to,
   * and would survive the retraction it should have been part of.
   */
  @Property({ name: 'unlink_pending_saga_id', type: 'text', nullable: true })
  unlinkPendingSagaId?: string | null

  @Property({ name: 'unlink_pending_epoch', type: 'int', nullable: true })
  unlinkPendingEpoch?: number | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * The identity's current Case, and the row every writer serializes on.
 *
 * Ingest, link, unlink and resolve all lock this row before deciding anything,
 * so two inbound messages from the same person cannot both conclude "no active
 * Case" and open two.
 */
@Entity({ tableName: 'connect_identity_case_bindings' })
@Unique({
  name: 'connect_identity_case_bindings_identity_uq',
  properties: ['tenantId', 'organizationId', 'identityId'],
})
export class ConnectIdentityCaseBinding {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'currentCaseId' | 'version'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'current_case_id', type: 'uuid', nullable: true })
  currentCaseId?: string | null

  /** Monotonic provenance counter, bumped on every rebinding. */
  @Property({ name: 'version', type: 'int', default: 0 })
  version: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Case transitions ──────────────────────────────────────────

/** Append-only lifecycle audit. Written in the same transaction as the Case. */
@Entity({ tableName: 'connect_case_transitions' })
@Index({ name: 'connect_case_transitions_case_idx', properties: ['tenantId', 'caseId', 'createdAt'] })
export class ConnectCaseTransition {
  [OptionalProps]?: 'createdAt' | 'payload' | 'actorUserId' | 'fromStatus'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  /** `system` for ingest-driven transitions, `user` for agent commands. */
  @Property({ name: 'actor_kind', type: 'text' })
  actorKind!: 'system' | 'user'

  @Property({ name: 'actor_user_id', type: 'uuid', nullable: true })
  actorUserId?: string | null

  @Property({ name: 'from_status', type: 'text', nullable: true })
  fromStatus?: ConnectCaseStatus | null

  @Property({ name: 'to_status', type: 'text' })
  toStatus!: ConnectCaseStatus

  /** Non-PII context only — never the message subject or body. */
  @Property({ name: 'payload', type: 'json', nullable: true })
  payload?: Record<string, unknown> | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

// ── Inbound receipt ───────────────────────────────────────────

export type ConnectReceiptStatus = 'processing' | 'completed'
export type ConnectReceiptDisposition = 'opened' | 'attached' | 'suppressed' | 'dead_lettered'

/**
 * The idempotency record for one inbound event.
 *
 * Claimed by a UNIQUE INSERT before any non-idempotent work — no
 * read-then-create arbitration, because two deliveries racing that check would
 * both pass it. A duplicate delivery loses the insert, catches the unique
 * violation, looks up the winner and returns success.
 */
@Entity({ tableName: 'connect_inbound_receipts' })
@Unique({
  name: 'connect_inbound_receipts_message_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'externalMessageId'],
})
@Index({
  name: 'connect_inbound_receipts_sweep_idx',
  properties: ['tenantId', 'status', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_inbound_receipts_status_chk',
  expression: `"status" in ('processing', 'completed')`,
})
@Check({
  name: 'connect_inbound_receipts_disposition_chk',
  expression: `"disposition" is null or "disposition" in ('opened', 'attached', 'suppressed', 'dead_lettered')`,
})
// The state machine, expressed where it cannot be bypassed: a processing
// receipt has no disposition and no Case; a completed open/attach MUST name its
// Case; a suppressed or dead-lettered receipt must NOT, because nothing was
// created for it.
@Check({
  name: 'connect_inbound_receipts_shape_chk',
  expression:
    `("status" = 'processing' and "disposition" is null and "case_id" is null)
     or ("status" = 'completed' and "disposition" in ('opened', 'attached') and "case_id" is not null)
     or ("status" = 'completed' and "disposition" in ('suppressed', 'dead_lettered') and "case_id" is null)`,
})
export class ConnectInboundReceipt {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'disposition'
    | 'terminalReason'
    | 'caseId'
    | 'leaseExpiresAt'
    | 'attempts'
    | 'lastAttemptAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** `communication_channels.external_messages.id` from the event. */
  @Property({ name: 'external_message_id', type: 'uuid' })
  externalMessageId!: string

  /** Stable source event id, for tracing a receipt back to its delivery. */
  @Property({ name: 'source_event_id', type: 'text', nullable: true })
  sourceEventId?: string | null

  /**
   * UTC date the receipt was first claimed. Immutable, and the partition key
   * every operational metric counts by — deriving a cohort from `created_at`
   * later would shift historical numbers when a receipt is retried.
   */
  @Property({ name: 'claim_cohort_utc_date', type: 'date' })
  claimCohortUtcDate!: string

  @Property({ name: 'status', type: 'text', default: 'processing' })
  status: ConnectReceiptStatus = 'processing'

  @Property({ name: 'disposition', type: 'text', nullable: true })
  disposition?: ConnectReceiptDisposition | null

  @Property({ name: 'terminal_reason', type: 'text', nullable: true })
  terminalReason?: string | null

  @Property({ name: 'case_id', type: 'uuid', nullable: true })
  caseId?: string | null

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'last_attempt_at', type: Date, nullable: true })
  lastAttemptAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Suppression counter ───────────────────────────────────────

/**
 * Auto-responder / loop suppression, keyed by
 * `(tenant, organization, channel, from_handle_hash)`.
 *
 * Deliberately NOT keyed more broadly: a tenant- or organization-wide bucket
 * means one looping sender suppresses unrelated customers' mail, which is a
 * worse failure than the loop it prevents.
 */
@Entity({ tableName: 'connect_inbound_suppressions' })
@Unique({
  name: 'connect_inbound_suppressions_key_uq',
  properties: ['tenantId', 'organizationId', 'channelId', 'fromHandleHash', 'windowStartedAt'],
})
@Index({
  name: 'connect_inbound_suppressions_window_idx',
  properties: ['tenantId', 'windowStartedAt'],
})
export class ConnectInboundSuppression {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'hitCount' | 'lastExternalMessageId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Blind index of the sender handle — never the handle itself. */
  @Property({ name: 'from_handle_hash', type: 'text' })
  fromHandleHash!: string

  @Property({ name: 'window_started_at', type: Date })
  windowStartedAt!: Date

  @Property({ name: 'hit_count', type: 'int', default: 0 })
  hitCount: number = 0

  /** Makes each increment idempotent by external message id. */
  @Property({ name: 'last_external_message_id', type: 'uuid', nullable: true })
  lastExternalMessageId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Settings ──────────────────────────────────────────────────

/** Per-organization ingestion settings. One row per organization. */
@Entity({ tableName: 'connect_settings' })
@Unique({ name: 'connect_settings_scope_uq', properties: ['tenantId', 'organizationId'] })
@Check({
  name: 'connect_settings_windows_chk',
  expression: `"reopen_window_days" <= "auto_close_after_days"`,
})
export class ConnectSettings {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'attachWindowHours'
    | 'reopenWindowDays'
    | 'autoCloseAfterDays'
    | 'identityMatchThreshold'
    | 'suppressionCount'
    | 'suppressionWindowMinutes'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** How long an open Case keeps absorbing new inbound from the same identity. */
  @Property({ name: 'attach_window_hours', type: 'int', default: 72 })
  attachWindowHours: number = 72

  /** How long a resolved Case may be reopened instead of superseded. */
  @Property({ name: 'reopen_window_days', type: 'int', default: 7 })
  reopenWindowDays: number = 7

  /** How long a resolved Case waits before closing. Must be >= reopen window. */
  @Property({ name: 'auto_close_after_days', type: 'int', default: 14 })
  autoCloseAfterDays: number = 14

  /** 0–100. Below it, an identity stays unresolved rather than guessing. */
  @Property({ name: 'identity_match_threshold', type: 'int', default: 80 })
  identityMatchThreshold: number = 80

  @Property({ name: 'suppression_count', type: 'int', default: 3 })
  suppressionCount: number = 3

  @Property({ name: 'suppression_window_minutes', type: 'int', default: 60 })
  suppressionWindowMinutes: number = 60

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Domain outbox ─────────────────────────────────────────────

export type ConnectOutboxStatus = 'pending' | 'published'

/**
 * Transactional outbox for Connect domain events.
 *
 * Inserted in the SAME transaction as the domain mutation, so an event can
 * never describe a state that was rolled back, and a crash between commit and
 * publish loses nothing — the sweeper drains what the wake job missed.
 */
@Entity({ tableName: 'connect_domain_outbox' })
@Unique({ name: 'connect_domain_outbox_event_uq', properties: ['tenantId', 'sourceEventId'] })
@Index({
  name: 'connect_domain_outbox_pending_idx',
  properties: ['status', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_domain_outbox_status_chk',
  expression: `"status" in ('pending', 'published')`,
})
export class ConnectDomainOutboxEntry {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'leaseExpiresAt' | 'publishedAt' | 'attempts'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  /** Stable, caller-derived id. Makes publication idempotent across retries. */
  @Property({ name: 'source_event_id', type: 'text' })
  sourceEventId!: string

  @Property({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string

  @Property({ name: 'aggregate_version', type: 'int' })
  aggregateVersion!: number

  @Property({ name: 'event_type', type: 'text' })
  eventType!: string

  /** Identifier-only. Never message content. */
  @Property({ name: 'payload', type: 'json' })
  payload!: Record<string, unknown>

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ConnectOutboxStatus = 'pending'

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'published_at', type: Date, nullable: true })
  publishedAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Outbound (Inbox Operations) ───────────────────────────────

/**
 * The agent's reply, as a LOGICAL message.
 *
 * Separate from the attempts that try to deliver it, because a retry must not
 * duplicate the customer-visible message: one logical reply may have several
 * attempts, and the client command key is what makes a lost 202 resolvable
 * without sending twice.
 */
@Entity({ tableName: 'connect_outbound_messages' })
@Unique({
  name: 'connect_outbound_messages_command_uq',
  properties: ['tenantId', 'organizationId', 'caseId', 'clientCommandKey'],
})
@Index({ name: 'connect_outbound_messages_case_idx', properties: ['tenantId', 'caseId', 'createdAt'] })
export class ConnectOutboundMessage {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'maskedRecipientLabel' | 'erasedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'conversation_id', type: 'uuid' })
  conversationId!: string

  /**
   * Browser-generated, stable for the life of a draft. A lost 202 is retried
   * with the SAME key, which resolves to this row instead of enqueuing a second
   * customer reply.
   */
  @Property({ name: 'client_command_key', type: 'text' })
  clientCommandKey!: string

  /** Encrypted at rest — this is the agent's message to the customer. */
  @Property({ name: 'payload', type: 'text' })
  payload!: string

  /**
   * Hash of the submitted content. A response retry must carry the same
   * fingerprint; a different one under the same key means the draft changed,
   * which is a new message rather than a retry.
   */
  @Property({ name: 'payload_fingerprint', type: 'text' })
  payloadFingerprint!: string

  /** Opaque Contract D reference. Connect never stores a chosen address. */
  @Property({ name: 'reply_target_ref', type: 'text' })
  replyTargetRef!: string

  /** Masked label, safe to render. */
  @Property({ name: 'masked_recipient_label', type: 'text', nullable: true })
  maskedRecipientLabel?: string | null

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Set when retention erased the ciphertext; the row itself is kept. */
  @Property({ name: 'erased_at', type: Date, nullable: true })
  erasedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * Delivery states for one attempt.
 *
 * `unknown` is the state this whole design exists for: the provider may have
 * accepted the message and we cannot tell. It is NEVER automatically resent,
 * because a duplicate reply to a customer is worse than a delayed one.
 */
export type ConnectAttemptStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'unknown'

@Entity({ tableName: 'connect_outbound_attempts' })
@Index({ name: 'connect_outbound_attempts_message_idx', properties: ['tenantId', 'messageId'] })
@Index({ name: 'connect_outbound_attempts_status_idx', properties: ['tenantId', 'status', 'updatedAt'] })
@Unique({ name: 'connect_outbound_attempts_correlation_uq', properties: ['tenantId', 'hubCorrelationId'] })
// One child per predecessor: two operators clicking retry at once must not fork
// an attempt chain and send the customer two replies.
@Index({
  name: 'connect_outbound_attempts_predecessor_uq',
  expression:
    `create unique index "connect_outbound_attempts_predecessor_uq" on "connect_outbound_attempts" ("tenant_id", "predecessor_attempt_id") where "predecessor_attempt_id" is not null`,
})
@Check({
  name: 'connect_outbound_attempts_status_chk',
  expression: `"status" in ('queued', 'sending', 'sent', 'failed', 'unknown')`,
})
export class ConnectOutboundAttempt {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'predecessorAttemptId'
    | 'providerMessageId'
    | 'errorReason'
    | 'dispatchedAt'
    | 'settledAt'
    | 'deliveryRevision'
    | 'consumedByRetry'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'message_id', type: 'uuid' })
  messageId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  /** The attempt this one replaces. Only a FAILED attempt may have a child. */
  @Property({ name: 'predecessor_attempt_id', type: 'uuid', nullable: true })
  predecessorAttemptId?: string | null

  @Property({ name: 'attempt_number', type: 'int' })
  attemptNumber!: number

  /**
   * Immutable per attempt, generated BEFORE enqueue. Contract A binds it to the
   * attempt, so an outcome event that carries a different correlation cannot be
   * applied to this attempt.
   */
  @Property({ name: 'hub_correlation_id', type: 'text' })
  hubCorrelationId!: string

  @Property({ name: 'status', type: 'text', default: 'queued' })
  status: ConnectAttemptStatus = 'queued'

  @Property({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId?: string | null

  @Property({ name: 'error_reason', type: 'text', nullable: true })
  errorReason?: string | null

  /**
   * Highest delivery revision applied. Outcomes arrive out of order, so a lower
   * revision is ignored rather than allowed to regress a terminal decision.
   */
  @Property({ name: 'delivery_revision', type: 'int', default: 0 })
  deliveryRevision: number = 0

  @Property({ name: 'dispatched_at', type: Date, nullable: true })
  dispatchedAt?: Date | null

  @Property({ name: 'settled_at', type: Date, nullable: true })
  settledAt?: Date | null

  /** Set when a retry consumed this failed attempt, so it cannot be retried twice. */
  @Property({ name: 'consumed_by_retry', type: 'boolean', default: false })
  consumedByRetry: boolean = false

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type ConnectOutboxDispatchStatus = 'pending' | 'dispatched' | 'abandoned'

/**
 * The dispatch outbox row, written in the SAME transaction as the message and
 * its first attempt.
 *
 * That is what makes a crash between "202 returned" and "job enqueued"
 * recoverable: the durable row is the instruction, and the queue job is only an
 * optimisation.
 */
@Entity({ tableName: 'connect_outbox' })
@Unique({ name: 'connect_outbox_attempt_uq', properties: ['tenantId', 'attemptId'] })
@Index({ name: 'connect_outbox_pending_idx', properties: ['status', 'leaseExpiresAt'] })
@Check({
  name: 'connect_outbox_status_chk',
  expression: `"status" in ('pending', 'dispatched', 'abandoned')`,
})
export class ConnectOutbox {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'leaseExpiresAt' | 'dispatchedAt' | 'attempts'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'attempt_id', type: 'uuid' })
  attemptId!: string

  @Property({ name: 'payload_fingerprint', type: 'text' })
  payloadFingerprint!: string

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ConnectOutboxDispatchStatus = 'pending'

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'dispatched_at', type: Date, nullable: true })
  dispatchedAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/** Append-only record of who moved a Case between agents, and why. */
@Entity({ tableName: 'connect_assignment_audits' })
@Index({ name: 'connect_assignment_audits_case_idx', properties: ['tenantId', 'caseId', 'createdAt'] })
export class ConnectAssignmentAudit {
  [OptionalProps]?: 'createdAt' | 'fromAssigneeUserId' | 'toAssigneeUserId' | 'reason'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  @Property({ name: 'from_assignee_user_id', type: 'uuid', nullable: true })
  fromAssigneeUserId?: string | null

  @Property({ name: 'to_assignee_user_id', type: 'uuid', nullable: true })
  toAssigneeUserId?: string | null

  @Property({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * Per-user unread watermark.
 *
 * Per USER, not per Case: unread is a property of one agent's attention, so it
 * must not transfer with an assignment — a manager reassigning a Case should not
 * silently mark it read for the new owner.
 */
@Entity({ tableName: 'connect_case_read_states' })
@Unique({
  name: 'connect_case_read_states_user_uq',
  properties: ['tenantId', 'organizationId', 'caseId', 'userId'],
})
export class ConnectCaseReadState {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'lastReadAt' | 'lastReadExternalMessageId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'user_id', type: 'uuid' })
  userId!: string

  @Property({ name: 'last_read_at', type: Date, nullable: true })
  lastReadAt?: Date | null

  @Property({ name: 'last_read_external_message_id', type: 'uuid', nullable: true })
  lastReadExternalMessageId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

/**
 * An attempt whose outcome could not be determined, surfaced for a human.
 *
 * Phase 1 supports refresh and acknowledge ONLY — no force-sent / force-failed.
 * Asserting an outcome the provider never confirmed is exactly how a customer
 * gets a duplicate reply or a silently dropped one.
 */
@Entity({ tableName: 'connect_unknown_deliveries' })
@Unique({ name: 'connect_unknown_deliveries_attempt_uq', properties: ['tenantId', 'attemptId'] })
@Index({ name: 'connect_unknown_deliveries_open_idx', properties: ['tenantId', 'organizationId', 'acknowledgedAt'] })
export class ConnectUnknownDelivery {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'acknowledgedAt' | 'acknowledgedByUserId' | 'acknowledgeReason' | 'lookupSupported' | 'lastCheckedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'attempt_id', type: 'uuid' })
  attemptId!: string

  @Property({ name: 'channel_id', type: 'uuid' })
  channelId!: string

  /** Whether the provider can corroborate at all — drives the operator's options. */
  @Property({ name: 'lookup_supported', type: 'boolean', nullable: true })
  lookupSupported?: boolean | null

  @Property({ name: 'last_checked_at', type: Date, nullable: true })
  lastCheckedAt?: Date | null

  @Property({ name: 'acknowledged_at', type: Date, nullable: true })
  acknowledgedAt?: Date | null

  @Property({ name: 'acknowledged_by_user_id', type: 'uuid', nullable: true })
  acknowledgedByUserId?: string | null

  @Property({ name: 'acknowledge_reason', type: 'text', nullable: true })
  acknowledgeReason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Customer projection ───────────────────────────────────────

export type ConnectIdentityLinkAction = 'link' | 'unlink' | 'relink'

/**
 * Append-only record of every identity link change.
 *
 * The ONLY place a prior customer association survives an unlink. Clearing the
 * association elsewhere is what makes unlink actually remove exposure; keeping
 * the history here is what makes it auditable. Ordinary customer-context reads
 * never touch this table, so an agent cannot recover the old association from
 * the audit trail.
 */
@Entity({ tableName: 'connect_identity_link_audits' })
@Index({
  name: 'connect_identity_link_audits_identity_idx',
  properties: ['tenantId', 'identityId', 'createdAt'],
})
@Check({
  name: 'connect_identity_link_audits_action_chk',
  expression: `"action" in ('link', 'unlink', 'relink')`,
})
export class ConnectIdentityLinkAudit {
  [OptionalProps]?: 'createdAt' | 'fromCustomerKind' | 'fromCustomerId' | 'toCustomerKind' | 'toCustomerId' | 'reason'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'action', type: 'text' })
  action!: ConnectIdentityLinkAction

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  @Property({ name: 'from_customer_kind', type: 'text', nullable: true })
  fromCustomerKind?: 'person' | 'company' | null

  @Property({ name: 'from_customer_id', type: 'uuid', nullable: true })
  fromCustomerId?: string | null

  @Property({ name: 'to_customer_kind', type: 'text', nullable: true })
  toCustomerKind?: 'person' | 'company' | null

  @Property({ name: 'to_customer_id', type: 'uuid', nullable: true })
  toCustomerId?: string | null

  /** Encrypted at rest — an operator's note about a customer. */
  @Property({ name: 'reason', type: 'text', nullable: true })
  reason?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

export type ConnectManualMatchStatus = 'open' | 'resolved' | 'superseded'

/**
 * Work item for an unresolved identity.
 *
 * At most one OPEN task per identity: a customer writing five times should
 * produce one thing to do, not five. Phase 1 has no assignee — the queue is an
 * organization-wide, oldest-first list, because routing rules are a separate
 * decision from having a queue at all.
 */
@Entity({ tableName: 'connect_manual_match_tasks' })
@Index({
  name: 'connect_manual_match_tasks_open_uq',
  expression:
    `create unique index "connect_manual_match_tasks_open_uq" on "connect_manual_match_tasks" ("tenant_id", "organization_id", "identity_id") where "status" = 'open'`,
})
@Index({
  name: 'connect_manual_match_tasks_queue_idx',
  properties: ['tenantId', 'organizationId', 'status', 'createdAt'],
})
@Check({
  name: 'connect_manual_match_tasks_status_chk',
  expression: `"status" in ('open', 'resolved', 'superseded')`,
})
export class ConnectManualMatchTask {
  [OptionalProps]?: 'createdAt' | 'updatedAt' | 'status' | 'resolution' | 'resolvedAt' | 'sourceEventId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'status', type: 'text', default: 'open' })
  status: ConnectManualMatchStatus = 'open'

  @Property({ name: 'resolution', type: 'text', nullable: true })
  resolution?: string | null

  /** Idempotency key for the subscriber that opens the task. */
  @Property({ name: 'source_event_id', type: 'text', nullable: true })
  sourceEventId?: string | null

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type ConnectProjectionStatus = 'pending' | 'projected' | 'failed' | 'superseded'

/**
 * One Customer-timeline projection intent per resolved Case.
 *
 * The `projectionKey` is derived from the Case id and a projection VERSION, not
 * from retry time, so a retry is byte-identical and the source can reconcile it
 * as a duplicate. Relinking to a different customer bumps the version, which
 * produces a new key rather than reviving the tombstoned one — the audit chain
 * stays intact and old content is never resurrected.
 */
@Entity({ tableName: 'connect_pending_projections' })
@Unique({ name: 'connect_pending_projections_key_uq', properties: ['tenantId', 'projectionKey'] })
@Index({
  name: 'connect_pending_projections_drain_idx',
  properties: ['status', 'leaseExpiresAt'],
})
@Index({
  name: 'connect_pending_projections_identity_idx',
  properties: ['tenantId', 'organizationId', 'identityId', 'status'],
})
@Check({
  name: 'connect_pending_projections_status_chk',
  expression: `"status" in ('pending', 'projected', 'failed', 'superseded')`,
})
export class ConnectPendingProjection {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'lastError'
    | 'leaseExpiresAt'
    | 'attempts'
    | 'projectedAt'
    | 'identityId'
    | 'customerKind'
    | 'customerId'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'identity_id', type: 'uuid', nullable: true })
  identityId?: string | null

  /** Opaque reference only — never a copied name, email or phone number. */
  @Property({ name: 'customer_kind', type: 'text', nullable: true })
  customerKind?: 'person' | 'company' | null

  @Property({ name: 'customer_id', type: 'uuid', nullable: true })
  customerId?: string | null

  /** Deterministic source key. Derived from Case id + version, never from time. */
  @Property({ name: 'projection_key', type: 'text' })
  projectionKey!: string

  @Property({ name: 'projection_version', type: 'int' })
  projectionVersion!: number

  /** The retraction group this projection belongs to. */
  @Property({ name: 'association_epoch', type: 'int' })
  associationEpoch!: number

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ConnectProjectionStatus = 'pending'

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'projected_at', type: Date, nullable: true })
  projectedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type ConnectRetractionPhase =
  | 'pending_hide'
  | 'committing'
  | 'finalizing'
  | 'completed'
  | 'aborted'

export type ConnectSagaDecision = 'undecided' | 'commit' | 'abort'

/**
 * The unlink coordinator's durable state.
 *
 * Unlink spans two modules, so neither a lost acknowledgement nor a coordinator
 * crash may leave a customer's timeline half-cleared. The saga stores the exact
 * inventory it intends to retract BEFORE calling the peer, and a monotonic
 * decision, so recovery converges by reading both ledgers rather than guessing.
 */
@Entity({ tableName: 'connect_retraction_sagas' })
@Unique({
  name: 'connect_retraction_sagas_saga_uq',
  properties: ['tenantId', 'organizationId', 'sagaId', 'epoch'],
})
@Index({
  name: 'connect_retraction_sagas_recovery_idx',
  properties: ['phase', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_retraction_sagas_phase_chk',
  expression: `"phase" in ('pending_hide', 'committing', 'finalizing', 'completed', 'aborted')`,
})
@Check({
  name: 'connect_retraction_sagas_decision_chk',
  expression: `"decision" in ('undecided', 'commit', 'abort')`,
})
export class ConnectRetractionSaga {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'phase'
    | 'decision'
    | 'lastError'
    | 'leaseExpiresAt'
    | 'attempts'
    | 'completedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'saga_id', type: 'text' })
  sagaId!: string

  /** Monotonic fence. A stale recovery worker's lower epoch is rejected. */
  @Property({ name: 'epoch', type: 'int' })
  epoch!: number

  @Property({ name: 'association_epoch', type: 'int' })
  associationEpoch!: number

  /** Complete, precommitted list of source keys this saga retracts. */
  @Property({ name: 'inventory', type: 'jsonb' })
  inventory!: string[]

  @Property({ name: 'phase', type: 'text', default: 'pending_hide' })
  phase: ConnectRetractionPhase = 'pending_hide'

  @Property({ name: 'decision', type: 'text', default: 'undecided' })
  decision: ConnectSagaDecision = 'undecided'

  @Property({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'completed_at', type: Date, nullable: true })
  completedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

export type ConnectPendingRetractionStatus = 'pending' | 'finalized' | 'failed'

/** One finalize job per projection a saga hid. Bounded retry, never a delete. */
@Entity({ tableName: 'connect_pending_retractions' })
@Unique({ name: 'connect_pending_retractions_key_uq', properties: ['tenantId', 'projectionKey'] })
@Index({
  name: 'connect_pending_retractions_drain_idx',
  properties: ['status', 'leaseExpiresAt'],
})
@Check({
  name: 'connect_pending_retractions_status_chk',
  expression: `"status" in ('pending', 'finalized', 'failed')`,
})
export class ConnectPendingRetraction {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'status'
    | 'lastError'
    | 'leaseExpiresAt'
    | 'attempts'
    | 'finalizedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'saga_id', type: 'text' })
  sagaId!: string

  @Property({ name: 'case_id', type: 'uuid' })
  caseId!: string

  @Property({ name: 'identity_id', type: 'uuid' })
  identityId!: string

  @Property({ name: 'projection_key', type: 'text' })
  projectionKey!: string

  /** The association that was cleared. Kept for audit, never read as active. */
  @Property({ name: 'former_customer_kind', type: 'text', nullable: true })
  formerCustomerKind?: 'person' | 'company' | null

  @Property({ name: 'former_customer_id', type: 'uuid', nullable: true })
  formerCustomerId?: string | null

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: ConnectPendingRetractionStatus = 'pending'

  @Property({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null

  @Property({ name: 'lease_expires_at', type: Date, nullable: true })
  leaseExpiresAt?: Date | null

  @Property({ name: 'attempts', type: 'int', default: 0 })
  attempts: number = 0

  @Property({ name: 'finalized_at', type: Date, nullable: true })
  finalizedAt?: Date | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}

// ── Operational metrics ───────────────────────────────────────

/**
 * The fact types Metrics records.
 *
 * Every one is derived from a Connect-owned domain event. Metrics never reads
 * `messages`, `communication_channels` or `customers` storage — a reporting
 * module that queries peer tables becomes a hidden coupling that breaks when
 * the peer refactors, and worse, can outlive the authorization that produced
 * the data.
 */
export type ConnectFactType =
  | 'inbound_claimed'
  | 'inbound_opened'
  | 'inbound_attached'
  | 'inbound_suppressed'
  | 'inbound_dead_lettered'
  | 'outbound_attempted'
  | 'outbound_sent'
  | 'outbound_failed'
  | 'outbound_unknown'
  | 'case_assigned'
  | 'case_resolved'
  | 'case_reopened'
  | 'first_response_seconds'
  | 'elapsed_assigned_to_resolution_seconds'
  | 'projection_lag_ms'
  | 'projection_failed'

/**
 * One immutable operational fact.
 *
 * Append-only and idempotent by `sourceKey`, which is the publishing event's
 * own `sourceEventId` plus the fact type. At-least-once publication is
 * therefore harmless: a redelivered event maps to the same key and the unique
 * index rejects the second insert.
 *
 * Dimensions are deliberately narrow — ids, a disposition, a timestamp, and a
 * sender HASH where suppression analysis needs one. A raw handle or a message
 * body here would put customer content into a reporting table that outlives
 * retention on the record it came from.
 */
@Entity({ tableName: 'connect_operational_facts' })
@Unique({
  name: 'connect_operational_facts_source_uq',
  properties: ['tenantId', 'organizationId', 'sourceKey'],
})
@Index({
  name: 'connect_operational_facts_day_idx',
  properties: ['tenantId', 'organizationId', 'cohortUtcDate', 'factType'],
})
@Index({
  name: 'connect_operational_facts_sender_idx',
  properties: ['tenantId', 'organizationId', 'channelId', 'senderHash'],
})
export class ConnectOperationalFact {
  [OptionalProps]?:
    | 'createdAt'
    | 'caseId'
    | 'conversationId'
    | 'attemptId'
    | 'projectionKey'
    | 'channelId'
    | 'senderHash'
    | 'disposition'
    | 'value'
    | 'appliedWindowMinutes'
    | 'appliedCountLimit'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  /** Never null: the organization is the authorization boundary for reporting. */
  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'fact_type', type: 'text' })
  factType!: ConnectFactType

  /** `<eventSourceId>:<factType>` — what makes a redelivery a no-op. */
  @Property({ name: 'source_key', type: 'text' })
  sourceKey!: string

  /**
   * The IMMUTABLE cohort this fact belongs to, frozen by the writer. A terminal
   * fact that arrives after midnight still lands on its claim/enqueue day, so a
   * reconciliation equation can never be broken by a slow worker.
   */
  @Property({ name: 'cohort_utc_date', type: 'string', length: 10 })
  cohortUtcDate!: string

  @Property({ name: 'case_id', type: 'uuid', nullable: true })
  caseId?: string | null

  @Property({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId?: string | null

  @Property({ name: 'attempt_id', type: 'uuid', nullable: true })
  attemptId?: string | null

  @Property({ name: 'projection_key', type: 'text', nullable: true })
  projectionKey?: string | null

  @Property({ name: 'channel_id', type: 'uuid', nullable: true })
  channelId?: string | null

  /** Keyed blind index only. Never reversible to an address. */
  @Property({ name: 'sender_hash', type: 'text', nullable: true })
  senderHash?: string | null

  @Property({ name: 'disposition', type: 'text', nullable: true })
  disposition?: string | null

  /** Duration or measurement facts carry a number; counters leave it null. */
  @Property({ name: 'value', type: 'double', nullable: true })
  value?: number | null

  /**
   * The suppression settings IN FORCE when this receipt was decided. Without
   * them a later settings change silently reinterprets history, and the
   * per-sender safety criterion becomes unfalsifiable.
   */
  @Property({ name: 'applied_window_minutes', type: 'int', nullable: true })
  appliedWindowMinutes?: number | null

  @Property({ name: 'applied_count_limit', type: 'int', nullable: true })
  appliedCountLimit?: number | null

  @Property({ name: 'occurred_at', type: Date })
  occurredAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()
}

/**
 * One aggregated row per organization per UTC day.
 *
 * Rebuildable by construction: it is a pure function of the immutable facts for
 * that day, so a late event or a fixed bug is repaired by recomputing rather
 * than by patching a counter nobody can audit.
 *
 * `generatedAt` and `stale` exist so the UI can distinguish "no traffic" from
 * "not aggregated yet" from "aggregated, but a rebuild is in flight". Showing
 * zero for the latter two is the failure mode this whole spec exists to avoid.
 */
@Entity({ tableName: 'connect_metric_daily' })
@Unique({
  name: 'connect_metric_daily_day_uq',
  properties: ['tenantId', 'organizationId', 'utcDate'],
})
export class ConnectMetricDaily {
  [OptionalProps]?:
    | 'createdAt'
    | 'updatedAt'
    | 'stale'
    | 'inboundClaimed'
    | 'casesOpened'
    | 'casesAttached'
    | 'inboundSuppressed'
    | 'inboundDeadLettered'
    | 'outboundAttempted'
    | 'outboundSent'
    | 'outboundFailed'
    | 'outboundUnknown'
    | 'unknownMaxAgeSeconds'
    | 'casesAssigned'
    | 'casesResolved'
    | 'casesReopened'
    | 'firstResponseP50Seconds'
    | 'firstResponseP90Seconds'
    | 'firstResponseSampleCount'
    | 'elapsedResolutionP50Seconds'
    | 'elapsedResolutionP90Seconds'
    | 'elapsedResolutionSampleCount'
    | 'projectionLagP50Ms'
    | 'projectionLagP90Ms'
    | 'projectionLagMaxMs'
    | 'projectionSampleCount'
    | 'projectionFailed'
    | 'observedMaxPermittedPerSender'
    | 'appliedCountLimit'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'utc_date', type: 'string', length: 10 })
  utcDate!: string

  @Property({ name: 'inbound_claimed', type: 'int', default: 0 })
  inboundClaimed: number = 0

  @Property({ name: 'cases_opened', type: 'int', default: 0 })
  casesOpened: number = 0

  @Property({ name: 'cases_attached', type: 'int', default: 0 })
  casesAttached: number = 0

  @Property({ name: 'inbound_suppressed', type: 'int', default: 0 })
  inboundSuppressed: number = 0

  @Property({ name: 'inbound_dead_lettered', type: 'int', default: 0 })
  inboundDeadLettered: number = 0

  @Property({ name: 'outbound_attempted', type: 'int', default: 0 })
  outboundAttempted: number = 0

  @Property({ name: 'outbound_sent', type: 'int', default: 0 })
  outboundSent: number = 0

  @Property({ name: 'outbound_failed', type: 'int', default: 0 })
  outboundFailed: number = 0

  /** Never folded into sent or failed. An unknown send is its own answer. */
  @Property({ name: 'outbound_unknown', type: 'int', default: 0 })
  outboundUnknown: number = 0

  @Property({ name: 'unknown_max_age_seconds', type: 'int', nullable: true })
  unknownMaxAgeSeconds?: number | null

  @Property({ name: 'cases_assigned', type: 'int', default: 0 })
  casesAssigned: number = 0

  @Property({ name: 'cases_resolved', type: 'int', default: 0 })
  casesResolved: number = 0

  @Property({ name: 'cases_reopened', type: 'int', default: 0 })
  casesReopened: number = 0

  @Property({ name: 'first_response_p50_seconds', type: 'double', nullable: true })
  firstResponseP50Seconds?: number | null

  @Property({ name: 'first_response_p90_seconds', type: 'double', nullable: true })
  firstResponseP90Seconds?: number | null

  /**
   * The population behind the percentiles. A p90 over three samples is not a
   * p90, and an operator cannot tell without this number.
   */
  @Property({ name: 'first_response_sample_count', type: 'int', default: 0 })
  firstResponseSampleCount: number = 0

  @Property({ name: 'elapsed_resolution_p50_seconds', type: 'double', nullable: true })
  elapsedResolutionP50Seconds?: number | null

  @Property({ name: 'elapsed_resolution_p90_seconds', type: 'double', nullable: true })
  elapsedResolutionP90Seconds?: number | null

  @Property({ name: 'elapsed_resolution_sample_count', type: 'int', default: 0 })
  elapsedResolutionSampleCount: number = 0

  @Property({ name: 'projection_lag_p50_ms', type: 'double', nullable: true })
  projectionLagP50Ms?: number | null

  @Property({ name: 'projection_lag_p90_ms', type: 'double', nullable: true })
  projectionLagP90Ms?: number | null

  @Property({ name: 'projection_lag_max_ms', type: 'double', nullable: true })
  projectionLagMaxMs?: number | null

  /**
   * Zero means the Customer Projection capability is absent or produced no
   * work, which the API reports as UNAVAILABLE rather than as a lag of zero.
   */
  @Property({ name: 'projection_sample_count', type: 'int', default: 0 })
  projectionSampleCount: number = 0

  @Property({ name: 'projection_failed', type: 'int', default: 0 })
  projectionFailed: number = 0

  /**
   * The largest number of receipts any single `(channel, sender)` pair was
   * PERMITTED in its window. The safety criterion is that this never exceeds
   * the limit that was actually applied.
   */
  @Property({ name: 'observed_max_permitted_per_sender', type: 'int', default: 0 })
  observedMaxPermittedPerSender: number = 0

  @Property({ name: 'applied_count_limit', type: 'int', nullable: true })
  appliedCountLimit?: number | null

  /** Set while a rebuild is in flight, so the UI can keep showing last-good. */
  @Property({ name: 'stale', type: 'boolean', default: false })
  stale: boolean = false

  @Property({ name: 'generated_at', type: Date })
  generatedAt!: Date

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date()
}
