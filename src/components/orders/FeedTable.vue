<script setup lang="ts" generic="T">
import type { FeedColumn, FeedRow } from './model'

defineProps<{ columns: FeedColumn<T>[]; rows: FeedRow<T>[]; rowKey: (row: FeedRow<T>) => string; actionLabel?: string }>()
defineSlots<{ action?: (props: { row: FeedRow<T> }) => unknown }>()
</script>

<template>
  <div class="feed-scroll">
    <table class="table feed-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.key" :class="column.align === 'left' ? 'left' : ''">{{ column.label }}</th>
          <th v-if="$slots.action" class="action-col">{{ actionLabel ?? '' }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="rowKey(row)">
          <td v-for="column in columns" :key="column.key" :data-label="column.label" :class="[column.align === 'left' ? 'left' : 'num', column.className?.(row) ?? '']">{{ column.value(row) }}</td>
          <td v-if="$slots.action" class="action-col"><slot name="action" :row="row" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.feed-scroll { overflow-x: auto; }
.feed-table { table-layout: auto; min-width: 860px; }
.feed-table th, .feed-table td { padding: 12px 12px; font-size: 12.5px; }
.feed-table th { font-size: 11.5px; }
.feed-table th:first-child, .feed-table td:first-child { padding-left: 18px; }
.feed-table th:last-child, .feed-table td:last-child { padding-right: 18px; }
.feed-table .left { text-align: left; }
.feed-table td.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.action-col { width: 1%; white-space: nowrap; }
.feed-table tbody tr:last-child td { border-bottom: 0; }
/* Phones (owner 2026-11-17): one card per row, each value under its column name — no sideways scrolling. */
@media (max-width: 720px) {
  .feed-scroll { overflow: visible; }
  .feed-table { display: block; min-width: 0; }
  .feed-table thead { display: none; }
  .feed-table tbody { display: block; }
  .feed-table tbody tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; padding: 14px 16px; border-bottom: 1px solid var(--color-border); }
  .feed-table tbody tr:last-child { border-bottom: 0; }
  .feed-table td, .feed-table td:first-child, .feed-table td:last-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 0; border: 0; font-size: 13.5px; text-align: left; overflow-wrap: anywhere; }
  .feed-table td::before { content: attr(data-label); color: var(--color-text-muted); font-family: var(--font-sans); font-size: 11px; }
  .feed-table td.action-col { grid-column: 1 / -1; flex-direction: row; justify-content: flex-end; width: auto; padding-top: 4px; }
  .feed-table td.action-col::before { content: none; }
}
</style>
