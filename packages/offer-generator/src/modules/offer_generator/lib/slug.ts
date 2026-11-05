import crypto from 'crypto'
import { ACCESS_TOKEN_LENGTH, PUBLIC_PATH_PREFIX } from './constants'

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_PATTERN = new RegExp(`^[a-z0-9]{${ACCESS_TOKEN_LENGTH}}$`)
const MAX_NUMBERED_SUFFIX = 99
const TAKEN_SLUGS_LIMIT = 200

export type SlugQueryRunner = {
  getConnection(): {
    execute(sql: string, params?: unknown[]): Promise<unknown[]>
  }
}

export type TakenSlugsLookup = (base: string) => Promise<string[]>

export function slugifyClientName(input: string): string {
  return input
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function buildBaseSlug(clientName: string, now: Date = new Date()): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${slugifyClientName(clientName) || 'oferta'}-${year}-${month}`
}

export function generateAccessToken(): string {
  let token = ''
  for (let index = 0; index < ACCESS_TOKEN_LENGTH; index += 1) {
    token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)]
  }
  return token
}

export function buildOfferSegment(slug: string, accessToken: string): string {
  return `${slug}-${accessToken}`
}

export function parseOfferSegment(segment: string): { slug: string; token: string } | null {
  const index = segment.lastIndexOf('-')
  if (index < 1) return null
  const slug = segment.slice(0, index)
  const token = segment.slice(index + 1)
  if (!TOKEN_PATTERN.test(token)) return null
  return { slug, token }
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return crypto.timingSafeEqual(bufferA, bufferB)
}

function randomSuffix(): string {
  return crypto.randomBytes(2).toString('hex')
}

export async function ensureUniqueSlugWith(lookup: TakenSlugsLookup, base: string): Promise<string> {
  let taken: Set<string>
  try {
    taken = new Set(await lookup(base))
  } catch {
    return `${base}-${randomSuffix()}`
  }
  if (!taken.has(base)) return base
  for (let counter = 2; counter <= MAX_NUMBERED_SUFFIX; counter += 1) {
    const candidate = `${base}-${counter}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${randomSuffix()}`
}

export async function ensureUniqueSlug(em: SlugQueryRunner, base: string): Promise<string> {
  return ensureUniqueSlugWith(async (prefix) => {
    const rows = await em
      .getConnection()
      .execute('select slug from offer_generator_offers where slug like ? limit ?', [
        `${prefix}%`,
        TAKEN_SLUGS_LIMIT,
      ])
    return rows
      .map((row) => (row as { slug?: unknown }).slug)
      .filter((slug): slug is string => typeof slug === 'string')
  }, base)
}

export function buildPublicOfferUrl(
  segment: string,
  baseUrl: string | undefined = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL,
): string {
  const origin = (baseUrl ?? '').replace(/\/+$/, '')
  return `${origin}${PUBLIC_PATH_PREFIX}/${segment}`
}
