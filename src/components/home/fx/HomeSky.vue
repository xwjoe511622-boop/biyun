<script setup lang="ts">
import CosmosSky from '@/components/home/cosmos/CosmosSky.vue'

/**
 * The home page's backdrop: ONE quiet cosmos sky (stars, galaxy band and a few small bodies at the edges, no warp) in a sticky
 * full-viewport stage inside a track that spans the page content (sticky rather than fixed, so it ends with the
 * home and never paints over the footer). No camera moves (owner 10-22: 不能为了特效过度开发). Decorative only.
 */
</script>

<template>
  <div class="home-sky-track" aria-hidden="true">
    <div class="home-sky">
      <CosmosSky variant="hero" calm />
      <i class="home-sky-veil"></i>
    </div>
  </div>
</template>
