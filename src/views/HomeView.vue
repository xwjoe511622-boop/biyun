<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { SKIN } from '@/core/skin'

// One home page per skin; the build-time literal keeps only this skin's page in the bundle.
const Home = SKIN === 'okx'
  ? defineAsyncComponent(() => import('@/views/home/HomeOkx.vue'))
  : defineAsyncComponent(() => import('@/views/home/HomeBinance.vue'))
// Phones (≤720px, OKX skin) get the compact app-style home instead of the desktop marketing page (owner 11-17).
const HomeMobile = defineAsyncComponent(() => import('@/components/home/mobile/HomeMobile.vue'))
const PHONE = '(max-width: 720px)'
const phone = ref(SKIN === 'okx' && typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
let query: MediaQueryList | null = null
const onChange = (event: MediaQueryListEvent): void => { phone.value = event.matches }
onMounted(() => {
  if (SKIN !== 'okx' || typeof window.matchMedia !== 'function') return
  query = window.matchMedia(PHONE)
  phone.value = query.matches
  query.addEventListener('change', onChange)
})
onBeforeUnmount(() => query?.removeEventListener('change', onChange))
</script>

<template>
  <HomeMobile v-if="phone" />
  <component :is="Home" v-else />
</template>
