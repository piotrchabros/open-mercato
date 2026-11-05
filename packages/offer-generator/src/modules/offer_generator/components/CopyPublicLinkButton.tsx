'use client'

import * as React from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { IconButton } from '@open-mercato/ui/primitives/icon-button'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export function useCopyPublicLink(): (url: string) => Promise<boolean> {
  const t = useT()
  return React.useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url)
        flash(t('offer_generator.publicLink.copied', 'Public link copied.'), 'success')
        return true
      } catch {
        flash(t('offer_generator.publicLink.copyFailed', 'Could not copy the link.'), 'error')
        return false
      }
    },
    [t],
  )
}

export type CopyPublicLinkButtonProps = {
  url: string
  iconOnly?: boolean
  disabled?: boolean
}

export function CopyPublicLinkButton({ url, iconOnly = false, disabled = false }: CopyPublicLinkButtonProps) {
  const t = useT()
  const copy = useCopyPublicLink()
  const label = t('offer_generator.publicLink.copy', 'Copy public link')
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void copy(url)
    },
    [copy, url],
  )

  if (iconOnly) {
    return (
      <IconButton type="button" variant="ghost" aria-label={label} title={label} disabled={disabled} onClick={handleClick}>
        <Copy />
      </IconButton>
    )
  }

  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={handleClick}>
      <Copy />
      {label}
    </Button>
  )
}

export default CopyPublicLinkButton
