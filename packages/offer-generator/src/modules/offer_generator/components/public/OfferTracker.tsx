'use client'

import * as React from 'react'
import { TRACKING } from '../../lib/constants'
import {
  MAX_TRACKED_SECTIONS,
  buildSectionKey,
  computeScrollPct,
  fitBeatBody,
  normalizeSectionLabel,
} from '../../lib/tracker-sections'
import type { TrackingBeatInput, TrackingStartInput } from '../../data/validators'

export const OFFER_SESSION_ENDPOINT = '/api/offer_generator/public/sessions'

const INTERACTION_EVENTS = ['scroll', 'pointerdown', 'pointermove', 'keydown', 'touchstart'] as const
const TICK_MS = 1000
const SECTION_VISIBLE_RATIO = 0.2
const SECTION_VISIBLE_VIEWPORT_SHARE = 0.4
const SECTION_THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
const SECTION_LABEL_SELECTOR = '[data-section-label], .sec-label, h2, h3'

type StartResponse = { ok?: boolean; counted?: boolean }

type TrackedSection = { element: Element; key: string; label: string; ms: number; visible: boolean }

type TrackerHandle = {
  attachFrame: (frame: HTMLIFrameElement | null) => void
  dispose: () => void
}

export type OfferTrackerProps = {
  segment: string
  frameRef: React.RefObject<HTMLIFrameElement | null>
  frameVersion: number
}

function newViewKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function postTracking(body: TrackingStartInput | TrackingBeatInput, useBeacon: boolean): Promise<Response | null> {
  const payload = JSON.stringify(body)
  if (useBeacon && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([payload], { type: 'text/plain' })
      if (navigator.sendBeacon(OFFER_SESSION_ENDPOINT, blob)) return Promise.resolve(null)
    } catch {}
  }
  try {
    return fetch(OFFER_SESSION_ENDPOINT, {
      method: 'POST',
      body: payload,
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'text/plain' },
    }).catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

async function readStartResponse(response: Response | null): Promise<StartResponse | null> {
  if (!response || !response.ok) return null
  try {
    const data: unknown = await response.json()
    return data && typeof data === 'object' ? (data as StartResponse) : null
  } catch {
    return null
  }
}

function findSectionElements(doc: Document): Element[] {
  const tiers = ['[data-section]', 'section', '.sec-label, h2']
  for (const selector of tiers) {
    const found = Array.from(doc.querySelectorAll(selector))
    if (found.length > 0) return found.slice(0, MAX_TRACKED_SECTIONS)
  }
  return []
}

function resolveSectionLabel(element: Element): string {
  const explicit = normalizeSectionLabel(element.getAttribute('data-section'))
  if (explicit) return explicit
  const heading = element.matches(SECTION_LABEL_SELECTOR) ? element : element.querySelector(SECTION_LABEL_SELECTOR)
  const fromHeading = normalizeSectionLabel(heading?.textContent)
  if (fromHeading) return fromHeading
  return normalizeSectionLabel(element.getAttribute('aria-label'))
}

function readFrameDocument(frame: HTMLIFrameElement | null): Document | null {
  if (!frame) return null
  try {
    return frame.contentDocument
  } catch {
    return null
  }
}

function createTracker(segment: string): TrackerHandle {
  let disposed = false
  let stopped = false
  let live = false
  let started = false
  let viewKey = newViewKey()
  let visibleMs = 0
  let activeMs = 0
  let maxScroll = 0
  let lastInteraction = Date.now()
  let lastTick = Date.now()
  let lastBeatAt = Date.now()
  let lastBeatSignature = ''
  let hiddenAt: number | null = document.visibilityState === 'hidden' ? Date.now() : null
  let ticker: ReturnType<typeof setInterval> | null = null
  let frame: HTMLIFrameElement | null = null
  let frameWindow: Window | null = null
  let observer: IntersectionObserver | null = null
  let sections: TrackedSection[] = []

  const updateScroll = () => {
    const frameRect = frame ? frame.getBoundingClientRect() : null
    const pct = frameRect
      ? computeScrollPct(window.innerHeight - frameRect.top, frameRect.height)
      : computeScrollPct(window.scrollY + window.innerHeight, document.documentElement.scrollHeight)
    if (pct > maxScroll) maxScroll = pct
  }

  const onInteraction = (event: Event) => {
    lastInteraction = Date.now()
    if (event.type === 'scroll') updateScroll()
  }

  const isSectionVisible = (intersectionRatio: number, intersectingHeight: number) =>
    intersectionRatio >= SECTION_VISIBLE_RATIO ||
    intersectingHeight >= window.innerHeight * SECTION_VISIBLE_VIEWPORT_SHARE

  const refreshVisibilityFromRects = () => {
    if (observer || !frame) return
    const frameTop = frame.getBoundingClientRect().top
    for (const section of sections) {
      const rect = section.element.getBoundingClientRect()
      const top = Math.max(0, frameTop + rect.top)
      const bottom = Math.min(window.innerHeight, frameTop + rect.bottom)
      const intersectingHeight = Math.max(0, bottom - top)
      const ratio = rect.height > 0 ? intersectingHeight / rect.height : 0
      section.visible = intersectingHeight > 0 && isSectionVisible(ratio, intersectingHeight)
    }
  }

  const detachFrameListeners = () => {
    if (!frameWindow) return
    try {
      for (const name of INTERACTION_EVENTS) frameWindow.removeEventListener(name, onInteraction)
    } catch {}
    frameWindow = null
  }

  const detachSections = () => {
    observer?.disconnect()
    observer = null
    sections = []
  }

  const attachFrame = (nextFrame: HTMLIFrameElement | null) => {
    if (disposed || stopped) return
    detachFrameListeners()
    detachSections()
    frame = nextFrame
    const doc = readFrameDocument(nextFrame)
    if (!nextFrame || !doc) return
    try {
      frameWindow = nextFrame.contentWindow
      if (frameWindow) {
        for (const name of INTERACTION_EVENTS) frameWindow.addEventListener(name, onInteraction, { passive: true })
      }
    } catch {
      frameWindow = null
    }
    sections = findSectionElements(doc).map((element, index) => {
      const label = resolveSectionLabel(element)
      return { element, key: buildSectionKey(index, label), label, ms: 0, visible: false }
    })
    if (sections.length === 0 || typeof IntersectionObserver === 'undefined') return
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const section = sections.find((candidate) => candidate.element === entry.target)
          if (!section) continue
          section.visible =
            entry.isIntersecting && isSectionVisible(entry.intersectionRatio, entry.intersectionRect.height)
        }
      },
      { threshold: SECTION_THRESHOLDS },
    )
    for (const section of sections) observer.observe(section.element)
  }

  const resetView = () => {
    viewKey = newViewKey()
    activeMs = 0
    maxScroll = 0
    lastBeatSignature = ''
    for (const section of sections) section.ms = 0
  }

  const sendBeat = (useBeacon: boolean) => {
    if (!live) return
    updateScroll()
    const ms = Math.round(activeMs)
    const sectionMs = sections.reduce((total, section) => total + Math.round(section.ms), 0)
    const signature = `${viewKey}|${ms}|${maxScroll}|${sectionMs}`
    if (signature === lastBeatSignature) return
    lastBeatSignature = signature
    lastBeatAt = Date.now()
    const body = fitBeatBody(
      {
        t: 'beat',
        seg: segment,
        key: viewKey,
        ms,
        sc: maxScroll,
        sx: sections.map((section) => ({ k: section.key, l: section.label, ms: section.ms })),
      },
      TRACKING.MAX_BODY_BYTES,
    )
    void postTracking(body, useBeacon)
  }

  const sendStart = () => {
    started = true
    const key = viewKey
    updateScroll()
    const body: TrackingStartInput = {
      t: 'start',
      seg: segment,
      key,
      ref: document.referrer.slice(0, 300) || null,
    }
    void postTracking(body, false)
      .then(readStartResponse)
      .then((data) => {
        if (disposed || key !== viewKey) return
        if (!data || data.ok !== true || data.counted !== true) {
          teardown()
          return
        }
        live = true
        lastBeatAt = Date.now()
      })
  }

  const tick = () => {
    const now = Date.now()
    const delta = Math.min(now - lastTick, 2 * TICK_MS)
    lastTick = now
    if (document.visibilityState !== 'visible') return
    updateScroll()
    if (!started) {
      visibleMs += delta
      if (visibleMs >= TRACKING.START_DELAY_MS) sendStart()
      return
    }
    if (!live) return
    if (now - lastInteraction < TRACKING.IDLE_AFTER_MS) {
      activeMs = Math.min(activeMs + delta, TRACKING.MAX_ACTIVE_MS)
      refreshVisibilityFromRects()
      for (const section of sections) {
        if (section.visible) section.ms = Math.min(section.ms + delta, TRACKING.MAX_ACTIVE_MS)
      }
    }
    if (now - lastBeatAt >= TRACKING.HEARTBEAT_MS) sendBeat(false)
  }

  const onVisibility = () => {
    const now = Date.now()
    if (document.visibilityState === 'hidden') {
      hiddenAt = now
      sendBeat(true)
      return
    }
    lastTick = now
    const hiddenFor = hiddenAt === null ? 0 : now - hiddenAt
    hiddenAt = null
    if (live && hiddenFor >= TRACKING.NEW_VIEW_AFTER_HIDDEN_MS) {
      live = false
      resetView()
      lastInteraction = now
      sendStart()
    }
  }

  const onPageHide = () => sendBeat(true)

  function teardown() {
    stopped = true
    live = false
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    for (const name of INTERACTION_EVENTS) window.removeEventListener(name, onInteraction)
    detachFrameListeners()
    detachSections()
  }

  const begin = () => {
    if (disposed) return
    lastInteraction = Date.now()
    lastTick = Date.now()
    for (const name of INTERACTION_EVENTS) window.addEventListener(name, onInteraction, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    ticker = setInterval(tick, TICK_MS)
  }

  const prerendering = (document as Document & { prerendering?: boolean }).prerendering === true
  if (prerendering) document.addEventListener('prerenderingchange', begin, { once: true })
  else begin()

  return {
    attachFrame,
    dispose: () => {
      document.removeEventListener('prerenderingchange', begin)
      if (live) sendBeat(true)
      disposed = true
      teardown()
    },
  }
}

export function OfferTracker({ segment, frameRef, frameVersion }: OfferTrackerProps): null {
  const trackerRef = React.useRef<TrackerHandle | null>(null)

  React.useEffect(() => {
    if (typeof window === 'undefined' || navigator.webdriver) return undefined
    const tracker = createTracker(segment)
    trackerRef.current = tracker
    tracker.attachFrame(frameRef.current)
    return () => {
      tracker.dispose()
      if (trackerRef.current === tracker) trackerRef.current = null
    }
  }, [segment, frameRef])

  React.useEffect(() => {
    if (frameVersion === 0) return
    trackerRef.current?.attachFrame(frameRef.current)
  }, [frameVersion, frameRef])

  return null
}
