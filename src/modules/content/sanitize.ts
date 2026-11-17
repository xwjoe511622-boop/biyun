/**
 * Strict allowlist HTML sanitizer for admin-authored rich text (notices, help articles, CMS pages).
 *
 * Design:
 * - Input is parsed with `DOMParser` into an inert document (no script execution, no resource
 *   loading), then a brand-new tree is rebuilt with DOM APIs. Nothing from the source document is
 *   moved or cloned, so only what this file explicitly copies can survive.
 * - Element allowlist; dangerous containers (script/style/iframe/svg/math/form controls/…) are
 *   dropped together with their content; any other unknown element is unwrapped (children kept).
 * - Attribute allowlist per element. No `style`, `class`, `id`, `name` or event handlers, which
 *   also rules out CSS injection and DOM clobbering.
 * - URLs: links allow http(s), mailto and same-origin relative paths / fragments; images allow
 *   http(s), same-origin rooted paths and raster `data:image/*;base64` only.
 * - Depth-limited so a pathological nesting cannot exhaust the stack.
 */

const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed',
  'noframes', 'template', 'svg', 'math', 'form', 'input', 'button', 'textarea', 'select', 'option',
  'link', 'meta', 'base', 'title', 'head', 'audio', 'video', 'source', 'track', 'canvas', 'dialog',
  'portal', 'xmp', 'plaintext', 'listing', 'param',
])

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
  'sub', 'sup', 'small', 'mark', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a',
  'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'span', 'div', 'figure',
  'figcaption', 'section', 'article',
])

const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  ol: ['start'],
}

const MAX_DEPTH = 48
const MAX_INPUT_LENGTH = 400_000

/** Removes whitespace/control characters browsers ignore inside a URL scheme (`java\tscript:`). */
const URL_JUNK = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g')

function compactUrl(value: string): string {
  return value.replace(URL_JUNK, '')
}

function isRelativeSafe(value: string): boolean {
  if (value.startsWith('#')) return true
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
}

export function safeLinkHref(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const compact = compactUrl(trimmed)
  if (isRelativeSafe(compact)) return trimmed
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)
  if (scheme === null) return ''
  const name = (scheme[1] ?? '').toLowerCase()
  if (name !== 'http' && name !== 'https' && name !== 'mailto') return ''
  try {
    const url = new URL(compact)
    return url.href
  } catch {
    return ''
  }
}

export function safeImageSrc(raw: string): string {
  const compact = compactUrl(raw.trim())
  if (compact === '') return ''
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(compact)) return compact
  if (compact.startsWith('/') && !compact.startsWith('//') && !compact.includes('\\')) return compact
  if (!/^https?:/i.test(compact)) return ''
  try {
    return new URL(compact).href
  } catch {
    return ''
  }
}

function isExternal(href: string): boolean {
  return /^https?:/i.test(href)
}

function copyAttributes(source: Element, target: Element, tag: string): void {
  const allowed = ALLOWED_ATTRS[tag]
  if (allowed === undefined) return
  for (const name of allowed) {
    const value = source.getAttribute(name)
    if (value === null) continue
    if (name === 'href') {
      const href = safeLinkHref(value)
      if (href !== '') target.setAttribute('href', href)
      continue
    }
    if (name === 'src') {
      const src = safeImageSrc(value)
      if (src !== '') target.setAttribute('src', src)
      continue
    }
    if (name === 'colspan' || name === 'rowspan' || name === 'start' || name === 'width' || name === 'height') {
      if (/^\d{1,4}$/.test(value.trim())) target.setAttribute(name, value.trim())
      continue
    }
    target.setAttribute(name, value.slice(0, 500))
  }
  if (tag === 'a' && target.hasAttribute('href') && isExternal(target.getAttribute('href') ?? '')) {
    target.setAttribute('target', '_blank')
    target.setAttribute('rel', 'noopener noreferrer nofollow')
  }
  if (tag === 'img') {
    target.setAttribute('loading', 'lazy')
    target.setAttribute('referrerpolicy', 'no-referrer')
  }
}

function rebuild(source: Node, target: Node, doc: Document, depth: number): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      target.appendChild(doc.createTextNode(child.nodeValue ?? ''))
      continue
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue // comments, CDATA, processing instructions
    const element = child as Element
    const tag = element.localName.toLowerCase()
    // Only HTML-namespace elements: anything foreign (svg/math content) is dropped.
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROP_WITH_CONTENT.has(tag)) continue
    if (depth >= MAX_DEPTH) {
      const text = element.textContent ?? ''
      if (text !== '') target.appendChild(doc.createTextNode(text))
      continue
    }
    if (!ALLOWED_TAGS.has(tag)) {
      rebuild(element, target, doc, depth + 1)
      continue
    }
    if (tag === 'img') {
      const src = safeImageSrc(element.getAttribute('src') ?? '')
      if (src === '') continue
    }
    if (tag === 'a' && safeLinkHref(element.getAttribute('href') ?? '') === '') {
      // A link whose target was rejected must not look clickable: keep only its content.
      rebuild(element, target, doc, depth + 1)
      continue
    }
    const clean = doc.createElement(tag)
    copyAttributes(element, clean, tag)
    if (tag !== 'img' && tag !== 'br' && tag !== 'hr') rebuild(element, clean, doc, depth + 1)
    target.appendChild(clean)
  }
}

/** Returns sanitized HTML safe for `v-html`. Non-string input yields an empty string. */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') return ''
  const html = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const container = out.createElement('div')
  rebuild(parsed.body, container, out, 0)
  return container.innerHTML
}

/** Plain-text excerpt of rich text (for list previews); never returns markup. */
export function htmlToText(input: unknown, maxLength = 160): string {
  if (typeof input !== 'string' || input === '') return ''
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${input.slice(0, MAX_INPUT_LENGTH)}`, 'text/html')
  parsed.querySelectorAll('script,style,template,noscript').forEach((node) => node.remove())
  const text = (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text
}
