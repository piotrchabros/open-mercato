import type { ClockSourceEvent } from './clock-domain'
import type { SlaScope } from './async'

type Context = { resolve: <T = unknown>(name: string) => T }
type SourceConsumer = { apply: (scope: SlaScope, caseId: string, generation: number, source: ClockSourceEvent) => Promise<unknown> }
type ReparentConsumer = { apply: (event: 'split' | 'merged' | 'reparenting_undone', payload: Record<string, unknown>) => Promise<unknown> }
type GenerationConsumer = { apply: (payload: Record<string, unknown>) => Promise<unknown> }

export async function consumeGeneration(payload: Record<string, unknown>, context: Context): Promise<void> {
  const consumer = optionalResolve<GenerationConsumer>(context, 'connectSlaGenerationConsumer')
  if (consumer) await consumer.apply(payload)
}

export async function consumeSource(payload: Record<string, unknown>, context: Context, type: ClockSourceEvent['type']): Promise<void> {
  const consumer = optionalResolve<SourceConsumer>(context, 'connectSlaSourceConsumer')
  if (!consumer) return
  const tenantId = stringValue(payload.tenantId)
  const organizationId = stringValue(payload.organizationId)
  const caseId = stringValue(payload.caseId)
  const sourceEventId = stringValue(payload.sourceEventId)
  const generation = integerValue(payload.generation)
  const occurredAt = dateValue(payload.occurredAt)
  if (!tenantId || !organizationId || !caseId || !sourceEventId || generation === null || !occurredAt) return
  let source: ClockSourceEvent
  if (type === 'response') {
    const evidence = payload.responseEvidence
    if (evidence !== 'human' && evidence !== 'human_accepted_ai' && evidence !== 'unknown') return
    source = { type, sourceEventId, occurredAt, evidence }
  } else if (type === 'wait_ended') {
    const waitStartedAt = dateValue(payload.startedAt)
    if (!waitStartedAt) return
    source = { type, sourceEventId, occurredAt, waitStartedAt }
  } else source = { type, sourceEventId, occurredAt }
  await consumer.apply({ tenantId, organizationId }, caseId, generation, source)
}

export async function consumeReparent(payload: Record<string, unknown>, context: Context, type: 'split' | 'merged' | 'reparenting_undone'): Promise<void> {
  const consumer = optionalResolve<ReparentConsumer>(context, 'connectSlaReparentConsumer')
  if (consumer) await consumer.apply(type, payload)
}

function optionalResolve<T>(context: Context, name: string): T | null {
  try { return context.resolve<T>(name) } catch { return null }
}
function stringValue(value: unknown): string | null { return typeof value === 'string' && value ? value : null }
function integerValue(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null }
function dateValue(value: unknown): Date | null { const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date : null }
