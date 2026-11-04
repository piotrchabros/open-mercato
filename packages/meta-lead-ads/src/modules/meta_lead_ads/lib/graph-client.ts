import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  GRAPH_DEFAULT_BASE_URL,
  GRAPH_LEAD_FIELDS,
  GRAPH_PAGE_LIMIT,
  GRAPH_TIMEOUT_MS,
  resolveGraphApiVersion,
  type MetaLeadErrorCode,
  type MetaPageSubscriptionStatus,
} from './constants'
import { PermanentLeadError, TransientLeadError } from './errors'
import { isTestOverrideAllowed } from './preset'
import { graphLeadSchema, type GraphFormQuestion, type GraphLead } from '../data/validators'

const logger = createLogger('meta_lead_ads')

const USAGE_HEADERS = ['x-app-usage', 'x-business-use-case-usage', 'x-page-usage'] as const
const USAGE_THRESHOLD_PERCENT = 90
const MAX_PAGES_FOLLOWED = 50
const TOKEN_EXPIRED_SUBCODE = 463
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613])
const TRANSIENT_CODES = new Set([1, 2])
const REVOKED_SUBCODES = new Set([458, 459, 467])
const PASSWORD_CHANGED_SUBCODE = 460

export type GraphCallOptions = { graphVersion?: string; baseUrl?: string | null }

export type GraphErrorClass =
  | 'token_invalid'
  | 'no_leads_access'
  | 'missing_permissions'
  | 'validation'
  | 'not_found'
  | 'rate_limited'
  | 'transient'
  | 'network'

export type GraphTokenReason = 'expired' | 'revoked' | 'password_changed' | 'unknown'

export type GraphErrorClassification = {
  errorClass: GraphErrorClass
  permanent: boolean
  leadErrorCode: MetaLeadErrorCode
  connectionStatus?: 'token_expired' | 'invalid'
  pageStatus?: MetaPageSubscriptionStatus
  tokenReason?: GraphTokenReason
}

export type GraphPaging = { after: string | null; hasNext: boolean }
export type GraphPageAccount = { id: string; name: string; accessToken: string | null; tasks: string[] }
export type GraphForm = {
  id: string
  name: string
  locale: string | null
  status: string | null
  questions: GraphFormQuestion[]
}
export type GraphTokenInfo = {
  isValid: boolean
  expiresAt: Date | null
  scopes: string[]
  userId: string | null
  errorCode: number | null
  errorSubcode: number | null
}
export type GraphUser = { id: string; name: string | null }
export type GraphAppCredentials = { appId: string; appSecret: string }
export type GraphTokenExchangeResult = { accessToken: string; expiresAt: Date | null }

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readGraphErrorBody(body: unknown) {
  const error = asRecord(asRecord(body)?.error)
  return {
    code: asNumber(error?.code),
    subcode: asNumber(error?.error_subcode),
    type: asString(error?.type),
    message: asString(error?.message),
    fbtraceId: asString(error?.fbtrace_id),
  }
}

function resolveTokenReason(subcode: number | null): GraphTokenReason {
  if (subcode === TOKEN_EXPIRED_SUBCODE) return 'expired'
  if (subcode === PASSWORD_CHANGED_SUBCODE) return 'password_changed'
  if (subcode !== null && REVOKED_SUBCODES.has(subcode)) return 'revoked'
  return 'unknown'
}

const LEADS_ACCESS_MESSAGE = /leads?[\s_]*(access|retrieval)/i

export function classifyGraphError(input: {
  status: number | null
  body?: unknown
  cause?: unknown
}): GraphErrorClassification {
  const { status } = input
  const { code, subcode, message } = readGraphErrorBody(input.body)

  if (code === 190 || (code === null && status === 401)) {
    const tokenReason = resolveTokenReason(subcode)
    return {
      errorClass: 'token_invalid',
      permanent: true,
      leadErrorCode: 'token_invalid',
      connectionStatus: tokenReason === 'expired' ? 'token_expired' : 'invalid',
      pageStatus: 'token_expired',
      tokenReason,
    }
  }
  if (code === 10 || (code === null && status === 403)) {
    return {
      errorClass: 'no_leads_access',
      permanent: true,
      leadErrorCode: 'no_leads_access',
      pageStatus: 'no_leads_access',
    }
  }
  if (code !== null && code >= 200 && code <= 299) {
    return {
      errorClass: 'missing_permissions',
      permanent: true,
      leadErrorCode: 'no_leads_access',
      pageStatus: 'missing_permissions',
    }
  }
  if (code === 100) {
    if (status === 404) return { errorClass: 'not_found', permanent: true, leadErrorCode: 'validation' }
    if (message && LEADS_ACCESS_MESSAGE.test(message)) {
      return {
        errorClass: 'no_leads_access',
        permanent: true,
        leadErrorCode: 'no_leads_access',
        pageStatus: 'no_leads_access',
      }
    }
    return { errorClass: 'validation', permanent: true, leadErrorCode: 'validation' }
  }
  if ((code !== null && RATE_LIMIT_CODES.has(code)) || status === 429) {
    return { errorClass: 'rate_limited', permanent: false, leadErrorCode: 'graph_rate_limited' }
  }
  if ((code !== null && TRANSIENT_CODES.has(code)) || (status !== null && status >= 500)) {
    return { errorClass: 'transient', permanent: false, leadErrorCode: 'graph_transient' }
  }
  if (status === null && input.cause !== undefined) {
    return { errorClass: 'network', permanent: false, leadErrorCode: 'network' }
  }
  return { errorClass: 'transient', permanent: false, leadErrorCode: 'graph_transient' }
}

export class MetaGraphError extends Error {
  readonly status: number | null
  readonly code: number | null
  readonly subcode: number | null
  readonly fbtraceId: string | null
  readonly classification: GraphErrorClassification

  constructor(input: {
    status: number | null
    code?: number | null
    subcode?: number | null
    fbtraceId?: string | null
    classification: GraphErrorClassification
  }) {
    const statusLabel = input.status === null ? 'no response' : `HTTP ${input.status}`
    super(`[internal] Graph API call failed (${input.classification.errorClass}, ${statusLabel})`)
    this.name = 'MetaGraphError'
    this.status = input.status
    this.code = input.code ?? null
    this.subcode = input.subcode ?? null
    this.fbtraceId = input.fbtraceId ?? null
    this.classification = input.classification
  }
}

export function toLeadError(error: MetaGraphError): TransientLeadError | PermanentLeadError {
  const { classification } = error
  if (classification.permanent) return new PermanentLeadError(classification.leadErrorCode, error.message)
  return new TransientLeadError(classification.leadErrorCode, error.message)
}

export function parseGraphTime(value: string): Date | null {
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function resolveGraphBaseUrl(options?: GraphCallOptions): string {
  const overridesAllowed = isTestOverrideAllowed()
  const fromOptions = overridesAllowed ? options?.baseUrl?.trim() : null
  const fromEnv = overridesAllowed ? process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL?.trim() : null
  return (fromOptions || fromEnv || GRAPH_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export interface MetaGraphClient {
  getLead(leadId: string, pageToken: string, options?: GraphCallOptions): Promise<GraphLead>
  listFormLeads(
    input: { metaFormId: string; pageToken: string; fromUnix?: number; toUnix?: number; after?: string | null; limit?: number },
    options?: GraphCallOptions,
  ): Promise<{ leads: GraphLead[]; paging: GraphPaging }>
  listPageForms(
    input: { metaPageId: string; pageToken: string; after?: string | null },
    options?: GraphCallOptions,
  ): Promise<{ forms: GraphForm[]; paging: GraphPaging }>
  listUserPages(userToken: string, options?: GraphCallOptions): Promise<GraphPageAccount[]>
  subscribePage(metaPageId: string, pageToken: string, options?: GraphCallOptions): Promise<void>
  getPageSubscription(
    metaPageId: string,
    pageToken: string,
    options?: GraphCallOptions,
  ): Promise<{ subscribed: boolean; fields: string[] }>
  unsubscribePage(metaPageId: string, pageToken: string, options?: GraphCallOptions): Promise<void>
  probeLeadsAccess(metaPageId: string, pageToken: string, options?: GraphCallOptions): Promise<void>
  debugToken(inputToken: string, app: GraphAppCredentials, options?: GraphCallOptions): Promise<GraphTokenInfo>
  exchangeCodeForToken(
    input: { code: string; redirectUri: string; appId: string; appSecret: string },
    options?: GraphCallOptions,
  ): Promise<GraphTokenExchangeResult>
  exchangeToken(
    input: { shortLivedToken: string; appId: string; appSecret: string },
    options?: GraphCallOptions,
  ): Promise<GraphTokenExchangeResult>
  getMe(userToken: string, options?: GraphCallOptions): Promise<GraphUser>
  getPermissions(userToken: string, options?: GraphCallOptions): Promise<string[]>
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

type RequestInput = {
  method?: 'GET' | 'POST' | 'DELETE'
  path: string
  query: Record<string, string | number | undefined | null>
  options?: GraphCallOptions
  checkUsage?: boolean
}

function readUsagePercent(headers: Headers): number {
  let highest = 0
  for (const headerName of USAGE_HEADERS) {
    const raw = headers.get(headerName)
    if (!raw) continue
    const matches = raw.match(/"(?:call_count|total_time|total_cputime)"\s*:\s*(\d+(?:\.\d+)?)/g) ?? []
    for (const match of matches) {
      const value = Number(match.split(':')[1])
      if (Number.isFinite(value) && value > highest) highest = value
    }
  }
  return highest
}

function buildValidationError(status: number): MetaGraphError {
  return new MetaGraphError({
    status,
    classification: { errorClass: 'validation', permanent: true, leadErrorCode: 'validation' },
  })
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readPaging(body: UnknownRecord | null): GraphPaging {
  const paging = asRecord(body?.paging)
  const cursors = asRecord(paging?.cursors)
  const hasNext = typeof paging?.next === 'string' && paging.next.length > 0
  return { after: hasNext ? asString(cursors?.after) : null, hasNext }
}

function readQuestionOptions(value: unknown): string[] | undefined {
  const options = asArray(value)
    .map((option) => {
      if (typeof option === 'string') return option
      const record = asRecord(option)
      return asString(record?.value) ?? asString(record?.key)
    })
    .filter((option): option is string => option !== null)
  return options.length > 0 ? options : undefined
}

function readForm(value: unknown): GraphForm | null {
  const record = asRecord(value)
  const id = asString(record?.id)
  if (!record || !id) return null
  const questions: GraphFormQuestion[] = []
  for (const rawQuestion of asArray(record.questions)) {
    const question = asRecord(rawQuestion)
    const key = asString(question?.key)
    if (!question || !key) continue
    const options = readQuestionOptions(question.options)
    questions.push({
      key,
      label: asString(question.label) ?? key,
      type: asString(question.type) ?? 'CUSTOM',
      ...(options ? { options } : {}),
    })
  }
  return {
    id,
    name: asString(record.name) ?? id,
    locale: asString(record.locale),
    status: asString(record.status),
    questions,
  }
}

function readExpiry(body: UnknownRecord | null): Date | null {
  const expiresIn = asNumber(body?.expires_in)
  return expiresIn !== null && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null
}

function readAccessToken(body: UnknownRecord | null, status: number): string {
  const accessToken = asString(body?.access_token)
  if (!accessToken) throw buildValidationError(status)
  return accessToken
}

export function createMetaGraphClient(settings: { fetchImpl?: FetchImpl; timeoutMs?: number } = {}): MetaGraphClient {
  const fetchImpl: FetchImpl = settings.fetchImpl ?? ((input, init) => fetch(input, init))
  const timeoutMs = settings.timeoutMs ?? GRAPH_TIMEOUT_MS

  async function request(input: RequestInput): Promise<UnknownRecord | null> {
    const version = input.options?.graphVersion?.trim() || resolveGraphApiVersion()
    const url = new URL(`${resolveGraphBaseUrl(input.options)}/${version}/${input.path.replace(/^\/+/, '')}`)
    for (const [key, value] of Object.entries(input.query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    let text: string
    try {
      response = await fetchImpl(url.toString(), { method: input.method ?? 'GET', signal: controller.signal })
      text = await response.text()
    } catch (cause) {
      throw new MetaGraphError({
        status: null,
        classification: classifyGraphError({ status: null, cause: cause ?? 'network' }),
      })
    } finally {
      clearTimeout(timer)
    }

    const body = parseJson(text)
    if (!response.ok) {
      const details = readGraphErrorBody(body)
      throw new MetaGraphError({
        status: response.status,
        code: details.code,
        subcode: details.subcode,
        fbtraceId: details.fbtraceId,
        classification: classifyGraphError({ status: response.status, body }),
      })
    }

    const usagePercent = readUsagePercent(response.headers)
    if (usagePercent > 0) logger.debug('Graph usage headers received', { path: input.path, usagePercent })
    if (input.checkUsage && usagePercent >= USAGE_THRESHOLD_PERCENT) {
      throw new MetaGraphError({
        status: response.status,
        classification: { errorClass: 'rate_limited', permanent: false, leadErrorCode: 'graph_rate_limited' },
      })
    }
    return asRecord(body)
  }

  function parseLead(value: unknown, status = 200): GraphLead {
    const parsed = graphLeadSchema.safeParse(value)
    if (!parsed.success) throw buildValidationError(status)
    return parsed.data
  }

  return {
    async getLead(leadId, pageToken, options) {
      const body = await request({
        path: leadId,
        query: { fields: GRAPH_LEAD_FIELDS, access_token: pageToken },
        options,
      })
      return parseLead(body)
    },

    async listFormLeads(input, options) {
      const filters: { field: string; operator: string; value: number }[] = []
      if (input.fromUnix !== undefined) filters.push({ field: 'time_created', operator: 'GREATER_THAN', value: input.fromUnix })
      if (input.toUnix !== undefined) filters.push({ field: 'time_created', operator: 'LESS_THAN', value: input.toUnix })
      const body = await request({
        path: `${input.metaFormId}/leads`,
        query: {
          fields: GRAPH_LEAD_FIELDS,
          filtering: filters.length > 0 ? JSON.stringify(filters) : undefined,
          limit: Math.min(input.limit ?? GRAPH_PAGE_LIMIT, GRAPH_PAGE_LIMIT),
          after: input.after,
          access_token: input.pageToken,
        },
        options,
        checkUsage: true,
      })
      return { leads: asArray(body?.data).map((entry) => parseLead(entry)), paging: readPaging(body) }
    },

    async listPageForms(input, options) {
      const body = await request({
        path: `${input.metaPageId}/leadgen_forms`,
        query: {
          fields: 'id,name,locale,status,questions{key,label,type,options}',
          limit: GRAPH_PAGE_LIMIT,
          after: input.after,
          access_token: input.pageToken,
        },
        options,
      })
      const forms = asArray(body?.data)
        .map((entry) => readForm(entry))
        .filter((form): form is GraphForm => form !== null)
      return { forms, paging: readPaging(body) }
    },

    async listUserPages(userToken, options) {
      const pages: GraphPageAccount[] = []
      let after: string | null = null
      for (let iteration = 0; iteration < MAX_PAGES_FOLLOWED; iteration += 1) {
        const body = await request({
          path: 'me/accounts',
          query: { fields: 'id,name,access_token,tasks', limit: GRAPH_PAGE_LIMIT, after, access_token: userToken },
          options,
        })
        for (const entry of asArray(body?.data)) {
          const record = asRecord(entry)
          const id = asString(record?.id)
          if (!record || !id) continue
          pages.push({
            id,
            name: asString(record.name) ?? id,
            accessToken: asString(record.access_token),
            tasks: asArray(record.tasks).filter((task): task is string => typeof task === 'string'),
          })
        }
        const paging = readPaging(body)
        if (!paging.hasNext || !paging.after) break
        after = paging.after
      }
      return pages
    },

    async subscribePage(metaPageId, pageToken, options) {
      await request({
        method: 'POST',
        path: `${metaPageId}/subscribed_apps`,
        query: { subscribed_fields: 'leadgen', access_token: pageToken },
        options,
      })
    },

    async getPageSubscription(metaPageId, pageToken, options) {
      const body = await request({
        path: `${metaPageId}/subscribed_apps`,
        query: { access_token: pageToken },
        options,
      })
      const fields = new Set<string>()
      for (const entry of asArray(body?.data)) {
        for (const field of asArray(asRecord(entry)?.subscribed_fields)) {
          if (typeof field === 'string') fields.add(field)
        }
      }
      return { subscribed: fields.has('leadgen'), fields: Array.from(fields) }
    },

    async unsubscribePage(metaPageId, pageToken, options) {
      await request({
        method: 'DELETE',
        path: `${metaPageId}/subscribed_apps`,
        query: { access_token: pageToken },
        options,
      })
    },

    async probeLeadsAccess(metaPageId, pageToken, options) {
      await request({
        path: `${metaPageId}/leadgen_forms`,
        query: { fields: 'id', limit: 1, access_token: pageToken },
        options,
      })
    },

    async debugToken(inputToken, app, options) {
      const body = await request({
        path: 'debug_token',
        query: { input_token: inputToken, access_token: `${app.appId}|${app.appSecret}` },
        options,
      })
      const data = asRecord(body?.data)
      if (!data) throw buildValidationError(200)
      const error = asRecord(data.error)
      const expiresAtSeconds = asNumber(data.expires_at)
      return {
        isValid: data.is_valid === true,
        expiresAt: expiresAtSeconds && expiresAtSeconds > 0 ? new Date(expiresAtSeconds * 1000) : null,
        scopes: asArray(data.scopes).filter((scope): scope is string => typeof scope === 'string'),
        userId: asString(data.user_id),
        errorCode: asNumber(error?.code),
        errorSubcode: asNumber(error?.subcode),
      }
    },

    async exchangeCodeForToken(input, options) {
      const body = await request({
        path: 'oauth/access_token',
        query: {
          client_id: input.appId,
          client_secret: input.appSecret,
          redirect_uri: input.redirectUri,
          code: input.code,
        },
        options,
      })
      return { accessToken: readAccessToken(body, 200), expiresAt: readExpiry(body) }
    },

    async exchangeToken(input, options) {
      const body = await request({
        path: 'oauth/access_token',
        query: {
          grant_type: 'fb_exchange_token',
          client_id: input.appId,
          client_secret: input.appSecret,
          fb_exchange_token: input.shortLivedToken,
        },
        options,
      })
      return { accessToken: readAccessToken(body, 200), expiresAt: readExpiry(body) }
    },

    async getMe(userToken, options) {
      const body = await request({ path: 'me', query: { fields: 'id,name', access_token: userToken }, options })
      const id = asString(body?.id)
      if (!id) throw buildValidationError(200)
      return { id, name: asString(body?.name) }
    },

    async getPermissions(userToken, options) {
      const body = await request({ path: 'me/permissions', query: { access_token: userToken }, options })
      return asArray(body?.data)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is UnknownRecord => entry !== null && entry.status === 'granted')
        .map((entry) => asString(entry.permission))
        .filter((permission): permission is string => permission !== null)
    },
  }
}

let cachedClient: MetaGraphClient | null = null

export function getMetaGraphClient(): MetaGraphClient {
  if (!cachedClient) cachedClient = createMetaGraphClient()
  return cachedClient
}

export function setMetaGraphClient(client: MetaGraphClient | null): void {
  cachedClient = client
}
