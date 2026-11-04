import { REQUIRED_SCOPES } from '../lib/constants'
import type { MetaGraphClient } from '../lib/graph-client'
import { buildMetaLoginDialogUrl, completeMetaOAuth, findMissingScopes } from '../lib/oauth'

describe('buildMetaLoginDialogUrl', () => {
  it('builds the Facebook Login for Business dialog URL', () => {
    const url = new URL(
      buildMetaLoginDialogUrl({
        appId: 'app-1',
        loginConfigId: 'cfg-9',
        redirectUri: 'https://crm.example.com/api/meta_lead_ads/oauth/callback',
        state: 'state-xyz',
        graphVersion: 'v24.0',
      }),
    )
    expect(url.origin).toBe('https://www.facebook.com')
    expect(url.pathname).toBe('/v24.0/dialog/oauth')
    expect(url.searchParams.get('client_id')).toBe('app-1')
    expect(url.searchParams.get('config_id')).toBe('cfg-9')
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('redirect_uri')).toBe('https://crm.example.com/api/meta_lead_ads/oauth/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('findMissingScopes', () => {
  it('returns nothing when all required scopes are granted', () => {
    expect(findMissingScopes([...REQUIRED_SCOPES, 'public_profile'])).toEqual([])
  })

  it('returns the required scopes that were not granted', () => {
    expect(findMissingScopes(['pages_show_list', 'leads_retrieval'])).toEqual([
      'pages_manage_metadata',
      'pages_read_engagement',
    ])
  })
})

describe('completeMetaOAuth', () => {
  it('exchanges the code, upgrades to a long-lived token and loads the user', async () => {
    const expiresAt = new Date('2027-01-01T00:00:00.000Z')
    const exchangeCodeForToken = jest.fn().mockResolvedValue({ accessToken: 'short', expiresAt: null })
    const exchangeToken = jest.fn().mockResolvedValue({ accessToken: 'long', expiresAt })
    const getMe = jest.fn().mockResolvedValue({ id: 'u-1', name: 'Jan Kowalski' })
    const debugToken = jest.fn().mockResolvedValue({
      isValid: true,
      expiresAt: null,
      scopes: ['pages_show_list'],
      userId: 'u-1',
      errorCode: null,
      errorSubcode: null,
    })
    const graph = { exchangeCodeForToken, exchangeToken, getMe, debugToken } as unknown as MetaGraphClient
    const graphOptions = { graphVersion: 'v24.0' }

    const result = await completeMetaOAuth({
      graph,
      code: 'code-1',
      redirectUri: 'https://crm.example.com/cb',
      appId: 'app-1',
      appSecret: 'secret-1',
      graphOptions,
    })

    expect(exchangeCodeForToken).toHaveBeenCalledWith(
      { code: 'code-1', redirectUri: 'https://crm.example.com/cb', appId: 'app-1', appSecret: 'secret-1' },
      graphOptions,
    )
    expect(exchangeToken).toHaveBeenCalledWith(
      { shortLivedToken: 'short', appId: 'app-1', appSecret: 'secret-1' },
      graphOptions,
    )
    expect(getMe).toHaveBeenCalledWith('long', graphOptions)
    expect(debugToken).toHaveBeenCalledWith('long', { appId: 'app-1', appSecret: 'secret-1' }, graphOptions)
    expect(result).toEqual({
      userAccessToken: 'long',
      tokenExpiresAt: expiresAt,
      metaUserId: 'u-1',
      metaUserName: 'Jan Kowalski',
      grantedScopes: ['pages_show_list'],
    })
  })
})
