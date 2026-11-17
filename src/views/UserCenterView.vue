<script setup lang="ts">
import UserAvatar from '@/components/common/UserAvatar.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Bell, ChevronRight, ClipboardList, Copy, Globe2, Headset, IdCard, LogOut, Mail, Moon, ShieldCheck, Sun, UserRound } from '@lucide/vue'
import { NOTICES_ENTRY, OKX_NAV, type NavItemDef } from '@/components/layout/nav-config'
import { BRAND_NAME } from '@/core/brand'
import { isFeatureEnabled } from '@/core/feature-flags'
import { theme, toggleTheme } from '@/core/theme'
import { fetchFooterArticles } from '@/modules/content/content.api'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'

/**
 * 个人中心 (phones, owner 2026-11-17): what the large exchanges open from the avatar in the top-left corner —
 * account card (name, UID, verification), the four account shortcuts, then the 更多 menu's benefit and service
 * entries (read from `OKX_NAV`), the legal articles that the hidden phone footer used to carry, theme and sign-out.
 */
const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      guestTitle: '欢迎来到 {brand}', guestSub: '登录后查看资产、订单与账户设置', login: '登录', signup: '注册',
      uid: 'UID', copy: '复制', copied: '已复制', verified: '已认证', unverified: '未认证',
      orders: '订单', security: '账户安全', kyc: '身份认证', messages: '消息',
      support: '帮助与客服', supportHelp: '帮助中心', supportMail: '联系客服', about: '关于', settings: '设置', theme: '主题', dark: '深色', light: '浅色', logout: '退出登录',
      risk: '风险提示：数字资产及合约价格波动剧烈，杠杆交易可能放大亏损。请在充分了解风险后谨慎决策。',
    },
    'en-US': {
      guestTitle: 'Welcome to {brand}', guestSub: 'Log in to see your assets, orders and account settings', login: 'Log in', signup: 'Sign up',
      uid: 'UID', copy: 'Copy', copied: 'Copied', verified: 'Verified', unverified: 'Unverified',
      orders: 'Orders', security: 'Security', kyc: 'Verification', messages: 'Messages',
      support: 'Help and support', supportHelp: 'Help center', supportMail: 'Contact support', about: 'About', settings: 'Settings', theme: 'Theme', dark: 'Dark', light: 'Light', logout: 'Log out',
      risk: 'Risk warning: digital asset and derivative prices are highly volatile and leverage can magnify losses. Trade only after you understand the risks.',
    },
  },
})
const { t: gt } = useI18n({ useScope: 'global' })
const router = useRouter()
const session = useSessionStore()
const market = useMarketStore()
/** Support mailbox from the server's public config; the row is hidden when none is configured. */
const supportEmail = computed(() => {
  const value = market.publicInfo?.msg?.contact_email
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+$/.test(value.trim()) ? value.trim() : ''
})

const name = computed(() => {
  const user = session.user
  if (user === null) return ''
  return String(user.nickName ?? user.userAccount ?? user.email ?? user.mobileNumber ?? '')
})
const account = computed(() => {
  const user = session.user
  return user === null ? '' : String(user.userAccount ?? user.email ?? user.mobileNumber ?? '')
})
const uid = computed(() => (session.user?.id === undefined ? '' : String(session.user.id)))
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyUid(): Promise<void> {
  try {
    await navigator.clipboard.writeText(uid.value)
    copied.value = true
    if (copiedTimer !== null) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1500)
  } catch {
    // Clipboard blocked: the UID stays readable on the card.
  }
}

const shortcuts = computed(() => [
  { key: 'orders', to: '/orders', icon: ClipboardList },
  { key: 'security', to: '/security', icon: ShieldCheck },
  { key: 'kyc', to: '/kyc', icon: IdCard },
  { key: 'messages', to: '/messages', icon: Bell },
])

/** 更多 menu sections (benefits, service) plus announcements, exactly as the header defines them. */
const sections = computed(() => {
  const group = OKX_NAV.find((entry) => entry.key === 'more')
  return (group?.columns ?? []).map((column, index) => ({
    title: column.title,
    items: [...(index === 1 ? [NOTICES_ENTRY] : []), ...column.items].filter((item: NavItemDef) => item.flag === undefined || isFeatureEnabled(item.flag)),
  }))
})

const legal = ref<{ id: string; title: string; fileName: string }[]>([])
const controller = new AbortController()
onMounted(async () => {
  if (market.publicInfo === null) void market.loadPublicInfo().catch(() => { /* the support mailbox row stays hidden */ })
  if (session.isAuthenticated && session.user === null) void session.loadUserInfo()
  try {
    legal.value = (await fetchFooterArticles(controller.signal)).slice(0, 8)
  } catch {
    legal.value = []
  }
})
onBeforeUnmount(() => {
  controller.abort()
  if (copiedTimer !== null) clearTimeout(copiedTimer)
})

/** The language panel belongs to the header; it listens for this event. */
function openLanguage(): void {
  window.dispatchEvent(new Event('bw:open-locale'))
}

async function signOut(): Promise<void> {
  await session.logout()
  await router.push('/')
}
</script>

<template>
  <section class="me">
    <div v-if="session.isAuthenticated" class="me-card">
      <UserAvatar class="me-avatar" :size="58" />
      <div class="me-id">
        <strong class="ellipsis">{{ name !== '' ? name : '—' }}</strong>
        <small v-if="account !== '' && account !== name" class="ellipsis">{{ account }}</small>
        <span class="me-meta">
          <button v-if="uid !== ''" class="me-uid" type="button" :aria-label="t('copy')" @click="copyUid">{{ t('uid') }} {{ uid }}<Copy :size="12" aria-hidden="true" /><em v-if="copied">{{ t('copied') }}</em></button>
          <RouterLink class="me-badge" :class="{ ok: session.authLevel === 1 }" to="/kyc">{{ session.authLevel === 1 ? t('verified') : t('unverified') }}</RouterLink>
        </span>
      </div>
    </div>
    <div v-else class="me-card me-guest">
      <div>
        <strong>{{ t('guestTitle', { brand: BRAND_NAME }) }}</strong>
        <small>{{ t('guestSub') }}</small>
      </div>
      <div class="me-guest-actions">
        <RouterLink class="me-btn gold" to="/login">{{ t('login') }}</RouterLink>
        <RouterLink class="me-btn" to="/register">{{ t('signup') }}</RouterLink>
      </div>
    </div>

    <nav v-if="session.isAuthenticated" class="me-shortcuts">
      <RouterLink v-for="item in shortcuts" :key="item.key" class="me-shortcut" :to="item.to" :data-testid="`me-${item.key}`">
        <span><component :is="item.icon" :size="20" :stroke-width="1.7" aria-hidden="true" /></span>{{ t(item.key) }}
      </RouterLink>
    </nav>

    <section v-for="section in sections" :key="section.title" class="me-group">
      <h2>{{ gt(section.title) }}</h2>
      <div class="me-grid">
        <RouterLink v-for="item in section.items" :key="item.to" class="me-tile" :to="item.to">
          <span><component :is="item.icon" :size="20" :stroke-width="1.6" aria-hidden="true" /></span><em>{{ gt(item.label) }}</em>
        </RouterLink>
      </div>
    </section>

    <section class="me-group">
      <h2>{{ t('support') }}</h2>
      <RouterLink class="me-row" to="/help" data-testid="me-help"><Headset :size="18" :stroke-width="1.6" aria-hidden="true" /><span>{{ t('supportHelp') }}</span><ChevronRight :size="16" aria-hidden="true" /></RouterLink>
      <a v-if="supportEmail !== ''" class="me-row" :href="`mailto:${supportEmail}`"><Mail :size="18" :stroke-width="1.6" aria-hidden="true" /><span>{{ t('supportMail') }}</span><i>{{ supportEmail }}</i></a>
    </section>

    <section v-if="legal.length > 0" class="me-group">
      <h2>{{ t('about') }}</h2>
      <RouterLink v-for="link in legal" :key="link.id" class="me-row" :to="{ name: 'help', params: { id: link.fileName } }">
        <span>{{ link.title }}</span><ChevronRight :size="16" aria-hidden="true" />
      </RouterLink>
    </section>

    <section class="me-group">
      <h2>{{ t('settings') }}</h2>
      <button class="me-row" type="button" data-testid="me-language" @click="openLanguage">
        <Globe2 :size="18" :stroke-width="1.6" aria-hidden="true" /><span>{{ gt('nav.language') }}</span><ChevronRight :size="16" aria-hidden="true" />
      </button>
      <button class="me-row" type="button" data-testid="me-theme" @click="toggleTheme">
        <Moon v-if="theme === 'dark'" :size="18" :stroke-width="1.6" aria-hidden="true" /><Sun v-else :size="18" :stroke-width="1.6" aria-hidden="true" />
        <span>{{ t('theme') }}</span><i>{{ theme === 'dark' ? t('dark') : t('light') }}</i><ChevronRight :size="16" aria-hidden="true" />
      </button>
      <button v-if="session.isAuthenticated" class="me-row danger" type="button" data-testid="me-logout" @click="signOut">
        <LogOut :size="18" :stroke-width="1.6" aria-hidden="true" /><span>{{ t('logout') }}</span>
      </button>
    </section>

    <footer class="me-foot">
      <p>{{ t('risk') }}</p>
      <small>{{ BRAND_NAME }} © {{ new Date().getFullYear() }}</small>
    </footer>
  </section>
</template>

<style scoped>
.me { display: flex; flex-direction: column; gap: 14px; max-width: 720px; margin: 0 auto; padding: 14px 14px 28px; }
.me-card {
  display: flex; align-items: center; gap: 14px; padding: 18px; overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent) 38%, var(--color-border)); border-radius: 18px;
  background: url('@/assets/biyun-mark-watermark.png') no-repeat right -14px bottom -12px / 150px auto,
    linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 18%, var(--color-surface)), var(--color-surface) 62%);
}
.me-avatar { flex: 0 0 58px; }
.me-id { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.me-id strong { font-family: var(--font-display); font-size: 18px; font-weight: 750; }
.me-id small { color: var(--color-text-secondary); font-size: 12px; }
.me-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.me-uid { display: inline-flex; align-items: center; gap: 5px; color: var(--color-text-secondary); font-size: 12px; }
.me-uid em { color: var(--color-up); font-style: normal; }
.me-badge { padding: 2px 8px; border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 11px; font-weight: 700; text-decoration: none; }
.me-badge.ok { background: color-mix(in srgb, var(--color-up) 18%, transparent); color: var(--color-up); }
.me-guest { flex-direction: column; align-items: stretch; }
.me-guest strong { display: block; font-family: var(--font-display); font-size: 18px; font-weight: 750; }
.me-guest small { display: block; margin-top: 4px; color: var(--color-text-secondary); font-size: 13px; }
.me-guest-actions { display: flex; gap: 10px; }
.me-btn { display: inline-flex; align-items: center; justify-content: center; flex: 1 1 0; height: 40px; border: 1px solid var(--color-border-strong); border-radius: 999px; color: var(--color-text); font-size: 14px; font-weight: 700; text-decoration: none; }
.me-btn.gold { border-color: transparent; background: var(--color-accent); color: #1a1408; }

.me-shortcuts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; padding: 14px 6px; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); }
.me-shortcut { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; color: var(--color-text-secondary); font-size: 12px; text-decoration: none; }
.me-shortcut span { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 14px; color: var(--color-accent-text); border: 1px solid color-mix(in srgb, var(--color-accent) 34%, var(--color-border)); background: radial-gradient(120% 90% at 22% 12%, color-mix(in srgb, var(--color-accent) 30%, transparent), transparent 62%), linear-gradient(160deg, var(--color-surface-alt), var(--color-surface)); box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 14%, transparent), 0 6px 14px -10px color-mix(in srgb, var(--color-accent) 80%, transparent); }

.me-group { border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface); overflow: hidden; }
.me-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px 4px; padding: 10px 6px 16px; }
.me-tile { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; color: var(--color-text-secondary); text-decoration: none; }
.me-tile span { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 14px; color: var(--color-accent-text); background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface-alt)); transition: transform .12s ease; }
.me-tile:active span { transform: scale(.93); }
.me-tile em { max-width: 100%; overflow: hidden; font-size: 12px; font-style: normal; white-space: nowrap; text-overflow: ellipsis; }
.me-group h2 { margin: 0; padding: 12px 16px 4px; color: var(--color-text-muted); font-size: 12px; font-weight: 600; }
.me-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 0 12px 0 16px; color: var(--color-text); font-size: 14.5px; text-align: left; text-decoration: none; }
.me-row + .me-row { border-top: 1px solid var(--color-border); }
.me-row > svg:first-child { flex: 0 0 auto; color: var(--color-accent-text); }
.me-row > span { flex: 1 1 auto; min-width: 0; }
.me-row > i { color: var(--color-text-muted); font-size: 13px; font-style: normal; }
.me-row > svg:last-child:not(:first-child) { flex: 0 0 auto; color: var(--color-text-muted); }
.me-row:active { background: var(--color-hover); }
.me-row.danger, .me-row.danger > svg:first-child { color: var(--color-down); }

.me-foot { padding: 2px; color: var(--color-text-muted); }
.me-foot p { margin: 0 0 6px; font-size: 11px; line-height: 1.6; }
.me-foot small { font-size: 11px; }
</style>
