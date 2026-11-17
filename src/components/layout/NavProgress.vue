<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'

/**
 * Thin top bar while a navigation is pending (the page chunk is still downloading), so a slow link never looks like a
 * dead click. Shown only after 150 ms to avoid flicker on cached chunks.
 */
const router = useRouter()
const visible = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

function stop(): void {
  clearTimeout(timer)
  visible.value = false
}

const offBefore = router.beforeEach(() => {
  clearTimeout(timer)
  timer = setTimeout(() => { visible.value = true }, 150)
})
const offAfter = router.afterEach(stop)
const offError = router.onError(stop)
onBeforeUnmount(() => { stop(); offBefore(); offAfter(); offError() })
</script>

<template>
  <div v-if="visible" class="nav-progress" role="progressbar" aria-busy="true"><i></i></div>
</template>

<style scoped>
.nav-progress {
  position: fixed;
  inset: 0 0 auto 0;
  height: 2px;
  z-index: 2000;
  overflow: hidden;
  pointer-events: none;
}
.nav-progress i {
  display: block;
  width: 40%;
  height: 100%;
  background: var(--color-accent);
  animation: nav-progress-slide 1s ease-in-out infinite;
}
@keyframes nav-progress-slide {
  from { transform: translateX(-100%); }
  to { transform: translateX(250%); }
}
</style>
