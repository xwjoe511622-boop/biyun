import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { bootSplashHtml } from './scripts/boot-splash.ts'

/**
 * Display brand (src/core/brand.ts): VITE_BRAND, else derived from VITE_SITE_DOMAIN (bitwinex.cc -> bitwinex), else
 * longbit. The longbit build keeps public/ and index.html exactly as before; other brands serve brand-public/<id>/
 * (favicon set, manifest, og-image) and get their head tags injected below.
 */
type BrandId = 'longbit' | 'bitwinex'
function resolveBrand(env: Record<string, string>): BrandId {
  const raw = (env.VITE_BRAND ?? '').trim().toLowerCase()
  if (raw === 'bitwinex' || raw === 'longbit') return raw
  if (raw !== '') throw new Error(`VITE_BRAND=${raw}: expected bitwinex or longbit`)
  return /(^|\.)bitwinex\.cc$/.test((env.VITE_SITE_DOMAIN ?? '').trim()) ? 'bitwinex' : 'longbit'
}

/**
 * Layout skin (owner 10-21: two separately deployed front ends from one code base):
 *   VITE_SKIN=binance (default; www) | okx (OKX-style layout, black-gold dark / white-gold light).
 * Defined as a build-time literal (src/core/skin.ts) and written to <html data-skin="…">; skin CSS lives in
 * src/styles/skin-<id>.css, skin-specific pages under src/views/home/ and src/components/home/<id>/.
 */
type SkinId = 'binance' | 'okx'
function resolveSkin(env: Record<string, string>): SkinId {
  const raw = (env.VITE_SKIN ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'binance') return 'binance'
  if (raw === 'okx') return 'okx'
  throw new Error(`VITE_SKIN=${raw}: expected binance or okx`)
}

function skinHtml(skin: SkinId, brand: BrandId): Plugin {
  return {
    name: 'skin-html',
    transformIndexHtml(html) {
      // Entry splash (scripts/boot-splash.ts): inline SVG + CSS that paints with the HTML, dismissed by src/core/boot-splash.ts.
      // BITWINEX shows its name only (owner 2026-11-18): no mark rises out of the hole, no logo image.
      const splash = bootSplashHtml(skin, brand === 'bitwinex' ? 'BITWINEX' : 'LONGBIT', false)
      const out = html.replace(/<html lang="zh-CN"/, `<html lang="zh-CN" data-skin="${skin}"`).replace('<div id="app"></div>', `${splash}\n    <div id="app"></div>`)
      return skin === 'okx' ? out.replace(/<meta name="theme-color" content="[^"]*" \/>/, '<meta name="theme-color" content="#000000" />') : out
    },
  }
}

/**
 * Demo mode (owner 2026-11-17): `VITE_DEMO=1` puts the in-browser mock backend (demo/mock.js + demo/icons.json) into
 * the page before the app starts. It replaces `fetch` and `WebSocket`, seeds a demo session and simulated markets, so
 * the client shows complete pages with no server at all (v0 / design previews). Off by default: a normal build never
 * reads these files. `.env.development` turns it on for `npm run dev`; `npm run build:demo` builds a demo bundle.
 */
function demoHtml(): Plugin {
  return {
    name: 'demo-backend',
    transformIndexHtml() {
      const read = (file: string): string => readFileSync(fileURLToPath(new URL(`./demo/${file}`, import.meta.url)), 'utf8')
      const code = read('mock.js').replace('__ICONS__', () => read('icons.json')).replace(/<\/script/g, '<\\/script')
      return [{ tag: 'script', children: code, injectTo: 'head-prepend' }]
    },
  }
}

const BITWINEX_HEAD = {
  title: 'BITWINEX',
  description: 'BITWINEX — Spot, USDT-margined perpetuals on crypto, gold and US stocks, copy trading and earn in one account.',
  themeColor: '#070b18',
}

function brandHtml(brand: BrandId, siteDomain: string): Plugin {
  return {
    name: 'brand-html',
    transformIndexHtml(html) {
      if (brand === 'longbit') return html
      const site = `https://www.${siteDomain}`
      const h = BITWINEX_HEAD
      const head = [
        `<meta name="description" content="${h.description}" />`,
        '<link rel="icon" href="/favicon.ico" sizes="32x32" />',
        '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />',
        '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
        '<link rel="manifest" href="/site.webmanifest" />',
        '<meta property="og:type" content="website" />',
        `<meta property="og:site_name" content="${h.title}" />`,
        `<meta property="og:title" content="${h.title}" />`,
        `<meta property="og:description" content="${h.description}" />`,
        `<meta property="og:url" content="${site}/" />`,
        `<meta property="og:image" content="${site}/og-image.png" />`,
        '<meta property="og:image:width" content="1200" />',
        '<meta property="og:image:height" content="630" />',
        '<meta name="twitter:card" content="summary_large_image" />',
        `<meta name="twitter:image" content="${site}/og-image.png" />`,
      ].join('\n    ')
      return html
        .replace('<html lang="zh-CN">', `<html lang="zh-CN" data-brand="${brand}">`)
        .replace(/<meta name="theme-color" content="[^"]*" \/>/, `<meta name="theme-color" content="${h.themeColor}" />`)
        .replace(/<title>[^<]*<\/title>/, `<title>${h.title}</title>\n    ${head}`)
    },
  }
}

/**
 * App modules every page loads through the entry (router, stores used by the header/footer, the http
 * and market-socket layers). Grouped first so the terminal groups do not pull them into their
 * chunks. The RSA/AES signing module stays out: it is loaded on demand for signed calls only.
 */
const CORE_MODULE = /src[\\/](stores[\\/](market|session|account)\.ts|modules[\\/](api[\\/](http|validation|types|public\.api|auth\.api|account\.api|order\.api)|content[\\/]api-helpers|ws[\\/]|finance[\\/]|market[\\/])|core[\\/]|config[\\/]|i18n[\\/]|router[\\/])/

/**
 * Dev proxy targets are the values supplied for this stage:
 *   HTTP  /fe-ex-api/  -> https://www.exchange.invalid/fe-ex-api/
 *   HTTP  /wallet-api/ -> https://www.exchange.invalid/wallet-api/
 *   WS    /fe-kline-ws -> wss://ws.exchange.invalid/kline-api/  (only used when VITE_WS_URL is set)
 *
 * Production is a static build served by Nginx; no Node process is required.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const brand = resolveBrand({ ...env, ...process.env } as Record<string, string>)
  const skin = resolveSkin({ ...env, ...process.env } as Record<string, string>)
  // Dev server only: which live site the API proxy talks to (default the old test site, as before).
  const proxyOrigin = (process.env.DEV_PROXY_ORIGIN ?? 'https://www.exchange.invalid').trim()
  const proxyWs = (process.env.DEV_PROXY_WS ?? 'wss://ws.exchange.invalid').trim()
  const siteDomain = (process.env.VITE_SITE_DOMAIN ?? env.VITE_SITE_DOMAIN ?? 'exchange.invalid').trim()
  // Never in tests: the unit tests stub the network themselves.
  const demo = mode !== 'test' && (process.env.VITE_DEMO ?? env.VITE_DEMO ?? '').trim() === '1'
  return {
    plugins: [vue(), brandHtml(brand, siteDomain), skinHtml(skin, brand), ...(demo ? [demoHtml()] : [])],
    // okx skin (pro.): gold favicon / app icons and a black theme colour (owner 10-22), same file names as bitwinex.
    publicDir: brand === 'longbit' ? 'public' : brand === 'bitwinex' && skin === 'okx' ? 'brand-public/bitwinex-gold' : `brand-public/${brand}`,
    define: { 'import.meta.env.VITE_BRAND': JSON.stringify(brand), 'import.meta.env.VITE_SKIN': JSON.stringify(skin), 'import.meta.env.VITE_DEMO': JSON.stringify(demo ? '1' : '') },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      // Demo previews run in hosted sandboxes (v0 …): listen on every interface, accept their host names and take any
      // free port. The normal dev server stays on 127.0.0.1:5173 exactly as before.
      host: demo ? true : '127.0.0.1',
      port: Number(process.env.PORT ?? 5173),
      strictPort: !demo,
      allowedHosts: demo ? true : undefined,
      proxy: {
        // cookieDomainRewrite: the session cookie is set for the live domain; rewritten so it lands on 127.0.0.1 and a
        // login on the local page sticks. Origin/Referer: the server's cross-site check compares them with its own host
        // (「跨站请求校验失败」 from 127.0.0.1). Same as the admin console's dev proxy.
        '/fe-ex-api': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        '/wallet-api': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        '/futures-api': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        '/otc-api': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        // Public spot v3 (fgw): pair trading status `GET /api/v3/exchangeInfo` (404 on the dev server without this).
        '/api/v3': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Business pages (VIP / earn / loans / launchpad …): `/sapi/v1|v2/*` and `/fapi/v1/feeBurn` (dev server only;
        // without these the pages render their error state and the mobile audit never sees real table data).
        '/sapi': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        '/fapi': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
          headers: { Origin: proxyOrigin, Referer: `${proxyOrigin}/` },
        },
        // Sequenced spot depth snapshot (spot-md, src/config/endpoints.ts); without it the local book 404s and
        // falls back to the legacy depth channel. The socket is cross-origin wss directly.
        '/smd': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
        },
        // Sequenced futures depth snapshot (futures-md); the socket is cross-origin wss directly.
        '/fmd': {
          target: proxyOrigin,
          changeOrigin: true,
          secure: true,
        },
        '/fe-kline-ws': {
          target: proxyWs,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/fe-kline-ws/, '/kline-api'),
        },
      },
    },
    build: {
      outDir: 'dist',
      // Not 'assets': the SPA has an /assets route, and a same-named directory makes nginx
      // (try_files $uri $uri/ ...) answer /assets with a directory 403 instead of the SPA.
      assetsDir: '_lb',
      sourcemap: false,
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        output: {
          // Fewer, larger files: without HTTP/2 every request costs a full round trip (~450 ms through
          // the owner's proxy), so the ~50 tiny per-icon / per-widget chunks are merged by audience.
          codeSplitting: {
            groups: [
              // Framework runtime used by every page (plus the SFC export helper, so no app chunk has to
              // import it back from the entry).
              { name: 'vendor', test: /node_modules[\\/](@vue|vue|vue-router|pinia|vue-i18n|@intlify)[\\/]|plugin-vue:export-helper/, priority: 40 },
              // All icons in one small file instead of one request per icon.
              { name: 'icons', test: /node_modules[\\/]@lucide[\\/]/, priority: 30 },
              // KLineCharts only ships with the trading terminals, never with the home page.
              { name: 'chart', test: /node_modules[\\/](klinecharts|@klinecharts)[\\/]/, priority: 30 },
              // QR codes are only drawn by the wallet pages.
              { name: 'qrcode', test: /node_modules[\\/](qrcode|dijkstrajs|pngjs)[\\/]/, priority: 30 },
              // App core every page already loads (stores, api, ws, i18n, formatting). Captured first
              // so the terminal groups below do not pull it into their chunks.
              { name: 'core', test: (id: string) => CORE_MODULE.test(id) && !id.includes('modules/api/security'), priority: 25 },
              { name: 'common', test: /src[\\/]components[\\/]common[\\/]/, priority: 22, includeDependenciesRecursively: false },
              // Futures terminal (store, modules, widgets) in one file.
              // Futures market data (stores + pure modules) is read by the home perpetuals board and the
              // header, so it stays small and separate; the terminal widgets load only with the terminal.
              { name: 'futures-data', test: /src[\\/](modules[\\/]futures|stores[\\/]futures-)/, priority: 21, includeDependenciesRecursively: false },
              { name: 'futures', test: /src[\\/]components[\\/]futures[\\/]/, priority: 20, includeDependenciesRecursively: false },
              // Widgets shared by the spot, margin and futures terminals (book, trades, depth, chart).
              { name: 'terminal', test: /src[\\/](components[\\/]trade[\\/](ModernChart|OrderBook|DepthChart|TradesPanel|market-source)|modules[\\/]charts[\\/])/, priority: 20, includeDependenciesRecursively: false },
            ],
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      include: ['tests/**/*.spec.ts'],
      globals: false,
      restoreMocks: true,
      // Store specs must not open the real sequenced depth feed; its own spec enables it explicitly.
      // The product suites test the real pages, so every product is open under Vitest (core/feature-flags.ts).
      env: { VITE_FUTURES_SEQ_DEPTH: '0', VITE_OPEN_FUTURES_TRADING: '1', VITE_OPEN_OTC: '1', VITE_OPEN_COPY_TRADING: '1', VITE_OPEN_EARN: '1', VITE_OPEN_LOANS: '1', VITE_OPEN_LAUNCHPAD: '1', VITE_OPEN_LAUNCHPOOL: '1', VITE_OPEN_VESTING: '1' },
    },
  }
})
