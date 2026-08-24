export type ExactRational = {
  numerator: bigint
  denominator: bigint
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

export function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let dividend = absolute(left)
  let divisor = absolute(right)
  while (divisor !== 0n) {
    const remainder = dividend % divisor
    dividend = divisor
    divisor = remainder
  }
  return dividend
}

export function reduceRational(value: ExactRational): ExactRational {
  if (value.denominator === 0n) throw new Error('[internal] rational denominator cannot be zero')
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n }

  const sign = value.denominator < 0n ? -1n : 1n
  const numerator = value.numerator * sign
  const denominator = value.denominator * sign
  const divisor = greatestCommonDivisor(numerator, denominator)
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  }
}

export function addRationals(left: ExactRational, right: ExactRational): ExactRational {
  const divisor = greatestCommonDivisor(left.denominator, right.denominator)
  const leftFactor = right.denominator / divisor
  const rightFactor = left.denominator / divisor
  return reduceRational({
    numerator: left.numerator * leftFactor + right.numerator * rightFactor,
    denominator: left.denominator * leftFactor,
  })
}

export function serializeRational(value: ExactRational): { numerator: string; denominator: string } {
  const reduced = reduceRational(value)
  return {
    numerator: reduced.numerator.toString(),
    denominator: reduced.denominator.toString(),
  }
}
