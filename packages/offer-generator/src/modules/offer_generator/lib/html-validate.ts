export const MIN_OFFER_BODY_TEXT = 200
export const REFINE_MIN_SIZE_RATIO = 0.5

const REFINE_MIN_BASE_LENGTH = 2000

export type OfferHtmlIssue = 'no-html-close' | 'no-body' | 'empty-body'

export type OfferHtmlCheck =
  | { ok: true; bodyTextLength: number }
  | { ok: false; issue: OfferHtmlIssue; bodyTextLength: number }

export type RefineShrinkCheck =
  | { ok: true; ratio: number }
  | { ok: false; issue: 'refine-shrunk'; ratio: number; shrinkPercent: number }

export function offerBodyTextLength(html: string): number {
  const open = /<body(?:\s[^>]*)?>/i.exec(html)
  const closeIndex = html.toLowerCase().lastIndexOf('</body>')
  if (!open || closeIndex === -1) return 0
  const start = open.index + open[0].length
  if (closeIndex < start) return 0

  return html
    .slice(start, closeIndex)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}

export function checkOfferHtmlComplete(html: string): OfferHtmlCheck {
  const lower = html.toLowerCase()
  const bodyTextLength = offerBodyTextLength(html)
  const fail = (issue: OfferHtmlIssue): OfferHtmlCheck => ({ ok: false, issue, bodyTextLength })

  if (!lower.includes('</html>')) return fail('no-html-close')
  if (!/<body/i.test(html) || !lower.includes('</body>')) return fail('no-body')
  if (bodyTextLength < MIN_OFFER_BODY_TEXT) return fail('empty-body')
  return { ok: true, bodyTextLength }
}

export function checkRefineNotShrunk(baseStripped: string, outputStripped: string): RefineShrinkCheck {
  if (baseStripped.length < REFINE_MIN_BASE_LENGTH) {
    return { ok: true, ratio: baseStripped.length === 0 ? 1 : outputStripped.length / baseStripped.length }
  }
  const ratio = outputStripped.length / baseStripped.length
  if (ratio < REFINE_MIN_SIZE_RATIO) {
    return { ok: false, issue: 'refine-shrunk', ratio, shrinkPercent: Math.round((1 - ratio) * 100) }
  }
  return { ok: true, ratio }
}
