'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { EligibleProvider } from './types'

/**
 * Provision a new shared inbox (Connect upstream Contract E, AUTH-UP-EMAIL-01 /
 * AUTH-UP-GMAIL-01).
 *
 * Two shapes behind one form, because they are genuinely different flows:
 * Gmail redirects to Google for consent, while IMAP posts a mailbox secret.
 * Credential-validation errors are rendered per field from the provider's own
 * response and never echo the submitted values.
 */

type Props = {
  eligibleProviders: EligibleProvider[]
  onProvisioned: () => void
}

const GMAIL_PROVIDER_KEY = 'gmail'

export function ProvisionSharedInboxForm({ eligibleProviders, onProvisioned }: Props) {
  const t = useT()
  const [providerKey, setProviderKey] = React.useState(eligibleProviders[0]?.providerKey ?? '')
  const [displayName, setDisplayName] = React.useState('')
  const [fromAddress, setFromAddress] = React.useState('')
  const [host, setHost] = React.useState('')
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({})

  const { runMutation, retryLastMutation } = useGuardedMutation({
    contextId: 'communication_channels.shared_inbox_provision',
  })

  React.useEffect(() => {
    if (!providerKey && eligibleProviders.length > 0) setProviderKey(eligibleProviders[0].providerKey)
  }, [eligibleProviders, providerKey])

  const startGmailFlow = React.useCallback(async () => {
    setFormError(null)
    setFieldErrors({})
    setIsSubmitting(true)
    try {
      const response = await apiCall<{ authorizeUrl?: string; error?: string }>(
        '/api/communication_channels/shared-inboxes/gmail/oauth/start',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName }),
        },
      )
      if (!response.ok || !response.result?.authorizeUrl) {
        setFormError(
          response.result?.error ??
            t('communication_channels.sharedInbox.errors.oauthStart', 'Could not start the Google authorization'),
        )
        return
      }
      window.location.assign(response.result.authorizeUrl)
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t('communication_channels.sharedInbox.errors.oauthStart', 'Could not start the Google authorization'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [displayName, t])

  const submitCredentials = React.useCallback(async () => {
    setFormError(null)
    setFieldErrors({})
    setIsSubmitting(true)
    try {
      await runMutation({
        context: { providerKey, retryLastMutation },
        mutationPayload: { providerKey, displayName },
        operation: async () => {
          const response = await apiCall<{
            error?: string
            fieldErrors?: Record<string, string>
          }>('/api/communication_channels/shared-inboxes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              providerKey,
              displayName,
              credentials: { host, username, password, fromAddress },
            }),
          })
          if (!response.ok) {
            if (response.result?.fieldErrors) setFieldErrors(response.result.fieldErrors)
            throw new Error(
              response.result?.error ??
                t('communication_channels.sharedInbox.errors.provision', 'Could not provision the inbox'),
            )
          }
          return response.result
        },
      })
      setDisplayName('')
      setFromAddress('')
      setHost('')
      setUsername('')
      setPassword('')
      onProvisioned()
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t('communication_channels.sharedInbox.errors.provision', 'Could not provision the inbox'),
      )
    } finally {
      setIsSubmitting(false)
    }
  }, [displayName, fromAddress, host, onProvisioned, password, providerKey, retryLastMutation, runMutation, t, username])

  if (eligibleProviders.length === 0) {
    return (
      <Alert status="information">
        <AlertDescription>
          {t(
            'communication_channels.sharedInbox.provision.noProviders',
            'No installed email provider supports shared inboxes. Install the Gmail or IMAP channel package first.',
          )}
        </AlertDescription>
      </Alert>
    )
  }

  const isGmail = providerKey === GMAIL_PROVIDER_KEY

  return (
    <section aria-label={t('communication_channels.sharedInbox.provision.aria', 'Provision a shared inbox')}>
      <SectionHeader title={t('communication_channels.sharedInbox.provision.title', 'Add a shared inbox')} />

      {formError ? (
        <Alert status="error" className="my-3">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (isGmail) void startGmailFlow()
          else void submitCredentials()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-provider">
              {t('communication_channels.sharedInbox.provision.provider', 'Provider')}
            </label>
            <select
              id="shared-inbox-provider"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={providerKey}
              onChange={(event) => setProviderKey(event.target.value)}
            >
              {eligibleProviders.map((provider) => (
                <option key={provider.providerKey} value={provider.providerKey}>
                  {t(
                    `communication_channels.channel.providers.${provider.providerKey}`,
                    provider.providerKey,
                  )}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-display-name">
              {t('communication_channels.sharedInbox.provision.displayName', 'Inbox name')}
            </label>
            <Input
              id="shared-inbox-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={t('communication_channels.sharedInbox.provision.displayNamePlaceholder', 'Support')}
              required
            />
          </div>
        </div>

        {isGmail ? (
          <p className="text-sm text-muted-foreground">
            {t(
              'communication_channels.sharedInbox.provision.gmailHint',
              'You will be redirected to Google to authorize the shared mailbox. Sign in as the shared account, not your own.',
            )}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-from-address">
                {t('communication_channels.sharedInbox.provision.fromAddress', 'Mailbox address')}
              </label>
              <Input
                id="shared-inbox-from-address"
                type="email"
                value={fromAddress}
                onChange={(event) => setFromAddress(event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.fromAddress)}
              />
              {fieldErrors.fromAddress ? (
                <p className="mt-1 text-xs text-status-error-base">{fieldErrors.fromAddress}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-host">
                {t('communication_channels.sharedInbox.provision.host', 'IMAP host')}
              </label>
              <Input
                id="shared-inbox-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.host)}
              />
              {fieldErrors.host ? (
                <p className="mt-1 text-xs text-status-error-base">{fieldErrors.host}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-username">
                {t('communication_channels.sharedInbox.provision.username', 'Username')}
              </label>
              <Input
                id="shared-inbox-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.username)}
              />
              {fieldErrors.username ? (
                <p className="mt-1 text-xs text-status-error-base">{fieldErrors.username}</p>
              ) : null}
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="shared-inbox-password">
                {t('communication_channels.sharedInbox.provision.password', 'Password')}
              </label>
              <Input
                id="shared-inbox-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.password)}
              />
              {fieldErrors.password ? (
                <p className="mt-1 text-xs text-status-error-base">{fieldErrors.password}</p>
              ) : null}
            </div>
          </div>
        )}

        <Button type="submit" disabled={isSubmitting || displayName.trim().length === 0}>
          {isGmail
            ? t('communication_channels.sharedInbox.provision.gmailSubmit', 'Authorize with Google')
            : t('communication_channels.sharedInbox.provision.submit', 'Provision inbox')}
        </Button>
      </form>
    </section>
  )
}

export default ProvisionSharedInboxForm
