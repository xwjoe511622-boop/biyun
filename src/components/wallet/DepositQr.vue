<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { safeQrImage } from '@/modules/security/security-state'
import { generateDepositQrDataUrl } from '@/modules/wallet/depositQr'

const props = defineProps<{
  /** Plain deposit address without the memo/tag suffix. */
  address: string
  /** `addressQRCode` exactly as returned by the server. */
  remoteQr: string
  alt: string
}>()

const qrSrc = ref('')
let generation = 0

watch(
  () => [props.address, props.remoteQr] as const,
  async ([address, remoteQr]) => {
    const current = ++generation
    // Clear synchronously so an old raster cannot survive a coin/account switch while the next
    // QR is still being generated.
    qrSrc.value = ''
    if (address === '') {
      return
    }
    const safeRemote = safeQrImage(remoteQr, window.location.origin)
    if (safeRemote !== '') {
      qrSrc.value = safeRemote
      return
    }
    try {
      const local = await generateDepositQrDataUrl(address)
      if (current !== generation || props.address !== address) {
        return
      }
      qrSrc.value = local
    } catch {
      if (current === generation && props.address === address) {
        qrSrc.value = ''
      }
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  // Invalidate in-flight raster generation when the panel is torn down or the session drops.
  generation += 1
})
</script>

<template>
  <img
    v-if="qrSrc !== ''"
    class="deposit-qr"
    :src="qrSrc"
    :alt="alt"
    width="160"
    height="160"
    data-testid="deposit-qr"
    referrerpolicy="no-referrer"
  />
</template>

<style scoped>
.deposit-qr {
  width: 160px;
  height: 160px;
  object-fit: contain;
  background: #fff;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
}
</style>
