export function formatCostAmount(
  amountMinor: string | null,
  currencyCode: string | null,
  locale: string,
  emptyLabel: string,
): string {
  if (!amountMinor || !/^\d+$/.test(amountMinor)) return emptyLabel

  const amount = BigInt(amountMinor)
  if (!currencyCode) return new Intl.NumberFormat(locale || undefined).format(amount)

  try {
    const currencyFormatter = new Intl.NumberFormat(locale || undefined, {
      style: 'currency',
      currency: currencyCode,
    })
    const fractionDigits = currencyFormatter.resolvedOptions().maximumFractionDigits ?? 2
    const scale = 10n ** BigInt(fractionDigits)
    const major = amount / scale
    const fraction = amount % scale
    const formattedMajor = new Intl.NumberFormat(locale || undefined).format(major)
    if (fractionDigits === 0) return `${formattedMajor} ${currencyCode}`

    const decimalSeparator = new Intl.NumberFormat(locale || undefined)
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.'
    return `${formattedMajor}${decimalSeparator}${fraction.toString().padStart(fractionDigits, '0')} ${currencyCode}`
  } catch {
    return `${new Intl.NumberFormat(locale || undefined).format(amount)} ${currencyCode}`
  }
}
