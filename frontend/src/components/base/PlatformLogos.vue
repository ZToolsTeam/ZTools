<script setup>
import { computed } from 'vue'
import { AppleLogo, WindowsLogo } from '@/utils/appIcons'
import { getPluginPlatforms } from '@/utils/platform'

/**
 * 插件支持的平台：直接显示系统标志（Windows / Apple），两个都支持就并排显示两个。
 * 插件没有声明平台时不渲染。悬停与读屏给出完整说明。
 */
const props = defineProps({
  plugin: { type: Object, required: true }
})

const LOGOS = { windows: { icon: WindowsLogo, name: 'Windows' }, macos: { icon: AppleLogo, name: 'macOS' } }
const platforms = computed(() => (getPluginPlatforms(props.plugin) || []).filter((p) => LOGOS[p]))
const description = computed(() => {
  const names = platforms.value.map((p) => LOGOS[p].name)
  return names.length > 1 ? `支持 ${names.join(' 和 ')}` : `仅支持 ${names[0]}`
})
</script>

<template>
  <span v-if="platforms.length" class="platform-logos" :title="description" role="img" :aria-label="description">
    <component :is="LOGOS[p].icon" v-for="p in platforms" :key="p" class="platform-logo" aria-hidden="true" />
  </span>
</template>

<style scoped>
.platform-logos {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  color: var(--rc-text-muted);
  line-height: 1;
}

.platform-logo {
  vertical-align: 0;
}
</style>
