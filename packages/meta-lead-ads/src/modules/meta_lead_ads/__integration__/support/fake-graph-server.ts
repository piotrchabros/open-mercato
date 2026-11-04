import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GraphLead } from '../../data/validators'
import type { GraphForm, GraphPageAccount } from '../../lib/graph-client'

export type FakeGraphFailMode = 'none' | '500' | '190' | 'leads_access'

export type FakeGraphState = {
  leads: Map<string, GraphLead>
  formsByPage: Map<string, GraphForm[]>
  pages: GraphPageAccount[]
  subscriptions: Map<string, boolean>
  failMode: FakeGraphFailMode
  calls: { method: string; path: string }[]
  user: { id: string; name: string }
  grantedScopes: string[]
}

export type FakeGraphServer = {
  baseUrl: string
  state: FakeGraphState
  close: () => Promise<void>
}

const VERSION_PREFIX = /^\/v\d+\.\d+(?=\/)/
const FAKE_SHORT_LIVED_TOKEN = 'fake-short-lived-user-token'
const FAKE_LONG_LIVED_TOKEN = 'fake-long-lived-user-token'
const LONG_LIVED_TTL_SECONDS = 60 * 24 * 60 * 60
const LEADS_ACCESS_PATTERN = /^\/[^/]+(\/leads|\/leadgen_forms)?$/
const DEFAULT_PAGE_LIMIT = 100

function createInitialState(): FakeGraphState {
  return {
    leads: new Map(),
    formsByPage: new Map(),
    pages: [],
    subscriptions: new Map(),
    failMode: 'none',
    calls: [],
    user: { id: 'fake-meta-user-1', name: 'Fake Meta User' },
    grantedScopes: ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'leads_retrieval'],
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function sendGraphError(res: ServerResponse, status: number, code: number, message: string, subcode?: number): void {
  sendJson(res, status, {
    error: {
      message,
      type: 'OAuthException',
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: 'FAKE_TRACE',
    },
  })
}

function applyFailMode(state: FakeGraphState, pathname: string, res: ServerResponse): boolean {
  if (state.failMode === '500') {
    sendGraphError(res, 500, 2, 'Fake service temporarily unavailable')
    return true
  }
  if (state.failMode === '190') {
    sendGraphError(res, 400, 190, 'Fake invalid access token', 460)
    return true
  }
  if (state.failMode === 'leads_access' && LEADS_ACCESS_PATTERN.test(pathname)) {
    sendGraphError(res, 403, 10, 'Fake missing leads access')
    return true
  }
  return false
}

function parseUnixParam(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readTimeFilters(filtering: string | null): { from: number | null; to: number | null } {
  if (!filtering) return { from: null, to: null }
  try {
    const parsed: unknown = JSON.parse(filtering)
    if (!Array.isArray(parsed)) return { from: null, to: null }
    let from: number | null = null
    let to: number | null = null
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const operator = (entry as { operator?: unknown }).operator
      const value = Number((entry as { value?: unknown }).value)
      if (!Number.isFinite(value)) continue
      if (operator === 'GREATER_THAN') from = value
      if (operator === 'LESS_THAN') to = value
    }
    return { from, to }
  } catch {
    return { from: null, to: null }
  }
}

function leadUnixTime(lead: GraphLead): number {
  const parsed = Date.parse(lead.created_time.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
}

function pageOf<Item>(items: Item[], url: URL): { data: Item[]; paging: Record<string, unknown> } {
  const limit = Math.min(parseUnixParam(url.searchParams.get('limit')) ?? DEFAULT_PAGE_LIMIT, DEFAULT_PAGE_LIMIT)
  const offset = Number(url.searchParams.get('after') ?? '0') || 0
  const slice = items.slice(offset, offset + limit)
  const hasNext = offset + limit < items.length
  const paging: Record<string, unknown> = { cursors: { before: String(offset), after: String(offset + limit) } }
  if (hasNext) paging.next = `${url.origin}${url.pathname}?after=${offset + limit}`
  return { data: slice, paging }
}

function handleRequest(state: FakeGraphState, req: IncomingMessage, res: ServerResponse): void {
  const method = (req.method ?? 'GET').toUpperCase()
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname.replace(VERSION_PREFIX, '')
  state.calls.push({ method, path: pathname })

  if (pathname === '/oauth/access_token') {
    const isExchange = url.searchParams.get('grant_type') === 'fb_exchange_token'
    sendJson(res, 200, {
      access_token: isExchange ? FAKE_LONG_LIVED_TOKEN : FAKE_SHORT_LIVED_TOKEN,
      token_type: 'bearer',
      expires_in: LONG_LIVED_TTL_SECONDS,
    })
    return
  }
  if (applyFailMode(state, pathname, res)) return

  if (pathname === '/me' && method === 'GET') {
    sendJson(res, 200, { id: state.user.id, name: state.user.name })
    return
  }
  if (pathname === '/me/permissions' && method === 'GET') {
    sendJson(res, 200, { data: state.grantedScopes.map((permission) => ({ permission, status: 'granted' })) })
    return
  }
  if (pathname === '/me/accounts' && method === 'GET') {
    const data = state.pages.map((page) => ({
      id: page.id,
      name: page.name,
      access_token: page.accessToken,
      tasks: page.tasks,
    }))
    sendJson(res, 200, { data, paging: { cursors: { before: '0', after: String(data.length) } } })
    return
  }
  if (pathname === '/debug_token' && method === 'GET') {
    sendJson(res, 200, {
      data: {
        is_valid: true,
        expires_at: Math.floor(Date.now() / 1000) + LONG_LIVED_TTL_SECONDS,
        scopes: state.grantedScopes,
        user_id: state.user.id,
      },
    })
    return
  }

  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 1 && method === 'GET') {
    const lead = state.leads.get(segments[0])
    if (!lead) {
      sendGraphError(res, 404, 100, 'Fake lead not found')
      return
    }
    sendJson(res, 200, lead)
    return
  }
  if (segments.length === 2) {
    const [ownerId, resource] = segments
    if (resource === 'leads' && method === 'GET') {
      const { from, to } = readTimeFilters(url.searchParams.get('filtering'))
      const matching = Array.from(state.leads.values())
        .filter((lead) => lead.form_id === ownerId)
        .filter((lead) => (from === null || leadUnixTime(lead) > from) && (to === null || leadUnixTime(lead) < to))
      sendJson(res, 200, pageOf(matching, url))
      return
    }
    if (resource === 'leadgen_forms' && method === 'GET') {
      const forms = (state.formsByPage.get(ownerId) ?? []).map((form) => ({
        id: form.id,
        name: form.name,
        locale: form.locale,
        status: form.status,
        questions: form.questions,
      }))
      sendJson(res, 200, pageOf(forms, url))
      return
    }
    if (resource === 'subscribed_apps') {
      if (method === 'POST') {
        state.subscriptions.set(ownerId, true)
        sendJson(res, 200, { success: true })
        return
      }
      if (method === 'DELETE') {
        state.subscriptions.set(ownerId, false)
        sendJson(res, 200, { success: true })
        return
      }
      if (method === 'GET') {
        const subscribed = state.subscriptions.get(ownerId) === true
        sendJson(res, 200, { data: subscribed ? [{ id: 'fake-app', subscribed_fields: ['leadgen'] }] : [] })
        return
      }
    }
  }
  sendGraphError(res, 404, 100, 'Fake unknown path')
}

export async function startFakeGraphServer(): Promise<FakeGraphServer> {
  const state = createInitialState()
  const host = process.env.OM_META_LEAD_ADS_FAKE_GRAPH_HOST?.trim() || '127.0.0.1'
  const server = createServer((req, res) => handleRequest(state, req, res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://${host}:${port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
