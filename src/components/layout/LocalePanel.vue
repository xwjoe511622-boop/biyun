<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Search, X } from '@lucide/vue'
import { LOCALES, setLocale } from '@/i18n'
import { useValuationPrefs } from '@/modules/wallet/use-valuation'
import { VALUATION_UNITS, type ValuationUnit } from '@/modules/wallet/valuation'
import { SEARCH_THRESHOLD, filterLocales, localeRows, moveIndex, trapIndex } from './locale-panel-model'
import '@/styles/locale-panel.css'

/**
 * Language & region / Currency panel behind the header globe (Binance "语言和地区 | 汇率", OKX "语言 | 计价货币").
 * Desktop: a popover under the globe. Phones (≤640px): a full-screen sheet; the drawer's language entry opens
 * the same panel. Only languages with a real message file are listed (`@/i18n/catalog`); the currency tab is
 * the existing asset valuation unit (`useValuationPrefs`, shared with the home card and assets overview).
 *
 * Keyboard: Tab is trapped inside, ←/→ switch tabs, arrow keys / Home / End move through the options,
 * Enter or Space picks, Esc closes and focus returns to the globe. Click outside closes.
 */
const props = defineProps<{ open: boolean; anchor: HTMLElement | null }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'locale-change': [code: string] }>()

type TabKey = 'language' | 'currency'

const { locale } = useI18n()
const prefs = useValuationPrefs()

interface PanelCopy {
  dialog: string
  language: string
  currency: string
  search: string
  noMatch: string
  close: string
  currencyNote: string
  units: Record<ValuationUnit, string>
}
const COPY: Record<string, PanelCopy> = {
  'zh-CN': {
    dialog: '语言和计价货币',
    language: '语言和地区',
    currency: '计价货币',
    search: '搜索语言',
    noMatch: '没有匹配的语言',
    close: '关闭',
    currencyNote: '资产总览与首页账户卡片按此单位估值',
    units: { BTC: '比特币', USDT: '泰达币', USD: '美元（按 USDT 1:1 折算）' },
  },
  'en-US': {
    dialog: 'Language and currency',
    language: 'Language and region',
    currency: 'Currency',
    search: 'Search languages',
    noMatch: 'No language matches',
    close: 'Close',
    currencyNote: 'Your asset totals are valued in this unit',
    units: { BTC: 'Bitcoin', USDT: 'Tether USD', USD: 'US dollar (at USDT 1:1)' },
  },
}
const copy = computed<PanelCopy>(() => COPY[locale.value] ?? COPY['en-US'])

const UNIT_GLYPH: Record<ValuationUnit, string> = { BTC: '₿', USDT: '₮', USD: '$' }

const tab = ref<TabKey>('language')
const query = ref('')
const showSearch = computed(() => LOCALES.length > SEARCH_THRESHOLD)
const rows = computed(() => localeRows(filterLocales(LOCALES, query.value), locale.value, locale.value))
const units = computed(() => VALUATION_UNITS.map((unit) => ({
  code: unit,
  glyph: UNIT_GLYPH[unit],
  secondary: copy.value.units[unit],
  selected: prefs.unit.value === unit,
})))

const panel = ref<HTMLElement | null>(null)
const position = ref({ top: 72, right: 16 })

function place(): void {
  const rect = props.anchor?.getBoundingClientRect()
  if (rect === undefined) return
  // Hang from the header's bottom edge (Binance/OKX), right edge lined up with the globe.
  const headerBottom = props.anchor?.closest('header')?.getBoundingClientRect().bottom ?? rect.bottom
  position.value = { top: Math.round(Math.max(rect.bottom, headerBottom) + 6), right: Math.max(16, Math.round(window.innerWidth - rect.right - 8)) }
}

function close(): void {
  emit('update:open', false)
}

function pickLocale(code: string): void {
  if (code !== locale.value) {
    setLocale(code)
    emit('locale-change', code)
  }
  close()
}

function pickUnit(unit: ValuationUnit): void {
  prefs.setUnit(unit)
  close()
}

function focusables(): HTMLElement[] {
  const root = panel.value
  if (root === null) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]'))
    .filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0)
}

/** The selected option of the visible list (else the first one, else the first tab). */
function focusCurrent(): void {
  const root = panel.value
  if (root === null) return
  const list = root.querySelector<HTMLElement>(`#lp-pane-${tab.value} [role="listbox"]`)
  const target = list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('[role="option"]')
  ;(target ?? root.querySelector<HTMLElement>('[role="tab"]'))?.focus()
}

function onPanelKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusables()
  const next = trapIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey)
  if (next < 0) return
  event.preventDefault()
  items[next].focus()
}

function onTabKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  selectTab(tab.value === 'language' ? 'currency' : 'language', true)
}

function selectTab(next: TabKey, focusTab = false): void {
  tab.value = next
  void nextTick(() => {
    if (focusTab) panel.value?.querySelector<HTMLElement>(`#lp-tab-${next}`)?.focus()
  })
}

/** Roving focus within a listbox; Enter/Space click the focused option. */
function onListKey(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement
  const options = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'))
  const current = options.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    options[current]?.click()
    return
  }
  const columns = getComputedStyle(list).gridTemplateColumns.split(' ').filter((part) => part !== '').length
  const next = moveIndex(current, event.key, options.length, columns)
  if (next === null) return
  event.preventDefault()
  options[next].focus()
}

function onDocumentPointer(event: PointerEvent): void {
  const target = event.target as Node | null
  if (target === null) return
  if (panel.value?.contains(target) === true || props.anchor?.contains(target) === true) return
  close()
}

function onViewport(): void {
  place()
}

function listen(on: boolean): void {
  if (on) {
    document.addEventListener('pointerdown', onDocumentPointer, true)
    window.addEventListener('resize', onViewport)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointer, true)
    window.removeEventListener('resize', onViewport)
  }
}

watch(() => props.open, (open, wasOpen) => {
  if (open) {
    tab.value = 'language'
    query.value = ''
    place()
    listen(true)
    void nextTick(focusCurrent)
  } else if (wasOpen === true) {
    listen(false)
    // Give focus back to the globe only when it was inside the panel (a click elsewhere keeps its own focus).
    const active = document.activeElement
    if (active === null || active === document.body || panel.value?.contains(active) === true) props.anchor?.focus()
  }
})
onBeforeUnmount(() => listen(false))
</script>

<template>
  <Teleport to="body">
    <Transition name="lp">
      <div
        v-if="open"
        ref="panel"
        class="lp-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="copy.dialog"
        :style="{ '--lp-top': `${position.top}px`, '--lp-right': `${position.right}px` }"
        @keydown="onPanelKey"
      >
        <div class="lp-head">
          <div class="lp-tabs" role="tablist" :aria-label="copy.dialog" @keydown="onTabKey">
            <button
              v-for="key in (['language', 'currency'] as const)"
              :id="`lp-tab-${key}`"
              :key="key"
              class="lp-tab"
              :class="{ 'is-active': tab === key }"
              type="button"
              role="tab"
              :aria-selected="tab === key"
              :aria-controls="`lp-pane-${key}`"
              :tabindex="tab === key ? 0 : -1"
              @click="selectTab(key)"
            >{{ copy[key] }}</button>
          </div>
          <button class="lp-close" type="button" :aria-label="copy.close" @click="close"><X :size="22" aria-hidden="true" /></button>
        </div>

        <div v-show="tab === 'language'" id="lp-pane-language" class="lp-pane" role="tabpanel" aria-labelledby="lp-tab-language">
          <label v-if="showSearch" class="lp-search">
            <Search :size="16" aria-hidden="true" />
            <input v-model="query" type="search" :placeholder="copy.search" :aria-label="copy.search" autocomplete="off" />
          </label>
          <ul class="lp-list" role="listbox" :aria-label="copy.language" @keydown="onListKey">
            <li
              v-for="row in rows"
              :key="row.code"
              class="lp-option"
              :class="{ 'is-selected': row.selected }"
              role="option"
              :aria-selected="row.selected"
              :tabindex="row.selected ? 0 : -1"
              @click="pickLocale(row.code)"
            >
              <span class="lp-glyph" :lang="row.code" aria-hidden="true">{{ row.glyph }}</span>
              <span class="lp-names">
                <span class="lp-primary" :lang="row.code">{{ row.primary }}</span>
                <span v-if="row.secondary !== ''" class="lp-secondary">{{ row.secondary }}</span>
              </span>
              <Check v-if="row.selected" class="lp-check" :size="18" :stroke-width="2.4" aria-hidden="true" />
            </li>
          </ul>
          <p v-if="rows.length === 0" class="lp-empty">{{ copy.noMatch }}</p>
        </div>

        <div v-show="tab === 'currency'" id="lp-pane-currency" class="lp-pane" role="tabpanel" aria-labelledby="lp-tab-currency">
          <p class="lp-note">{{ copy.currencyNote }}</p>
          <ul class="lp-list is-rows" role="listbox" :aria-label="copy.currency" @keydown="onListKey">
            <li
              v-for="unit in units"
              :key="unit.code"
              class="lp-option"
              :class="{ 'is-selected': unit.selected }"
              role="option"
              :aria-selected="unit.selected"
              :tabindex="unit.selected ? 0 : -1"
              @click="pickUnit(unit.code)"
            >
              <span class="lp-glyph is-unit" aria-hidden="true">{{ unit.glyph }}</span>
              <span class="lp-names">
                <span class="lp-primary">{{ unit.code }}</span>
                <span class="lp-secondary">{{ unit.secondary }}</span>
              </span>
              <Check v-if="unit.selected" class="lp-check" :size="18" :stroke-width="2.4" aria-hidden="true" />
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
