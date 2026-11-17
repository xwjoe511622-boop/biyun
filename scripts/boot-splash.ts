/**
 * Entry splash (owner 10-22: 进交易所的时候做个合适的动画，接近黑洞的金色天体，节省加载资源). Self-drawn: a black hole
 * with a rotating accretion disk, a lensed arc over the top, a gold photon ring and a few infalling sparks, as
 * inline SVG + CSS injected into index.html, so it paints with the HTML (no image, no font, no request).
 *
 * The CSP is `script-src 'self'`, so there is no inline script: the splash fades in only after 180 ms (a cached
 * reload removes it before that, see src/core/boot-splash.ts), hides itself under prefers-reduced-motion, and has
 * a 12 s CSS fallback exit in case the app never boots.
 */
type SkinId = 'binance' | 'okx'

interface SplashColors {
  bg: string
  glow: string
  diskDim: string
  disk: string
  diskHot: string
  ring: string
  arc: string
  /** W mark gradient stops (5), tagline accent ("WIN"), and the rules either side of the tagline. */
  w: [string, string, string, string, string]
  accent: string
  rule: string
}

const COLORS: Record<SkinId, SplashColors> = {
  // Black-gold: gold on pure black.
  okx: { bg: '#000', glow: '#c99a4a', diskDim: '#6b4614', disk: '#d9a85a', diskHot: '#fff2d2', ring: '#ffe6b0', arc: '#f0c879',
    w: ['#FFE9A0', '#F2C64E', '#C08A22', '#F6D36E', '#B07A18'], accent: '#f2c64e', rule: '#c9a24a' },
  // www (owner 10-22: blue logo): indigo disk, blue photon ring and lensed rim, blue W.
  binance: { bg: '#03050d', glow: '#3450e0', diskDim: '#1b2580', disk: '#5b7cff', diskHot: '#e6eeff', ring: '#b9caff', arc: '#8aa6ff',
    w: ['#CFDBFF', '#7D9BFF', '#2E5BFF', '#9EB6FF', '#1F3FC2'], accent: '#7d9bff', rule: '#5b7cff' },
}

/** BITWINEX gold "W" (designer mark, viewBox 0 0 1594 987): three polygons. */
const W_PATHS = ['M6 8H273L646 724 521 984Z', 'M797 40 1031 440 913 665 797 440 681 665 563 440Z', 'M1321 8H1588L1073 984 948 724Z']

/**
 * `mark`: draw the gold W rising out of the hole and the BITWINEX tagline (bitwinex brand); otherwise only the
 * wordmark is shown under the black hole.
 */
export function bootSplashHtml(skin: SkinId, wordmark: string, mark: boolean, logo = ''): string {
  const c = COLORS[skin]
  // Disk: back half (behind the hole), lensed arcs, hole, photon ring, front half; dashes ride the disk to show spin.
  const back = 'M-92 0A92 12 0 0 1 92 0'
  const front = 'M-92 0A92 12 0 0 0 92 0'
  // The far side of the disk, bent over the top of the hole by its gravity (Gargantua look).
  const arc = 'M-40 1A40 37 0 0 1 40 1'
  // The W (34 × 21 units) sits in the event horizon and rises from behind the front of the disk.
  // With a logo image (BIYUN, owner 2026-11-17) the hole stays empty and the logo stands under it instead of the
  // W, the plain word mark and the old tagline.
  const w = mark && logo === '' ? `<g class="bm"><g transform="translate(-17 -23) scale(.02133)" fill="url(#bw)">${W_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g></g>\n` : ''
  const tagline = mark && logo === '' ? '<i><s></s><span><em>WIN</em> THE FUTURE</span><s></s></i>' : ''
  const name = logo === '' ? `<b>${wordmark}</b>` : `<img class="bl" src="${logo}" alt="${wordmark}"/>`
  const sparks = [0, 1, 2, 3].map((i) => `<circle class="bs" r="2.2" style="animation-delay:${(i * 0.55).toFixed(2)}s"/>`).join('')
  return `<div id="boot" aria-hidden="true"><svg viewBox="-100 -64 200 128">
<defs><radialGradient id="bg"><stop offset=".25" stop-color="${c.glow}" stop-opacity=".5"/><stop offset="1" stop-color="${c.glow}" stop-opacity="0"/></radialGradient>
<linearGradient id="bd" x1="-92" x2="92" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c.diskDim}" stop-opacity="0"/><stop offset=".22" stop-color="${c.disk}"/><stop offset=".42" stop-color="${c.diskHot}"/><stop offset=".7" stop-color="${c.disk}"/><stop offset="1" stop-color="${c.diskDim}" stop-opacity="0"/></linearGradient>
<linearGradient id="bw" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.w[0]}"/><stop offset=".28" stop-color="${c.w[1]}"/><stop offset=".55" stop-color="${c.w[2]}"/><stop offset=".78" stop-color="${c.w[3]}"/><stop offset="1" stop-color="${c.w[4]}"/></linearGradient>
<linearGradient id="ba" y1="-38" y2="2" x1="0" x2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c.diskHot}"/><stop offset=".5" stop-color="${c.arc}"/><stop offset="1" stop-color="${c.arc}" stop-opacity="0"/></linearGradient></defs>
<circle class="bg" r="64" fill="url(#bg)"/>
<path d="${back}" stroke="url(#bd)" stroke-width="16" opacity=".16"/><path d="${back}" stroke="url(#bd)" stroke-width="4.5" opacity=".75"/><path class="bk" d="${back}"/>
<path d="${arc}" stroke="url(#ba)" stroke-width="20" opacity=".2"/><path d="${arc}" stroke="url(#ba)" stroke-width="9" opacity=".55"/><path d="${arc}" stroke="url(#ba)" stroke-width="2.4"/>
<path d="M-28 3A28 23 0 0 0 28 3" stroke="${c.arc}" stroke-width="5" opacity=".18"/><path d="M-28 3A28 23 0 0 0 28 3" stroke="${c.arc}" stroke-width="1.3" opacity=".7"/>
<circle r="23" fill="#000"/><circle r="24.2" stroke="${c.ring}" stroke-width="2.4" opacity=".25"/><circle r="24.2" stroke="${c.ring}" stroke-width=".8"/>
${w}<path d="${front}" stroke="url(#bd)" stroke-width="18" opacity=".18"/><path d="${front}" stroke="url(#bd)" stroke-width="5.5"/><path d="${front}" stroke="${c.diskHot}" stroke-width="1" opacity=".7"/><path class="fr" d="${front}"/>
<g transform="scale(1 .15)">${sparks}</g></svg>${name}${tagline}</div>
<style>
#boot{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2vmin;background:${c.bg};pointer-events:none;animation:bw-in .35s ease-out .18s both,bw-out .4s ease-in 12s forwards}
#boot svg{width:min(92vmin,620px);overflow:visible;fill:none;animation:bw-grow 1.2s cubic-bezier(.2,.7,.2,1) .18s both}
#boot .bg{animation:bw-pulse 2.4s ease-in-out infinite alternate}
#boot .bk,#boot .fr{stroke:${c.diskHot};stroke-width:1.2;stroke-linecap:round;stroke-dasharray:1 7 5 13;opacity:.4;animation:bw-spin 1.4s linear infinite}
#boot .bk{animation-direction:reverse;opacity:.22}
#boot .bs{fill:${c.diskHot};animation:bw-fall 2.2s cubic-bezier(.5,0,.9,.6) infinite}
#boot b{font:600 clamp(15px,3.2vmin,24px)/1 system-ui,sans-serif;letter-spacing:.5em;margin-right:-.5em;color:#fff;animation:bw-in .6s ease-out .7s both}
#boot i{display:flex;align-items:center;gap:1.4vmin;font:500 clamp(10px,1.7vmin,13px)/1 system-ui,sans-serif;font-style:normal;letter-spacing:.32em;color:#e9e9ee;animation:bw-in .6s ease-out .95s both}
#boot i span{margin-right:-.32em}#boot em{font-style:normal;color:${c.accent}}
#boot s{width:clamp(28px,7vmin,64px);height:1px;background:linear-gradient(90deg,transparent,${c.rule})}#boot s:last-child{transform:scaleX(-1)}
#boot .bl{width:min(58vmin,300px);height:auto;margin-top:-2vmin;animation:bw-in .6s ease-out .7s both,bw-rise 1s cubic-bezier(.2,.8,.2,1) .7s both}
#boot .bm{animation:bw-rise 1.1s cubic-bezier(.2,.8,.2,1) .35s both}
#boot.out{animation:bw-gone .4s ease-in forwards}
#boot.out svg{transition:transform .4s ease-in;transform:scale(1.18)}
@keyframes bw-in{from{opacity:0}}
@keyframes bw-gone{from{opacity:1}to{opacity:0;visibility:hidden}}
@keyframes bw-out{to{opacity:0;visibility:hidden}}
@keyframes bw-rise{from{transform:translateY(16px);opacity:0}}
@keyframes bw-grow{from{transform:scale(.86);opacity:0}}
@keyframes bw-pulse{to{opacity:.6;transform:scale(1.06)}}
@keyframes bw-spin{to{stroke-dashoffset:-78}}
@keyframes bw-fall{0%{transform:rotate(0) translateX(98px);opacity:0}25%{opacity:1}100%{transform:rotate(520deg) translateX(24px);opacity:0}}
@media (prefers-reduced-motion:reduce){#boot{display:none}}
</style>`
}
