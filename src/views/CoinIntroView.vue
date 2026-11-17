<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StateBlock from '@/components/common/StateBlock.vue'
import { isApiError } from '@/core/errors'
import { fetchCoinIntro } from '@/modules/api/public.api'
import type { CoinIntroItem } from '@/modules/api/types'
import { toDecString } from '@/modules/finance/decimal'
import { useMarketStore } from '@/stores/market'
import { safeWebUrl } from '@/core/urls'

const { t, locale } = useI18n()
const market = useMarketStore()

const items = ref<CoinIntroItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const selected = ref<string>('')

const current = computed(() => items.value.find((item) => (item.coinSymbol ?? '') === selected.value))

function symbolOf(item: CoinIntroItem): string {
  return (item.coinSymbol ?? '').toUpperCase()
}

function amount(value: string | number | undefined): string {
  const text = toDecString(value)
  return text === '' ? '--' : text
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    if (market.publicInfo === null) {
      try {
        await market.loadPublicInfo()
      } catch {
        // Coin intro does not depend on public info; ignore and continue.
      }
    }
    items.value = await fetchCoinIntro()
    if (selected.value === '' && items.value.length > 0) {
      selected.value = symbolOf(items.value[0])
    }
  } catch (error_) {
    error.value = isApiError(error_) ? error_.message : error_ instanceof Error ? error_.message : String(error_)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
watch(locale, () => { void load() })
</script>

<template>
  <div class="coin-intro">
    <section class="panel list-panel">
      <header class="panel-header">
        <span class="panel-title">{{ t('coinIntro.title') }}</span>
        <button class="btn btn-ghost" type="button" :disabled="loading" @click="load">{{ t('common.refresh') }}</button>
      </header>
      <div class="panel-body">
        <StateBlock v-if="loading && items.length === 0" variant="loading" :message="t('common.loading')" />
        <StateBlock v-else-if="error !== null" variant="error" :message="error" retryable @retry="load" />
        <StateBlock v-else-if="items.length === 0" variant="empty" :message="t('coinIntro.empty')" />
        <ul v-else class="coin-list scroll-y">
          <li v-for="item in items" :key="item.id">
            <button
              class="coin-item"
              :class="{ active: symbolOf(item) === selected }"
              type="button"
              @click="selected = symbolOf(item)"
            >
              <span class="coin-symbol">{{ symbolOf(item) }}</span>
              <span class="ellipsis muted">{{ item.shortName ?? item.longName ?? '' }}</span>
            </button>
          </li>
        </ul>
      </div>
    </section>

    <section class="panel detail-panel">
      <header class="panel-header">
        <span class="panel-title">{{ current ? `${symbolOf(current)} · ${current.shortName ?? ''}` : t('coinIntro.title') }}</span>
      </header>
      <div class="panel-body">
        <StateBlock v-if="current === undefined" variant="empty" :message="t('coinIntro.select')" />
        <div v-else class="stack detail">
          <dl class="facts">
            <div><dt>{{ t('coinIntro.longName') }}</dt><dd>{{ current.longName ?? '--' }}</dd></div>
            <div><dt>{{ t('coinIntro.publishTime') }}</dt><dd>{{ current.publishTimeStr ?? '--' }}</dd></div>
            <div><dt>{{ t('coinIntro.publishAmount') }}</dt><dd class="num">{{ amount(current.publishAmount) }}</dd></div>
            <div><dt>{{ t('coinIntro.currencyAmount') }}</dt><dd class="num">{{ amount(current.currencyAmount) }}</dd></div>
          </dl>
          <div class="row">
            <a v-if="safeWebUrl(current.officialUrl)" class="btn" :href="safeWebUrl(current.officialUrl)" target="_blank" rel="noopener noreferrer">
              {{ t('coinIntro.officialSite') }}
            </a>
            <a v-if="safeWebUrl(current.blockchainUrl)" class="btn" :href="safeWebUrl(current.blockchainUrl)" target="_blank" rel="noopener noreferrer">
              {{ t('coinIntro.explorer') }}
            </a>
          </div>
          <div class="field">
            <span class="field-label">{{ t('coinIntro.introduction') }}</span>
            <p class="introduction wrap-anywhere">{{ current.introduction ?? '--' }}</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.coin-intro {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: var(--space-3);
  align-items: start;
}

.coin-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 560px;
}

.coin-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border-radius: var(--radius);
  text-align: left;
  font-size: var(--font-size-sm);
}

.coin-item.active {
  background: var(--color-accent-soft);
  color: var(--color-accent-text);
}

.coin-symbol {
  font-weight: 600;
  min-width: 44px;
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-2);
  margin: 0;
}

.facts dt {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.facts dd {
  margin: 0;
  font-size: var(--font-size-md);
}

.introduction {
  margin: 0;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface-alt);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  white-space: pre-wrap;
}

.source {
  font-size: var(--font-size-xs);
}

@media (max-width: 900px) {
  .coin-intro {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
