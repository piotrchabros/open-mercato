export const COUNTRY_CALLING_CODES: Record<string, string> = {
  AT: '43',
  BE: '32',
  BG: '359',
  CA: '1',
  CH: '41',
  CY: '357',
  CZ: '420',
  DE: '49',
  DK: '45',
  EE: '372',
  ES: '34',
  FI: '358',
  FR: '33',
  GB: '44',
  GR: '30',
  HR: '385',
  HU: '36',
  IE: '353',
  IT: '39',
  LT: '370',
  LU: '352',
  LV: '371',
  MT: '356',
  NL: '31',
  NO: '47',
  PL: '48',
  PT: '351',
  RO: '40',
  SE: '46',
  SI: '386',
  SK: '421',
  UA: '380',
  US: '1',
}

export type PhoneNormalizationResult = {
  raw: string
  e164: string | null
  usableForMatching: boolean
}

const DEFAULT_COUNTRY = 'PL'
const MIN_DIGITS = 7
const MAX_DIGITS = 15
const SEPARATORS = /[\s\-.()/]/g

const unusable = (raw: string): PhoneNormalizationResult => ({ raw, e164: null, usableForMatching: false })

const usable = (raw: string, digits: string): PhoneNormalizationResult => ({
  raw,
  e164: `+${digits}`,
  usableForMatching: true,
})

const isWithinLength = (digits: string): boolean => digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS

export function normalizePhoneToE164(raw: string, defaultCountry?: string | null): PhoneNormalizationResult {
  const stripped = (raw ?? '').trim().replace(SEPARATORS, '')
  if (!stripped) return unusable(raw)

  const international = stripped.startsWith('+')
    ? stripped.slice(1)
    : stripped.startsWith('00')
      ? stripped.slice(2)
      : null

  if (international !== null) {
    if (!/^\d+$/.test(international) || !isWithinLength(international)) return unusable(raw)
    return usable(raw, international)
  }

  if (!/^\d+$/.test(stripped) || !isWithinLength(stripped)) return unusable(raw)
  const callingCode = COUNTRY_CALLING_CODES[(defaultCountry ?? DEFAULT_COUNTRY).toUpperCase()]
  if (!callingCode) return unusable(raw)
  const national = stripped.replace(/^0/, '')
  const digits = `${callingCode}${national}`
  if (digits.length > MAX_DIGITS) return unusable(raw)
  return usable(raw, digits)
}
