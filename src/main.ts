// First: decides at once whether the entry splash (index.html) is skipped for this session.
import { dismissBootSplash } from './core/boot-splash'
import './core/zod-config'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import { startSessionKeepAlive } from './core/session-keepalive'
import { installSafetyNet } from './core/safety-net'
import { fetchUserInfo } from './modules/api/auth.api'
import { useSessionStore } from './stores/session'
import '@fontsource-variable/figtree'
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/jetbrains-mono'
// OKX skin face (used only under :root[data-skin='okx'], see styles/skin-okx.css); upright axis only.
import '@fontsource-variable/hanken-grotesk/wght.css'
// Heavy grotesque for the BITWINEX name only (owner 2026-11-18); Latin subset, one weight.
import '@fontsource/archivo-black/latin-400.css'
import './styles/tokens.css'
import './styles/brand-bitwinex.css'
import './styles/skin-binance.css'
import './styles/skin-okx.css'
import './styles/base.css'
import './styles/buttons-fx.css'

const pinia = createPinia()
const app = createApp(App).use(pinia).use(router).use(i18n)
// Nothing the user does may end in silence: unhandled errors are logged and toasted (`core/safety-net.ts`).
installSafetyNet(app)
app.mount('#app')
// The splash leaves as soon as the first route has resolved and rendered (never waits on market data).
void router.isReady().then(dismissBootSplash, dismissBootSplash)

// A session restored from storage needs its profile (and proves the token is still accepted).
const sessionStore = useSessionStore(pinia)
if (sessionStore.isAuthenticated) void sessionStore.loadUserInfo()
// Keeps the sliding server TTL alive while the user is actively on the page.
startSessionKeepAlive({ touch: fetchUserInfo })
