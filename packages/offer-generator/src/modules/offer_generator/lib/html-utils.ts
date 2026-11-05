const PRINT_STYLE_MARKER = 'data-offer-print'

const PRINT_STYLES = `<style ${PRINT_STYLE_MARKER}>@page{size:A4;margin:12mm}html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.card,.svc-item,.why-cell,.tbl tr{break-inside:avoid;page-break-inside:avoid}.sec-label{break-after:avoid;page-break-after:avoid}</style>`

export function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:html)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

export function stripDataUris(html: string): { stripped: string; restore: (value: string) => string } {
  const placeholders: string[] = []
  const stripped = html.replace(/data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+/g, (match) => {
    placeholders.push(match)
    return `__IMG_${placeholders.length - 1}__`
  })
  const restore = (value: string): string =>
    value.replace(/__IMG_(\d+)__/g, (_match, index: string) => placeholders[Number(index)] ?? '')
  return { stripped, restore }
}

export function detectHtmlLanguage(html: string): string | null {
  const match = /<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z]{2,3})(?:-[a-zA-Z0-9-]+)?["']?/i.exec(html)
  return match ? match[1].toLowerCase() : null
}

export function injectPrintStyles(html: string): string {
  if (html.includes(PRINT_STYLE_MARKER)) return html
  const headClose = /<\/head\s*>/i.exec(html)
  if (headClose) {
    return `${html.slice(0, headClose.index)}${PRINT_STYLES}${html.slice(headClose.index)}`
  }
  const bodyOpen = /<body(?:\s[^>]*)?>/i.exec(html)
  if (bodyOpen) {
    const end = bodyOpen.index + bodyOpen[0].length
    return `${html.slice(0, end)}${PRINT_STYLES}${html.slice(end)}`
  }
  return `${PRINT_STYLES}${html}`
}

export function countEditedElements(html: string): number {
  return (html.match(/\sdata-user-edited\s*=/gi) ?? []).length
}
