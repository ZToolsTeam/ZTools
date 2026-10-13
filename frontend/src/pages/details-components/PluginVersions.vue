<script setup>
defineProps({
  changelogs: {
    type: Array,
    default: () => []
  }
})
</script>

<template>
  <div
    v-if="!changelogs || changelogs.length === 0"
    class="text-center py-12 text-gray-400"
  >
    <i class="fa fa-history text-5xl mb-4"></i>
    <p>暂无版本记录</p>
  </div>
  <div
    else
    class="space-y-8 pl-4 border-l-2 ml-2"
    style="border-color: var(--zt-border)"
  >
    <div v-for="log in changelogs" :key="log.id" class="relative">
      <div
        class="absolute -left-[1.35rem] top-1 w-4 h-4 rounded-full bg-blue-600 border-4"
        style="border-color: var(--zt-bg-elevated)"
      ></div>
      <div class="mb-1 flex items-center gap-3">
        <span class="font-bold text-lg" style="color: var(--zt-text)"
          >v{{ log.version }}</span
        >
        <span
          class="text-sm opacity-60"
          style="color: var(--zt-text-secondary)"
          >{{ log.release_date || log.created_at?.split(' ')[0] }}</span
        >
      </div>
      <div
        class="text-sm whitespace-pre-wrap leading-relaxed opacity-80"
        style="color: var(--zt-text)"
      >
        {{ log.changes || log.content }}
      </div>
    </div>
  </div>
</template>
