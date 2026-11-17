// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { htmlToText, safeImageSrc, safeLinkHref, sanitizeHtml } from '@/modules/content/sanitize'

function render(html: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = sanitizeHtml(html)
  return host
}

function assertInert(html: string): void {
  const out = sanitizeHtml(html)
  const host = document.createElement('div')
  host.innerHTML = out
  const all = Array.from(host.querySelectorAll('*'))
  for (const element of all) {
    for (const attr of Array.from(element.attributes)) {
      expect(attr.name.startsWith('on'), `${attr.name} on ${element.tagName} from ${html}`).toBe(false)
      expect(['style', 'class', 'id', 'name', 'srcdoc', 'formaction', 'xlink:href']).not.toContain(attr.name)
      if (attr.name === 'href' || attr.name === 'src') {
        expect(attr.value.replace(/\s/g, '').toLowerCase()).not.toMatch(/^(javascript|vbscript|data:text|file):/)
      }
    }
    expect(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META', 'BASE', 'TEMPLATE', 'NOSCRIPT'])
      .not.toContain(element.tagName.toUpperCase())
  }
  expect(out.toLowerCase()).not.toContain('<script')
}

describe('sanitizeHtml — XSS vectors', () => {
  const vectors = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<img src="javascript:alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href=" javascript:alert(1)">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<svg onload=alert(1)><circle/></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example" srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<p onclick="alert(1)" class="x" id="cookie">hi</p>',
    '<details open ontoggle=alert(1)>',
    '<base href="javascript:/">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
    '<template><img src=x onerror=alert(1)></template>',
    '<style>@import "https://evil.example";</style><p>x</p>',
    '<!--<img src=x onerror=alert(1)>-->',
    '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+">',
    '<a href="//evil.example/path">x</a>',
    '<img src="//evil.example/x.png">',
    '<table><tr><td background="javascript:alert(1)" onmouseover="alert(1)">x</td></tr></table>',
    '<xmp><img src=x onerror=alert(1)></xmp>',
    '<input autofocus onfocus=alert(1)>',
    '<video><source onerror="alert(1)"></video>',
  ]

  for (const vector of vectors) {
    it(`neutralises ${vector.slice(0, 60)}`, () => assertInert(vector))
  }

  it('drops script content entirely instead of leaving the code as text', () => {
    expect(sanitizeHtml('<p>a</p><script>steal()</script>')).toBe('<p>a</p>')
  })

  it('does not execute anything while parsing', () => {
    const marker = { hit: false }
    ;(window as unknown as { __hit: () => void }).__hit = () => { marker.hit = true }
    sanitizeHtml('<img src=x onerror="__hit()"><script>__hit()</script>')
    expect(marker.hit).toBe(false)
  })

  it('handles deep nesting without overflowing', () => {
    const deep = `${'<div>'.repeat(1000)}x${'</div>'.repeat(1000)}`
    expect(() => sanitizeHtml(deep)).not.toThrow()
    expect(sanitizeHtml(deep)).toContain('x')
  })
})

describe('sanitizeHtml — keeps legitimate rich text', () => {
  it('keeps formatting, lists and tables', () => {
    const host = render('<h2>Title</h2><p><strong>Bold</strong> <em>it</em></p><ul><li>a</li></ul><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>')
    expect(host.querySelector('h2')?.textContent).toBe('Title')
    expect(host.querySelector('strong')?.textContent).toBe('Bold')
    expect(host.querySelectorAll('li')).toHaveLength(1)
    expect(host.querySelector('td')?.getAttribute('colspan')).toBe('2')
  })

  it('keeps safe links and hardens external ones', () => {
    const host = render('<a href="https://example.com/a?b=1">ext</a><a href="/notices/2">int</a><a href="mailto:a@b.co">m</a>')
    const [ext, int, mail] = Array.from(host.querySelectorAll('a'))
    expect(ext?.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(ext?.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(ext?.getAttribute('target')).toBe('_blank')
    expect(int?.getAttribute('href')).toBe('/notices/2')
    expect(int?.hasAttribute('target')).toBe(false)
    expect(mail?.getAttribute('href')).toBe('mailto:a@b.co')
  })

  it('keeps https and raster data images, drops everything else', () => {
    const host = render('<img src="https://cdn.example.com/a.png" alt="a"><img src="data:image/png;base64,AAAA"><img src="ftp://x/y.png">')
    const images = Array.from(host.querySelectorAll('img'))
    expect(images).toHaveLength(2)
    expect(images[0]?.getAttribute('alt')).toBe('a')
    expect(images[0]?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('unwraps links whose href was rejected', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">bad</a>')).toBe('bad')
    expect(sanitizeHtml('<a>plain</a>')).toBe('plain')
  })

  it('unwraps unknown elements but keeps their text', () => {
    expect(sanitizeHtml('<font color="red">hello</font>')).toBe('hello')
  })

  it('returns empty for non-strings', () => {
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml(42)).toBe('')
  })
})

describe('URL helpers', () => {
  it('rejects scripted and protocol-relative hrefs', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBe('')
    expect(safeLinkHref('\u0000javascript:alert(1)')).toBe('')
    expect(safeLinkHref('//evil.example')).toBe('')
    expect(safeLinkHref('/\\evil.example')).toBe('')
    expect(safeLinkHref('https://ok.example/')).toBe('https://ok.example/')
  })

  it('rejects svg data images', () => {
    expect(safeImageSrc('data:image/svg+xml;base64,AAAA')).toBe('')
  })

  it('produces a plain-text excerpt without markup', () => {
    expect(htmlToText('<p>Hello <b>world</b></p><script>x()</script>', 8)).toBe('Hello wo…')
  })
})
