import { TRACKING } from '../lib/constants'
import {
  getOfferInsights,
  insertView,
  normalizeSectionsPatch,
  recordFirstView,
  touchView,
  type ViewsQueryRunner,
} from '../lib/views-repository'

const OFFER_ID = '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60'
const TENANT_ID = '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61'
const ORG_ID = '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62'
const VIEW_KEY = '9c1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f63'
const VISITOR_ID = 'ad1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f64'

function buildRunner(responder: (sql: string, params: unknown[]) => unknown[]) {
  const execute = jest.fn(async (sql: string, params: unknown[] = []) => responder(sql, params))
  const runner: ViewsQueryRunner = { getConnection: () => ({ execute }) }
  return { runner, execute }
}

describe('normalizeSectionsPatch', () => {
  it('merges duplicate keys with the max dwell and keeps the first label', () => {
    expect(
      normalizeSectionsPatch([
        { k: '01-intro', l: 'Intro', ms: 1200 },
        { k: '01-intro', l: 'Other', ms: 3400 },
        { k: '02-pricing', l: 'Pricing', ms: 500.6 },
      ]),
    ).toEqual({ '01-intro': { l: 'Intro', ms: 3400 }, '02-pricing': { l: 'Pricing', ms: 501 } })
  })

  it('drops empty keys, clamps dwell and caps the key count', () => {
    const many = Array.from({ length: 70 }, (_, index) => ({ k: `s${index}`, l: '', ms: -5 }))
    const patch = normalizeSectionsPatch([{ k: '  ', l: 'x', ms: 10 }, ...many, { k: 'big', l: '', ms: 1e12 }])
    expect(Object.keys(patch)).toHaveLength(60)
    expect(patch.s0).toEqual({ l: '', ms: 0 })
    expect(patch.big).toBeUndefined()
    expect(normalizeSectionsPatch([{ k: 'big', l: '', ms: 1e12 }]).big.ms).toBe(TRACKING.MAX_ACTIVE_MS)
  })

  it('returns an empty patch when no sections are sent', () => {
    expect(normalizeSectionsPatch(undefined)).toEqual({})
  })
})

describe('touchView', () => {
  it('sends the normalized sections patch for a jsonb merge and reports success', async () => {
    const { runner, execute } = buildRunner(() => [{ view_key: VIEW_KEY }])
    const touched = await touchView(runner, {
      viewKey: VIEW_KEY,
      offerId: OFFER_ID,
      activeMs: 20000.4,
      scrollPct: 140,
      sections: [{ k: '01-intro', l: 'Intro', ms: 900 }],
    })
    expect(touched).toBe(true)
    const [sql, params] = execute.mock.calls[0]
    expect(sql).toContain('FULL OUTER JOIN jsonb_each(?::jsonb)')
    expect(sql).not.toContain('updated_at')
    expect(params).toEqual([
      20000,
      TRACKING.MAX_ACTIVE_MS,
      5000,
      100,
      JSON.stringify({ '01-intro': { l: 'Intro', ms: 900 } }),
      JSON.stringify({ '01-intro': { l: 'Intro', ms: 900 } }),
      60,
      VIEW_KEY,
      OFFER_ID,
      TRACKING.MAX_BEATS,
    ])
  })

  it('reports false when no row matched', async () => {
    const { runner } = buildRunner(() => [])
    expect(await touchView(runner, { viewKey: VIEW_KEY, offerId: OFFER_ID, activeMs: 1, scrollPct: 1 })).toBe(false)
  })
})

describe('insertView', () => {
  it('passes caps and a null ip hash so the per-IP cap is skipped', async () => {
    const { runner, execute } = buildRunner(() => [{ view_key: VIEW_KEY }])
    const counted = await insertView(runner, {
      viewKey: VIEW_KEY,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      offerId: OFFER_ID,
      visitorId: VISITOR_ID,
      ipHash: null,
      country: 'PLX',
      device: 'desktop',
      browser: 'Chrome',
      os: 'Windows',
      referrer: 'x'.repeat(400),
      isInternal: false,
    })
    expect(counted).toBe(true)
    const [sql, params] = execute.mock.calls[0]
    expect(sql).toContain('ON CONFLICT (view_key) DO NOTHING')
    expect(sql).toContain('?::varchar IS NULL OR')
    expect(params[6]).toBe('PL')
    expect((params[10] as string).length).toBe(300)
    expect(params.slice(13)).toEqual([
      TRACKING.MAX_VIEWS_PER_OFFER_PER_DAY,
      null,
      OFFER_ID,
      null,
      TRACKING.MAX_VIEWS_PER_IP_PER_HOUR,
    ])
  })

  it('reports false when capped or duplicated', async () => {
    const { runner } = buildRunner(() => [])
    const counted = await insertView(runner, {
      viewKey: VIEW_KEY,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      offerId: OFFER_ID,
      visitorId: VISITOR_ID,
      ipHash: 'abc',
      country: null,
      device: 'mobile',
      browser: 'Safari',
      os: 'iOS',
      referrer: null,
      isInternal: true,
    })
    expect(counted).toBe(false)
  })
})

describe('recordFirstView', () => {
  const offer = { id: OFFER_ID, tenantId: TENANT_ID, organizationId: ORG_ID }

  it('does nothing for internal views', async () => {
    const { runner, execute } = buildRunner(() => [])
    expect(await recordFirstView(runner, offer, { internal: true })).toEqual({ firstView: false })
    expect(execute).not.toHaveBeenCalled()
  })

  it('bumps counters without touching updated_at and reports the first view', async () => {
    const { runner, execute } = buildRunner(() => [{ first_view: true }])
    expect(await recordFirstView(runner, offer, { internal: false })).toEqual({ firstView: true })
    const [sql, params] = execute.mock.calls[0]
    expect(sql).not.toContain('updated_at')
    expect(sql).toContain("WHEN o.status = 'sent' THEN 'viewed'")
    expect(params).toEqual([OFFER_ID, TENANT_ID, ORG_ID])
  })

  it('reports a repeat view', async () => {
    const { runner } = buildRunner(() => [{ first_view: false }])
    expect(await recordFirstView(runner, offer, { internal: false })).toEqual({ firstView: false })
  })
})

describe('getOfferInsights', () => {
  it('maps stats, views and sections and orders sections by index', async () => {
    const started = new Date('2026-11-01T10:00:00.000Z')
    const { runner, execute } = buildRunner((sql) => {
      if (sql.includes('unique_visitors')) {
        return [
          {
            views: 2,
            unique_visitors: 1,
            total_active_ms: 30001,
            internal_views: 1,
            first_viewed_at: started,
            last_view_at: '2026-11-02T10:00:00.000Z',
            avg_max_scroll_pct: 62.5,
          },
        ]
      }
      if (sql.includes('visitor_no')) {
        return [
          {
            id: VIEW_KEY,
            started_at: started,
            last_seen_at: started,
            visitor_no: 1,
            country: null,
            device: 'desktop',
            browser: 'Chrome',
            os: 'Windows',
            referrer: null,
            is_internal: false,
            active_ms: 15000,
            max_scroll_pct: 80,
            sections_seen: 2,
          },
        ]
      }
      return [
        { key: '10-contact', label: 'Contact', viewers: 1, total_ms: 1000 },
        { key: '02-pricing', label: null, viewers: 2, total_ms: 3001 },
      ]
    })

    const insights = await getOfferInsights(runner, { tenantId: TENANT_ID, organizationId: ORG_ID }, OFFER_ID)

    expect(insights.stats).toEqual({
      views: 2,
      uniqueVisitors: 1,
      totalActiveMs: 30001,
      avgActiveMs: 15001,
      internalViews: 1,
      firstViewedAt: started.toISOString(),
      lastViewAt: '2026-11-02T10:00:00.000Z',
      avgMaxScrollPct: 63,
    })
    expect(insights.truncated).toBe(false)
    expect(insights.views[0]).toMatchObject({ id: VIEW_KEY, visitorNo: 1, sectionsSeen: 2, startedAt: started.toISOString() })
    expect(insights.sections).toEqual([
      { key: '02-pricing', label: '02-pricing', viewers: 2, totalMs: 3001, avgMs: 1501 },
      { key: '10-contact', label: 'Contact', viewers: 1, totalMs: 1000, avgMs: 1000 },
    ])
    for (const call of execute.mock.calls) {
      expect(call[1]).toEqual(expect.arrayContaining([OFFER_ID, TENANT_ID, ORG_ID]))
    }
  })

  it('truncates to 200 views', async () => {
    const row = { id: VIEW_KEY, started_at: new Date(), last_seen_at: new Date(), visitor_no: 1 }
    const { runner } = buildRunner((sql) => (sql.includes('visitor_no') ? Array.from({ length: 201 }, () => row) : []))
    const insights = await getOfferInsights(runner, { tenantId: TENANT_ID, organizationId: ORG_ID }, OFFER_ID)
    expect(insights.views).toHaveLength(200)
    expect(insights.truncated).toBe(true)
    expect(insights.stats.views).toBe(0)
  })
})
