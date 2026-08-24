import { OptionalProps } from '@mikro-orm/core'
import { Check, Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type SlaResponseState = 'open' | 'met' | 'breached' | 'unknown'
export type SlaResolutionState = 'open' | 'met' | 'breached' | 'merged' | 'superseded'
export type SlaRebuildStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SlaOutboxStatus = 'pending' | 'published'

@Entity({ tableName: 'connect_sla_business_calendars' })
@Index({
  name: 'connect_sla_business_calendars_active_name_uq',
  expression: 'create unique index "connect_sla_business_calendars_active_name_uq" on "connect_sla_business_calendars" ("tenant_id", "organization_id", lower("name")) where "deleted_at" is null',
})
@Index({
  name: 'connect_sla_business_calendars_default_uq',
  expression: 'create unique index "connect_sla_business_calendars_default_uq" on "connect_sla_business_calendars" ("tenant_id", "organization_id") where "is_default" = true and "deleted_at" is null',
})
export class BusinessCalendar {
  [OptionalProps]?: 'isDefault' | 'currentVersion' | 'createdAt' | 'updatedAt' | 'deletedAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) name!: string
  @Property({ name: 'is_default', type: 'boolean', default: false }) isDefault = false
  @Property({ name: 'current_version', type: 'integer', nullable: true }) currentVersion: number | null = null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt = new Date()
  @Property({ name: 'deleted_at', type: Date, nullable: true }) deletedAt: Date | null = null
}

@Entity({ tableName: 'connect_sla_business_calendar_versions' })
@Unique({ name: 'connect_sla_business_calendar_versions_uq', properties: ['tenantId', 'organizationId', 'calendarId', 'version'] })
export class BusinessCalendarVersion {
  [OptionalProps]?: 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @ManyToOne(() => BusinessCalendar, { fieldName: 'calendar_id', mapToPk: true, deleteRule: 'restrict' }) calendarId!: string
  @Property({ type: 'integer' }) version!: number
  @Property({ type: 'text' }) timezone!: string
  @Property({ name: 'published_by_user_id', type: 'uuid', nullable: true }) publishedByUserId: string | null = null
  @Property({ name: 'published_at', type: Date }) publishedAt!: Date
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}

@Entity({ tableName: 'connect_sla_business_windows' })
@Check({ name: 'connect_sla_business_windows_weekday_chk', expression: '"weekday" between 0 and 6' })
@Check({ name: 'connect_sla_business_windows_bounds_chk', expression: '"local_end" > "local_start"' })
@Index({ name: 'connect_sla_business_windows_version_idx', properties: ['tenantId', 'organizationId', 'calendarVersionId', 'weekday', 'localStart'] })
export class BusinessWindow {
  [OptionalProps]?: 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @ManyToOne(() => BusinessCalendarVersion, { fieldName: 'calendar_version_id', mapToPk: true, deleteRule: 'cascade' }) calendarVersionId!: string
  @Property({ type: 'smallint' }) weekday!: number
  @Property({ name: 'local_start', type: 'string', columnType: 'time(0)' }) localStart!: string
  @Property({ name: 'local_end', type: 'string', columnType: 'time(0)' }) localEnd!: string
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}

@Entity({ tableName: 'connect_sla_business_holidays' })
@Unique({ name: 'connect_sla_business_holidays_uq', properties: ['tenantId', 'organizationId', 'calendarVersionId', 'localDate'] })
export class BusinessHoliday {
  [OptionalProps]?: 'label' | 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @ManyToOne(() => BusinessCalendarVersion, { fieldName: 'calendar_version_id', mapToPk: true, deleteRule: 'cascade' }) calendarVersionId!: string
  @Property({ name: 'local_date', type: 'string', columnType: 'date' }) localDate!: string
  @Property({ type: 'text', nullable: true }) label: string | null = null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}

@Entity({ tableName: 'connect_sla_policies' })
@Index({ name: 'connect_sla_policies_active_name_uq', expression: 'create unique index "connect_sla_policies_active_name_uq" on "connect_sla_policies" ("tenant_id", "organization_id", lower("name")) where "deleted_at" is null' })
@Index({ name: 'connect_sla_policies_match_idx', properties: ['tenantId', 'organizationId', 'isActive', 'priority'] })
export class Policy {
  [OptionalProps]?: 'isActive' | 'currentVersion' | 'createdAt' | 'updatedAt' | 'deletedAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ type: 'text' }) name!: string
  @Property({ type: 'integer' }) priority!: number
  @Property({ name: 'is_active', type: 'boolean', default: true }) isActive = true
  @Property({ name: 'current_version', type: 'integer', nullable: true }) currentVersion: number | null = null
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt = new Date()
  @Property({ name: 'deleted_at', type: Date, nullable: true }) deletedAt: Date | null = null
}

@Entity({ tableName: 'connect_sla_policy_versions' })
@Check({ name: 'connect_sla_policy_versions_targets_chk', expression: '"response_target_minutes" > 0 and "resolution_target_minutes" > 0' })
@Check({ name: 'connect_sla_policy_versions_warnings_chk', expression: '"response_warning_minutes" >= 0 and "response_warning_minutes" < "response_target_minutes" and "resolution_warning_minutes" >= 0 and "resolution_warning_minutes" < "resolution_target_minutes"' })
@Unique({ name: 'connect_sla_policy_versions_uq', properties: ['tenantId', 'organizationId', 'policyId', 'version'] })
@Index({ name: 'connect_sla_policy_versions_effective_idx', properties: ['tenantId', 'organizationId', 'channelId', 'effectiveFrom'] })
export class PolicyVersion {
  [OptionalProps]?: 'channelId' | 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @ManyToOne(() => Policy, { fieldName: 'policy_id', mapToPk: true, deleteRule: 'restrict' }) policyId!: string
  @Property({ type: 'integer' }) version!: number
  @Property({ name: 'channel_id', type: 'uuid', nullable: true }) channelId: string | null = null
  @Property({ name: 'response_target_minutes', type: 'integer' }) responseTargetMinutes!: number
  @Property({ name: 'resolution_target_minutes', type: 'integer' }) resolutionTargetMinutes!: number
  @Property({ name: 'response_warning_minutes', type: 'integer' }) responseWarningMinutes!: number
  @Property({ name: 'resolution_warning_minutes', type: 'integer' }) resolutionWarningMinutes!: number
  @ManyToOne(() => BusinessCalendarVersion, { fieldName: 'calendar_version_id', mapToPk: true, deleteRule: 'restrict' }) calendarVersionId!: string
  @Property({ name: 'effective_from', type: Date }) effectiveFrom!: Date
  @Property({ name: 'published_by_user_id', type: 'uuid', nullable: true }) publishedByUserId: string | null = null
  @Property({ name: 'published_at', type: Date }) publishedAt!: Date
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}

@Entity({ tableName: 'connect_sla_case_clocks' })
@Check({ name: 'connect_sla_case_clocks_response_state_chk', expression: '"response_state" in (\'open\', \'met\', \'breached\', \'unknown\')' })
@Check({ name: 'connect_sla_case_clocks_resolution_state_chk', expression: '"resolution_state" in (\'open\', \'met\', \'breached\', \'merged\', \'superseded\')' })
@Check({ name: 'connect_sla_case_clocks_pause_chk', expression: '"resolution_paused_seconds" >= 0' })
@Unique({ name: 'connect_sla_case_clocks_case_generation_uq', properties: ['tenantId', 'organizationId', 'caseId', 'generation'] })
@Index({ name: 'connect_sla_case_clocks_due_idx', properties: ['tenantId', 'organizationId', 'nextDueAt', 'id'] })
export class CaseClock {
  [OptionalProps]?: 'respondedAt' | 'resolvedAt' | 'waitStartedAt' | 'parentClockId' | 'supersededByClockId' | 'nextDueAt' | 'internalVersion' | 'createdAt' | 'updatedAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'case_id', type: 'uuid' }) caseId!: string
  @Property({ type: 'integer' }) generation!: number
  @Property({ name: 'source_event_id', type: 'text' }) sourceEventId!: string
  @ManyToOne(() => PolicyVersion, { fieldName: 'policy_version_id', mapToPk: true, deleteRule: 'restrict' }) policyVersionId!: string
  @ManyToOne(() => BusinessCalendarVersion, { fieldName: 'calendar_version_id', mapToPk: true, deleteRule: 'restrict' }) calendarVersionId!: string
  @Property({ name: 'started_at', type: Date }) startedAt!: Date
  @Property({ name: 'response_due_at', type: Date }) responseDueAt!: Date
  @Property({ name: 'resolution_due_at', type: Date }) resolutionDueAt!: Date
  @Property({ name: 'response_state', type: 'text' }) responseState!: SlaResponseState
  @Property({ name: 'resolution_state', type: 'text' }) resolutionState!: SlaResolutionState
  @Property({ name: 'responded_at', type: Date, nullable: true }) respondedAt: Date | null = null
  @Property({ name: 'resolved_at', type: Date, nullable: true }) resolvedAt: Date | null = null
  @Property({ name: 'resolution_paused_seconds', type: 'integer', default: 0 }) resolutionPausedSeconds = 0
  @Property({ name: 'wait_started_at', type: Date, nullable: true }) waitStartedAt: Date | null = null
  @ManyToOne(() => CaseClock, { fieldName: 'parent_clock_id', mapToPk: true, nullable: true, deleteRule: 'restrict' }) parentClockId: string | null = null
  @ManyToOne(() => CaseClock, { fieldName: 'superseded_by_clock_id', mapToPk: true, nullable: true, deleteRule: 'restrict' }) supersededByClockId: string | null = null
  @Property({ name: 'next_due_at', type: Date, nullable: true }) nextDueAt: Date | null = null
  @Property({ name: 'internal_version', type: 'integer', default: 1 }) internalVersion = 1
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt = new Date()
}

@Entity({ tableName: 'connect_sla_event_receipts' })
@Unique({ name: 'connect_sla_event_receipts_uq', properties: ['tenantId', 'organizationId', 'sourceEventId', 'consumerVersion'] })
export class EventReceipt {
  [OptionalProps]?: 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'source_event_id', type: 'text' }) sourceEventId!: string
  @Property({ name: 'consumer_version', type: 'integer' }) consumerVersion!: number
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}

@Entity({ tableName: 'connect_sla_event_outbox' })
@Unique({ name: 'connect_sla_event_outbox_source_uq', properties: ['tenantId', 'organizationId', 'sourceEventId', 'eventType'] })
@Index({ name: 'connect_sla_event_outbox_pending_idx', properties: ['status', 'leaseExpiresAt', 'createdAt'] })
@Check({ name: 'connect_sla_event_outbox_status_chk', expression: '"status" in (\'pending\', \'published\')' })
export class SlaEventOutbox {
  [OptionalProps]?: 'status' | 'leaseExpiresAt' | 'publishedAt' | 'attempts' | 'createdAt' | 'updatedAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'source_event_id', type: 'text' }) sourceEventId!: string
  @Property({ name: 'event_type', type: 'text' }) eventType!: string
  @Property({ type: 'json' }) payload!: Record<string, unknown>
  @Property({ type: 'text', default: 'pending' }) status: SlaOutboxStatus = 'pending'
  @Property({ name: 'lease_expires_at', type: Date, nullable: true }) leaseExpiresAt: Date | null = null
  @Property({ name: 'published_at', type: Date, nullable: true }) publishedAt: Date | null = null
  @Property({ type: 'integer', default: 0 }) attempts = 0
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt = new Date()
}

@Entity({ tableName: 'connect_sla_rebuild_runs' })
@Check({ name: 'connect_sla_rebuild_runs_status_chk', expression: '"status" in (\'pending\', \'running\', \'completed\', \'failed\', \'cancelled\')' })
@Unique({ name: 'connect_sla_rebuild_runs_command_uq', properties: ['tenantId', 'organizationId', 'commandKey'] })
export class RebuildRun {
  [OptionalProps]?: 'watermark' | 'generationCursor' | 'waitCursor' | 'deliveryCursor' | 'leaseOwner' | 'leaseExpiresAt' | 'processedCount' | 'errorCount' | 'progressJobId' | 'internalVersion' | 'createdAt' | 'updatedAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @Property({ name: 'command_key', type: 'text' }) commandKey!: string
  @Property({ type: 'text' }) reason!: string
  @Property({ type: 'text', nullable: true }) watermark: string | null = null
  @Property({ name: 'generation_cursor', type: 'text', nullable: true }) generationCursor: string | null = null
  @Property({ name: 'wait_cursor', type: 'text', nullable: true }) waitCursor: string | null = null
  @Property({ name: 'delivery_cursor', type: 'text', nullable: true }) deliveryCursor: string | null = null
  @Property({ name: 'lease_owner', type: 'text', nullable: true }) leaseOwner: string | null = null
  @Property({ name: 'lease_expires_at', type: Date, nullable: true }) leaseExpiresAt: Date | null = null
  @Property({ type: 'text' }) status!: SlaRebuildStatus
  @Property({ name: 'processed_count', type: 'integer', default: 0 }) processedCount = 0
  @Property({ name: 'error_count', type: 'integer', default: 0 }) errorCount = 0
  @Property({ name: 'progress_job_id', type: 'uuid', nullable: true }) progressJobId: string | null = null
  @Property({ name: 'internal_version', type: 'integer', default: 1 }) internalVersion = 1
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
  @Property({ name: 'updated_at', type: Date, onCreate: () => new Date(), onUpdate: () => new Date() }) updatedAt = new Date()
}

@Entity({ tableName: 'connect_sla_clock_revisions' })
@Index({ name: 'connect_sla_clock_revisions_clock_idx', properties: ['tenantId', 'organizationId', 'clockId', 'internalVersion'] })
export class ClockRevision {
  [OptionalProps]?: 'createdAt'
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' }) id!: string
  @Property({ name: 'tenant_id', type: 'uuid' }) tenantId!: string
  @Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string
  @ManyToOne(() => CaseClock, { fieldName: 'clock_id', mapToPk: true, deleteRule: 'cascade' }) clockId!: string
  @Property({ name: 'internal_version', type: 'integer' }) internalVersion!: number
  @Property({ type: 'text' }) reason!: string
  @Property({ name: 'before_state', type: 'json' }) before!: Record<string, unknown>
  @Property({ name: 'after_state', type: 'json' }) after!: Record<string, unknown>
  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() }) createdAt = new Date()
}
