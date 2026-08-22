'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { SharedInboxMemberRow, SharedInboxMembersResponse } from './types'

/**
 * Member list, grant, and revoke for one shared inbox (Connect upstream
 * Contract E, AUTH-UP-UI-01).
 *
 * Revoked members stay in the list as the recovery/audit view: the operator can
 * see who was removed, by whom, and re-grant in one click. That is the whole
 * point of soft revocation — a mistaken click is recoverable without support.
 */

type Props = {
  channelId: string
  channelName: string
  onMembershipChanged: () => void
}

export function SharedInboxMembersPanel({ channelId, channelName, onMembershipChanged }: Props) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [members, setMembers] = React.useState<SharedInboxMemberRow[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [newMemberId, setNewMemberId] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId: `communication_channels.shared_inbox_members:${channelId}`,
  })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      setLoadError(null)
      const response = await apiCall<SharedInboxMembersResponse>(
        `/api/communication_channels/shared-inboxes/${channelId}/members`,
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok) {
        setLoadError(
          t('communication_channels.sharedInbox.errors.loadMembers', 'Failed to load members'),
        )
        setMembers([])
      } else {
        setMembers(response.result?.items ?? [])
      }
      setIsLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [channelId, reloadToken, t])

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  const grantMember = React.useCallback(
    async (userId: string) => {
      setActionError(null)
      setIsSubmitting(true)
      try {
        await runMutation({
          context: { channelId, userId, retryLastMutation },
          mutationPayload: { channelId, userId },
          operation: async () => {
            const response = await apiCall<{ error?: string }>(
              `/api/communication_channels/shared-inboxes/${channelId}/members`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userId }),
              },
            )
            if (!response.ok) {
              throw new Error(
                response.result?.error ??
                  t('communication_channels.sharedInbox.errors.grant', 'Failed to add the member'),
              )
            }
            return response.result
          },
        })
        setNewMemberId('')
        reload()
        onMembershipChanged()
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : t('communication_channels.sharedInbox.errors.grant', 'Failed to add the member'),
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [channelId, onMembershipChanged, reload, retryLastMutation, runMutation, t],
  )

  const revokeMember = React.useCallback(
    async (userId: string) => {
      const confirmed = await confirm({
        title: t('communication_channels.sharedInbox.revoke.title', 'Remove member?'),
        description: t(
          'communication_channels.sharedInbox.revoke.description',
          'They will immediately lose access to this shared inbox. You can restore access afterwards from the revoked list.',
        ),
        variant: 'destructive',
        confirmText: t('communication_channels.sharedInbox.revoke.confirm', 'Remove'),
      })
      if (!confirmed) return

      setActionError(null)
      setIsSubmitting(true)
      try {
        await runMutation({
          context: { channelId, userId, retryLastMutation },
          mutationPayload: { channelId, userId },
          operation: async () => {
            const response = await apiCall<{ error?: string }>(
              `/api/communication_channels/shared-inboxes/${channelId}/members`,
              {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ userId }),
              },
            )
            if (!response.ok) {
              throw new Error(
                response.result?.error ??
                  t('communication_channels.sharedInbox.errors.revoke', 'Failed to remove the member'),
              )
            }
            return response.result
          },
        })
        reload()
        onMembershipChanged()
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : t('communication_channels.sharedInbox.errors.revoke', 'Failed to remove the member'),
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [channelId, confirm, onMembershipChanged, reload, retryLastMutation, runMutation, t],
  )

  const activeMembers = members.filter((member) => member.isActive)
  const revokedMembers = members.filter((member) => !member.isActive)

  return (
    <section aria-label={t('communication_channels.sharedInbox.members.aria', 'Shared inbox members')}>
      <SectionHeader
        title={t('communication_channels.sharedInbox.members.title', 'Members')}
        count={activeMembers.length}
      />
      <p className="mb-4 text-sm text-muted-foreground">{channelName}</p>

      {actionError ? (
        <Alert status="error" className="mb-4">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <form
        className="mb-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = newMemberId.trim()
          if (trimmed) void grantMember(trimmed)
        }}
      >
        <div className="flex-1 min-w-64">
          <label className="mb-1 block text-sm font-medium" htmlFor={`shared-inbox-member-${channelId}`}>
            {t('communication_channels.sharedInbox.members.addLabel', 'Add member by user ID')}
          </label>
          <Input
            id={`shared-inbox-member-${channelId}`}
            value={newMemberId}
            onChange={(event) => setNewMemberId(event.target.value)}
            placeholder={t(
              'communication_channels.sharedInbox.members.addPlaceholder',
              'User ID (UUID)',
            )}
          />
        </div>
        <Button type="submit" disabled={isSubmitting || newMemberId.trim().length === 0}>
          {t('communication_channels.sharedInbox.members.add', 'Add member')}
        </Button>
      </form>

      {isLoading ? (
        <LoadingMessage
          label={t('communication_channels.sharedInbox.members.loading', 'Loading members...')}
        />
      ) : loadError ? (
        <ErrorMessage label={loadError} />
      ) : activeMembers.length === 0 ? (
        <EmptyState
          title={t('communication_channels.sharedInbox.members.emptyTitle', 'No members yet')}
          description={t(
            'communication_channels.sharedInbox.members.emptyDescription',
            'Add the people who should read and reply from this inbox. Membership alone is not enough — they also need the shared inbox read and send permissions.',
          )}
        />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {activeMembers.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-4 p-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{member.userId}</p>
                <p className="text-xs text-muted-foreground">
                  {t('communication_channels.sharedInbox.members.grantedAt', 'Added')}{' '}
                  {new Date(member.createdAt).toLocaleString()}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => void revokeMember(member.userId)}
                disabled={isSubmitting}
              >
                {t('communication_channels.sharedInbox.members.revoke', 'Remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {revokedMembers.length > 0 ? (
        <div className="mt-6">
          <SectionHeader
            title={t('communication_channels.sharedInbox.members.revokedTitle', 'Removed members')}
            count={revokedMembers.length}
          />
          <p className="mb-2 text-sm text-muted-foreground">
            {t(
              'communication_channels.sharedInbox.members.revokedDescription',
              'Kept for audit. Re-add anyone removed by mistake.',
            )}
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {revokedMembers.map((member) => (
              <li key={member.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{member.userId}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('communication_channels.sharedInbox.members.revokedAt', 'Removed')}{' '}
                    {member.revokedAt ? new Date(member.revokedAt).toLocaleString() : '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge variant="neutral">
                    {t('communication_channels.sharedInbox.members.revokedBadge', 'Removed')}
                  </StatusBadge>
                  <Button
                    variant="outline"
                    onClick={() => void grantMember(member.userId)}
                    disabled={isSubmitting}
                  >
                    {t('communication_channels.sharedInbox.members.restore', 'Restore access')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {ConfirmDialogElement}
    </section>
  )
}

export default SharedInboxMembersPanel
