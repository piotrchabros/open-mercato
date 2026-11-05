import sanitizeHtml from 'sanitize-html'

const DOCTYPE = '<!DOCTYPE html>'
const SAFE_LINK_RELS = new Set(['stylesheet', 'icon'])

const EXTRA_TAGS = [
  'html',
  'head',
  'body',
  'meta',
  'title',
  'style',
  'link',
  'img',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'picture',
  'source',
]

const SVG_TAGS = ['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']

const SVG_PRESENTATION_ATTRIBUTES = [
  'fill',
  'fill-rule',
  'fill-opacity',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-dasharray',
  'opacity',
  'transform',
  'vector-effect',
]

const UNSAFE_SVG_ATTRIBUTE_VALUE = /url\s*\(|javascript:|data:|expression\s*\(/i

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'form', 'input'])

const ALLOWED_TAGS = [...sanitizeHtml.defaults.allowedTags, ...EXTRA_TAGS, ...SVG_TAGS].filter(
  (tag) => !FORBIDDEN_TAGS.has(tag),
)

const GLOBAL_ATTRIBUTES = ['class', 'id', 'style', 'title', 'lang', 'dir', 'role', 'data-*', 'aria-*']

function isSafeStylesheetOrIcon(attribs: Record<string, string>): boolean {
  const rel = (attribs.rel ?? '').toLowerCase().trim()
  const href = (attribs.href ?? '').trim().toLowerCase()
  return SAFE_LINK_RELS.has(rel) && href.startsWith('https:')
}

function svgAttributes(...names: string[]): string[] {
  return [...names, ...SVG_PRESENTATION_ATTRIBUTES]
}

function stripUnsafeSvgAttributes(tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag {
  const safe = Object.fromEntries(
    Object.entries(attribs).filter(([, value]) => !UNSAFE_SVG_ATTRIBUTE_VALUE.test(value)),
  )
  return { tagName, attribs: safe }
}

const SVG_TRANSFORMS = Object.fromEntries(SVG_TAGS.map((tag) => [tag, stripUnsafeSvgAttributes]))

export function sanitizeOfferHtml(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': GLOBAL_ATTRIBUTES,
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'loading'],
      source: ['srcset', 'type', 'media'],
      meta: ['charset', 'name', 'content', 'property'],
      link: ['rel', 'href', 'type', 'media', 'sizes', 'crossorigin'],
      td: ['colspan', 'rowspan', 'headers'],
      th: ['colspan', 'rowspan', 'scope', 'headers'],
      col: ['span'],
      colgroup: ['span'],
      ol: ['start', 'type'],
      svg: svgAttributes('viewbox', 'width', 'height', 'preserveaspectratio', 'focusable'),
      g: svgAttributes(),
      path: svgAttributes('d', 'pathlength'),
      circle: svgAttributes('cx', 'cy', 'r'),
      ellipse: svgAttributes('cx', 'cy', 'rx', 'ry'),
      rect: svgAttributes('x', 'y', 'width', 'height', 'rx', 'ry'),
      line: svgAttributes('x1', 'y1', 'x2', 'y2'),
      polyline: svgAttributes('points'),
      polygon: svgAttributes('points'),
    },
    allowedSchemes: ['https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    allowProtocolRelative: false,
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => frame.tag === 'link' && !isSafeStylesheetOrIcon(frame.attribs),
    transformTags: {
      ...SVG_TRANSFORMS,
      a: (tagName, attribs) =>
        attribs.target === '_blank'
          ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }
          : { tagName, attribs },
    },
  })
  return `${DOCTYPE}\n${clean.trimStart()}`
}
