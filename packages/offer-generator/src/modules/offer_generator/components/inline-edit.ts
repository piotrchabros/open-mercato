const EDIT_STYLE_ID = 'om-offer-edit-mode-style'
const TOOLBAR_ID = 'om-offer-edit-toolbar'
const EDITABLE_SELECTORS = 'h1, h2, h3, h4, h5, h6, p, li, td, th, label, button, span, a, blockquote'

const ORIG_ATTR = 'data-om-offer-orig'
const EDITED_ATTR = 'data-user-edited'
const EDITABLE_MARKER = 'data-om-offer-editable'

const EDIT_STYLE_CSS = `
  [${EDITABLE_MARKER}] {
    transition: outline 80ms ease, background 80ms ease;
  }
  [${EDITABLE_MARKER}]:hover {
    outline: 2px dashed #6366f1 !important;
    outline-offset: 3px !important;
    cursor: text !important;
  }
  [${EDITABLE_MARKER}]:focus {
    outline: 2px solid #6366f1 !important;
    outline-offset: 3px !important;
    background: rgba(99,102,241,0.06) !important;
  }
  [${EDITED_ATTR}="1"] {
    outline: 1px dashed rgba(245,158,11,0.6) !important;
    outline-offset: 2px !important;
  }
  [${EDITED_ATTR}="1"][${EDITABLE_MARKER}]:hover {
    outline: 2px dashed #f59e0b !important;
  }
  #${TOOLBAR_ID} {
    position: absolute;
    z-index: 99999;
    display: none;
    gap: 2px;
    padding: 4px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #${TOOLBAR_ID}.visible { display: flex; }
  #${TOOLBAR_ID} button {
    background: transparent;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    line-height: 1;
    min-width: 26px;
  }
  #${TOOLBAR_ID} button:hover { background: rgba(99,102,241,0.25); }
  #${TOOLBAR_ID} .sep { width: 1px; background: rgba(255,255,255,0.1); margin: 0 2px; }
`

export type InlineEditLabels = {
  bold: string
  italic: string
  underline: string
  link: string
  unlink: string
  clearFormatting: string
  linkPrompt: string
}

export const DEFAULT_INLINE_EDIT_LABELS: InlineEditLabels = {
  bold: 'Bold (Ctrl+B)',
  italic: 'Italic (Ctrl+I)',
  underline: 'Underline (Ctrl+U)',
  link: 'Insert link',
  unlink: 'Remove link',
  clearFormatting: 'Clear formatting',
  linkPrompt: 'Link URL:',
}

type DocBag = { cleanup: () => void }
const activeDocs = new WeakMap<Document, DocBag>()

type ExecCommandDocument = Document & { execCommand: (command: string, showUi: boolean, value?: string) => boolean }

function applyFormat(doc: Document, command: string, value?: string): void {
  ;(doc as ExecCommandDocument).execCommand(command, false, value)
}

function requestLinkUrl(doc: Document, label: string): string | null {
  const host = typeof window !== 'undefined' ? window : doc.defaultView
  const url = host?.prompt(label, 'https://')
  return url && url.trim() ? url.trim() : null
}

function buildToolbar(doc: Document, labels: InlineEditLabels): HTMLElement {
  const existing = doc.getElementById(TOOLBAR_ID)
  if (existing) return existing
  const toolbar = doc.createElement('div')
  toolbar.id = TOOLBAR_ID

  const makeButton = (text: string, title: string, action: () => void, style?: Partial<CSSStyleDeclaration>) => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.title = title
    button.setAttribute('aria-label', title)
    if (style) Object.assign(button.style, style)
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      action()
    })
    return button
  }

  const makeSeparator = () => {
    const separator = doc.createElement('div')
    separator.className = 'sep'
    return separator
  }

  toolbar.appendChild(makeButton('B', labels.bold, () => applyFormat(doc, 'bold')))
  toolbar.appendChild(makeButton('I', labels.italic, () => applyFormat(doc, 'italic'), { fontStyle: 'italic' }))
  toolbar.appendChild(makeButton('U', labels.underline, () => applyFormat(doc, 'underline'), { textDecoration: 'underline' }))
  toolbar.appendChild(makeSeparator())
  toolbar.appendChild(
    makeButton('Link', labels.link, () => {
      const url = requestLinkUrl(doc, labels.linkPrompt)
      if (url) applyFormat(doc, 'createLink', url)
    }),
  )
  toolbar.appendChild(makeButton('Unlink', labels.unlink, () => applyFormat(doc, 'unlink')))
  toolbar.appendChild(makeSeparator())
  toolbar.appendChild(makeButton('Tx', labels.clearFormatting, () => applyFormat(doc, 'removeFormat')))

  doc.body.appendChild(toolbar)
  return toolbar
}

function positionToolbar(doc: Document, toolbar: HTMLElement): void {
  const selection = doc.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    toolbar.classList.remove('visible')
    return
  }
  const range = selection.getRangeAt(0)
  const anchor = range.startContainer.parentElement
  const editable = anchor?.closest(`[${EDITABLE_MARKER}]`)
  if (!editable) {
    toolbar.classList.remove('visible')
    return
  }
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    toolbar.classList.remove('visible')
    return
  }
  const view = doc.defaultView
  const scrollX = view?.scrollX || 0
  const scrollY = view?.scrollY || 0
  toolbar.classList.add('visible')
  const toolbarRect = toolbar.getBoundingClientRect()
  let left = rect.left + scrollX + rect.width / 2 - toolbarRect.width / 2
  let top = rect.top + scrollY - toolbarRect.height - 10
  if (top < scrollY + 4) top = rect.bottom + scrollY + 8
  const docWidth = doc.documentElement.clientWidth
  if (left < 4) left = 4
  if (left + toolbarRect.width > docWidth - 4) left = docWidth - toolbarRect.width - 4
  toolbar.style.left = `${left}px`
  toolbar.style.top = `${top}px`
}

function markEditedOnInput(element: HTMLElement): void {
  const original = element.getAttribute(ORIG_ATTR) ?? ''
  const current = (element.textContent || '').trim()
  if (current !== original) element.setAttribute(EDITED_ATTR, '1')
}

function isElementNode(target: EventTarget | null): target is HTMLElement {
  return Boolean(target && typeof (target as Node).nodeType === 'number' && (target as Node).nodeType === 1)
}

export function isEditModeActive(doc: Document): boolean {
  return activeDocs.has(doc)
}

export function applyEditMode(doc: Document, labels: InlineEditLabels = DEFAULT_INLINE_EDIT_LABELS): void {
  if (activeDocs.has(doc) || !doc.body) return

  if (!doc.getElementById(EDIT_STYLE_ID)) {
    const style = doc.createElement('style')
    style.id = EDIT_STYLE_ID
    style.textContent = EDIT_STYLE_CSS
    doc.head?.appendChild(style)
  }

  const toolbar = buildToolbar(doc, labels)

  doc.querySelectorAll<HTMLElement>(EDITABLE_SELECTORS).forEach((element) => {
    if (element.querySelector(EDITABLE_SELECTORS)) return
    if (element.closest(`#${TOOLBAR_ID}`)) return
    const text = (element.textContent || '').trim()
    if (text.length === 0) return
    element.setAttribute('contenteditable', 'true')
    element.setAttribute(EDITABLE_MARKER, 'true')
    element.setAttribute('spellcheck', 'true')
    if (!element.hasAttribute(ORIG_ATTR)) element.setAttribute(ORIG_ATTR, text)
  })

  const onSelectionChange = () => positionToolbar(doc, toolbar)
  doc.addEventListener('selectionchange', onSelectionChange)

  const onInput = (event: Event) => {
    const target = event.target
    if (!isElementNode(target) || !target.hasAttribute(EDITABLE_MARKER)) return
    markEditedOnInput(target)
  }
  doc.addEventListener('input', onInput, true)

  const onClick = (event: Event) => {
    const target = event.target
    if (!isElementNode(target)) return
    if (target.closest(`[${EDITABLE_MARKER}]`) && target.closest('a, button')) event.preventDefault()
  }
  doc.addEventListener('click', onClick, true)

  const hideToolbar = () => toolbar.classList.remove('visible')
  doc.defaultView?.addEventListener('scroll', hideToolbar, true)
  doc.defaultView?.addEventListener('resize', hideToolbar)

  activeDocs.set(doc, {
    cleanup: () => {
      doc.removeEventListener('selectionchange', onSelectionChange)
      doc.removeEventListener('input', onInput, true)
      doc.removeEventListener('click', onClick, true)
      doc.defaultView?.removeEventListener('scroll', hideToolbar, true)
      doc.defaultView?.removeEventListener('resize', hideToolbar)
    },
  })
}

function stripEditAttributes(root: ParentNode): void {
  root.querySelectorAll('[contenteditable]').forEach((element) => {
    element.removeAttribute('contenteditable')
    element.removeAttribute(EDITABLE_MARKER)
    element.removeAttribute('spellcheck')
    element.removeAttribute(ORIG_ATTR)
  })
}

export function extractEditedHtml(doc: Document): string {
  const clone = doc.documentElement.cloneNode(true) as HTMLElement
  stripEditAttributes(clone)
  clone.querySelector(`#${EDIT_STYLE_ID}`)?.remove()
  clone.querySelector(`#${TOOLBAR_ID}`)?.remove()
  return `<!DOCTYPE html>\n${clone.outerHTML}`
}

export function disableEditMode(doc: Document): void {
  const bag = activeDocs.get(doc)
  if (bag) {
    bag.cleanup()
    activeDocs.delete(doc)
  }
  stripEditAttributes(doc)
  doc.getElementById(EDIT_STYLE_ID)?.remove()
  doc.getElementById(TOOLBAR_ID)?.remove()
}

export function countEditedElements(html: string): number {
  const matches = html.match(new RegExp(`${EDITED_ATTR}=["']1["']`, 'g'))
  return matches ? matches.length : 0
}

export function countEditedElementsInDocument(doc: Document): number {
  return doc.querySelectorAll(`[${EDITED_ATTR}="1"]`).length
}
