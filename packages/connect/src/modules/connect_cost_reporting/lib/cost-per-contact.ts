import {
  COST_PER_CONTACT_FORMULA_VERSION,
  allocatedCostSummarySchema,
  availableReportSchema,
  denominatorSummarySchema,
  type AllocatedCostSummary,
  type AvailableReport,
  type DenominatorSummary,
} from '../data/validators'

type Rational = { numerator: bigint; denominator: bigint }

function gcd(left: bigint, right: bigint): bigint {
  let currentLeft = left < 0n ? -left : left
  let currentRight = right < 0n ? -right : right
  while (currentRight !== 0n) {
    const remainder = currentLeft % currentRight
    currentLeft = currentRight
    currentRight = remainder
  }
  return currentLeft
}

export function reduceRational(value: Rational): Rational {
  if (value.denominator <= 0n || value.numerator < 0n) throw new Error('[internal] invalid rational')
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n }
  const divisor = gcd(value.numerator, value.denominator)
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor }
}

export function addRationals(left: Rational, right: Rational): Rational {
  return reduceRational({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  })
}

export function roundRational(value: Rational): bigint {
  const reduced = reduceRational(value)
  const quotient = reduced.numerator / reduced.denominator
  const remainder = reduced.numerator % reduced.denominator
  return quotient + (remainder * 2n >= reduced.denominator ? 1n : 0n)
}

function parseRational(value: { numerator: string; denominator: string }): Rational {
  return reduceRational({ numerator: BigInt(value.numerator), denominator: BigInt(value.denominator) })
}

export function composeCostPerContactReport(input: {
  from: string
  to: string
  cost: AllocatedCostSummary
  denominator: DenominatorSummary
}): AvailableReport {
  const cost = allocatedCostSummarySchema.parse(input.cost)
  const denominator = denominatorSummarySchema.parse(input.denominator)
  const byType = new Map(cost.byType.map((entry) => [entry.type, parseRational(entry.allocatedMinor)]))
  const zero = { numerator: 0n, denominator: 1n }
  const agent = byType.get('agent') ?? zero
  const channel = byType.get('channel') ?? zero
  const ai = byType.get('ai') ?? zero
  const total = addRationals(addRationals(agent, channel), ai)

  return availableReportSchema.parse({
    capability: 'available',
    formulaVersion: COST_PER_CONTACT_FORMULA_VERSION,
    from: input.from,
    to: input.to,
    currencyCode: cost.currencyCode,
    totals: {
      agentMinor: roundRational(agent).toString(),
      channelMinor: roundRational(channel).toString(),
      aiMinor: roundRational(ai).toString(),
      totalMinor: roundRational(total).toString(),
    },
    denominator: denominator.count,
    costPerContactMinor: denominator.count === 0
      ? null
      : roundRational({ numerator: total.numerator, denominator: total.denominator * BigInt(denominator.count) }).toString(),
    matchedInputCount: cost.matchedInputCount,
    costSourceVersion: cost.contractVersion,
    denominatorSourceVersion: denominator.contractVersion,
    costGeneratedAt: cost.generatedAt,
    denominatorGeneratedAt: denominator.generatedAt,
  })
}
