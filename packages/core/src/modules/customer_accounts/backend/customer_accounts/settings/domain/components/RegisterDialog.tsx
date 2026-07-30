"use client"

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { Label } from '@open-mercato/ui/primitives/label'
import { KbdShortcut } from '@open-mercato/ui/primitives/kbd'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export type RegisterDialogProps = {
  open: boolean
  onOpenChange: (next: boolean) => void
  mode: 'register' | 'change'
  currentHostname?: string | null
  onSubmit: (hostname: string, target: 'portal' | 'backend') => Promise<void>
  /**
   * Whether to offer the backend target (#4271). Comes from the API, which
   * checks both the deployment flag and the caller's ACL feature — and
   * re-checks both on POST, so this only decides what is rendered.
   */
  canRegisterBackend?: boolean
  initialError?: string | null
}

const HOSTNAME_BASIC = /^[a-z0-9.-]+$/i

export function RegisterDialog({
  open,
  onOpenChange,
  mode,
  currentHostname,
  onSubmit,
  canRegisterBackend = false,
  initialError,
}: RegisterDialogProps) {
  const t = useT()
  const [hostname, setHostname] = React.useState('')
  const [target, setTarget] = React.useState<'portal' | 'backend'>('portal')
  const [error, setError] = React.useState<string | null>(initialError ?? null)
  const [submitting, setSubmitting] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) {
      setHostname('')
      setTarget('portal')
      setError(null)
      setSubmitting(false)
      return
    }
    setError(initialError ?? null)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, initialError])

  const validate = React.useCallback(
    (value: string): string | null => {
      const trimmed = value.trim()
      if (!trimmed) return t('customer_accounts.domainMapping.errors.required', 'Domain is required')
      if (trimmed.length > 253) return t('customer_accounts.domainMapping.hostname.validation.invalid', 'Enter a valid domain name (no protocol, path, or port)')
      if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(':')) {
        return t('customer_accounts.domainMapping.hostname.validation.invalid', 'Enter a valid domain name (no protocol, path, or port)')
      }
      if (!HOSTNAME_BASIC.test(trimmed) && !/^xn--/i.test(trimmed)) {
        return t('customer_accounts.domainMapping.hostname.validation.invalid', 'Enter a valid domain name (no protocol, path, or port)')
      }
      return null
    },
    [t],
  )

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      const validation = validate(hostname)
      if (validation) {
        setError(validation)
        return
      }
      setSubmitting(true)
      setError(null)
      try {
        await onSubmit(hostname.trim(), target)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Submission failed'
        setError(message)
      } finally {
        setSubmitting(false)
      }
    },
    [hostname, target, onSubmit, validate],
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLFormElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        handleSubmit(event)
      }
    },
    [handleSubmit],
  )

  const title =
    mode === 'change'
      ? t('customer_accounts.domainMapping.dialog.change.title', 'Change custom domain')
      : t('customer_accounts.domainMapping.dialog.register.title', 'Register custom domain')

  const description =
    mode === 'change' && currentHostname
      ? t(
          'customer_accounts.domainMapping.changeDomain.description',
          'Your current domain ({hostname}) will stay active until the new domain is fully set up. No downtime for your customers.',
          { hostname: currentHostname },
        )
      : t('customer_accounts.domainMapping.description', 'Map your own domain to the customer portal')

  const submitLabel =
    mode === 'change'
      ? t('customer_accounts.domainMapping.dialog.change.submit', 'Start replacement')
      : t('customer_accounts.domainMapping.dialog.register.submit', 'Register')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
          <div className="space-y-2">
            <Label htmlFor="custom-domain-hostname">
              {t('customer_accounts.domainMapping.hostname.label', 'Domain')}
            </Label>
            <Input
              id="custom-domain-hostname"
              ref={inputRef}
              value={hostname}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('customer_accounts.domainMapping.hostname.placeholder', 'e.g., shop.yourdomain.com')}
              onChange={(event) => {
                setHostname(event.target.value)
                if (error) setError(null)
              }}
              aria-invalid={error ? true : undefined}
              disabled={submitting}
            />
            {error ? (
              <p className="text-sm text-status-error-text" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          {canRegisterBackend ? (
            <div className="space-y-2">
              <Label htmlFor="custom-domain-target">
                {t('customer_accounts.domainMapping.target.label', 'What this domain serves')}
              </Label>
              <select
                id="custom-domain-target"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={target}
                onChange={(event) => setTarget(event.target.value === 'backend' ? 'backend' : 'portal')}
                disabled={submitting}
              >
                <option value="portal">
                  {t('customer_accounts.domainMapping.target.portal', 'Customer portal (storefront)')}
                </option>
                <option value="backend">
                  {t('customer_accounts.domainMapping.target.backend', 'Admin panel (backend)')}
                </option>
              </select>
              <p className="text-muted-foreground text-sm">
                {t(
                  'customer_accounts.domainMapping.target.hint',
                  'An admin domain pins the organization for everyone signing in on it. Each organization can have one active admin domain.',
                )}
              </p>
            </div>
          ) : null}

          <DialogFooter className="items-center">
            <span className="hidden text-xs text-muted-foreground sm:inline-flex sm:items-center sm:gap-1">
              <KbdShortcut keys={['⌘', 'Enter']} />
            </span>
            <Button
              type="button"
              variant="ghost"
              size="default"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t('customer_accounts.domainMapping.dialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="default" disabled={submitting}>
              {submitting ? <Spinner className="mr-2 h-4 w-4" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export default RegisterDialog
