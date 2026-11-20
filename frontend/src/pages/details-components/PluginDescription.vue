<script setup>
import { useAppI18n } from '@/i18n'

const { t } = useAppI18n()
defineProps({
  description: String
})
</script>

<template>
  <p class="leading-relaxed whitespace-pre-wrap" style="color: var(--rc-text-primary)">
    {{ description || t('details.noDescription') }}
  </p>
</template>
