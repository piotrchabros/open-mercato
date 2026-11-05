export type InsightsDimension = 'device' | 'browser' | 'os'

const KNOWN_VALUES: Record<InsightsDimension, readonly string[]> = {
  device: ['desktop', 'mobile', 'tablet', 'other'],
  browser: ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other'],
  os: ['windows', 'macos', 'ios', 'android', 'linux', 'other'],
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function resolveInsightValueKey(dimension: InsightsDimension, value: string): string {
  const normalized = value.trim().toLowerCase()
  return KNOWN_VALUES[dimension].includes(normalized) ? normalized : 'other'
}

export function formatReferrerHost(referrer: string | null): string | null {
  if (!referrer) return null
  try {
    return new URL(referrer).hostname.replace(/^www\./, '') || null
  } catch {
    return referrer
  }
}

export function toTimestamp(iso: string | null): number | null {
  if (!iso) return null
  const parsed = new Date(iso).getTime()
  return Number.isNaN(parsed) ? null : parsed
}
