import type { EntityManager } from '@mikro-orm/postgresql'
import type { FilterQuery } from '@mikro-orm/core'
import { z } from 'zod'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  BusinessCalendar,
  BusinessCalendarVersion,
  BusinessHoliday,
  BusinessWindow,
  CaseClock,
  Policy,
  PolicyVersion,
} from '../data/entities'

const scopeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
}).strict()

const scopedIdSchema = scopeSchema.extend({ id: z.string().uuid() }).strict()
const scopedCaseSchema = scopeSchema.extend({
  caseId: z.string().uuid(),
  generation: z.number().int().nonnegative().optional(),
}).strict()

export type ConnectSlaCalendarReader = ReturnType<typeof createConnectSlaCalendarReader>
export type ConnectSlaPolicyReader = ReturnType<typeof createConnectSlaPolicyReader>
export type ConnectSlaClockReader = ReturnType<typeof createConnectSlaClockReader>

export function createConnectSlaCalendarReader(em: EntityManager) {
  return {
    async findById(rawInput: z.input<typeof scopedIdSchema>) {
      const input = scopedIdSchema.parse(rawInput)
      return em.findOne(BusinessCalendar, { ...input, deletedAt: null })
    },
    async findVersion(rawInput: z.input<typeof scopedIdSchema>) {
      const input = scopedIdSchema.parse(rawInput)
      return em.findOne(BusinessCalendarVersion, input)
    },
    async listVersionDefinition(rawInput: z.input<typeof scopedIdSchema>) {
      const input = scopedIdSchema.parse(rawInput)
      const where = { tenantId: input.tenantId, organizationId: input.organizationId, calendarVersionId: input.id }
      const [windows, holidays] = await Promise.all([
        em.find(BusinessWindow, where, { orderBy: [{ weekday: 'asc' }, { localStart: 'asc' }, { id: 'asc' }] }),
        findWithDecryption(
          em,
          BusinessHoliday,
          where as FilterQuery<BusinessHoliday>,
          { orderBy: [{ localDate: 'asc' }, { id: 'asc' }] },
          { tenantId: input.tenantId, organizationId: input.organizationId },
        ),
      ])
      return { windows, holidays }
    },
  }
}

export function createConnectSlaPolicyReader(em: EntityManager) {
  return {
    async findById(rawInput: z.input<typeof scopedIdSchema>) {
      const input = scopedIdSchema.parse(rawInput)
      return em.findOne(Policy, { ...input, deletedAt: null })
    },
    async findVersion(rawInput: z.input<typeof scopedIdSchema>) {
      const input = scopedIdSchema.parse(rawInput)
      return em.findOne(PolicyVersion, input)
    },
    async listCandidates(rawInput: z.input<typeof scopeSchema> & { channelId: string; at: Date }) {
      const input = scopeSchema.extend({ channelId: z.string().uuid(), at: z.date() }).strict().parse(rawInput)
      const policies = await em.find(Policy, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        isActive: true,
        deletedAt: null,
      }, { orderBy: [{ priority: 'asc' }, { id: 'asc' }] })
      if (!policies.length) return []
      const policyOrder = new Map(policies.map((policy, index) => [policy.id, index]))
      const versions = await em.find(PolicyVersion, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        channelId: { $in: [input.channelId, null] },
        effectiveFrom: { $lte: input.at },
        policyId: { $in: policies.map((policy) => policy.id) },
      })
      return versions.sort((left, right) => {
        const channelRank = Number(right.channelId !== null) - Number(left.channelId !== null)
        return channelRank || (policyOrder.get(left.policyId) ?? 0) - (policyOrder.get(right.policyId) ?? 0)
      })
    },
  }
}

export function createConnectSlaClockReader(em: EntityManager) {
  return {
    async findById(rawInput: z.input<typeof scopedIdSchema>) {
      return em.findOne(CaseClock, scopedIdSchema.parse(rawInput))
    },
    async findForCase(rawInput: z.input<typeof scopedCaseSchema>) {
      const input = scopedCaseSchema.parse(rawInput)
      return em.findOne(CaseClock, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        caseId: input.caseId,
        ...(input.generation === undefined ? {} : { generation: input.generation }),
      }, { orderBy: { generation: 'desc' } })
    },
  }
}
