import crypto from 'crypto'
import { TRACKING } from './constants'
import { trackingBodySchema, type TrackingBody } from '../data/validators'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IP_HASH_LENGTH = 32
const VISITOR_COOKIE_MAX_AGE_SECONDS = 34_560_000

export type { TrackingBody }

export type ParsedUserAgent = {
  device: 'desktop' | 'mobile' | 'tablet'
  browser: string
  os: string
}

const BOT_UA_RE = new RegExp(
  [
    'bot|crawl|spider|slurp|preview|scanner|headless|phantomjs|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|monitor',
    'facebookexternalhit|facebot|whatsapp\\/|telegrambot|slack-imgproxy|skypeuripreview|microsoftpreview|bingpreview|google-pagerenderer|googleimageproxy|google-safety|barracuda|mimecast|proofpoint|urlscan',
    'curl\\/|wget|python-requests|python-urllib|go-http-client|okhttp|axios|node-fetch|undici|java\\/|libwww',
  ].join('|'),
  'i',
)

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || !ua.trim()) return true
  return BOT_UA_RE.test(ua)
}

export function parseUserAgent(ua: string): ParsedUserAgent {
  let browser = 'other'
  if (/Edg/i.test(ua)) browser = 'Edge'
  else if (/OPR/.test(ua)) browser = 'Opera'
  else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome'
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox'
  else if (/Safari/i.test(ua)) browser = 'Safari'

  let os = 'other'
  if (/Windows/i.test(ua)) os = 'Windows'
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS'
  else if (/Android/i.test(ua)) os = 'Android'
  else if (/Linux|X11/i.test(ua)) os = 'Linux'

  let device: ParsedUserAgent['device'] = 'desktop'
  if (/iPad/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) device = 'tablet'
  else if (/iPhone|Android|Mobi/i.test(ua)) device = 'mobile'

  return { device, browser, os }
}

export function hashClientIp(ip: string): string {
  const secret = process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET || process.env.JWT_SECRET
  if (!secret) throw new Error('[internal] OM_OFFER_GENERATOR_IP_HASH_SECRET or JWT_SECRET must be set')
  return crypto.createHmac('sha256', secret).update(ip).digest('hex').slice(0, IP_HASH_LENGTH)
}

export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin')
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  const host = headers.get('host')
  if (host && originHost === host) return true
  const forwardedHost = headers.get('x-forwarded-host')
  return !!forwardedHost && originHost === forwardedHost
}

export function readVisitorCookie(headers: Headers): string | null {
  const cookie = headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== TRACKING.VISITOR_COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return UUID_RE.test(value) ? value : null
  }
  return null
}

export function buildVisitorCookie(visitorId: string, secure: boolean): string {
  return `${TRACKING.VISITOR_COOKIE}=${visitorId}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function parseTrackingBody(text: string): TrackingBody | null {
  if (Buffer.byteLength(text, 'utf8') > TRACKING.MAX_BODY_BYTES) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = trackingBodySchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
