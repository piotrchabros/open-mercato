export type MetricsPercentiles = {
  p50Seconds?: number | null
  p90Seconds?: number | null
  sampleCount: number
}

export type MetricsProjectionLag = {
  p50Ms: number | null
  p90Ms: number | null
  maxMs: number | null
  sampleCount: number
  failed: number
}

export type MetricsDay = {
  utcDate: string
  inboundClaimed: number
  casesOpened: number
  casesAttached: number
  inboundSuppressed: number
  inboundDeadLettered: number
  /** Must be 0 on a complete day. Anything else means receipts are stuck. */
  unreconciled: number
  outboundAttempted: number
  outboundSent: number
  outboundFailed: number
  outboundUnknown: number
  unknownMaxAgeSeconds: number | null
  casesAssigned: number
  casesResolved: number
  casesReopened: number
  /** Null when the population is empty — never a zero-second percentile. */
  firstResponse: MetricsPercentiles | null
  elapsedAssignedToResolution: MetricsPercentiles | null
  /** Null when the Customer Projection capability produced no samples. */
  projectionLag: MetricsProjectionLag | null
  suppression: {
    observedMaxPermittedPerSender: number
    appliedCountLimit: number | null
    withinLimit: boolean | null
  }
  generatedAt: string
  stale: boolean
}

export type MetricsSummary = {
  from: string
  to: string
  completeDays: number
  requestedDays: number
  days: MetricsDay[]
  totals: {
    inboundClaimed: number
    casesOpened: number
    casesAttached: number
    inboundSuppressed: number
    inboundDeadLettered: number
    unreconciled: number
    outboundAttempted: number
    outboundSent: number
    outboundFailed: number
    outboundUnknown: number
    casesResolved: number
    casesReopened: number
  } | null
  baselineMaturity: {
    completeDays: number
    requiredDays: number
    mature: boolean
  }
}

export type ExceptionType = 'unreconciled_inbound' | 'dead_lettered' | 'unknown_send' | 'projection_failed'

export type ExceptionsResponse = {
  type: ExceptionType
  total: number
  page: number
  pageSize: number
  items: Array<Record<string, unknown>>
}
