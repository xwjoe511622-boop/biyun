<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Headset,
  Search,
  IdCard,
  LogOut,
  Menu,
  Moon,
  ShieldCheck,
  Sun,
  UserRound,
  X,
} from '@lucide/vue'
import BrandMark from '@/components/common/BrandMark.vue'
import { BRAND_FULL, BRAND_NAME_ZH } from '@/core/brand'
import ExtensionSlot from '@/components/common/ExtensionSlot.vue'
import { defaultBrand, type BrandConfig } from '@/config/runtime'
import { isFeatureEnabled } from '@/core/feature-flags'
import { LOCALES } from '@/i18n'
import LocalePanel from './LocalePanel.vue'
import MobileSearch from '@/components/layout/MobileSearch.vue'
import BrandWordmark from '@/components/common/BrandWordmark.vue'
import UserAvatar from '@/components/common/UserAvatar.vue'
import { useMarketStore } from '@/stores/market'
import { useSessionStore } from '@/stores/session'
import { safeWebUrl } from '@/core/urls'
import { theme, toggleTheme } from '@/core/theme'
import { warmRoute } from '@/router/chunk-recovery'
import { routeTitle } from '@/router'
import { NAV_CONFIG, type Copy } from './nav-config'

/**
 * Site header. Binance arrangement: logo, product nav whose groups open mega-menus (icon + name + one-line
 * description, grouped in columns), then account actions, language and theme on the right. Below 1100px the
 * nav moves into a drawer behind a menu button.
 *
 * Stable class names for skins (styled by tokens only, no colours here): .app-header, .brand, .nav, .nav-link,
 * .nav-group, .nav-trigger, .nav-menu, .nav-menu-col, .nav-menu-category, .nav-menu-item, .header-right,
 * .icon-button, .auth-btn, .account, .nav-drawer.
 */
const { t, locale } = useI18n()
const router = useRouter()
const market = useMarketStore()
const session = useSessionStore()

const brand = computed<BrandConfig>(() => ({
  ...defaultBrand,
  logoUrl: safeWebUrl(market.publicInfo?.msg?.logoUrl, true),
}))

interface NavMenuItem {
  to: string
  label: string
  desc: string
  icon: Component
}
interface NavMenuColumn {
  /** Column heading; empty for a single unlabeled column. */
  title: string
  items: NavMenuItem[]
}
interface NavGroup {
  key: string
  label: string
  to?: string
  columns?: NavMenuColumn[]
  layout: 'columns' | 'stack'
}

/** Per-skin groups from `nav-config.ts` (each route in exactly one place); entries behind an off flag are hidden. */
const navGroups = computed<NavGroup[]>(() => {
  const pick = (key: Copy): string => key ? t(key) : ''
  return NAV_CONFIG.map((group) => ({
    key: group.key,
    label: pick(group.label),
    to: group.to,
    layout: group.layout ?? 'columns',
    columns: group.columns
      ?.map((column) => ({
        title: pick(column.title),
        items: column.items
          .filter((item) => item.flag === undefined || isFeatureEnabled(item.flag))
          .map((item) => ({ to: item.to, label: pick(item.label), desc: pick(item.desc), icon: item.icon })),
      }))
      .filter((column) => column.items.length > 0),
  })).filter((group) => group.to !== undefined || (group.columns?.length ?? 0) > 0)
})

const copy = computed(() => {
  return {
    menu: t('headerUi.menu'),
    close: t('headerUi.closeMenu'),
    back: t('headerUi.back'),
    search: t('headerUi.searchCoins'),
    support: t('headerUi.support'),
    assets: t('headerUi.assets'),
    orders: t('headerUi.orders'),
  }
})

/** Prefix match on the path: vue-router only marks nested records active, and /otc/orders is a sibling of /otc. */
function isActive(to: string): boolean {
  const path = router.currentRoute.value.path
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)
}
/** A menu is marked active by its own pages only: routes that also have a top-level link (/futures, /otc) mark that link. */
function groupActive(group: NavGroup): boolean {
  const direct = new Set(navGroups.value.flatMap((entry) => (entry.to !== undefined ? [entry.to] : [])))
  return group.columns?.some((column) => column.items.some((item) => !direct.has(item.to) && isActive(item.to))) ?? false
}

/**
 * Phones (≤720px, owner 2026-11-17): the bottom-navigation pages keep the brand, with an avatar that opens 个人中心;
 * every other page shows a back button and its title instead, like the large exchanges' inner pages.
 */
const TOP_LEVEL = new Set(['home', 'markets', 'trade', 'margin', 'futures', 'explore', 'assets'])
const innerPage = computed(() => !TOP_LEVEL.has(String(router.currentRoute.value.name ?? '')))
const pageTitle = computed(() => {
  const key = router.currentRoute.value.meta.titleKey
  return typeof key === 'string' && key !== '' ? t(key) : ''
})
/** Search belongs to the two browsing pages; the other main pages show their name instead (owner 2026-11-17). */
/** The avatar is the home page's alone; support sits on home and assets (owner 2026-11-17). */
const homePage = computed(() => router.currentRoute.value.name === 'home')
const supportPage = computed(() => ['home', 'assets'].includes(String(router.currentRoute.value.name ?? '')))
const searchOpen = ref(false)
const searchPage = computed(() => ['home', 'markets'].includes(String(router.currentRoute.value.name ?? '')))
const MAIN_TITLES: Record<string, string> = { trade: 'nav.trade', margin: 'nav.trade', futures: 'nav.trade', explore: 'nav.explore', assets: 'nav.assets' }
const mainTitle = computed(() => {
  const key = MAIN_TITLES[String(router.currentRoute.value.name ?? '')]
  return key === undefined ? '' : t(key)
})
function goBack(): void {
  if (window.history.length > 1) router.back()
  else void router.push('/')
}

const accountLabel = computed(() => {
  const user = session.user
  if (user === null) {
    return ''
  }
  return String(user.userAccount ?? user.email ?? user.mobileNumber ?? user.nickName ?? '')
})

watchEffect(() => {
  const title = routeTitle(router.currentRoute.value.meta, locale.value)
  document.title = title === '' ? BRAND_FULL : `${title} · ${BRAND_FULL}`
})

/** Language & currency panel (LocalePanel.vue): opened from the globe, or from the drawer on phones. */
const localeOpen = ref(false)
const localeButton = ref<HTMLElement | null>(null)
const currentLocaleLabel = computed(() => LOCALES.find((option) => option.code === locale.value)?.label ?? '')
function onLocaleChange(): void {
  void market.loadPublicInfo({ force: true }).catch(() => { /* Market error state is rendered by the view. */ })
}
function openLocaleFromDrawer(): void {
  drawerOpen.value = false
  localeOpen.value = true
}

/** Which dropdown is open by click/tap (`null` = none); closed on navigation, outside tap and Escape. */
const openMenu = ref<string | null>(null)
const hoveredMenu = ref<string | null>(null)
// One visible group across mouse hover, touch click and keyboard activation.
const visibleMenu = computed(() => openMenu.value ?? hoveredMenu.value)
function hoverMenu(key: string, event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  openMenu.value = null
  hoveredMenu.value = key
}
function leaveMenu(key: string): void {
  if (hoveredMenu.value === key) hoveredMenu.value = null
}
const navElement = ref<HTMLElement | null>(null)
let menuResizeObserver: ResizeObserver | undefined
// Position even hidden menus: visibility:hidden boxes can still widen the document.
function fitMenus(): void {
  const viewport = document.documentElement.clientWidth
  navElement.value?.querySelectorAll<HTMLElement>('.nav-group').forEach(group => {
    const menu = group.querySelector<HTMLElement>('.nav-menu')
    if (menu === null || group.offsetWidth === 0) return
    const left = group.getBoundingClientRect().left
    const target = Math.max(8, Math.min(left, viewport - menu.offsetWidth - 8))
    menu.style.left = `${target - left}px`
  })
}
watch(navGroups, fitMenus, { flush: 'post' })
/** Drawer (≤1100px) open state. */
const drawerOpen = ref(false)
function toggleMenu(key: string): void {
  openMenu.value = openMenu.value === key ? null : key
  hoveredMenu.value = null
}
function closeMenus(event?: Event): void {
  openMenu.value = null
  hoveredMenu.value = null
  // Drop focus so a mouse user's menu doesn't stay pinned open by the clicked link.
  ;(event?.currentTarget as HTMLElement | undefined)?.blur?.()
}
function onDocumentPointer(event: PointerEvent): void {
  if (visibleMenu.value !== null && !(event.target as Element | null)?.closest?.('.nav-group')) {
    openMenu.value = null
    hoveredMenu.value = null
  }
}
function onDocumentKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    openMenu.value = null
    hoveredMenu.value = null
    drawerOpen.value = false
  }
}
/** 个人中心 › 语言 opens the same language panel (the globe button is not shown on phones). */
const openLocale = (): void => { localeOpen.value = true }
onMounted(() => window.addEventListener('bw:open-locale', openLocale))
onBeforeUnmount(() => window.removeEventListener('bw:open-locale', openLocale))

onMounted(() => {
  fitMenus()
  window.addEventListener('resize', fitMenus)
  // Window resize and locale watches remain available without ResizeObserver; menu dismissal must
  // still register in that environment instead of aborting the rest of this mounted hook.
  if (typeof ResizeObserver !== 'undefined') {
    menuResizeObserver = new ResizeObserver(fitMenus)
    navElement.value?.querySelectorAll('.nav-group').forEach(group => menuResizeObserver?.observe(group))
  }
  document.addEventListener('pointerdown', onDocumentPointer)
  document.addEventListener('keydown', onDocumentKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', fitMenus)
  menuResizeObserver?.disconnect()
  document.removeEventListener('pointerdown', onDocumentPointer)
  document.removeEventListener('keydown', onDocumentKey)
})
// The page behind an open drawer does not scroll (touch scrolling would otherwise move the page under it).
watch(drawerOpen, (open) => {
  document.documentElement.classList.toggle('drawer-lock', open)
})
onBeforeUnmount(() => document.documentElement.classList.remove('drawer-lock'))
const offAfterEach = router.afterEach(() => {
  openMenu.value = null
  hoveredMenu.value = null
  drawerOpen.value = false
})
onBeforeUnmount(offAfterEach)

/** Hovering a header link starts downloading that page's chunk, so the click navigates without a visible wait. */
function warmLink(event: Event): void {
  const link = (event.target as Element | null)?.closest?.('a[href]')
  const href = link?.getAttribute('href')
  if (href?.startsWith('/')) warmRoute(router, href)
}

/** A link tapped in the drawer closes it even when it points at the current page (no navigation happens). */
function onDrawerClick(event: MouseEvent): void {
  if ((event.target as Element | null)?.closest?.('a[href]')) drawerOpen.value = false
}

async function signOut(): Promise<void> {
  drawerOpen.value = false
  await session.logout()
  await router.push('/trade')
}
</script>

<template>
  <header class="app-header" :class="{ 'is-inner': innerPage, 'is-home': homePage }">
    <button v-if="innerPage" class="m-back icon-button" type="button" :aria-label="copy.back" data-testid="header-back" @click="goBack"><ChevronLeft :size="22" :stroke-width="1.9" /></button>
    <span v-if="innerPage" class="m-title ellipsis">{{ pageTitle }}</span>
    <RouterLink v-else-if="homePage" class="m-me" to="/me" :aria-label="t('nav.userCenter')" data-testid="header-me"><UserAvatar :size="36" :active="session.isAuthenticated" /></RouterLink>
    <button v-if="homePage" class="m-search-icon icon-button" type="button" :aria-label="copy.search" data-testid="header-search" @click="searchOpen = true"><Search :size="19" :stroke-width="1.7" aria-hidden="true" /></button>
    <button v-else-if="!innerPage && searchPage" class="m-search" type="button" data-testid="header-search" @click="searchOpen = true"><Search :size="15" aria-hidden="true" /><span>{{ copy.search }}</span></button>
    <span v-else-if="!innerPage" class="m-main-title ellipsis">{{ mainTitle }}</span>
    <MobileSearch v-if="searchOpen" v-model:open="searchOpen" />
    <RouterLink v-if="supportPage && !homePage" class="m-support icon-button" to="/help" :aria-label="copy.support" :title="copy.support" data-testid="header-support"><Headset :size="19" :stroke-width="1.7" aria-hidden="true" /></RouterLink>
    <RouterLink class="brand" to="/">
      <img v-if="brand.logoUrl !== ''" class="brand-logo" :src="brand.logoUrl" :alt="brand.name" />
      <BrandMark v-else :size="28" />
      <BrandWordmark v-if="brand.name === 'BIYUN'" class="brand-wordmark" :height="17" />
      <span class="brand-words" :class="{ 'has-wordmark': brand.name === 'BIYUN' }">
        <span class="brand-name ellipsis">{{ brand.name }}</span>
        <span v-if="BRAND_NAME_ZH !== ''" class="brand-zh">{{ BRAND_NAME_ZH }}</span>
      </span>
      <span v-if="t('brand.test') !== ''" class="brand-tag">{{ t('brand.test') }}</span>
    </RouterLink>

    <nav ref="navElement" class="nav" @pointerover="warmLink" @focusin="warmLink">
      <template v-for="group in navGroups" :key="group.key">
        <RouterLink v-if="group.to" class="nav-link" :class="{ 'is-active': isActive(group.to) }" :to="group.to" active-class="" exact-active-class="">{{ group.label }}</RouterLink>
        <div v-else class="nav-group" :class="{ 'is-active': groupActive(group), 'is-open': visibleMenu === group.key }" @pointerenter="hoverMenu(group.key, $event)" @pointerleave="leaveMenu(group.key)">
          <button class="nav-link nav-trigger" type="button" aria-haspopup="true" :aria-expanded="visibleMenu === group.key" @click="toggleMenu(group.key)">{{ group.label }}<ChevronDown class="caret" :size="14" /></button>
          <div class="nav-menu" :class="{ 'is-wide': group.layout === 'columns' && (group.columns?.length ?? 0) > 1, 'is-stack': group.layout === 'stack' }">
            <div v-for="(column, index) in group.columns" :key="index" class="nav-menu-col">
              <div v-if="column.title !== ''" class="nav-menu-category">{{ column.title }}</div>
              <RouterLink v-for="item in column.items" :key="item.to" class="nav-menu-item" :class="{ 'is-current': isActive(item.to) }" :to="item.to" @click="closeMenus">
                <span class="nav-menu-icon"><component :is="item.icon" :size="20" :stroke-width="1.6" /></span>
                <span class="nav-menu-text"><strong>{{ item.label }}</strong><span>{{ item.desc }}</span></span>
              </RouterLink>
            </div>
          </div>
        </div>
      </template>
      <!-- Optional modules (short video / live / chat) also land here, but only when enabled. -->
      <ExtensionSlot slot="header.nav" />
    </nav>

    <div class="header-right">
      <template v-if="session.isAuthenticated">
        <RouterLink v-if="isFeatureEnabled('assetsPage')" class="header-link" :class="{ 'is-active': isActive('/assets') }" to="/assets" active-class="">{{ copy.assets }}</RouterLink>
        <RouterLink class="header-link" :class="{ 'is-active': isActive('/orders') }" to="/orders" active-class="">{{ copy.orders }}</RouterLink>
        <div class="nav-group user-group" :class="{ 'is-open': visibleMenu === 'account' }" @pointerenter="hoverMenu('account', $event)" @pointerleave="leaveMenu('account')">
          <button class="account" type="button" :title="accountLabel" :aria-label="accountLabel" :aria-expanded="visibleMenu === 'account'" @click="toggleMenu('account')">
            <span class="avatar"><UserRound :size="16" aria-hidden="true" /></span>
          </button>
          <div class="nav-menu nav-menu-right">
            <div class="account-head ellipsis">{{ accountLabel !== '' ? accountLabel : t('login.loggedInAs', { account: '—' }) }}</div>
            <RouterLink class="nav-menu-item row-item" to="/security" @click="closeMenus"><ShieldCheck :size="16" /><strong>{{ t('nav.security') }}</strong></RouterLink>
            <RouterLink class="nav-menu-item row-item" to="/kyc" @click="closeMenus"><IdCard :size="16" /><strong>{{ t('nav.kyc') }}</strong></RouterLink>
            <button class="nav-menu-item row-item sign-out" type="button" @click="signOut"><LogOut :size="16" /><strong>{{ t('nav.logout') }}</strong></button>
          </div>
        </div>
        <RouterLink class="icon-button" to="/messages" :title="t('nav.messages')" :aria-label="t('nav.messages')"><Bell :size="19" :stroke-width="1.7" /></RouterLink>
      </template>
      <template v-else>
        <RouterLink class="btn auth-btn auth-login" to="/login">{{ t('nav.login') }}</RouterLink>
        <RouterLink class="btn btn-primary auth-btn auth-register" to="/register">{{ t('nav.register') }}</RouterLink>
      </template>

      <button ref="localeButton" class="locale icon-button" :class="{ 'is-open': localeOpen }" type="button" :title="t('nav.language')" :aria-label="t('nav.language')" aria-haspopup="dialog" :aria-expanded="localeOpen" @click="localeOpen = !localeOpen">
        <Globe2 :size="19" :stroke-width="1.7" aria-hidden="true" />
      </button>
      <LocalePanel v-model:open="localeOpen" :anchor="localeButton" @locale-change="onLocaleChange" />
      <button class="icon-button theme-button" type="button" :title="t('nav.theme')" :aria-label="t('nav.theme')" @click="toggleTheme">
        <Moon v-if="theme === 'light'" :size="19" :stroke-width="1.7" /><Sun v-else :size="19" :stroke-width="1.7" />
      </button>
      <button class="icon-button drawer-button" type="button" :aria-label="copy.menu" :aria-expanded="drawerOpen" @click="drawerOpen = true">
        <Menu :size="21" :stroke-width="1.8" />
      </button>
    </div>

    <!-- Drawer navigation for tablets and phones. -->
    <Teleport to="body">
      <div v-if="drawerOpen" class="nav-drawer-backdrop" @click="drawerOpen = false"></div>
      <aside class="nav-drawer" :class="{ 'is-open': drawerOpen }" :aria-hidden="!drawerOpen" :inert="!drawerOpen">
        <div class="drawer-head">
          <RouterLink class="brand" to="/"><BrandMark :size="26" /><span class="brand-name">{{ brand.name }}</span></RouterLink>
          <button class="icon-button" type="button" :aria-label="copy.close" @click="drawerOpen = false"><X :size="22" /></button>
        </div>
        <div v-if="!session.isAuthenticated" class="drawer-auth">
          <RouterLink class="btn drawer-login" to="/login">{{ t('nav.login') }}</RouterLink>
          <RouterLink class="btn btn-primary" to="/register">{{ t('nav.register') }}</RouterLink>
        </div>
        <nav class="drawer-nav" @click="onDrawerClick">
          <template v-for="group in navGroups" :key="group.key">
            <RouterLink v-if="group.to" class="drawer-link" :to="group.to">{{ group.label }}<ChevronRight :size="16" /></RouterLink>
            <details v-else class="drawer-group" :open="groupActive(group)">
              <summary class="drawer-link">{{ group.label }}<ChevronDown :size="16" /></summary>
              <template v-for="(column, index) in group.columns" :key="index">
                <RouterLink v-for="item in column.items" :key="item.to" class="drawer-item" :to="item.to">
                  <component :is="item.icon" :size="18" :stroke-width="1.6" />{{ item.label }}
                </RouterLink>
              </template>
            </details>
          </template>
          <template v-if="session.isAuthenticated">
            <RouterLink v-if="isFeatureEnabled('assetsPage')" class="drawer-link" to="/assets">{{ copy.assets }}<ChevronRight :size="16" /></RouterLink>
            <RouterLink class="drawer-link" to="/orders">{{ copy.orders }}<ChevronRight :size="16" /></RouterLink>
            <RouterLink class="drawer-link" to="/security">{{ t('nav.security') }}<ChevronRight :size="16" /></RouterLink>
            <RouterLink class="drawer-link" to="/messages">{{ t('nav.messages') }}<ChevronRight :size="16" /></RouterLink>
            <button class="drawer-link" type="button" @click="signOut">{{ t('nav.logout') }}<LogOut :size="16" /></button>
          </template>
          <button class="drawer-link drawer-locale" type="button" aria-haspopup="dialog" @click="openLocaleFromDrawer">
            {{ t('nav.language') }}<span class="drawer-value">{{ currentLocaleLabel }}<ChevronRight :size="16" /></span>
          </button>
          <button class="drawer-link drawer-theme" type="button" @click="toggleTheme">
            {{ t('nav.theme') }}<Moon v-if="theme === 'light'" :size="16" /><Sun v-else :size="16" />
          </button>
        </nav>
      </aside>
    </Teleport>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  gap: 24px;
  height: 64px;
  padding: 0 24px;
  background: var(--bn-header, var(--color-surface));
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 40;
}

.brand { display: flex; align-items: center; gap: 9px; min-width: 0; max-width: 260px; flex: 0 0 auto; }
.brand-logo { height: 28px; max-width: 120px; object-fit: contain; }
.brand-words { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.brand-zh { color: var(--color-text-secondary); font-size: 13px; font-weight: 600; white-space: nowrap; }
.brand-name { font-family: var(--font-display); font-size: 20px; font-weight: 700; letter-spacing: -0.01em; color: var(--color-text); }
.brand-tag {
  color: var(--color-accent-text); background: var(--color-accent-soft); font-size: 10px; font-weight: 700;
  padding: 2px 7px; border-radius: var(--radius-pill); white-space: nowrap;
}

.nav { display: flex; align-items: center; gap: 0; min-width: 0; flex: 1 1 auto; height: 100%; }
.nav-link {
  position: relative; display: inline-flex; align-items: center; gap: 3px; height: 100%; padding: 0 12px;
  color: var(--color-text); font-size: 14px; font-weight: 500; white-space: nowrap; transition: color 0.15s;
}
.nav-link:hover, .nav-link.is-active, .nav-group.is-active > .nav-trigger, .nav-group.is-open > .nav-trigger { color: var(--color-accent-text); }
.nav-link.is-active::after, .nav-group.is-active > .nav-trigger::after {
  content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; background: var(--color-accent);
}
.caret { transition: transform 0.2s var(--ease-out); color: var(--color-text-secondary); }
.nav-group { position: relative; height: 100%; display: flex; align-items: center; }
.nav-group.is-open .caret { transform: rotate(180deg); }

.nav-menu {
  position: absolute; top: 100%; left: 0; z-index: 60; min-width: 300px; padding: 16px 8px;
  display: flex; gap: 8px;
  border: 1px solid var(--color-border); border-radius: 0 0 12px 12px; background: var(--color-elevated);
  box-shadow: var(--shadow-pop); opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity 0.14s, transform 0.14s var(--ease-out), visibility 0.14s;
}
.nav-menu.is-wide { min-width: 620px; }
/* One column of sections (OKX panels; also the two-entry 买币 menu): headings, a hairline between sections. */
.nav-menu.is-stack { flex-direction: column; gap: 0; min-width: 320px; padding: 8px; }
.nav-menu.is-stack .nav-menu-col + .nav-menu-col { margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--color-border); }
.nav-menu.is-stack .nav-menu-category { padding: 8px 16px 4px; }
.nav-menu.is-stack .nav-menu-item { padding: 10px 16px; }
.nav-menu-col { display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; }
.nav-menu-category { padding: 0 16px 8px; color: var(--color-text-muted); font-size: 12px; font-weight: 500; }
.nav-group.is-open > .nav-menu { opacity: 1; visibility: visible; transform: none; }
.nav-menu-item {
  display: flex; align-items: flex-start; gap: 14px; width: 100%; padding: 12px 16px; border-radius: 8px; text-align: left;
  color: var(--color-text); transition: background-color 0.12s;
}
.nav-menu-icon { display: inline-flex; flex: 0 0 auto; margin-top: 1px; color: var(--color-text); transition: color 0.12s; }
.nav-menu-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nav-menu-item strong { color: var(--color-text); font-size: 14px; font-weight: 500; }
.nav-menu-text span { color: var(--color-text-secondary); font-size: 12px; line-height: 1.45; }
.nav-menu-item:hover, .nav-menu-item.is-current { background: var(--color-hover); }
.nav-menu-item:hover .nav-menu-icon, .nav-menu-item:hover strong { color: var(--color-accent-text); }
.nav-menu-item.row-item { align-items: center; gap: 12px; padding: 10px 14px; color: var(--color-text-secondary); }
.nav-menu-item.row-item strong { font-weight: 500; }
.nav-menu-right { left: auto; right: 0; min-width: 220px; flex-direction: column; gap: 0; padding: 8px; border-radius: 0 0 12px 12px; }
.account-head { padding: 8px 14px 10px; margin-bottom: 4px; border-bottom: 1px solid var(--color-border); color: var(--color-text); font-size: 14px; font-weight: 600; }

.header-right { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; height: 100%; }
.header-link { padding: 0 8px; color: var(--color-text); font-size: 14px; font-weight: 500; white-space: nowrap; }
.header-link:hover, .header-link.is-active { color: var(--color-accent-text); }
.icon-button { color: var(--color-text); }
.icon-button:hover { color: var(--color-accent-text); }
.locale.is-open { color: var(--color-accent-text); }

.auth-btn { height: 32px; padding: 0 12px; font-size: 14px; font-weight: 500; border-radius: var(--radius); }
.auth-login { border-color: transparent; background: var(--color-surface-alt); color: var(--color-text); }
.auth-login:hover:not(:disabled) { background: var(--color-hover); }

.account { display: inline-flex; align-items: center; height: 100%; padding: 0 4px; color: var(--color-text); }
.avatar {
  display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 50%;
  background: var(--color-surface-alt); color: var(--color-text); transition: color 0.15s;
}
.account:hover .avatar, .user-group.is-open .avatar { color: var(--color-accent-text); }

.drawer-button { display: none; }
/* Header icon beads stay 36 px but take taps on a 44 px square (the 8 px gaps keep neighbours apart). */
.icon-button { position: relative; }
.icon-button::before { content: ''; position: absolute; inset: -4px; border-radius: inherit; }
:global(html.drawer-lock) { overflow: hidden; }

/* Drawer (teleported to body; scoped styles still apply to its own nodes). */
.nav-drawer-backdrop { position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, 0.5); }
.nav-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 91; width: min(360px, 100vw); overflow-y: auto; overscroll-behavior: contain;
  padding-right: env(safe-area-inset-right); padding-bottom: env(safe-area-inset-bottom);
  display: flex; flex-direction: column; background: var(--bn-header, var(--color-surface)); color: var(--color-text);
  transform: translateX(100%); visibility: hidden; transition: transform 0.25s var(--ease-out), visibility 0.25s;
}
.nav-drawer.is-open { transform: none; visibility: visible; }
.drawer-head { display: flex; align-items: center; justify-content: space-between; height: 60px; padding: 0 16px; }
.drawer-head .brand-name { font-size: 18px; }
.drawer-auth { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 8px 16px 16px; }
.drawer-auth .btn { height: 44px; }
.drawer-login { background: var(--color-surface-alt); color: var(--color-text); }
.drawer-nav { display: flex; flex-direction: column; padding: 0 0 24px; }
.drawer-locale { margin-top: 8px; border-top: 1px solid var(--color-border); }
.drawer-value { display: inline-flex; align-items: center; gap: 6px; color: var(--color-text-secondary); font-size: 14px; font-weight: 400; }
.drawer-link {
  display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 52px; padding: 0 16px;
  color: var(--color-text); font-size: 15px; font-weight: 500; text-align: left; cursor: pointer; list-style: none;
}
.drawer-link::-webkit-details-marker { display: none; }
.drawer-link :deep(svg), .drawer-link > svg { color: var(--color-text-secondary); }
.drawer-group[open] > summary > svg { transform: rotate(180deg); }
.drawer-item { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 16px 0 28px; color: var(--color-text-secondary); font-size: 14px; }
.drawer-item:hover, .drawer-link:hover { background: var(--color-hover); color: var(--color-text); }

/* Smaller laptops: tighten the row so long English labels fit. */
@media (min-width: 1101px) and (max-width: 1360px) {
  .app-header { gap: 12px; padding: 0 16px; }
  .brand-zh, .brand-tag { display: none; }
  .nav-link { padding: 0 8px; }
  .nav-link.is-active::after, .nav-group.is-active > .nav-trigger::after { left: 8px; right: 8px; }
  .header-link { padding: 0 4px; }
}

/* Tablets and phones: the nav moves into the drawer; the header scrolls with the page (--header-h is 0 ≤720px). */
@media (max-width: 1100px) {
  .app-header { height: 56px; padding: 0 16px; gap: 8px; }
  .nav { display: none; }
  .drawer-button { display: inline-flex; }
  .brand-zh, .brand-tag { display: none; }
  .header-link { display: none; }
}
.brand-wordmark { display: none; }
.m-back, .m-title, .m-me, .m-search, .m-search-icon, .m-support, .m-main-title { display: none; }
@media (max-width: 720px) {
  /* Home: the brand on the left; search, support, messages and the avatar on the right (owner 2026-11-17). */
  .m-me { display: inline-flex; flex: 0 0 36px; order: 3; margin-left: 8px; border-radius: 50%; }
  .m-me:active { transform: scale(.94); }
  .m-search-icon { display: inline-flex; order: 1; margin-right: 8px; }
  .app-header.is-home:not(.is-inner) .brand { display: inline-flex; margin-right: auto; }
  .app-header.is-home .brand-wordmark { display: block; margin-left: 2px; }
  .app-header.is-home .brand-words.has-wordmark { display: none; }
  .app-header.is-home .brand-name { font-size: 19px; font-weight: 800; letter-spacing: .04em; }
  .app-header.is-home .brand { gap: 9px; }
  /* The home page shows the word mark alone (owner 2026-11-17); the W stays on the sphere below it. */
  .app-header.is-home .brand:has(.brand-wordmark) > :not(.brand-wordmark) { display: none; }
  .app-header.is-home .brand-wordmark { margin-left: 0; }
  /* Main pages: bare line icons, no discs — three on the home page (search, messages, avatar). */
  .app-header .icon-button { border-color: transparent !important; background: transparent !important; box-shadow: none !important; }
  .app-header .icon-button :deep(svg) { width: 22px; height: 22px; stroke-width: 1.9; }
  .app-header:not(.is-inner) .icon-button:active { color: var(--color-accent-text); transform: scale(.92); }
  .app-header.is-home .m-search-icon { margin-right: 2px; }
  /* The magnifier's glyph fills less of its box than the bell's, so it is drawn larger to look the same size. */
  .app-header .m-search-icon :deep(svg) { width: 26px; height: 26px; stroke-width: 1.8; }
  .app-header .icon-button:not(.m-search-icon) :deep(svg) { width: 24px; height: 24px; }
  .app-header.is-home .m-me { margin-left: 6px; }
  .app-header.is-inner .brand { display: none; }
  .app-header.is-inner .m-back { display: inline-flex; margin-left: -8px; border-color: transparent; background: transparent; }
  .app-header.is-inner .m-title { display: block; flex: 1 1 auto; min-width: 0; margin-left: 2px; font-family: var(--font-display); font-size: 17px; font-weight: 700; }
  .app-header.is-inner .locale { display: none; }
  /* Main pages: avatar, search, support, messages — the brand, language and menu buttons give way (the bottom
     navigation, 探索 and 个人中心 carry everything the drawer listed; language lives in 个人中心 › 设置). */
  .app-header:not(.is-inner) .brand, .app-header .locale, .app-header .drawer-button { display: none; }
  .m-search { display: flex; align-items: center; gap: 7px; flex: 1 1 auto; min-width: 0; height: 36px; margin-right: 8px; padding: 0 13px; border-radius: 999px; background: var(--color-surface-alt); color: var(--color-text-muted); font-size: 13px; text-decoration: none; }
  .m-main-title { display: block; flex: 1 1 auto; min-width: 0; font-family: var(--font-display); font-size: 20px; font-weight: 750; letter-spacing: -0.01em; }
  .m-search span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .m-support { display: inline-flex; order: 1; margin-right: 8px; }
  .app-header:not(.is-inner) .header-right { flex: 0 0 auto; margin-left: 0; order: 2; }
  .app-header { position: relative; padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right)); }
  .brand-name { font-size: 18px; }
  .user-group { display: none; }
  .auth-login { display: none; }
  .auth-btn { height: 36px; padding: 0 14px; font-size: 14px; }
  .theme-button { display: none; }
  /* Touch targets ≥ 40 px (mobile audit 10-22); the brand link keeps its look, only its hit box grows. */
  .brand { min-height: 40px; }
  .icon-button { width: 40px; height: 40px; flex-basis: 40px; }
  .app-header .auth-btn { min-height: 40px; }
}
/* Phones: the drawer is a full-width sheet (a 30 px sliver of page beside it read as a glitch). */
@media (max-width: 480px) {
  .nav-drawer { width: 100%; }
}
/* Short landscape phones: tighter drawer rows so the whole menu is reachable. */
@media (max-height: 480px) and (orientation: landscape) {
  .drawer-head { height: 52px; }
  .drawer-link { min-height: 46px; }
}
</style>
