<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import QRCode from 'qrcode'

/** Local QR for the invite link (same `qrcode` dependency as `wallet/DepositQr`); nothing is sent anywhere. */
const props = defineProps<{ value: string; alt: string }>()
const src = ref('')
let generation = 0

watch(() => props.value, async (value) => {
  const current = ++generation
  src.value = ''
  if (value === '') return
  try {
    const url = await QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 1, width: 360, type: 'image/png' })
    if (current === generation) src.value = url
  } catch {
    if (current === generation) src.value = ''
  }
}, { immediate: true })
onBeforeUnmount(() => { generation += 1 })
</script>

<template>
  <img v-if="src !== ''" class="invite-qr" :src="src" :alt="alt" width="148" height="148" data-testid="invite-qr" />
  <span v-else class="invite-qr placeholder" aria-hidden="true"></span>
</template>

<style scoped>
.invite-qr { display: block; width: 148px; height: 148px; padding: 8px; border-radius: 14px; background: #fff; }
.placeholder { background: var(--color-surface-alt); }
</style>
