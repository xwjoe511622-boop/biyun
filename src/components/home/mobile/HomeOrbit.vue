<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowRight, X } from '@lucide/vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import CoinMark from '@/components/common/CoinMark.vue'
import { prefersReducedMotion } from '@/components/home/fx/fx'
import { groupDigits, isDecimalString, isSignedDecimalString } from '@/modules/finance/decimal'
import { percentView } from '@/modules/finance/display'
import { useMarketStore } from '@/stores/market'

/**
 * Phone home hero (owner 2026-11-17): the brand's black hole from the entry splash, alive — listed coins orbit the
 * gold W like planets, each with its live price and 24h change; a tap opens that pair. Under it, the market's
 * breadth (pairs up vs down) from the same live tickers. Nothing here is a marketing number.
 * Motion: one requestAnimationFrame loop, paused when the tab is hidden; reduced motion shows a still layout.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': { label: '实时行情轨道', up: '上涨', down: '下跌', breadth: '市场情绪', high: '高', low: '低', trade: '去交易', close: '关闭' },
    'en-US': { label: 'Live market orbit', up: 'Up', down: 'Down', breadth: 'Market breadth', high: 'H', low: 'L', trade: 'Trade', close: 'Close' },
  },
})
const market = useMarketStore()
const router = useRouter()

const PREFERRED = ['BTC', 'ETH', 'SOL', 'WIN', 'HYPE', 'XAUT']
const planets = computed(() => {
  const all = market.symbols
  const picked = PREFERRED.map((base) => all.find((entry) => entry.base === base)).filter((entry) => entry !== undefined)
  const rest = all.filter((entry) => !picked.includes(entry))
  return [...picked, ...rest].slice(0, 6).map((entry, index) => {
    const tick = market.tickers[entry.symbol.toLowerCase()]
    const rose = tick?.rose ?? ''
    return {
      entry, index,
      last: tick !== undefined && isDecimalString(tick.close) ? groupDigits(tick.close, Math.min(entry.pricePrecision, 6)) : '--',
      change: rose === '' ? { text: '--', direction: 'flat' as const } : percentView(rose),
      high: tick !== undefined && isDecimalString(tick.high) ? groupDigits(tick.high, Math.min(entry.pricePrecision, 6)) : '--',
      low: tick !== undefined && isDecimalString(tick.low) ? groupDigits(tick.low, Math.min(entry.pricePrecision, 6)) : '--',
    }
  })
})
const breadth = computed(() => {
  let up = 0
  let down = 0
  market.symbols.forEach((entry) => {
    const rose = market.tickers[entry.symbol.toLowerCase()]?.rose ?? ''
    if (!isSignedDecimalString(rose)) return
    if (rose.startsWith('-')) down += 1
    else if (/[1-9]/.test(rose)) up += 1
  })
  const total = up + down
  return { up, down, share: total === 0 ? 50 : Math.round((up / total) * 100) }
})

/** A tap selects the coin (detail card); the card's button opens its pair. */
const selected = ref('')
const picked = computed(() => planets.value.find((planet) => planet.entry.symbol === selected.value))
function open(pair: string): void {
  market.selectPair(pair)
  void router.push('/trade')
}

/* ------------------------------------------------------------------ orbit */
const stage = ref<HTMLElement | null>(null)
const nodes = ref<HTMLElement[]>([])
const trails = ref<HTMLCanvasElement | null>(null)
let frame = 0
let started = 0
/** Two rings on one tilted plane: outer four, inner two; the inner ring turns faster (Kepler, roughly). */
function place(now: number): void {
  const el = stage.value
  if (el === null) return
  const width = el.clientWidth
  const cx = width / 2
  const cy = 126
  const seconds = (now - started) / 1000 // float-ok: animation clock, not money
  const canvas = trails.value
  const ctx = canvas?.getContext('2d') ?? null
  if (canvas !== null && ctx !== null) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(el.clientHeight * ratio) }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, el.clientHeight)
    ctx.lineCap = 'round'
  }
  nodes.value.forEach((node, index) => {
    const inner = index >= 4
    const count = inner ? 2 : 4
    const slot = inner ? index - 4 : index
    const rx = inner ? width * 0.29 : width * 0.405
    const ry = inner ? 58 : 86
    const period = inner ? 26 : 44
    const angle = (slot / count) * Math.PI * 2 + (seconds / period) * Math.PI * 2 + (inner ? 0.9 : 0.35)
    const depth = Math.sin(angle) // -1 far side … 1 near side
    const near = (depth + 1) / 2
    const scale = 0.6 + 0.48 * near // far coins small and dim, near ones large and bright
    node.style.transform = `translate3d(${cx + rx * Math.cos(angle)}px, ${cy + ry * depth}px, 0) translate(-50%, -50%) scale(${scale})`
    node.style.zIndex = depth >= 0 ? '3' : '1'
    node.style.opacity = String(0.52 + 0.48 * near)
    node.style.filter = near > 0.7 ? '' : `brightness(${(0.8 + 0.28 * near).toFixed(2)})`
    // Far-side coins keep only their name, so labels do not pile up behind the hole.
    node.classList.toggle('far', depth < -0.1)
    if (ctx !== null) {
      // Comet tail: a fading arc of the orbit behind the coin.
      const TAIL = 0.62
      const STEPS = 14
      for (let step = 0; step < STEPS; step += 1) {
        const from = angle - TAIL * (1 - step / STEPS)
        const to = angle - TAIL * (1 - (step + 1) / STEPS)
        ctx.beginPath()
        ctx.moveTo(cx + rx * Math.cos(from), cy + ry * Math.sin(from))
        ctx.lineTo(cx + rx * Math.cos(to), cy + ry * Math.sin(to))
        ctx.strokeStyle = `rgba(255, 226, 150, ${(0.5 * (step + 1) / STEPS) * (0.45 + 0.55 * ((depth + 1) / 2))})`
        ctx.lineWidth = 0.6 + 2.2 * ((step + 1) / STEPS) * scale
        ctx.stroke()
      }
    }
  })
}
function loop(now: number): void {
  place(now)
  frame = requestAnimationFrame(loop)
}
function onVisibility(): void {
  cancelAnimationFrame(frame)
  if (document.visibilityState === 'visible' && !prefersReducedMotion()) frame = requestAnimationFrame(loop)
}
onMounted(() => {
  // The arc is animated by the SVG itself; hold it still for people who asked for less motion.
  if (prefersReducedMotion()) (stage.value?.querySelector('svg') as SVGSVGElement | null)?.pauseAnimations?.()
  started = performance.now()
  place(started)
  if (!prefersReducedMotion()) frame = requestAnimationFrame(loop)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('resize', onVisibility)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('resize', onVisibility)
})
</script>

<template>
  <section class="orbit" :aria-label="t('label')">
    <div ref="stage" class="orbit-stage">
      <svg class="orbit-sky" viewBox="0 12 360 270" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <radialGradient id="ho-glow"><stop offset=".2" stop-color="#c99a4a" stop-opacity=".55" /><stop offset="1" stop-color="#c99a4a" stop-opacity="0" /></radialGradient>
          <radialGradient id="ho-ball" cx="180" cy="138" r="43" fx="164" fy="116" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff6d6" /><stop offset=".22" stop-color="#f8d777" /><stop offset=".55" stop-color="#dba53a" /><stop offset=".85" stop-color="#a06c16" /><stop offset="1" stop-color="#6b440c" /></radialGradient>
          <radialGradient id="ho-shade" cx="204" cy="166" r="50" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2a1803" stop-opacity=".6" /><stop offset=".6" stop-color="#2a1803" stop-opacity=".12" /><stop offset="1" stop-color="#2a1803" stop-opacity="0" /></radialGradient>
          <radialGradient id="ho-spec"><stop offset="0" stop-color="#fff" stop-opacity=".85" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></radialGradient>
          <linearGradient id="ho-rim" x1="150" y1="100" x2="212" y2="178" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff8dc" /><stop offset=".5" stop-color="#f0c879" stop-opacity=".25" /><stop offset="1" stop-color="#ffe6b0" stop-opacity=".8" /></linearGradient>
          <linearGradient id="ho-sheen" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0" /><stop offset=".5" stop-color="#fff" stop-opacity=".42" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></linearGradient>
          <!-- The brand's arc (owner 2026-11-17): a tapered streak with a bright head circling the sphere on a tilted ring,
               after the swoosh of the BIYUN logo. Layered dashes of growing width share one head; drawn twice, clipped
               to the far half (behind the sphere) and the near half (in front). -->
          <path id="ho-ring" pathLength="100" d="M62 138a118 33 0 1 1 236 0a118 33 0 1 1-236 0" />
          <linearGradient id="ho-arc" x1="62" y1="105" x2="298" y2="171" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff2d2" /><stop offset=".45" stop-color="#f2c64e" /><stop offset="1" stop-color="#d9a85a" /></linearGradient>
          <radialGradient id="ho-flare"><stop offset="0" stop-color="#fff" /><stop offset=".25" stop-color="#ffe9a0" stop-opacity=".9" /><stop offset="1" stop-color="#f2c64e" stop-opacity="0" /></radialGradient>
          <g id="ho-swoosh" class="orbit-swoosh">
            <use href="#ho-ring" fill="none" stroke="#d9a85a" stroke-opacity=".16" stroke-width=".8" />
            <use href="#ho-ring" fill="none" stroke="url(#ho-arc)" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.45" stroke-dasharray="50 50" stroke-dashoffset="50"><animate attributeName="stroke-dashoffset" from="50" to="-50" dur="16s" repeatCount="indefinite" /></use><use href="#ho-ring" fill="none" stroke="url(#ho-arc)" stroke-width="2.6" stroke-linecap="round" stroke-opacity="0.6" stroke-dasharray="40 60" stroke-dashoffset="40"><animate attributeName="stroke-dashoffset" from="40" to="-60" dur="16s" repeatCount="indefinite" /></use><use href="#ho-ring" fill="none" stroke="url(#ho-arc)" stroke-width="3.9" stroke-linecap="round" stroke-opacity="0.75" stroke-dasharray="30 70" stroke-dashoffset="30"><animate attributeName="stroke-dashoffset" from="30" to="-70" dur="16s" repeatCount="indefinite" /></use><use href="#ho-ring" fill="none" stroke="url(#ho-arc)" stroke-width="5.3" stroke-linecap="round" stroke-opacity="0.9" stroke-dasharray="20 80" stroke-dashoffset="20"><animate attributeName="stroke-dashoffset" from="20" to="-80" dur="16s" repeatCount="indefinite" /></use><use href="#ho-ring" fill="none" stroke="url(#ho-arc)" stroke-width="6.8" stroke-linecap="round" stroke-opacity="1" stroke-dasharray="11 89" stroke-dashoffset="11"><animate attributeName="stroke-dashoffset" from="11" to="-89" dur="16s" repeatCount="indefinite" /></use>
            <g><circle r="11" fill="url(#ho-flare)" opacity=".85" /><circle r="2.600" fill="#fff" /><animateMotion dur="16s" repeatCount="indefinite"><mpath href="#ho-ring" /></animateMotion></g>
          </g>
          <clipPath id="ho-back"><rect x="40" y="90" width="280" height="48" /></clipPath>
          <clipPath id="ho-front"><rect x="40" y="138" width="280" height="60" /></clipPath>
          <clipPath id="ho-clip"><circle cx="180" cy="138" r="43" /></clipPath>
        </defs>
        <g fill="#fff">
          <circle class="tw" cx="24" cy="30" r=".9" opacity=".7" /><circle cx="78" cy="14" r=".6" opacity=".5" /><circle class="tw t2" cx="318" cy="26" r="1" opacity=".8" /><circle cx="342" cy="92" r=".6" opacity=".5" />
          <circle cx="16" cy="118" r=".7" opacity=".5" /><circle class="tw t3" cx="52" cy="232" r=".8" opacity=".6" /><circle cx="300" cy="244" r=".7" opacity=".6" /><circle cx="250" cy="20" r=".5" opacity=".5" />
          <circle cx="128" cy="40" r=".5" opacity=".4" /><circle class="tw t4" cx="336" cy="190" r=".9" opacity=".6" /><circle cx="96" cy="256" r=".5" opacity=".4" /><circle cx="204" cy="262" r=".6" opacity=".5" />
        </g>
        <circle cx="180" cy="138" r="120" fill="url(#ho-glow)" />
        <g fill="none" stroke="#d9a85a">
          <ellipse cx="180" cy="138" rx="146" ry="84" stroke-opacity=".22" stroke-width=".8" stroke-dasharray="2 5" />
          <ellipse cx="180" cy="138" rx="104" ry="57" stroke-opacity=".28" stroke-width=".8" />
        </g>
        <g transform="rotate(-15 180 138)"><g clip-path="url(#ho-back)"><use href="#ho-swoosh" /></g></g>
        <!-- The centre is a lit gold sphere (owner 2026-11-17): body, soft terminator, rim light, specular, embossed W. -->
        <circle cx="180" cy="138" r="52" fill="url(#ho-glow)" opacity=".9" />
        <circle cx="180" cy="138" r="43" fill="url(#ho-ball)" />
        <circle cx="180" cy="138" r="43" fill="url(#ho-shade)" />
        <g clip-path="url(#ho-clip)"><rect class="orbit-sheen" x="120" y="90" width="26" height="100" fill="url(#ho-sheen)" transform="rotate(18 180 138)" /></g>
        <ellipse cx="164" cy="113" rx="17" ry="9" transform="rotate(-28 164 113)" fill="url(#ho-spec)" />
        <circle cx="180" cy="138" r="42.400" fill="none" stroke="url(#ho-rim)" stroke-width="1.200" />
        <g transform="rotate(-15 180 138)"><g clip-path="url(#ho-front)"><use href="#ho-swoosh" /></g></g>
      </svg>
      <canvas ref="trails" class="orbit-trails" aria-hidden="true"></canvas>
      <button
        v-for="planet in planets"
        :key="planet.entry.symbol"
        :ref="(el) => { if (el !== null) nodes[planet.index] = el as HTMLElement }"
        class="planet"
        :class="{ picked: selected === planet.entry.symbol }"
        :aria-pressed="selected === planet.entry.symbol"
        type="button"
        :data-testid="`orbit-${planet.entry.base}`"
        @click="selected = selected === planet.entry.symbol ? '' : planet.entry.symbol"
      >
        <span class="planet-coin"><CoinMark :symbol="planet.entry.base" :icon-url="planet.entry.coin?.icon ?? ''" :size="40" /></span>
        <span class="planet-label"><b>{{ planet.entry.base }}</b><i class="num" :class="planet.change.direction">{{ planet.change.text }}</i></span>
        <span class="planet-price num">{{ planet.last }}</span>
      </button>
    </div>
    <Transition name="card">
      <div v-if="picked !== undefined" class="orbit-card" data-testid="orbit-card">
        <CoinMark :symbol="picked.entry.base" :icon-url="picked.entry.coin?.icon ?? ''" :size="38" />
        <span class="oc-main">
          <span class="oc-name"><b>{{ picked.entry.base }}</b><small>/{{ picked.entry.quote }}</small><i class="num" :class="picked.change.direction">{{ picked.change.text }}</i></span>
          <strong class="num">{{ picked.last }}</strong>
          <span class="oc-range num">{{ t('high') }} {{ picked.high }} · {{ t('low') }} {{ picked.low }}</span>
        </span>
        <button class="oc-go" type="button" data-testid="orbit-trade" @click="open(picked.entry.pair)">{{ t('trade') }}<ArrowRight :size="14" aria-hidden="true" /></button>
        <button class="oc-close" type="button" :aria-label="t('close')" @click="selected = ''"><X :size="15" aria-hidden="true" /></button>
      </div>
    </Transition>
    <div class="breadth" :aria-label="t('breadth')">
      <span class="up num">{{ t('up') }} {{ breadth.up }}</span>
      <span class="breadth-bar"><i :style="{ width: `${breadth.share}%` }"></i></span>
      <span class="down num">{{ breadth.down }} {{ t('down') }}</span>
    </div>
  </section>
</template>

<style scoped>
/* Frameless (owner 2026-11-17): the orbit sits directly on the page, in both themes. */
.orbit { position: relative; margin: -6px -14px 0; color: var(--color-text); }
.orbit-stage { position: relative; height: 270px; }
.orbit-sky { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
.orbit-trails { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
/* The sphere turns: a band of light crosses it slowly. A few stars twinkle. */
.orbit-sheen { animation: sheen-turn 7s ease-in-out infinite; }
@keyframes sheen-turn { 0% { transform: rotate(18deg) translateX(-30px); opacity: 0; } 25% { opacity: 1; } 60% { opacity: 1; } 80%, 100% { transform: rotate(18deg) translateX(120px); opacity: 0; } }
.orbit-sheen { transform-box: view-box; transform-origin: 180px 138px; }
.tw { animation: star-tw 3.200s ease-in-out infinite; } .tw.t2 { animation-delay: .9s; } .tw.t3 { animation-delay: 1.700s; } .tw.t4 { animation-delay: 2.400s; }
@keyframes star-tw { 0%, 100% { opacity: .15; } 50% { opacity: 1; } }

.planet { position: absolute; top: 0; left: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; will-change: transform; color: inherit; -webkit-tap-highlight-color: transparent; }
/* Each coin is a little ball: a dark body under the icon, a highlight top-left, shade bottom-right, a rim light,
   and a soft shadow underneath. */
.planet-coin { position: relative; display: inline-flex; overflow: hidden; border-radius: 50%; background: radial-gradient(circle at 34% 28%, #3a3324, #0c0a06 72%);
  box-shadow: 0 0 0 1.500px rgba(242, 198, 78, .6), 0 0 16px rgba(242, 198, 78, .42), 0 7px 10px -3px rgba(0, 0, 0, .75); }
.planet-coin :deep(img), .planet-coin :deep(svg) { border-radius: 50%; }
.planet-coin::after { content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle at 31% 24%, rgba(255, 255, 255, .82) 0, rgba(255, 255, 255, .28) 16%, transparent 38%), radial-gradient(circle at 72% 82%, rgba(0, 0, 0, .6), transparent 58%);
  box-shadow: inset 0 -5px 9px rgba(0, 0, 0, .55), inset 0 2px 3px rgba(255, 255, 255, .45), inset 0 0 0 1px rgba(255, 255, 255, .12); }
.planet-label { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px; background: rgba(10, 9, 6, .72); color: #f4efe3; font-size: 10.5px; line-height: 1.5; white-space: nowrap; }
.planet-label b { font-weight: 700; }
.planet-label i { font-style: normal; font-weight: 700; }
.planet-label .up { color: #2ad3a3; } .planet-label .down { color: #ff5a6e; } .planet-label .flat { color: rgba(244, 239, 227, .6); }
.orbit-sky g[fill='#fff'] { fill: var(--color-text-muted); }
.planet-price { color: var(--color-text-secondary); font-size: 10px; line-height: 1; }
.planet:active .planet-coin { transform: scale(.92); }
.planet.far .planet-price { display: none; }
.planet.far .planet-label i { display: none; }
.planet.picked .planet-coin { box-shadow: 0 0 0 2.5px #ffe9a0, 0 0 26px rgba(255, 233, 160, .85); }
.planet.picked { opacity: 1 !important; }

.orbit-card { color: #f4efe3; position: absolute; left: 14px; right: 14px; bottom: 0; z-index: 6; display: flex; align-items: center; gap: 10px; padding: 12px 34px 12px 12px; border: 1px solid rgba(242, 198, 78, .45); border-radius: 18px; background: linear-gradient(135deg, rgba(46, 36, 15, .975), rgba(14, 12, 8, .98)); backdrop-filter: blur(22px) saturate(1.4); -webkit-backdrop-filter: blur(22px) saturate(1.4); box-shadow: 0 16px 34px -14px rgba(0, 0, 0, .85), inset 0 1px 0 rgba(255, 255, 255, .16); }
.oc-main { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
.oc-name { display: flex; align-items: baseline; gap: 3px; font-size: 13px; }
.oc-name small { color: rgba(244, 239, 227, .55); font-size: 11px; }
.oc-name i { margin-left: 6px; font-size: 12px; font-style: normal; font-weight: 700; }
.oc-name .up { color: #2ad3a3; } .oc-name .down { color: #ff5a6e; }
.oc-main strong { font-size: 21px; font-weight: 750; letter-spacing: -0.01em; line-height: 1.2; }
.oc-range { overflow: hidden; color: rgba(244, 239, 227, .58); font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }
.oc-go { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; height: 36px; padding: 0 14px; border-radius: 999px; background: linear-gradient(100deg, #f6d36e, #d9a85a); color: #1a1408; font-size: 13px; font-weight: 750; }
.oc-close { position: absolute; top: 6px; right: 6px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; color: rgba(244, 239, 227, .6); }
.card-enter-active, .card-leave-active { transition: transform .24s cubic-bezier(.2, .7, .2, 1), opacity .2s ease; }
.card-enter-from, .card-leave-to { transform: translateY(14px); opacity: 0; }

.breadth { position: relative; z-index: 4; display: flex; align-items: center; gap: 10px; padding: 0 18px 2px; font-size: 11px; font-weight: 650; opacity: .9; }
.breadth .up { color: #2ad3a3; } .breadth .down { color: #ff5a6e; }
.breadth-bar { flex: 1 1 auto; height: 2.5px; overflow: hidden; border-radius: 999px; background: #ff5a6e; }
.breadth-bar i { display: block; height: 100%; border-right: 2px solid var(--color-bg); background: #2ad3a3; transition: width .6s ease; }
@media (prefers-reduced-motion: reduce) { .orbit-sheen, .tw { animation: none; } .orbit-sheen { opacity: 0; } }
</style>
