import {
  MetaGraphError,
  classifyGraphError,
  createMetaGraphClient,
  getMetaGraphClient,
  parseGraphTime,
  resolveGraphBaseUrl,
  setMetaGraphClient,
  toLeadError,
  type MetaGraphClient,
} from '../lib/graph-client'
import { PermanentLeadError, TransientLeadError } from '../lib/errors'

const TOKEN = 'EAAB-secret-page-token'

function errorBody(code: number, subcode?: number, message = 'Meta says: token EAAB-secret-page-token bad') {
  return { error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'trace123' } }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('classifyGraphError', () => {
  it.each([
    [undefined, 'invalid'],
    [463, 'token_expired'],
    [460, 'invalid'],
    [458, 'invalid'],
    [467, 'invalid'],
  ])('maps code 190 subcode %s to token_invalid / %s', (subcode, connectionStatus) => {
    const result = classifyGraphError({ status: 400, body: errorBody(190, subcode) })
    expect(result).toMatchObject({
      errorClass: 'token_invalid',
      permanent: true,
      leadErrorCode: 'token_invalid',
      connectionStatus,
      pageStatus: 'token_expired',
    })
  })

  it('reports token reasons', () => {
    expect(classifyGraphError({ status: 400, body: errorBody(190, 463) }).tokenReason).toBe('expired')
    expect(classifyGraphError({ status: 400, body: errorBody(190, 460) }).tokenReason).toBe('password_changed')
    expect(classifyGraphError({ status: 400, body: errorBody(190, 458) }).tokenReason).toBe('revoked')
    expect(classifyGraphError({ status: 400, body: errorBody(190, 999) }).tokenReason).toBe('unknown')
  })

  it('treats a bare HTTP 401 as token_invalid', () => {
    expect(classifyGraphError({ status: 401 }).errorClass).toBe('token_invalid')
  })

  it('maps code 10 and bare 403 to no_leads_access', () => {
    for (const result of [classifyGraphError({ status: 400, body: errorBody(10) }), classifyGraphError({ status: 403 })]) {
      expect(result).toMatchObject({
        errorClass: 'no_leads_access',
        permanent: true,
        leadErrorCode: 'no_leads_access',
        pageStatus: 'no_leads_access',
      })
    }
  })

  it('maps 200-299 to missing_permissions', () => {
    for (const code of [200, 210, 299]) {
      expect(classifyGraphError({ status: 403, body: errorBody(code) })).toMatchObject({
        errorClass: 'missing_permissions',
        permanent: true,
        leadErrorCode: 'no_leads_access',
        pageStatus: 'missing_permissions',
      })
    }
  })

  it('maps code 100 variants', () => {
    expect(classifyGraphError({ status: 404, body: errorBody(100) })).toMatchObject({
      errorClass: 'not_found',
      leadErrorCode: 'validation',
      permanent: true,
    })
    expect(classifyGraphError({ status: 400, body: errorBody(100, undefined, 'Invalid parameter') })).toMatchObject({
      errorClass: 'validation',
      leadErrorCode: 'validation',
    })
    expect(
      classifyGraphError({ status: 400, body: errorBody(100, undefined, 'The app lacks Leads Access for this page') }),
    ).toMatchObject({ errorClass: 'no_leads_access', permanent: true })
  })

  it.each([4, 17, 32, 613])('maps code %s to rate_limited', (code) => {
    expect(classifyGraphError({ status: 400, body: errorBody(code) })).toMatchObject({
      errorClass: 'rate_limited',
      permanent: false,
      leadErrorCode: 'graph_rate_limited',
    })
  })

  it('maps HTTP 429 to rate_limited', () => {
    expect(classifyGraphError({ status: 429 }).errorClass).toBe('rate_limited')
  })

  it('maps 5xx and codes 1/2 to transient', () => {
    for (const result of [
      classifyGraphError({ status: 500 }),
      classifyGraphError({ status: 503, body: 'bad gateway' }),
      classifyGraphError({ status: 400, body: errorBody(1) }),
      classifyGraphError({ status: 400, body: errorBody(2) }),
    ]) {
      expect(result).toMatchObject({ errorClass: 'transient', permanent: false, leadErrorCode: 'graph_transient' })
    }
  })

  it('maps transport failures to network', () => {
    expect(classifyGraphError({ status: null, cause: new Error('getaddrinfo ENOTFOUND') })).toMatchObject({
      errorClass: 'network',
      permanent: false,
      leadErrorCode: 'network',
    })
  })

  it('defaults unknown combinations to transient', () => {
    expect(classifyGraphError({ status: 418, body: errorBody(9999) })).toMatchObject({
      errorClass: 'transient',
      permanent: false,
    })
    expect(classifyGraphError({ status: null })).toMatchObject({ errorClass: 'transient', permanent: false })
  })
})

describe('parseGraphTime', () => {
  it('parses a +0000 offset', () => {
    expect(parseGraphTime('2026-11-04T10:19:58+0000')?.toISOString()).toBe('2026-11-04T10:19:58.000Z')
  })

  it('returns null for invalid input', () => {
    expect(parseGraphTime('not a date')).toBeNull()
  })
})

describe('resolveGraphBaseUrl', () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults to graph.facebook.com', () => {
    delete process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL
    expect(resolveGraphBaseUrl()).toBe('https://graph.facebook.com')
  })

  it('honours option and env overrides outside production', () => {
    process.env.NODE_ENV = 'test'
    expect(resolveGraphBaseUrl({ baseUrl: 'http://fake:9000/' })).toBe('http://fake:9000')
    process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL = 'http://env:1'
    expect(resolveGraphBaseUrl()).toBe('http://env:1')
  })

  it('ignores overrides in production unless OM_INTEGRATION_TEST=true', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.OM_INTEGRATION_TEST
    process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL = 'http://env:1'
    expect(resolveGraphBaseUrl({ baseUrl: 'http://fake:9000' })).toBe('https://graph.facebook.com')
    process.env.OM_INTEGRATION_TEST = 'true'
    expect(resolveGraphBaseUrl({ baseUrl: 'http://fake:9000' })).toBe('http://fake:9000')
  })
})

describe('graph client requests', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    delete process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function stubClient(responder: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
    const fetchImpl = jest.fn(async (input: string, init?: RequestInit) => responder(new URL(input), init))
    return { fetchImpl, client: createMetaGraphClient({ fetchImpl, timeoutMs: 50 }) }
  }

  it('builds the lead URL with version, fields and token', async () => {
    const { fetchImpl, client } = stubClient(() =>
      jsonResponse({ id: '1', created_time: '2026-11-04T10:19:58+0000', form_id: '2', field_data: [] }),
    )
    const lead = await client.getLead('1', TOKEN, { graphVersion: 'v23.0', baseUrl: 'http://fake:9000' })
    expect(lead.id).toBe('1')
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('http://fake:9000/v23.0/1')
    expect(url.searchParams.get('fields')).toContain('field_data')
    expect(url.searchParams.get('access_token')).toBe(TOKEN)
  })

  it('builds the form leads listing with filtering, limit and paging', async () => {
    const { fetchImpl, client } = stubClient(() =>
      jsonResponse({
        data: [{ id: '1', created_time: '2026-11-04T10:19:58+0000', form_id: '2', field_data: [] }],
        paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
      }),
    )
    const result = await client.listFormLeads({
      metaFormId: '55',
      pageToken: TOKEN,
      fromUnix: 100,
      toUnix: 200,
      limit: 500,
    })
    const url = new URL(fetchImpl.mock.calls[0][0])
    expect(url.pathname.endsWith('/55/leads')).toBe(true)
    expect(url.searchParams.get('limit')).toBe('100')
    expect(JSON.parse(url.searchParams.get('filtering') as string)).toEqual([
      { field: 'time_created', operator: 'GREATER_THAN', value: 100 },
      { field: 'time_created', operator: 'LESS_THAN', value: 200 },
    ])
    expect(result.paging).toEqual({ after: 'CUR', hasNext: true })
    expect(result.leads).toHaveLength(1)
  })

  it('treats a high usage header as transient rate limiting on list calls', async () => {
    const { client } = stubClient(() =>
      jsonResponse({ data: [] }, 200, { 'x-app-usage': '{"call_count":95,"total_time":10,"total_cputime":10}' }),
    )
    await expect(client.listFormLeads({ metaFormId: '55', pageToken: TOKEN })).rejects.toMatchObject({
      classification: { errorClass: 'rate_limited', permanent: false },
    })
  })

  it('lists forms with normalized questions', async () => {
    const { client } = stubClient(() =>
      jsonResponse({
        data: [
          {
            id: '9',
            name: 'Form',
            locale: 'pl_PL',
            status: 'ACTIVE',
            questions: [{ key: 'email', label: 'Email', type: 'EMAIL' }, { key: 'size', type: 'CUSTOM', options: [{ key: 'a', value: 'Small' }] }],
          },
        ],
      }),
    )
    const result = await client.listPageForms({ metaPageId: '1', pageToken: TOKEN })
    expect(result.forms[0].questions).toEqual([
      { key: 'email', label: 'Email', type: 'EMAIL' },
      { key: 'size', label: 'size', type: 'CUSTOM', options: ['Small'] },
    ])
  })

  it('follows paging when listing user pages', async () => {
    let call = 0
    const { fetchImpl, client } = stubClient(() => {
      call += 1
      return call === 1
        ? jsonResponse({ data: [{ id: '1', name: 'A', access_token: 'tok-a', tasks: ['MANAGE'] }], paging: { cursors: { after: 'C1' }, next: 'x' } })
        : jsonResponse({ data: [{ id: '2', name: 'B' }] })
    })
    const pages = await client.listUserPages(TOKEN)
    expect(pages).toEqual([
      { id: '1', name: 'A', accessToken: 'tok-a', tasks: ['MANAGE'] },
      { id: '2', name: 'B', accessToken: null, tasks: [] },
    ])
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('after')).toBe('C1')
  })

  it('uses POST/DELETE for subscription changes and reads subscription state', async () => {
    const { fetchImpl, client } = stubClient((url, init) =>
      init?.method === 'GET'
        ? jsonResponse({ data: [{ subscribed_fields: ['leadgen'] }] })
        : jsonResponse({ success: true }),
    )
    await client.subscribePage('1', TOKEN)
    await client.unsubscribePage('1', TOKEN)
    expect(await client.getPageSubscription('1', TOKEN)).toEqual({ subscribed: true, fields: ['leadgen'] })
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'DELETE', 'GET'])
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('subscribed_fields')).toBe('leadgen')
  })

  it('returns granted permissions only and token info', async () => {
    const permissions = stubClient(() =>
      jsonResponse({ data: [{ permission: 'leads_retrieval', status: 'granted' }, { permission: 'x', status: 'declined' }] }),
    )
    expect(await permissions.client.getPermissions(TOKEN)).toEqual(['leads_retrieval'])

    const debug = stubClient(() =>
      jsonResponse({ data: { is_valid: true, expires_at: 1762250400, scopes: ['a'], user_id: '7' } }),
    )
    const info = await debug.client.debugToken(TOKEN, { appId: '1', appSecret: 'sec' })
    expect(info).toMatchObject({ isValid: true, scopes: ['a'], userId: '7', errorCode: null })
    expect(info.expiresAt?.getTime()).toBe(1762250400000)
  })

  it('exchanges tokens', async () => {
    const { fetchImpl, client } = stubClient(() => jsonResponse({ access_token: 'long', expires_in: 3600 }))
    const result = await client.exchangeToken({ shortLivedToken: 'short', appId: '1', appSecret: 'sec' })
    expect(result.accessToken).toBe('long')
    expect(result.expiresAt).toBeInstanceOf(Date)
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('grant_type')).toBe('fb_exchange_token')
  })

  it('throws classified MetaGraphError on API errors without leaking tokens or Meta messages', async () => {
    const { client } = stubClient(() => jsonResponse(errorBody(190, 463), 400))
    const error = await client.getLead('1', TOKEN).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MetaGraphError)
    const graphError = error as MetaGraphError
    expect(graphError.classification.errorClass).toBe('token_invalid')
    expect(graphError.fbtraceId).toBe('trace123')
    expect(graphError.code).toBe(190)
    expect(graphError.subcode).toBe(463)
    expect(graphError.message.startsWith('[internal]')).toBe(true)
    expect(graphError.message).not.toContain(TOKEN)
    expect(graphError.message).not.toContain('Meta says')
    expect(JSON.stringify(graphError)).not.toContain(TOKEN)
  })

  it('does not leak the token on network failures', async () => {
    const { client } = stubClient(() => {
      throw new Error(`connect failed for https://graph.facebook.com/1?access_token=${TOKEN}`)
    })
    const error = (await client.getLead('1', TOKEN).catch((caught: unknown) => caught)) as MetaGraphError
    expect(error.classification.errorClass).toBe('network')
    expect(error.message).not.toContain(TOKEN)
    expect(error.cause).toBeUndefined()
  })

  it('aborts after the timeout and classifies as network', async () => {
    const { client } = stubClient(
      (url, init) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const error = (await client.getLead('1', TOKEN).catch((caught: unknown) => caught)) as MetaGraphError
    expect(error.classification.errorClass).toBe('network')
  })

  it('classifies HTTP 500 with an HTML body as transient', async () => {
    const { client } = stubClient(() => new Response('<html>oops</html>', { status: 502 }))
    await expect(client.getLead('1', TOKEN)).rejects.toMatchObject({
      classification: { errorClass: 'transient', permanent: false },
    })
  })

  it('rejects malformed lead payloads as validation errors', async () => {
    const { client } = stubClient(() => jsonResponse({ nope: true }))
    await expect(client.getLead('1', TOKEN)).rejects.toMatchObject({
      classification: { errorClass: 'validation', permanent: true },
    })
  })
})

describe('toLeadError', () => {
  it('maps permanent classifications to PermanentLeadError and others to TransientLeadError', () => {
    const permanent = new MetaGraphError({ status: 400, classification: classifyGraphError({ status: 400, body: errorBody(190) }) })
    const transient = new MetaGraphError({ status: 500, classification: classifyGraphError({ status: 500 }) })
    expect(toLeadError(permanent)).toBeInstanceOf(PermanentLeadError)
    expect(toLeadError(permanent)).toMatchObject({ leadErrorCode: 'token_invalid' })
    expect(toLeadError(transient)).toBeInstanceOf(TransientLeadError)
    expect(toLeadError(transient)).toMatchObject({ leadErrorCode: 'graph_transient' })
  })
})

describe('client cache', () => {
  afterEach(() => setMetaGraphClient(null))

  it('returns the override and falls back to a default client', () => {
    const override = { getLead: jest.fn() } as unknown as MetaGraphClient
    setMetaGraphClient(override)
    expect(getMetaGraphClient()).toBe(override)
    setMetaGraphClient(null)
    expect(getMetaGraphClient()).not.toBe(override)
  })
})
