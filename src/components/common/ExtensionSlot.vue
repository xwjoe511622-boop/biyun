<script setup lang="ts">
import { computed } from 'vue'
import { extensionsForSlot, type ExtensionSlot } from '@/core/extensions'

/**
 * Renders whatever optional module is registered **and** enabled for this slot.
 * With the default feature flags (all false) this renders nothing at all.
 */
const props = defineProps<{ slot: ExtensionSlot }>()

const extensions = computed(() => extensionsForSlot(props.slot))
</script>

<template>
  <component :is="extension.component" v-for="extension in extensions" :key="extension.id" />
</template>
