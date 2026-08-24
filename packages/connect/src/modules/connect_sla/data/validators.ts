import { z } from 'zod'

export const SLA_RESPONSE_STATES = ['open', 'met', 'breached', 'unknown'] as const
export const SLA_RESOLUTION_STATES = ['open', 'met', 'breached', 'merged', 'superseded'] as const
export const SLA_REBUILD_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const
export const SLA_NAME_MAX_LENGTH = 160
export const SLA_HOLIDAY_LABEL_MAX_LENGTH = 500
export const SLA_TARGET_MINUTES_MAX = 5_256_000

const uuidSchema = z.string().uuid()
const nameSchema = z.string().trim().min(1, 'name_required').max(SLA_NAME_MAX_LENGTH, 'name_too_long')
const isoDateTimeSchema = z.string().datetime({ offset: true })
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_invalid')
const localTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'time_invalid')

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const timezoneSchema = z.string().trim().min(1, 'timezone_invalid').refine(isValidIanaTimezone, 'timezone_invalid')

const businessWindowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  localStart: localTimeSchema,
  localEnd: localTimeSchema,
}).strict().refine((window) => window.localStart !== window.localEnd, {
  path: ['localEnd'],
  message: 'window_empty',
})

const businessHolidaySchema = z.object({
  localDate: localDateSchema,
  label: z.string().trim().max(SLA_HOLIDAY_LABEL_MAX_LENGTH, 'label_too_long').transform((value) => value || null).nullish(),
}).strict()

export const businessCalendarCreateSchema = z.object({
  name: nameSchema,
  isDefault: z.boolean().default(false),
}).strict()

export const businessCalendarUpdateSchema = businessCalendarCreateSchema.extend({ id: uuidSchema }).strict()
export const businessCalendarDeleteSchema = z.object({ id: uuidSchema }).strict()

export const businessCalendarPublishBodySchema = z.object({
  timezone: timezoneSchema,
  windows: z.array(businessWindowSchema).min(1, 'calendar_empty').max(100),
  holidays: z.array(businessHolidaySchema).max(3660).default([]),
}).strict().superRefine((value, ctx) => {
  const holidayDates = new Set<string>()
  value.holidays.forEach((holiday, index) => {
    if (holidayDates.has(holiday.localDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['holidays', index, 'localDate'], message: 'holiday_duplicate' })
    }
    holidayDates.add(holiday.localDate)
  })
})

export const businessCalendarPublishSchema = z.object({
  id: uuidSchema,
  timezone: timezoneSchema,
  windows: z.array(businessWindowSchema).min(1, 'calendar_empty').max(100),
  holidays: z.array(businessHolidaySchema).max(3660).default([]),
}).strict().superRefine((value, ctx) => {
  const holidayDates = new Set<string>()
  value.holidays.forEach((holiday, index) => {
    if (holidayDates.has(holiday.localDate)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['holidays', index, 'localDate'], message: 'holiday_duplicate' })
    }
    holidayDates.add(holiday.localDate)
  })
})

const targetMinutesSchema = z.number().int().positive('target_positive').max(SLA_TARGET_MINUTES_MAX)
const warningMinutesSchema = z.number().int().nonnegative('warning_nonnegative').max(SLA_TARGET_MINUTES_MAX)

export const policyCreateSchema = z.object({
  name: nameSchema,
  priority: z.number().int(),
  isActive: z.boolean().default(true),
}).strict()

export const policyUpdateSchema = policyCreateSchema.extend({ id: uuidSchema }).strict()
export const policyDeleteSchema = z.object({ id: uuidSchema }).strict()

export const policyPublishBodySchema = z.object({
  channelId: uuidSchema.nullish(),
  responseTargetMinutes: targetMinutesSchema,
  resolutionTargetMinutes: targetMinutesSchema,
  responseWarningMinutes: warningMinutesSchema,
  resolutionWarningMinutes: warningMinutesSchema,
  calendarVersionId: uuidSchema,
  effectiveFrom: isoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (value.responseWarningMinutes >= value.responseTargetMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['responseWarningMinutes'], message: 'warning_below_target' })
  }
  if (value.resolutionWarningMinutes >= value.resolutionTargetMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolutionWarningMinutes'], message: 'warning_below_target' })
  }
})

export const policyPublishSchema = z.object({
  id: uuidSchema,
  channelId: uuidSchema.nullish(),
  responseTargetMinutes: targetMinutesSchema,
  resolutionTargetMinutes: targetMinutesSchema,
  responseWarningMinutes: warningMinutesSchema,
  resolutionWarningMinutes: warningMinutesSchema,
  calendarVersionId: uuidSchema,
  effectiveFrom: isoDateTimeSchema,
}).strict().superRefine((value, ctx) => {
  if (value.responseWarningMinutes >= value.responseTargetMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['responseWarningMinutes'], message: 'warning_below_target' })
  }
  if (value.resolutionWarningMinutes >= value.resolutionTargetMinutes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolutionWarningMinutes'], message: 'warning_below_target' })
  }
})

const cursorListSchema = z.object({
  cursor: z.string().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

const pagedListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).strict()

export const businessCalendarListQuerySchema = pagedListSchema.extend({
  id: uuidSchema.optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
}).strict()

export const policyListQuerySchema = pagedListSchema.extend({
  id: uuidSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  channelId: uuidSchema.optional(),
}).strict()

export const caseClockListQuerySchema = cursorListSchema.extend({
  id: uuidSchema.optional(),
  caseId: uuidSchema.optional(),
  generation: z.coerce.number().int().nonnegative().optional(),
  responseState: z.enum(SLA_RESPONSE_STATES).optional(),
  resolutionState: z.enum(SLA_RESOLUTION_STATES).optional(),
}).strict()

export const clockEventPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  clockId: uuidSchema,
  caseId: uuidSchema,
  generation: z.number().int().nonnegative(),
  responseState: z.enum(SLA_RESPONSE_STATES),
  resolutionState: z.enum(SLA_RESOLUTION_STATES),
  occurredAt: isoDateTimeSchema,
  sourceEventId: z.string().min(1),
}).strict()

export const rebuildClocksSchema = z.object({
  commandKey: z.string().trim().min(1).max(255),
  reason: z.string().trim().min(1).max(500),
}).strict()

export const rebuildRunQuerySchema = z.object({ id: uuidSchema }).strict()

export type BusinessCalendarCreateInput = z.infer<typeof businessCalendarCreateSchema>
export type BusinessCalendarPublishInput = z.infer<typeof businessCalendarPublishSchema>
export type PolicyCreateInput = z.infer<typeof policyCreateSchema>
export type PolicyPublishInput = z.infer<typeof policyPublishSchema>
export type ClockEventPayload = z.infer<typeof clockEventPayloadSchema>
export type RebuildClocksInput = z.infer<typeof rebuildClocksSchema>
