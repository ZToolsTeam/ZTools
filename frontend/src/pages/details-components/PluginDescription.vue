<script setup>
defineProps({
  description: String
})
</script>

<template>
  <p class="leading-relaxed whitespace-pre-wrap" style="color: var(--zt-text)">
    {{ description || '暂无介绍' }}
  </p>
</template>
