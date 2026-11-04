'use client'

import * as React from 'react'
import { AlertTriangle, ExternalLink, Megaphone, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { cn } from '@open-mercato/shared/lib/utils'
import { formatRelativeTime } from '@open-mercato/shared/lib/time'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import type { NotificationRendererProps } from '@open-mercato/shared/modules/notifications/types'

const SEVERITY_STYLES: Record<string, { background: string; icon: string }> = {
  info: { background: 'bg-status-info-bg', icon: 'text-status-info-icon' },
  warning: { background: 'bg-status-warning-bg', icon: 'text-status-warning-icon' },
  error: { background: 'bg-status-error-bg', icon: 'text-status-error-icon' },
}

export function MetaLeadAdsNotificationRenderer({
  notification,
  onAction,
  onDismiss,
  actions = [],
}: NotificationRendererProps) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [executing, setExecuting] = React.useState(false)
  const isUnread = notification.status === 'unread'
  const styles = SEVERITY_STYLES[notification.severity] ?? SEVERITY_STYLES.info
  const Icon = notification.icon === 'megaphone' ? Megaphone : AlertTriangle
  const viewAction = actions.find((action) => action.id === 'view') ?? actions[0] ?? null

  const handleView = async () => {
    if (!viewAction || notification.status === 'actioned') {
      if (notification.linkHref) router.push(notification.linkHref)
      return
    }
    setExecuting(true)
    try {
      await onAction(viewAction.id)
    } finally {
      setExecuting(false)
    }
  }

  const timeAgo = formatRelativeTime(notification.createdAt, { locale, translate: t }) ?? ''

  return (
    <div
      className={cn(
        'group relative flex cursor-pointer items-start gap-4 rounded-xl p-3 transition-colors hover:bg-muted/40',
        isUnread && 'bg-muted/20',
      )}
      onClick={handleView}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleView()
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', styles.background)}>
        <Icon className={cn('size-5', styles.icon)} aria-hidden="true" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm font-medium leading-5 tracking-tight text-foreground">
          {notification.title}
        </p>
        {notification.body ? (
          <p className="text-xs leading-4 text-muted-foreground">{notification.body}</p>
        ) : null}
        {timeAgo ? <p className="text-xs leading-4 text-muted-foreground">{timeAgo}</p> : null}

        <div className="mt-2 flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              handleView()
            }}
            disabled={executing || (!viewAction && !notification.linkHref)}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            {t('common.view', 'View')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => {
              event.stopPropagation()
              onDismiss()
            }}
          >
            {t('notifications.actions.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>

      <IconButton
        type="button"
        variant="ghost"
        size="xs"
        className="absolute right-2 top-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          onDismiss()
        }}
        aria-label={t('notifications.actions.dismiss', 'Dismiss')}
      >
        <X className="size-3.5" />
      </IconButton>
    </div>
  )
}

export default MetaLeadAdsNotificationRenderer
