<script setup lang="ts">
import { computed } from 'vue'
import { vTick } from './fx'

/**
 * Live price tape between the hero and the markets block. Items are real tickers (rows still at `--` are
 * left out; nothing renders until one has a price). The strip is the item list twice, moved by one pure
 * CSS animation (translateX −50%), so it loops seamlessly; hover or keyboard focus pauses it.
 */
export interface TickerItem {
  key: string
  label: string
  last: string
  change: { text: string; direction: string }
}

const props = defineProps<{ items: TickerItem[]; label: string }>()
const emit = defineEmits<{ pick: [key: string] }>()

/** Live rows, repeated so one copy is always wider than a wide screen. */
const live = computed(() => props.items.filter((item) => item.last !== '--' && item.last !== ''))
const loop = computed(() => {
  const list = live.value
  if (list.length === 0) return []
  const out: TickerItem[] = []
  while (out.length < 14) out.push(...list)
  return out
})
/** ~2.6 s per item keeps the reading speed the same whatever the list length. */
const duration = computed(() => `${loop.value.length * 2.6}s`)
</script>

<template>
  <nav v-if="loop.length > 0" class="fx-tape" :aria-label="label">
    <div class="fx-tape-track" :style="{ '--fx-tape-dur': duration }">
      <ul v-for="copy in 2" :key="copy" class="fx-tape-list" :aria-hidden="copy === 2 ? 'true' : undefined">
        <li v-for="(item, index) in loop" :key="`${item.key}-${index}`">
          <button type="button" class="fx-tape-item" :tabindex="copy === 2 || index >= live.length ? -1 : undefined" @click="emit('pick', item.key)">
            <strong>{{ item.label }}</strong>
            <span v-tick="item.last" class="num fx-tape-px">{{ item.last }}</span>
            <span class="num fx-tape-chg" :class="item.change.direction">{{ item.change.text }}</span>
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>
