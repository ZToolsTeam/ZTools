<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="declarative-mica-shell w-[480px] max-h-[500px] flex flex-col rounded-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150"
      @keydown.stop="handleKeyDown"
    >
      <!-- 搜索框 -->
      <div class="p-3 border-b border-white/10 flex items-center gap-2 bg-white/5">
        <DeclarativeIcon icon="magnifying-glass" :size="16" class="text-slate-400" />
        <input
          ref="searchInputRef"
          v-model="query"
          type="text"
          placeholder="查找动作..."
          class="w-full bg-transparent text-sm text-slate-100 placeholder-slate-400 outline-none"
        />
        <kbd class="px-1.5 py-0.5 text-xs text-slate-400 bg-white/10 rounded">ESC</kbd>
      </div>

      <!-- Action 列表 -->
      <div class="flex-1 overflow-y-auto declarative-scrollbar p-2 space-y-1">
        <div
          v-if="filteredActions.length === 0"
          class="p-6 text-center text-sm text-slate-400"
        >
          无匹配动作
        </div>

        <div
          v-for="(action, idx) in filteredActions"
          :key="idx"
          class="flex items-center justify-between px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors"
          :class="[
            selectedIndex === idx
              ? 'bg-sky-500/20 text-white font-medium shadow-sm'
              : 'text-slate-200 hover:bg-white/5'
          ]"
          @click="executeAction(action)"
          @mouseenter="selectedIndex = idx"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <DeclarativeIcon
              :icon="action.props?.icon || 'check'"
              :size="16"
              :class="selectedIndex === idx ? 'text-sky-400' : 'text-slate-400'"
            />
            <span class="truncate">{{ action.props?.title || '未命名动作' }}</span>
          </div>

          <!-- 快捷键标签 -->
          <div v-if="action.props?.shortcut" class="flex items-center gap-1">
            <kbd
              v-for="(mod, mIdx) in action.props.shortcut.modifiers"
              :key="mIdx"
              class="px-1 py-0.5 text-xs text-slate-400 bg-white/10 rounded uppercase"
            >
              {{ mod }}
            </kbd>
            <kbd class="px-1 py-0.5 text-xs text-slate-400 bg-white/10 rounded uppercase">
              {{ action.props.shortcut.key }}
            </kbd>
          </div>
          <div v-else-if="idx === 0" class="text-xs text-slate-400 bg-white/10 px-1.5 py-0.5 rounded">
            Enter
          </div>
        </div>
      </div>

      <!-- 底部提示 -->
      <div class="px-3 py-2 border-t border-white/10 text-xs text-slate-400 flex items-center justify-between bg-black/20">
        <span>执行动作: <kbd class="px-1 bg-white/10 rounded">Enter</kbd></span>
        <span>关闭: <kbd class="px-1 bg-white/10 rounded">Esc</kbd></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";
import DeclarativeIcon from "./DeclarativeIcon.vue";

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  actions: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(["close", "trigger"]);

const query = ref("");
const selectedIndex = ref(0);
const searchInputRef = ref(null);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      query.value = "";
      selectedIndex.value = 0;
      nextTick(() => {
        searchInputRef.value?.focus();
      });
    }
  }
);

const filteredActions = computed(() => {
  if (!query.value.trim()) return props.actions;
  const q = query.value.toLowerCase();
  return props.actions.filter((a) => {
    const title = (a.props?.title || "").toLowerCase();
    return title.includes(q);
  });
});

watch(filteredActions, () => {
  selectedIndex.value = 0;
});

function handleKeyDown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filteredActions.value.length > 0) {
      selectedIndex.value = (selectedIndex.value + 1) % filteredActions.value.length;
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filteredActions.value.length > 0) {
      selectedIndex.value =
        (selectedIndex.value - 1 + filteredActions.value.length) % filteredActions.value.length;
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    const action = filteredActions.value[selectedIndex.value];
    if (action) {
      executeAction(action);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

function executeAction(action) {
  emit("trigger", action);
  emit("close");
}
</script>
