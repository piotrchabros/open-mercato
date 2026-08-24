import type { EntityManager } from '@mikro-orm/postgresql'
import { asFunction, asValue } from 'awilix'
import { randomUUID } from 'node:crypto'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectCaseSlaReader } from '../connect/lib/sla-source-reader'
import {
  BusinessCalendar,
  BusinessCalendarVersion,
  BusinessHoliday,
  BusinessWindow,
  CaseClock,
  ClockRevision,
  EventReceipt,
  Policy,
  PolicyVersion,
  RebuildRun,
  SlaEventOutbox,
} from './data/entities'
import { createConnectSlaDependencyHealth } from './lib/dependency-health'
import { createConnectSlaCalendarReader, createConnectSlaClockReader, createConnectSlaPolicyReader } from './lib/persistence'
import { createMikroClockPersistence, createMikroGenerationPersistence, createMikroRebuildSink, createMikroReparentPersistence } from './lib/persistence-adapters'
import { createConnectSlaSourceConsumer, createDeadlineSweepService, createGenerationConsumer, createReparentConsumer, type ClockPersistence, type GenerationPersistence, type RebuildSink, type ReparentPersistence } from './lib/async'
import { createLeasedRebuildWorker, createRebuildRunCoordinator, type RebuildRunStore } from './lib/rebuild-runs'
import { createMikroRebuildRunStore } from './lib/rebuild-store'
import { createClock, matchPolicy, type ClockState, type PolicyMatchCandidate } from './lib/clock-domain'
import type { BusinessCalendar as BusinessTimeCalendar } from './lib/business-time'

export function register(container: AppContainer) {
  container.register({
    BusinessCalendar: asValue(BusinessCalendar),
    BusinessCalendarVersion: asValue(BusinessCalendarVersion),
    BusinessWindow: asValue(BusinessWindow),
    BusinessHoliday: asValue(BusinessHoliday),
    Policy: asValue(Policy),
    PolicyVersion: asValue(PolicyVersion),
    CaseClock: asValue(CaseClock),
    EventReceipt: asValue(EventReceipt),
    RebuildRun: asValue(RebuildRun),
    SlaEventOutbox: asValue(SlaEventOutbox),
    ClockRevision: asValue(ClockRevision),
    connectSlaCalendarReader: asFunction((em: EntityManager) => createConnectSlaCalendarReader(em)).scoped(),
    connectSlaPolicyReader: asFunction((em: EntityManager) => createConnectSlaPolicyReader(em)).scoped(),
    connectSlaClockReader: asFunction((em: EntityManager) => createConnectSlaClockReader(em)).scoped(),
    connectSlaDependencyHealth: asFunction(() => createConnectSlaDependencyHealth(container)).scoped(),
    connectSlaClockPersistence: asFunction((em: EntityManager) => createMikroClockPersistence(em)).scoped(),
    connectSlaGenerationPersistence: asFunction((em: EntityManager) => createMikroGenerationPersistence(em)).scoped(),
    connectSlaReparentPersistence: asFunction((em: EntityManager) => createMikroReparentPersistence(em)).scoped(),
    connectSlaRebuildSink: asFunction((
      em: EntityManager,
      connectSlaGenerationConsumer: ReturnType<typeof createGenerationConsumer>,
      connectSlaSourceConsumer: ReturnType<typeof createConnectSlaSourceConsumer>,
    ) => createMikroRebuildSink(em, { generation: connectSlaGenerationConsumer, source: connectSlaSourceConsumer })).scoped(),
    connectSlaRebuildRunStore: asFunction((em: EntityManager) => createMikroRebuildRunStore(em)).scoped(),
    connectSlaRebuildRunCoordinator: asFunction((connectSlaRebuildRunStore: RebuildRunStore) => {
      const health = createConnectSlaDependencyHealth(container)
      return createRebuildRunCoordinator(connectSlaRebuildRunStore, health.connectCaseSlaReader as ConnectCaseSlaReader | null, randomUUID)
    }).scoped(),
    connectSlaSourceConsumer: asFunction((
      em: EntityManager,
      connectSlaClockPersistence: ClockPersistence,
    ) => createConnectSlaSourceConsumer(connectSlaClockPersistence, (clock) => resolveClockRuntime(em, clock))).scoped(),
    connectSlaDeadlineSweepService: asFunction((connectSlaClockPersistence: ClockPersistence) =>
      createDeadlineSweepService(connectSlaClockPersistence),
    ).scoped(),
    connectSlaGenerationConsumer: asFunction((
      em: EntityManager,
      connectSlaGenerationPersistence: GenerationPersistence,
    ) => createGenerationConsumer(connectSlaGenerationPersistence, (payload) => buildGenerationClock(em, payload))).scoped(),
    connectSlaReparentConsumer: asFunction((connectSlaReparentPersistence: ReparentPersistence) =>
      createReparentConsumer(connectSlaReparentPersistence),
    ).scoped(),
    connectSlaRebuildService: asFunction((connectSlaRebuildSink: RebuildSink, connectSlaRebuildRunStore: RebuildRunStore) => {
      const health = createConnectSlaDependencyHealth(container)
      const progress = resolveRebuildProgress(container)
      const worker = createLeasedRebuildWorker(connectSlaRebuildRunStore, health.connectCaseSlaReader as ConnectCaseSlaReader | null, connectSlaRebuildSink, progress)
      return { rebuild: (scope: { tenantId: string; organizationId: string }, runId: string, pageSize: number) => worker.run(scope, runId, randomUUID(), pageSize) }
    }).scoped(),
  })
}

function resolveRebuildProgress(container: AppContainer) {
  type Service = {
    startJob(id: string, scope: Record<string, unknown>): Promise<unknown>
    incrementProgress(id: string, count: number, scope: Record<string, unknown>): Promise<unknown>
    isCancellationRequested(id: string, tenantId: string, organizationId: string): Promise<boolean>
    completeJob(id: string, input: Record<string, unknown>, scope: Record<string, unknown>): Promise<unknown>
    failJob(id: string, input: { errorMessage: string }, scope: Record<string, unknown>): Promise<unknown>
    markCancelled(id: string, scope: Record<string, unknown>): Promise<unknown>
  }
  let service: Service
  try { service = container.resolve('progressService') as Service } catch { return null }
  return {
    start: async (id: string, scope: { tenantId: string; organizationId: string }) => { await service.startJob(id, scope) },
    increment: async (id: string, count: number, scope: { tenantId: string; organizationId: string }) => { await service.incrementProgress(id, count, scope) },
    isCancelled: (id: string, scope: { tenantId: string; organizationId: string }) => service.isCancellationRequested(id, scope.tenantId, scope.organizationId),
    complete: async (id: string, scope: { tenantId: string; organizationId: string }) => { await service.completeJob(id, {}, scope) },
    fail: async (id: string, scope: { tenantId: string; organizationId: string }, error: unknown) => { await service.failJob(id, { errorMessage: error instanceof Error ? error.message : 'connect_sla_rebuild_failed' }, scope) },
    cancelled: async (id: string, scope: { tenantId: string; organizationId: string }) => { await service.markCancelled(id, scope) },
  }
}

async function resolveClockRuntime(em: EntityManager, clock: ClockState) {
  const policyVersion = await em.findOneOrFail(PolicyVersion, { id: clock.policyVersionId })
  return {
    calendar: await loadBusinessCalendar(em, clock.calendarVersionId),
    resolutionTargetMinutes: policyVersion.resolutionTargetMinutes,
  }
}

async function loadBusinessCalendar(em: EntityManager, calendarVersionId: string): Promise<BusinessTimeCalendar> {
  const version = await em.findOneOrFail(BusinessCalendarVersion, { id: calendarVersionId })
  const [windows, holidays] = await Promise.all([
    em.find(BusinessWindow, { tenantId: version.tenantId, organizationId: version.organizationId, calendarVersionId }),
    em.find(
      BusinessHoliday,
      { tenantId: version.tenantId, organizationId: version.organizationId, calendarVersionId },
      { fields: ['id', 'localDate'] },
    ),
  ])
  return {
    timezone: version.timezone,
    windows: windows.map((window) => ({ weekday: window.weekday, startSecond: timeToSecond(window.localStart), endSecond: timeToSecond(window.localEnd) })),
    holidays: holidays.map((holiday) => holiday.localDate),
  }
}

export async function buildGenerationClock(em: EntityManager, payload: Record<string, unknown>) {
  const tenantId = stringField(payload, 'tenantId')
  const organizationId = stringField(payload, 'organizationId')
  const caseId = stringField(payload, 'caseId')
  const channelId = stringField(payload, 'channelId')
  const sourceEventId = stringField(payload, 'sourceEventId')
  const generation = numberField(payload, 'generation')
  const startedAt = dateField(payload, 'startedAt')
  if (!tenantId || !organizationId || !caseId || !channelId || !sourceEventId || generation === null || !startedAt) return null
  const policies = await em.find(Policy, { tenantId, organizationId, isActive: true, deletedAt: null })
  if (!policies.length) return null
  const versions = await em.find(PolicyVersion, {
    tenantId,
    organizationId,
    policyId: { $in: policies.map((policy) => policy.id) },
    effectiveFrom: { $lte: startedAt },
    channelId: { $in: [channelId, null] },
  })
  const policyById = new Map(policies.map((policy) => [policy.id, policy]))
  const latestVersions = new Map<string, PolicyVersion>()
  for (const version of versions) {
    const key = `${version.policyId}:${version.channelId ?? '*'}`
    const current = latestVersions.get(key)
    if (!current || version.effectiveFrom > current.effectiveFrom || (version.effectiveFrom.getTime() === current.effectiveFrom.getTime() && version.version > current.version)) latestVersions.set(key, version)
  }
  const candidates: PolicyMatchCandidate[] = [...latestVersions.values()].map((version) => {
    const policy = policyById.get(version.policyId) as Policy
    return {
      policyId: policy.id,
      policyVersionId: version.id,
      calendarVersionId: version.calendarVersionId,
      channelId: version.channelId,
      priority: policy.priority,
      effectiveFrom: version.effectiveFrom,
      isActive: policy.isActive,
      responseTargetMinutes: version.responseTargetMinutes,
      resolutionTargetMinutes: version.resolutionTargetMinutes,
    }
  })
  const candidate = matchPolicy(candidates, channelId, startedAt)
  if (!candidate) return null
  return { scope: { tenantId, organizationId }, sourceEventId, clock: createClock({ id: randomUUID(), caseId, generation, sourceEventId, startedAt, policy: candidate, calendar: await loadBusinessCalendar(em, candidate.calendarVersionId) }) }
}

function timeToSecond(value: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = value.split(':').map(Number)
  return hours * 3600 + minutes * 60 + seconds
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' && payload[key] ? payload[key] : null
}

function numberField(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === 'number' && Number.isInteger(payload[key]) && payload[key] >= 0 ? payload[key] : null
}

function dateField(payload: Record<string, unknown>, key: string): Date | null {
  const value = payload[key]
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
