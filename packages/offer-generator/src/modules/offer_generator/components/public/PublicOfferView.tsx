'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'
import { OfferTracker } from './OfferTracker'

export const PUBLIC_RENDER_ENDPOINT = '/api/offer_generator/render/public'

const MIN_HEIGHT_DELTA_PX = 2

export type PublicOfferViewProps = {
  segment: string
  title: string | null
  companyName: string | null
}

type FrameWindow = Window & typeof globalThis

function measureFrameHeight(doc: Document): number {
  const root = doc.documentElement
  const body = doc.body
  return Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0, root?.offsetHeight ?? 0)
}

export function PublicOfferView({ segment, title, companyName }: PublicOfferViewProps) {
  const t = useT()
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [frameHeight, setFrameHeight] = React.useState<number | null>(null)
  const [frameVersion, setFrameVersion] = React.useState(0)
  const src = `${PUBLIC_RENDER_ENDPOINT}/${encodeURIComponent(segment)}`

  const syncHeight = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    const next = measureFrameHeight(doc)
    if (next <= 0) return
    setFrameHeight((current) =>
      current !== null && Math.abs(current - next) < MIN_HEIGHT_DELTA_PX ? current : next,
    )
  }, [])

  React.useEffect(() => {
    if (frameVersion === 0) return undefined
    const frame = frameRef.current
    const doc = frame?.contentDocument
    const frameWindow = frame?.contentWindow as FrameWindow | null | undefined
    if (!doc || !frameWindow) return undefined
    syncHeight()
    const Observer = frameWindow.ResizeObserver ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver)
    const observer = Observer ? new Observer(() => syncHeight()) : null
    if (observer && doc.documentElement) observer.observe(doc.documentElement)
    if (observer && doc.body) observer.observe(doc.body)
    window.addEventListener('resize', syncHeight)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', syncHeight)
    }
  }, [frameVersion, syncHeight])

  const handleLoad = React.useCallback(() => {
    setFrameVersion((current) => current + 1)
  }, [])

  const handlePrint = React.useCallback(() => {
    const frameWindow = frameRef.current?.contentWindow
    if (!frameWindow) return
    frameWindow.focus()
    frameWindow.print()
  }, [])

  const privacyNote = companyName
    ? t('offer_generator.public.privacyNote', { company: companyName })
    : t('offer_generator.public.privacyNoteGeneric')

  return (
    <div className="min-h-screen bg-background">
      <meta name="robots" content="noindex,nofollow" />
      <iframe
        ref={frameRef}
        src={src}
        title={title ?? t('offer_generator.public.frameTitle')}
        onLoad={handleLoad}
        className="block min-h-screen w-full border-0"
        style={frameHeight !== null ? { height: frameHeight } : undefined}
      />
      <footer className="mx-auto max-w-3xl px-6 pb-8 pt-2 text-center text-xs text-muted-foreground print:hidden">
        {privacyNote}
      </footer>
      <div className="fixed bottom-4 right-4 z-sticky print:hidden">
        <Button type="button" variant="outline" onClick={handlePrint} className="shadow-md">
          {t('offer_generator.public.print')}
        </Button>
      </div>
      <OfferTracker segment={segment} frameRef={frameRef} frameVersion={frameVersion} />
    </div>
  )
}
