import { META_DIALOG_BASE_URL, REQUIRED_SCOPES } from './constants'
import type { GraphCallOptions, MetaGraphClient } from './graph-client'

export type MetaLoginDialogInput = {
  appId: string
  loginConfigId: string
  redirectUri: string
  state: string
  graphVersion: string
}

export type CompleteMetaOAuthInput = {
  graph: MetaGraphClient
  code: string
  redirectUri: string
  appId: string
  appSecret: string
  graphOptions?: GraphCallOptions
}

export type CompleteMetaOAuthResult = {
  userAccessToken: string
  tokenExpiresAt: Date | null
  metaUserId: string
  metaUserName: string | null
  grantedScopes: string[]
}

export function buildMetaLoginDialogUrl(input: MetaLoginDialogInput): string {
  const url = new URL(`${META_DIALOG_BASE_URL}/${input.graphVersion}/dialog/oauth`)
  url.searchParams.set('client_id', input.appId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('state', input.state)
  url.searchParams.set('config_id', input.loginConfigId)
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export function findMissingScopes(granted: string[]): string[] {
  const grantedSet = new Set(granted)
  return REQUIRED_SCOPES.filter((scope) => !grantedSet.has(scope))
}

export async function completeMetaOAuth(input: CompleteMetaOAuthInput): Promise<CompleteMetaOAuthResult> {
  const { graph, appId, appSecret, graphOptions } = input
  const shortLived = await graph.exchangeCodeForToken(
    { code: input.code, redirectUri: input.redirectUri, appId, appSecret },
    graphOptions,
  )
  const longLived = await graph.exchangeToken(
    { shortLivedToken: shortLived.accessToken, appId, appSecret },
    graphOptions,
  )
  const userAccessToken = longLived.accessToken
  const [user, tokenInfo] = await Promise.all([
    graph.getMe(userAccessToken, graphOptions),
    graph.debugToken(userAccessToken, { appId, appSecret }, graphOptions),
  ])
  return {
    userAccessToken,
    tokenExpiresAt: longLived.expiresAt ?? tokenInfo.expiresAt,
    metaUserId: user.id,
    metaUserName: user.name,
    grantedScopes: tokenInfo.scopes,
  }
}
