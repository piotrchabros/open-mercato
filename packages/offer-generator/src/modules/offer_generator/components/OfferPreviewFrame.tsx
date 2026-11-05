'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'

export const BACKEND_RENDER_ENDPOINT = '/api/offer_generator/render/offers'

const MIN_HEIGHT_DELTA_PX = 2

type FrameWindow = Window & typeof globalThis

export type OfferPreviewFrameProps = {
  offerId: string
  version: string | null
  reloadKey?: number
  title?: string
  frameRef?: React.MutableRefObject<HTMLIFrameElement | null>
  onFrameLoad?: (frame: HTMLIFrameElement) => void
}

export function buildOfferPreviewUrl(offerId: string, version: string | null): string {
  const base = `${BACKEND_RENDER_ENDPOINT}/${encodeURIComponent(offerId)}`
  return version ? `${base}?v=${encodeURIComponent(version)}` : base
}

function measureFrameHeight(doc: Document): number {
  const root = doc.documentElement
  const body = doc.body
  return Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0, root?.offsetHeight ?? 0)
}

export function OfferPreviewFrame({
  offerId,
  version,
  reloadKey = 0,
  title,
  frameRef,
  onFrameLoad,
}: OfferPreviewFrameProps) {
  const t = useT()
  const localRef = React.useRef<HTMLIFrameElement | null>(null)
  const ref = frameRef ?? localRef
  const [frameHeight, setFrameHeight] = React.useState<number | null>(null)
  const [loadCount, setLoadCount] = React.useState(0)
  const src = buildOfferPreviewUrl(offerId, version)

  const syncHeight = React.useCallback(() => {
    const doc = ref.current?.contentDocument
    if (!doc) return
    const next = measureFrameHeight(doc)
    if (next <= 0) return
    setFrameHeight((current) =>
      current !== null && Math.abs(current - next) < MIN_HEIGHT_DELTA_PX ? current : next,
    )
  }, [ref])

  React.useEffect(() => {
    if (loadCount === 0) return undefined
    const frame = ref.current
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
  }, [loadCount, ref, syncHeight])

  const handleLoad = React.useCallback(() => {
    setLoadCount((current) => current + 1)
    const frame = ref.current
    if (frame && onFrameLoad) onFrameLoad(frame)
  }, [onFrameLoad, ref])

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <iframe
        key={`${src}:${reloadKey}`}
        ref={ref}
        src={src}
        title={title ?? t('offer_generator.detail.preview.frameTitle', 'Offer preview')}
        onLoad={handleLoad}
        className="block min-h-screen w-full border-0"
        style={frameHeight !== null ? { height: frameHeight } : undefined}
      />
    </div>
  )
}

export default OfferPreviewFrame
