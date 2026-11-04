import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { Notification } from '@open-mercato/core/modules/notifications/data/entities'
import { MetaConnection, MetaPage } from '../data/entities'
import { NOTIFICATION_TYPES } from '../notifications'
import {
  API_VERSION_ALERT_DAYS,
  META_GRAPH_API_VERSIONS,
  QUEUES,
  WORKER_IDS,
  type MetaScope,
} from '../lib/constants'
import {
  MetaGraphError,
  classifyGraphError,
  getMetaGraphClient,
  type GraphCallOptions,
  type GraphTokenInfo,
  type MetaGraphClient,
} from '../lib/graph-client'
import { notifyApiVersionDeprecated } from '../lib/notifier'
import {
  applyConnectionStatus,
  applyPageStatus,
  describeGraphError,
  verifyPageSubscription,
  type ConnectionStatusUpdate,
  type PageServiceContext,
} from '../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials, type MetaAppCredentials } from '../lib/preset'
import { resolveJobScope, type ScopedJob } from '../lib/queue'
import { decryptionScope } from '../lib/scope'

const logger = createLogger('meta_lead_ads').child({ component: 'token-health' })

const DAY_MS = 24 * 60 * 60 * 1000
const MISSING_USER_TOKEN_ERROR = 'Meta user access token is missing'
const TOKEN_EXPIRED_ERROR = 'Meta user access token has expired'
const TOKEN_INVALID_ERROR = 'Meta user access token is no longer valid'
const DEFAULT_TOKEN_ERROR_CODE = 190

export const metadata: WorkerMeta = {
  queue: QUEUES.tokenHealth,
  id: WORKER_IDS.tokenHealth,
  concurrency: 2,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type HealthDeps = {
  ctx: PageServiceContext
  graph: MetaGraphClient
  credentials: MetaAppCredentials
  graphOptions: GraphCallOptions
}

export function apiVersionAlertGroupKey(version: string): string {
  return `meta_api_version_deprecated:${version}`
}

export function findApproachingSunset(
  version: string,
  now: Date = new Date(),
): { version: string; sunsetAt: string } | null {
  const definition = META_GRAPH_API_VERSIONS.find((entry) => entry.id === version)
  if (!definition?.sunsetAt) return null
  const sunsetMs = new Date(definition.sunsetAt).getTime()
  if (Number.isNaN(sunsetMs)) return null
  if (sunsetMs - now.getTime() > API_VERSION_ALERT_DAYS * DAY_MS) return null
  return { version: definition.id, sunsetAt: definition.sunsetAt }
}

export function statusFromTokenInfo(info: GraphTokenInfo, now: Date = new Date()): ConnectionStatusUpdate {
  const expired = info.expiresAt !== null && info.expiresAt.getTime() <= now.getTime()
  if (info.isValid && !expired) return { status: 'active', lastError: null, reason: null }
  if (expired && info.errorCode === null) {
    return { status: 'token_expired', lastError: TOKEN_EXPIRED_ERROR, reason: 'expired' }
  }
  const classification = classifyGraphError({
    status: null,
    body: { error: { code: info.errorCode ?? DEFAULT_TOKEN_ERROR_CODE, error_subcode: info.errorSubcode } },
  })
  const status = classification.connectionStatus ?? 'invalid'
  return {
    status,
    lastError: status === 'token_expired' ? TOKEN_EXPIRED_ERROR : TOKEN_INVALID_ERROR,
    reason: classification.tokenReason ?? 'unknown',
  }
}

function reportFailure(error: unknown, code: string, attributes: Record<string, string>): void {
  getTelemetryRuntime()?.reportError(error, { module: 'meta_lead_ads', code, attributes })
}

function resolveGraphClient(ctx: HandlerContext): MetaGraphClient {
  try {
    return ctx.resolve<MetaGraphClient>('metaGraphClient')
  } catch {
    return getMetaGraphClient()
  }
}

async function checkConnectionToken(deps: HealthDeps, connection: MetaConnection): Promise<void> {
  const { ctx, graph, credentials, graphOptions } = deps
  connection.lastHealthCheckAt = new Date()
  const userToken = connection.userAccessToken?.trim()
  if (!userToken) {
    await applyConnectionStatus(ctx, connection, {
      status: 'invalid',
      lastError: MISSING_USER_TOKEN_ERROR,
      reason: 'unknown',
    })
    return
  }
  if (!credentials.appId || !credentials.appSecret) {
    logger.warn('token health skipped debug_token because the Meta app is not configured', {
      connectionId: connection.id,
    })
    await ctx.em.flush()
    return
  }
  try {
    const info = await graph.debugToken(
      userToken,
      { appId: credentials.appId, appSecret: credentials.appSecret },
      graphOptions,
    )
    if (info.expiresAt) connection.tokenExpiresAt = info.expiresAt
    await applyConnectionStatus(ctx, connection, statusFromTokenInfo(info))
  } catch (error) {
    if (error instanceof MetaGraphError && error.classification.connectionStatus) {
      await applyConnectionStatus(ctx, connection, {
        status: error.classification.connectionStatus,
        lastError: describeGraphError(error.classification),
        reason: error.classification.tokenReason ?? null,
      })
      return
    }
    connection.lastError =
      error instanceof MetaGraphError ? describeGraphError(error.classification) : connection.lastError
    await ctx.em.flush()
    logger.warn('token health debug_token failed', { connectionId: connection.id })
    reportFailure(error, 'meta_lead_ads.token_health_debug_failed', { connectionId: connection.id })
  }
}

async function checkConnectionPages(deps: HealthDeps, scope: MetaScope, connection: MetaConnection): Promise<void> {
  const pages = await findWithDecryption(
    deps.ctx.em,
    MetaPage,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      connectionId: connection.id,
      deletedAt: null,
    },
    undefined,
    decryptionScope(scope),
  )
  for (const page of pages) {
    try {
      const next = await verifyPageSubscription(
        deps.graph,
        { metaPageId: page.metaPageId, pageAccessToken: page.pageAccessToken },
        deps.graphOptions,
      )
      await applyPageStatus(deps.ctx, page, next)
    } catch (error) {
      logger.warn('token health page check failed', { pageId: page.id })
      reportFailure(error, 'meta_lead_ads.token_health_page_failed', { pageId: page.id })
    }
  }
}

async function checkApiVersion(
  ctx: PageServiceContext,
  scope: MetaScope,
  graphOptions: GraphCallOptions,
): Promise<void> {
  const version = graphOptions.graphVersion
  if (!version) return
  const approaching = findApproachingSunset(version)
  if (!approaching) return
  const alreadySent = await ctx.em.count(Notification, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    type: NOTIFICATION_TYPES.apiVersionDeprecated,
    groupKey: apiVersionAlertGroupKey(approaching.version),
  })
  if (alreadySent > 0) return
  await notifyApiVersionDeprecated(ctx, { scope, version: approaching.version, sunsetAt: approaching.sunsetAt })
}

export default async function handle(job: QueuedJob<ScopedJob>, ctx: HandlerContext): Promise<void> {
  const scope = resolveJobScope(job?.payload ?? {})
  if (!scope) return

  const em = ctx.resolve<EntityManager>('em').fork()
  const serviceCtx: PageServiceContext = { em, resolve: ctx.resolve }
  const credentials = await resolveAppCredentials(ctx, scope)
  const deps: HealthDeps = {
    ctx: serviceCtx,
    graph: resolveGraphClient(ctx),
    credentials,
    graphOptions: graphOptionsFromCredentials(credentials),
  }

  const connections = await findWithDecryption(
    em,
    MetaConnection,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      status: { $ne: 'disconnected' },
    },
    undefined,
    decryptionScope(scope),
  )

  for (const connection of connections) {
    try {
      await checkConnectionToken(deps, connection)
    } catch (error) {
      logger.warn('token health connection check failed', { connectionId: connection.id })
      reportFailure(error, 'meta_lead_ads.token_health_connection_failed', { connectionId: connection.id })
    }
    await checkConnectionPages(deps, scope, connection)
  }

  try {
    await checkApiVersion(serviceCtx, scope, deps.graphOptions)
  } catch (error) {
    logger.warn('token health api version check failed', { organizationId: scope.organizationId })
    reportFailure(error, 'meta_lead_ads.token_health_api_version_failed', { organizationId: scope.organizationId })
  }

  logger.info('token health finished', { connections: connections.length })
}
