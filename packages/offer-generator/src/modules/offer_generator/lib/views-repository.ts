import { TRACKING } from './constants'
import type { OfferGeneratorScope } from './settings'

const VIEWS_LIMIT = 200
const MAX_SECTION_KEYS = 60
const SECTION_KEY_MAX = 64
const SECTION_LABEL_MAX = 120
const VIEW_TTL_HOURS = 12
const ACTIVE_MS_GRACE = 5000

export type ViewsQueryRunner = {
  getConnection(): {
    execute(sql: string, params?: unknown[]): Promise<unknown[]>
  }
}

export type InsertViewInput = {
  viewKey: string
  tenantId: string
  organizationId: string
  offerId: string
  visitorId: string
  ipHash: string | null
  country: string | null
  device: string
  browser: string
  os: string
  referrer: string | null
  isInternal: boolean
}

export type SectionDwellInput = { k: string; l: string; ms: number }

export type TouchViewInput = {
  viewKey: string
  offerId: string
  activeMs: number
  scrollPct: number
  sections?: SectionDwellInput[]
}

export type RecordFirstViewOffer = { id: string; tenantId: string; organizationId: string }

export type OfferInsightsStats = {
  views: number
  uniqueVisitors: number
  totalActiveMs: number
  avgActiveMs: number
  internalViews: number
  firstViewedAt: string | null
  lastViewAt: string | null
  avgMaxScrollPct: number
}

export type OfferViewRow = {
  id: string
  startedAt: string
  lastSeenAt: string
  visitorNo: number
  country: string | null
  device: string
  browser: string
  os: string
  referrer: string | null
  isInternal: boolean
  activeMs: number
  maxScrollPct: number
  sectionsSeen: number
}

export type OfferSectionInsight = {
  key: string
  label: string
  viewers: number
  totalMs: number
  avgMs: number
}

export type OfferInsightsDto = {
  stats: OfferInsightsStats
  views: OfferViewRow[]
  truncated: boolean
  sections: OfferSectionInsight[]
}

type Row = Record<string, unknown>

function asRow(value: unknown): Row {
  return value && typeof value === 'object' ? (value as Row) : {}
}

function cut(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max)
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function sectionOrder(key: string): number {
  const match = /^(\d+)/.exec(key)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

async function run(em: ViewsQueryRunner, sql: string, params: unknown[]): Promise<Row[]> {
  const rows = await em.getConnection().execute(sql, params)
  return Array.isArray(rows) ? rows.map(asRow) : []
}

export function normalizeSectionsPatch(
  sections: SectionDwellInput[] | undefined,
): Record<string, { l: string; ms: number }> {
  const patch: Record<string, { l: string; ms: number }> = {}
  if (!sections) return patch
  for (const section of sections) {
    const key = section.k.trim().slice(0, SECTION_KEY_MAX)
    if (!key) continue
    const ms = clampInt(section.ms, 0, TRACKING.MAX_ACTIVE_MS)
    const label = section.l.trim().slice(0, SECTION_LABEL_MAX)
    const existing = patch[key]
    if (existing) {
      existing.ms = Math.max(existing.ms, ms)
      if (!existing.l && label) existing.l = label
      continue
    }
    if (Object.keys(patch).length >= MAX_SECTION_KEYS) continue
    patch[key] = { l: label, ms }
  }
  return patch
}

export async function insertView(em: ViewsQueryRunner, input: InsertViewInput): Promise<boolean> {
  const ipHash = cut(input.ipHash, 64)
  const rows = await run(
    em,
    `INSERT INTO offer_generator_offer_views
  (id, view_key, tenant_id, organization_id, offer_id, visitor_id, ip_hash, country, device, browser, os, referrer, is_internal, started_at, last_seen_at, active_ms, max_scroll_pct, beats, sections, created_at)
SELECT gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::uuid, ?::varchar, ?::varchar, ?::varchar, ?::varchar, ?::varchar, ?::varchar, ?::boolean, now(), now(), 0, 0, 0, '{}'::jsonb, now()
WHERE (SELECT count(*) FROM offer_generator_offer_views WHERE offer_id = ?::uuid AND started_at > now() - interval '1 day') < ?::int
  AND (?::varchar IS NULL OR (SELECT count(*) FROM offer_generator_offer_views WHERE offer_id = ?::uuid AND ip_hash = ?::varchar AND started_at > now() - interval '1 hour') < ?::int)
ON CONFLICT (view_key) DO NOTHING
RETURNING view_key`,
    [
      input.viewKey,
      input.tenantId,
      input.organizationId,
      input.offerId,
      input.visitorId,
      ipHash,
      cut(input.country, 2),
      cut(input.device, 16),
      cut(input.browser, 32),
      cut(input.os, 32),
      cut(input.referrer, 300),
      input.isInternal,
      input.offerId,
      TRACKING.MAX_VIEWS_PER_OFFER_PER_DAY,
      ipHash,
      input.offerId,
      ipHash,
      TRACKING.MAX_VIEWS_PER_IP_PER_HOUR,
    ],
  )
  return rows.length === 1
}

export async function touchView(em: ViewsQueryRunner, input: TouchViewInput): Promise<boolean> {
  const patch = normalizeSectionsPatch(input.sections)
  const rows = await run(
    em,
    `UPDATE offer_generator_offer_views v SET
  last_seen_at = now(),
  active_ms = GREATEST(v.active_ms, LEAST(?::int, ?::int, (EXTRACT(EPOCH FROM (now() - v.started_at)) * 1000)::int + ?::int)),
  max_scroll_pct = GREATEST(v.max_scroll_pct, LEAST(GREATEST(?::int, 0), 100)),
  beats = v.beats + 1,
  sections = CASE WHEN ?::jsonb = '{}'::jsonb THEN v.sections ELSE (
    SELECT COALESCE(jsonb_object_agg(merged.key, merged.value), '{}'::jsonb)
    FROM (
      SELECT COALESCE(prev.key, incoming.key) AS key,
        CASE
          WHEN prev.value IS NULL THEN incoming.value
          WHEN incoming.value IS NULL THEN prev.value
          ELSE jsonb_build_object(
            'l', COALESCE(NULLIF(incoming.value->>'l', ''), prev.value->>'l', ''),
            'ms', GREATEST(COALESCE((prev.value->>'ms')::numeric, 0), COALESCE((incoming.value->>'ms')::numeric, 0))
          )
        END AS value
      FROM jsonb_each(v.sections) AS prev(key, value)
      FULL OUTER JOIN jsonb_each(?::jsonb) AS incoming(key, value) ON prev.key = incoming.key
      WHERE prev.key IS NOT NULL
        OR (SELECT count(*) FROM jsonb_object_keys(v.sections)) < ?::int
    ) merged
  ) END
WHERE v.view_key = ?::uuid AND v.offer_id = ?::uuid AND v.beats < ?::int AND v.started_at > now() - interval '${VIEW_TTL_HOURS} hours'
RETURNING v.view_key`,
    [
      clampInt(input.activeMs, 0, TRACKING.MAX_ACTIVE_MS),
      TRACKING.MAX_ACTIVE_MS,
      ACTIVE_MS_GRACE,
      clampInt(input.scrollPct, 0, 100),
      JSON.stringify(patch),
      JSON.stringify(patch),
      MAX_SECTION_KEYS,
      input.viewKey,
      input.offerId,
      TRACKING.MAX_BEATS,
    ],
  )
  return rows.length === 1
}

export async function recordFirstView(
  em: ViewsQueryRunner,
  offer: RecordFirstViewOffer,
  options: { internal: boolean },
): Promise<{ firstView: boolean }> {
  if (options.internal) return { firstView: false }
  const rows = await run(
    em,
    `WITH prev AS (
  SELECT id, viewed_at FROM offer_generator_offers
  WHERE id = ?::uuid AND tenant_id = ?::uuid AND organization_id = ?::uuid AND deleted_at IS NULL
  FOR UPDATE
)
UPDATE offer_generator_offers o SET
  view_count = o.view_count + 1,
  last_viewed_at = now(),
  viewed_at = COALESCE(o.viewed_at, now()),
  status = CASE WHEN o.status = 'sent' THEN 'viewed' ELSE o.status END
FROM prev
WHERE o.id = prev.id
RETURNING (prev.viewed_at IS NULL) AS first_view`,
    [offer.id, offer.tenantId, offer.organizationId],
  )
  const row = rows[0]
  return { firstView: row ? row.first_view === true : false }
}

async function loadStats(em: ViewsQueryRunner, scope: OfferGeneratorScope, offerId: string): Promise<OfferInsightsStats> {
  const rows = await run(
    em,
    `SELECT count(*) FILTER (WHERE NOT is_internal)::int AS views,
  count(DISTINCT visitor_id) FILTER (WHERE NOT is_internal)::int AS unique_visitors,
  COALESCE(sum(active_ms) FILTER (WHERE NOT is_internal), 0)::float8 AS total_active_ms,
  count(*) FILTER (WHERE is_internal)::int AS internal_views,
  min(started_at) FILTER (WHERE NOT is_internal) AS first_viewed_at,
  max(started_at) FILTER (WHERE NOT is_internal) AS last_view_at,
  COALESCE(avg(max_scroll_pct) FILTER (WHERE NOT is_internal), 0)::float8 AS avg_max_scroll_pct
FROM offer_generator_offer_views
WHERE offer_id = ?::uuid AND tenant_id = ?::uuid AND organization_id = ?::uuid`,
    [offerId, scope.tenantId, scope.organizationId],
  )
  const row = rows[0] ?? {}
  const views = toNumber(row.views)
  const totalActiveMs = toNumber(row.total_active_ms)
  return {
    views,
    uniqueVisitors: toNumber(row.unique_visitors),
    totalActiveMs,
    avgActiveMs: views ? Math.round(totalActiveMs / views) : 0,
    internalViews: toNumber(row.internal_views),
    firstViewedAt: toIso(row.first_viewed_at),
    lastViewAt: toIso(row.last_view_at),
    avgMaxScrollPct: Math.round(toNumber(row.avg_max_scroll_pct)),
  }
}

async function loadViews(
  em: ViewsQueryRunner,
  scope: OfferGeneratorScope,
  offerId: string,
  limit: number,
): Promise<OfferViewRow[]> {
  const rows = await run(
    em,
    `SELECT v.id::text AS id, v.started_at, v.last_seen_at, fv.visitor_no::int AS visitor_no, v.country, v.device, v.browser, v.os,
  v.referrer, v.is_internal, v.active_ms, v.max_scroll_pct,
  (SELECT count(*) FROM jsonb_object_keys(v.sections))::int AS sections_seen
FROM offer_generator_offer_views v
JOIN (
  SELECT visitor_id, dense_rank() OVER (ORDER BY min(started_at), visitor_id) AS visitor_no
  FROM offer_generator_offer_views
  WHERE offer_id = ?::uuid AND tenant_id = ?::uuid AND organization_id = ?::uuid
  GROUP BY visitor_id
) fv USING (visitor_id)
WHERE v.offer_id = ?::uuid AND v.tenant_id = ?::uuid AND v.organization_id = ?::uuid
ORDER BY v.started_at DESC, v.id
LIMIT ?::int`,
    [offerId, scope.tenantId, scope.organizationId, offerId, scope.tenantId, scope.organizationId, limit],
  )
  return rows.map((row) => ({
    id: String(row.id ?? ''),
    startedAt: toIso(row.started_at) ?? '',
    lastSeenAt: toIso(row.last_seen_at) ?? '',
    visitorNo: toNumber(row.visitor_no),
    country: toNullableString(row.country),
    device: toNullableString(row.device) ?? 'other',
    browser: toNullableString(row.browser) ?? 'other',
    os: toNullableString(row.os) ?? 'other',
    referrer: toNullableString(row.referrer),
    isInternal: row.is_internal === true,
    activeMs: toNumber(row.active_ms),
    maxScrollPct: toNumber(row.max_scroll_pct),
    sectionsSeen: toNumber(row.sections_seen),
  }))
}

async function loadSections(
  em: ViewsQueryRunner,
  scope: OfferGeneratorScope,
  offerId: string,
): Promise<OfferSectionInsight[]> {
  const rows = await run(
    em,
    `SELECT s.key, max(s.value->>'l') AS label, count(DISTINCT v.visitor_id)::int AS viewers,
  COALESCE(sum((s.value->>'ms')::numeric), 0)::float8 AS total_ms
FROM offer_generator_offer_views v
CROSS JOIN LATERAL jsonb_each(v.sections) AS s(key, value)
WHERE v.offer_id = ?::uuid AND v.tenant_id = ?::uuid AND v.organization_id = ?::uuid AND NOT v.is_internal
  AND COALESCE((s.value->>'ms')::numeric, 0) > 0
GROUP BY s.key`,
    [offerId, scope.tenantId, scope.organizationId],
  )
  return rows
    .map((row) => {
      const key = String(row.key ?? '')
      const viewers = toNumber(row.viewers)
      const totalMs = Math.round(toNumber(row.total_ms))
      return {
        key,
        label: toNullableString(row.label) ?? key,
        viewers,
        totalMs,
        avgMs: viewers ? Math.round(totalMs / viewers) : 0,
      }
    })
    .filter((section) => section.key.length > 0)
    .sort((a, b) => sectionOrder(a.key) - sectionOrder(b.key) || a.key.localeCompare(b.key))
}

export async function getOfferInsights(
  em: ViewsQueryRunner,
  scope: OfferGeneratorScope,
  offerId: string,
): Promise<OfferInsightsDto> {
  const [stats, rows, sections] = await Promise.all([
    loadStats(em, scope, offerId),
    loadViews(em, scope, offerId, VIEWS_LIMIT + 1),
    loadSections(em, scope, offerId),
  ])
  return {
    stats,
    views: rows.slice(0, VIEWS_LIMIT),
    truncated: rows.length > VIEWS_LIMIT,
    sections,
  }
}
