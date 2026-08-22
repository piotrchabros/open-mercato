'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ProvisionSharedInboxForm } from './ProvisionSharedInboxForm'
import { SharedInboxMembersPanel } from './SharedInboxMembersPanel'
import type { SharedInboxListResponse, SharedInboxRow } from './types'

/**
 * Organization-admin page for shared inboxes (Connect upstream Contract E,
 * AUTH-UP-UI-01): ownership, provisioning, membership, and provider recovery.
 */

function statusVariant(row: SharedInboxRow): StatusBadgeVariant {
  if (!row.isActive || row.status === 'disconnected') return 'error'
  if (row.status === 'requires_reauth' || row.status === 'error') return 'warning'
  return 'success'
}

export function SharedInboxesAdminPage() {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [data, setData] = React.useState<SharedInboxListResponse | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [selectedChannelId, setSelectedChannelId] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [busyChannelId, setBusyChannelId] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId: 'communication_channels.shared_inboxes',
  })

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setLoadError(null)
      const response = await apiCall<SharedInboxListResponse>(
        '/api/communication_channels/shared-inboxes',
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok) {
        setLoadError(
          t('communication_channels.sharedInbox.errors.load', 'Failed to load shared inboxes'),
        )
        setData(null)
      } else {
        setData(response.result ?? {})
      }
      setIsLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [reloadToken, t])

  const runChannelAction = React.useCallback(
    async (channelId: string, action: 'disable' | 'reconnect' | 'connect-projection') => {
      setActionError(null)
      setBusyChannelId(channelId)
      try {
        await runMutation({
          context: { channelId, action, retryLastMutation },
          mutationPayload: { channelId, action },
          operation: async () => {
            const response = await apiCall<{ error?: string; missing?: string[] }>(
              `/api/communication_channels/shared-inboxes/${channelId}/${action}`,
              { method: 'POST' },
            )
            if (!response.ok) {
              const missing = response.result?.missing
              throw new Error(
                [
                  response.result?.error ??
                    t('communication_channels.sharedInbox.errors.action', 'The action failed'),
                  missing && missing.length > 0 ? missing.join(', ') : null,
                ]
                  .filter(Boolean)
                  .join(' — '),
              )
            }
            return response.result
          },
        })
        reload()
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : t('communication_channels.sharedInbox.errors.action', 'The action failed'),
        )
      } finally {
        setBusyChannelId(null)
      }
    },
    [reload, retryLastMutation, runMutation, t],
  )

  const confirmDisable = React.useCallback(
    async (channelId: string) => {
      const confirmed = await confirm({
        title: t('communication_channels.sharedInbox.disable.title', 'Disable this inbox?'),
        description: t(
          'communication_channels.sharedInbox.disable.description',
          'New replies are blocked immediately. Queued messages that never reached the provider are marked failed and can be retried; messages that may already have been sent are left for reconciliation and are never resent automatically.',
        ),
        variant: 'destructive',
        confirmText: t('communication_channels.sharedInbox.disable.confirm', 'Disable'),
      })
      if (confirmed) await runChannelAction(channelId, 'disable')
    },
    [confirm, runChannelAction, t],
  )

  const items = data?.items ?? []
  const legacyChannels = data?.legacyChannels ?? []
  const selected = items.find((row) => row.id === selectedChannelId) ?? null

  return (
    <Page>
      <PageBody>
        <h1 className="mb-2 text-xl font-semibold">
          {t('communication_channels.sharedInbox.nav.title', 'Shared inboxes')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {t(
            'communication_channels.sharedInbox.page.description',
            'Team mailboxes owned by this organization. Members you add here still need the shared inbox read and send permissions.',
          )}
        </p>

        {legacyChannels.length > 0 ? (
          <Alert status="warning" className="mb-6">
            <AlertTitle>
              {t(
                'communication_channels.sharedInbox.legacy.title',
                'Legacy email channels need reprovisioning',
              )}
            </AlertTitle>
            <AlertDescription>
              {t(
                'communication_channels.sharedInbox.legacy.description',
                'These tenant-wide email channels predate organization ownership. They are disabled for team use until you provision them again inside an organization:',
              )}{' '}
              {legacyChannels
                .map((channel) => channel.externalIdentifier ?? channel.displayName)
                .join(', ')}
            </AlertDescription>
          </Alert>
        ) : null}

        {actionError ? (
          <Alert status="error" className="mb-6">
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mb-8">
          <SectionHeader
            title={t('communication_channels.sharedInbox.list.title', 'Inboxes')}
            count={items.length}
          />
          <div className="mt-3">
            {isLoading ? (
              <LoadingMessage
                label={t('communication_channels.sharedInbox.list.loading', 'Loading shared inboxes...')}
              />
            ) : loadError ? (
              <ErrorMessage label={loadError} />
            ) : items.length === 0 ? (
              <EmptyState
                title={t('communication_channels.sharedInbox.list.emptyTitle', 'No shared inboxes yet')}
                description={t(
                  'communication_channels.sharedInbox.list.emptyDescription',
                  'Provision a team mailbox below so several people can answer from one address.',
                )}
              />
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {items.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{row.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {row.externalIdentifier ?? '—'} ·{' '}
                        {t(
                          `communication_channels.channel.providers.${row.providerKey}`,
                          row.providerKey,
                        )}{' '}
                        ·{' '}
                        {t('communication_channels.sharedInbox.list.memberCount', 'members')}:{' '}
                        {row.activeMemberCount}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge variant={statusVariant(row)} dot>
                        {t(
                          `communication_channels.sharedInbox.status.${row.status}`,
                          row.status,
                        )}
                      </StatusBadge>
                      {row.projectionMode === 'connect_managed' ? (
                        <StatusBadge variant="info">
                          {t('communication_channels.sharedInbox.list.connectManaged', 'Connect')}
                        </StatusBadge>
                      ) : null}
                      <Button
                        variant="outline"
                        onClick={() => setSelectedChannelId(row.id === selectedChannelId ? null : row.id)}
                        aria-expanded={row.id === selectedChannelId}
                      >
                        {t('communication_channels.sharedInbox.list.manageMembers', 'Members')}
                      </Button>
                      {row.isActive ? (
                        <Button
                          variant="outline"
                          onClick={() => void confirmDisable(row.id)}
                          disabled={busyChannelId === row.id}
                        >
                          {t('communication_channels.sharedInbox.list.disable', 'Disable')}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          onClick={() => void runChannelAction(row.id, 'reconnect')}
                          disabled={busyChannelId === row.id}
                        >
                          {t('communication_channels.sharedInbox.list.reconnect', 'Reconnect')}
                        </Button>
                      )}
                      {row.projectionMode === 'legacy_customers' ? (
                        <Button
                          variant="outline"
                          onClick={() => void runChannelAction(row.id, 'connect-projection')}
                          disabled={busyChannelId === row.id}
                        >
                          {t('communication_channels.sharedInbox.list.enableConnect', 'Use Connect')}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {selected ? (
          <div className="mb-8">
            <SharedInboxMembersPanel
              channelId={selected.id}
              channelName={selected.displayName}
              onMembershipChanged={reload}
            />
          </div>
        ) : null}

        <ProvisionSharedInboxForm
          eligibleProviders={data?.eligibleProviders ?? []}
          onProvisioned={reload}
        />

        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}

export default SharedInboxesAdminPage
