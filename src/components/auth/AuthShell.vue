<script setup lang="ts">
// Shared split layout for the register / recover-password / login pages: a brand panel on the left
// and the form card on the right (the brand panel collapses on narrow screens). Purely
// presentational: no auth logic lives here.
import { useI18n } from 'vue-i18n'
import { CandlestickChart, KeyRound, ShieldCheck } from '@lucide/vue'
import BrandMark from '@/components/common/BrandMark.vue'
import { BRAND_NAME, BRAND_NAME_ZH } from '@/core/brand'

withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** Wider card for the two-column-friendly register form. */
    wide?: boolean
  }>(),
  { subtitle: '', wide: false },
)

const { t } = useI18n({
  useScope: 'local',
  messages: {
    'zh-CN': {
      headline: '一个账户，交易加密货币、黄金与美股',
      lead: '现货、U 本位永续合约、跟单与理财，实时行情与专业图表，精确到最小单位的账务。',
      p1: '登录二次验证与 TOTP 验证器',
      p2: '退出登录即清除本地会话',
      p3: '实时订单簿、深度图与专业 K 线',
    },
    'en-US': {
      headline: 'Crypto, gold and US stocks in one account',
      lead: 'Spot, USDT-margined perpetuals, copy trading and earn, with live markets, pro charts and exact accounting.',
      p1: 'Two-step login and TOTP authenticator',
      p2: 'Signing out clears the local session',
      p3: 'Live order book, depth chart and pro candles',
    },
  },
})
</script>

<template>
  <div class="auth-page">
    <aside class="auth-brand" aria-hidden="true">
      <div class="brand-glow"></div>
      <div class="brand-grid"></div>
      <div class="brand-inner">
        <div class="brand-row"><BrandMark :size="40" /><span class="brand-name brand-wordtext">{{ BRAND_NAME }}</span><span v-if="BRAND_NAME_ZH !== ''" class="brand-zh">{{ BRAND_NAME_ZH }}</span></div>
        <h2>{{ t('headline') }}</h2>
        <p>{{ t('lead') }}</p>
        <ul>
          <li><span><ShieldCheck :size="16" /></span>{{ t('p1') }}</li>
          <li><span><KeyRound :size="16" /></span>{{ t('p2') }}</li>
          <li><span><CandlestickChart :size="16" /></span>{{ t('p3') }}</li>
        </ul>
        <svg class="brand-chart" viewBox="0 0 400 120" preserveAspectRatio="none">
          <defs>
            <linearGradient id="auth-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style="stop-color: rgb(var(--brand-art-rgb))" stop-opacity="0.35" />
              <stop offset="1" style="stop-color: rgb(var(--brand-art-rgb))" stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 96 L40 88 L70 92 L110 70 L150 76 L190 52 L230 60 L270 38 L310 44 L350 20 L400 26 L400 120 L0 120 Z" fill="url(#auth-area)" />
          <path d="M0 96 L40 88 L70 92 L110 70 L150 76 L190 52 L230 60 L270 38 L310 44 L350 20 L400 26" fill="none" style="stroke: rgb(var(--brand-art-rgb))" stroke-width="2" />
        </svg>
      </div>
    </aside>

    <div class="auth-main">
      <!-- Phones: the brand panel is hidden, so the form opens with a compact brand card (owner 2026-11-17). -->
      <div class="auth-mobile-brand" aria-hidden="true">
        <div class="amb-row"><BrandMark :size="30" /><span class="brand-wordtext">{{ BRAND_NAME }}</span></div>
        <strong>{{ t('headline') }}</strong>
        <small>{{ t('lead') }}</small>
      </div>
      <section class="auth-card" :class="{ wide }">
        <header class="auth-heading">
          <h1>{{ title }}</h1>
          <p v-if="subtitle !== ''" class="auth-subtitle">{{ subtitle }}</p>
        </header>
        <slot name="notice" />
        <div class="auth-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="auth-footer">
          <slot name="footer" />
        </footer>
        <slot name="aside" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  display: grid;
  grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
  min-height: calc(100vh - 60px);
}

.auth-brand {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  padding: 56px;
  border-right: 1px solid var(--color-border);
  background: #07090c;
  color: #eef1f6;
}
.brand-glow { position: absolute; width: 560px; height: 560px; left: -140px; top: -200px; border-radius: 50%; background: rgba(var(--brand-art-rgb), 0.18); filter: blur(90px); }
.brand-grid {
  position: absolute; inset: 0;
  background-image: linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse 70% 70% at 30% 30%, #000 10%, transparent 75%);
  -webkit-mask-image: radial-gradient(ellipse 70% 70% at 30% 30%, #000 10%, transparent 75%);
}
.brand-inner { position: relative; max-width: 440px; animation: rise-in 0.7s var(--ease-out) both; }
.brand-row { display: flex; align-items: center; gap: 12px; }
.brand-name { font-family: var(--font-display); font-size: 26px; font-weight: 750; letter-spacing: -0.02em; }
.brand-zh { color: #a4aebd; font-size: 15px; font-weight: 600; letter-spacing: 0.08em; }
.auth-brand h2 { margin: 40px 0 0; font-size: 36px; line-height: 1.15; font-weight: 750; letter-spacing: -0.03em; }
.auth-brand p { margin: 14px 0 0; color: #a4aebd; font-size: 15px; line-height: 1.7; }
.auth-brand ul { display: grid; gap: 14px; margin: 32px 0 0; padding: 0; list-style: none; font-size: 14px; color: #d5dae2; }
.auth-brand li { display: flex; align-items: center; gap: 12px; }
.auth-brand li span { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 10px; background: rgba(var(--brand-art-rgb), 0.12); color: var(--brand-art-chip); }
.brand-chart { display: block; width: 100%; height: 110px; margin-top: 44px; }

.auth-main {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 72px 24px 96px;
  background: var(--color-surface);
}

.auth-card {
  width: 100%;
  max-width: 420px;
  min-width: 0;
  animation: rise-in 0.55s 0.08s var(--ease-out) both;
}

.auth-card.wide {
  max-width: 460px;
}

.auth-heading {
  margin-bottom: 28px;
}

.auth-heading h1 {
  margin: 0;
  font-size: 32px;
  font-weight: 750;
  line-height: 1.2;
  letter-spacing: -0.025em;
}

.auth-subtitle {
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.auth-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.auth-body :deep(.btn-primary) { height: 48px; border-radius: 12px; font-size: 15px; }

.auth-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin-top: 24px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

@media (max-width: 960px) {
  .auth-page { grid-template-columns: minmax(0, 1fr); }
  .auth-brand { display: none; }
}

.auth-mobile-brand { display: none; }
@media (max-width: 720px) {
  .auth-main { flex-direction: column; align-items: stretch; gap: 22px; padding: 16px 16px 72px; }
  .auth-card { max-width: none; }
  .auth-mobile-brand {
    display: flex; flex-direction: column; gap: 6px; padding: 20px 18px; overflow: hidden; border-radius: 18px; color: #f4efe3;
    border: 1px solid rgba(217, 168, 90, .42);
    background: radial-gradient(120% 140% at 100% 0%, rgba(217, 168, 90, .34), transparent 60%), linear-gradient(120deg, #17120a, #0c0c0e 70%);
  }
  .amb-row { display: flex; align-items: center; gap: 9px; font-family: var(--font-display); font-size: 19px; font-weight: 750; letter-spacing: -0.01em; }
  .auth-mobile-brand strong { margin-top: 8px; font-family: var(--font-display); font-size: 20px; font-weight: 750; line-height: 1.3; }
  .auth-mobile-brand small { max-width: 76%; color: rgba(244, 239, 227, .7); font-size: 12.5px; line-height: 1.55; }
  .auth-heading h1 {
    font-size: 26px;
  }
}
</style>
