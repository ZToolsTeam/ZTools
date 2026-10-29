<script setup>
defineProps({
  description: String
})
</script>

<template>
  <p class="leading-relaxed whitespace-pre-wrap" style="color: var(--rc-text-primary)">
    {{ description || '暂无介绍' }}
  </p>
</template>
