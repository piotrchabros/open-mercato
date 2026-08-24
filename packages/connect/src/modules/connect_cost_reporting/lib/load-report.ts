import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { CostPerContactSourceResolver } from '../di'
import {
  COST_PER_CONTACT_FORMULA_VERSION,
  allocatedCostSummarySchema,
  denominatorSummarySchema,
  unavailableReportSchema,
  type ReportResponse,
  type UnavailableReason,
} from '../data/validators'
import { composeCostPerContactReport } from './cost-per-contact'

const SOURCE_TIMEOUT_MS = 2_000

type SourceKind = 'cost' | 'denominator'
type SourceFailure = { failure: 'timeout' | 'error' | 'initializing' }

function unavailable(reason: UnavailableReason): ReportResponse {
  return unavailableReportSchema.parse({
    capability: 'unavailable',
    formulaVersion: COST_PER_CONTACT_FORMULA_VERSION,
    reason,
    totals: null,
    denominator: null,
    costPerContactMinor: null,
  })
}

function isInitializing(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && (error as { code?: unknown }).code === 'initializing'
}

async function bounded<T>(promise: Promise<T>): Promise<T | SourceFailure> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.catch((error: unknown) => ({ failure: isInitializing(error) ? 'initializing' : 'error' }) as SourceFailure),
      new Promise<SourceFailure>((resolve) => {
        timeout = setTimeout(() => resolve({ failure: 'timeout' }), SOURCE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function failureReason(kind: SourceKind, failure: SourceFailure['failure']): UnavailableReason {
  if (kind === 'cost') {
    if (failure === 'timeout') return 'cost_source_timeout'
    if (failure === 'initializing') return 'cost_source_initializing'
    return 'cost_source_error'
  }
  if (failure === 'timeout') return 'denominator_source_timeout'
  if (failure === 'initializing') return 'lineage_initializing'
  return 'denominator_source_error'
}

export async function loadCostPerContactReport(input: {
  container: AppContainer
  tenantId: string
  organizationId: string
  from: string
  to: string
  currencyCode: string
  financialAuthorized: boolean
}): Promise<ReportResponse> {
  if (!input.financialAuthorized) return unavailable('not_authorized')
  const resolver = input.container.resolve<CostPerContactSourceResolver>('connectCostReportingSourceResolver')
  const costSource = resolver.cost()
  if (costSource.status !== 'available') {
    return unavailable(costSource.status === 'module_disabled' ? 'cost_module_disabled' : 'cost_reader_unavailable')
  }
  const denominatorSource = resolver.denominator()
  if (denominatorSource.status !== 'available') {
    return unavailable(denominatorSource.status === 'module_disabled' ? 'connect_module_disabled' : 'denominator_reader_unavailable')
  }

  const [costResult, denominatorResult] = await Promise.all([
    bounded<Awaited<ReturnType<typeof costSource.reader.summarizeAllocated>>>(costSource.reader.summarizeAllocated({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      periodStart: new Date(input.from),
      periodEnd: new Date(input.to),
      currencyCode: input.currencyCode,
    })),
    bounded<Awaited<ReturnType<typeof denominatorSource.reader.countCanonicalRoots>>>(denominatorSource.reader.countCanonicalRoots({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      from: input.from,
      to: input.to,
    })),
  ])

  if ('failure' in costResult) return unavailable(failureReason('cost', costResult.failure))
  if ('failure' in denominatorResult) return unavailable(failureReason('denominator', denominatorResult.failure))

  const cost = allocatedCostSummarySchema.safeParse(costResult)
  if (!cost.success) {
    const version = typeof costResult === 'object' && costResult !== null && 'contractVersion' in costResult
      ? costResult.contractVersion
      : null
    return unavailable(version !== 'connect_analytics.allocated_cost.v1'
      ? 'cost_contract_version_unsupported'
      : 'cost_source_error')
  }
  const denominator = denominatorSummarySchema.safeParse(denominatorResult)
  if (!denominator.success) {
    const version = typeof denominatorResult === 'object' && denominatorResult !== null && 'contractVersion' in denominatorResult
      ? denominatorResult.contractVersion
      : null
    return unavailable(version !== 'connect.contact_root_created.v1'
      ? 'denominator_contract_version_unsupported'
      : 'denominator_source_error')
  }

  return composeCostPerContactReport({
    from: input.from,
    to: input.to,
    cost: cost.data,
    denominator: denominator.data,
  })
}
