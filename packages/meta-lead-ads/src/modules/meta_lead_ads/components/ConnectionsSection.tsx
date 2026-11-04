'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCallOrThrow, readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { LoadingMessage } from '@open-mercato/ui/backend/detail/LoadingMessage'
import { ErrorMessage } from '@open-mercato/ui/backend/detail/ErrorMessage'
import { ConnectionStatusBadge } from './StatusBadges'
import type { ConnectionDto, DisconnectResponse } from './types'

const logger = createLogger('meta_lead_ads').child({ component: 'ConnectionsSection' })

const CONNECTIONS_PATH = '/api/meta_lead_ads/connections'
const INITIATE_PATH = '/api/meta_lead_ads/oauth/initiate'

type ConnectionsSectionProps = {
  canManage: boolean
  onChanged?: () => void
}

type DisconnectContext = {
  formId: string
  operation: string
  connectionId: string
  retryLastMutation: () => Promise<boolean>
}

export function ConnectionsSection({ canManage, onChanged }: ConnectionsSectionProps) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [connections, setConnections] = React.useState<ConnectionDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadFailed, setLoadFailed] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<DisconnectContext>({
    contextId: 'meta_lead_ads-connections',
    blockedMessage: t('meta_lead_ads.connections.disconnect.error', 'Failed to disconnect the Meta account.'),
  })

  const loadConnections = React.useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const payload = await readApiResultOrThrow<{ items: ConnectionDto[] }>(CONNECTIONS_PATH)
      setConnections(payload.items ?? [])
    } catch (err) {
      logger.error('Failed to load connections', { err })
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const handleConnect = React.useCallback(() => {
    window.location.assign(INITIATE_PATH)
  }, [])

  const handleDisconnect = React.useCallback(
    async (connection: ConnectionDto) => {
      const proceed = await confirm({
        title: t('meta_lead_ads.connections.disconnect.title', 'Disconnect Meta account'),
        text: t(
          'meta_lead_ads.connections.disconnect.text',
          'Lead delivery from all pages of this connection will stop. Already imported leads and CRM records are kept.',
        ),
        confirmText: t('meta_lead_ads.connections.disconnect.confirm', 'Disconnect'),
        cancelText: t('meta_lead_ads.common.cancel', 'Cancel'),
        variant: 'destructive',
      })
      if (!proceed) return
      setBusyId(connection.id)
      try {
        const call = await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(connection.updatedAt), () =>
              apiCallOrThrow<DisconnectResponse>(`${CONNECTIONS_PATH}/${encodeURIComponent(connection.id)}`, {
                method: 'DELETE',
              }),
            ),
          context: {
            formId: 'meta_lead_ads-connections',
            operation: 'disconnect',
            connectionId: connection.id,
            retryLastMutation,
          },
          mutationPayload: { id: connection.id },
        })
        flash(
          t('meta_lead_ads.connections.disconnect.success', 'Meta account disconnected.'),
          'success',
        )
        logger.info('Connection disconnected', { unsubscribedPages: call.result?.unsubscribedPages ?? 0 })
        await loadConnections()
        onChanged?.()
      } catch (err) {
        if (!surfaceRecordConflict(err, t, { onRefresh: () => void loadConnections() })) {
          logger.error('Failed to disconnect connection', { err })
          flash(t('meta_lead_ads.connections.disconnect.error', 'Failed to disconnect the Meta account.'), 'error')
        }
      } finally {
        setBusyId(null)
      }
    },
    [confirm, loadConnections, onChanged, retryLastMutation, runMutation, t],
  )

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{t('meta_lead_ads.connections.title', 'Meta connections')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('meta_lead_ads.connections.description', 'Facebook accounts that deliver Lead Ads into the CRM.')}
          </p>
        </div>
        {canManage ? (
          <Button type="button" onClick={handleConnect}>
            {t('meta_lead_ads.connections.connect', 'Connect with Meta')}
          </Button>
        ) : null}
      </header>
      {loading ? (
        <LoadingMessage label={t('meta_lead_ads.connections.loading', 'Loading connections...')} />
      ) : loadFailed ? (
        <ErrorMessage
          label={t('meta_lead_ads.connections.loadError', 'Failed to load connections.')}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void loadConnections()}>
              {t('meta_lead_ads.common.retry', 'Retry')}
            </Button>
          }
        />
      ) : connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('meta_lead_ads.connections.empty', 'No Meta account connected yet.')}
        </p>
      ) : (
        <ul className="divide-y">
          {connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{connection.metaUserName ?? connection.metaUserId}</span>
                  <ConnectionStatusBadge status={connection.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('meta_lead_ads.connections.pageCount', '{count} pages', { count: connection.pageCount })}
                </p>
                {connection.lastError ? (
                  <p className="text-xs text-status-error-text">{connection.lastError}</p>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex items-center gap-2">
                  {connection.status !== 'active' ? (
                    <Button type="button" variant="outline" size="sm" onClick={handleConnect}>
                      {t('meta_lead_ads.connections.reconnect', 'Reconnect')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === connection.id}
                    onClick={() => void handleDisconnect(connection)}
                  >
                    {t('meta_lead_ads.connections.disconnect.action', 'Disconnect')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {ConfirmDialogElement}
    </section>
  )
}

export default ConnectionsSection
