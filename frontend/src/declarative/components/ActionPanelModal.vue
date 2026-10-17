<template>
  <div
    v-if="visible"
    class="action-panel-scrim"
    :class="`is-${placement}`"
    @click.self="emit('close')"
  >
    <div class="action-panel" role="dialog" aria-label="动作" @keydown.stop="handleKeyDown">
      <!-- 搜索框 -->
      <div class="action-panel-search">
        <label for="action-panel-query" class="sr-only">搜索动作</label>
        <input
          id="action-panel-query"
          ref="searchInputRef"
          v-model="query"
          type="text"
          :placeholder="targetTitle ? `搜索「${targetTitle}」的动作` : '搜索动作'"
          class="action-panel-input"
        />
        <ShortcutKeys combo="Ctrl+K" />
      </div>

      <!-- Action 列表 -->
      <div class="action-panel-list declarative-scrollbar">
        <div v-if="filteredActions.length === 0" class="action-panel-empty">无匹配动作</div>

        <template v-for="(action, idx) in filteredActions" :key="idx">
          <div
            v-if="action._sectionTitle && (idx === 0 || filteredActions[idx - 1]._sectionTitle !== action._sectionTitle)"
            class="action-panel-section"
          >
            {{ action._sectionTitle }}
          </div>

          <div
            class="action-panel-item"
            :class="{ 'is-selected': selectedIndex === idx }"
            role="option"
            :aria-selected="selectedIndex === idx"
            @click="executeAction(action)"
            @mousemove="selectedIndex = idx"
          >
            <span class="action-panel-marker" aria-hidden="true"></span>
            <template v-if="hasIcons">
              <DeclarativeIcon v-if="action.props?.icon" :icon="action.props.icon" :size="15" class="action-panel-icon" />
              <span v-else class="action-panel-icon-slot" aria-hidden="true"></span>
            </template>
            <span class="action-panel-title">{{ action.props?.title || '未命名动作' }}</span>
            <ShortcutKeys v-if="actionShortcutCombo(action)" :combo="actionShortcutCombo(action)" />
            <ShortcutKeys v-else-if="idx === 0" combo="Enter" />
          </div>
        </template>
      </div>

      <!-- 底部提示 -->
      <div class="action-panel-foot">
        <span class="action-panel-hint">
          <ShortcutKeys combo="ArrowUp+ArrowDown" /> 选择
          <span class="action-panel-dot">·</span>
          <ShortcutKeys combo="Enter" /> 执行
        </span>
        <span class="action-panel-hint"><ShortcutKeys combo="Escape" /> 关闭</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from "vue";
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import DeclarativeIcon from "./DeclarativeIcon.vue";

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  actions: {
    type: Array,
    default: () => []
  },
  targetTitle: {
    type: String,
    default: ""
  },
  /** center：居中；corner：贴右下角，靠近底栏的「动作」按钮（与设计稿一致） */
  placement: {
    type: String,
    default: "center"
  }
});

const MODIFIER_COMBO = { cmd: "Ctrl", command: "Ctrl", meta: "Ctrl", ctrl: "Ctrl", control: "Ctrl", opt: "Alt", option: "Alt", alt: "Alt", shift: "Shift" };

/** 把插件声明的 { modifiers: ['cmd'], key: 'c' } 转为统一写法 'Ctrl+C'；无法识别时不显示 */
function actionShortcutCombo(action) {
  const shortcut = action?.props?.shortcut;
  if (!shortcut || typeof shortcut.key !== "string" || !shortcut.key.trim()) return "";
  const modifiers = Array.isArray(shortcut.modifiers) ? shortcut.modifiers : [];
  const parts = [];
  for (const mod of modifiers) {
    const name = MODIFIER_COMBO[String(mod).toLowerCase()];
    if (name && !parts.includes(name)) parts.push(name);
  }
  parts.push(shortcut.key.trim());
  return parts.join("+");
}

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

// 只有动作带图标时才留图标列；没有图标的动作用空位对齐，不再用对勾冒充图标
const hasIcons = computed(() => filteredActions.value.some((action) => Boolean(action.props?.icon)));

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

<style scoped>
.action-panel-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--rc-scrim);
}
.action-panel-scrim.is-corner {
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0 14px 54px;
}
.action-panel {
  width: 400px;
  max-width: calc(100vw - 28px);
  max-height: min(500px, calc(100vh - 80px));
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  box-shadow: var(--rc-shadow-lg);
  overflow: hidden;
  animation: action-panel-in 0.14s ease-out;
}
@keyframes action-panel-in {
  from { opacity: 0; transform: translateY(4px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.action-panel-search {
  height: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid var(--rc-border);
}
.action-panel-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font: inherit;
  font-size: 14px;
  color: var(--rc-text-primary);
  caret-color: var(--rc-accent);
}
.action-panel-input::placeholder {
  color: var(--rc-text-faint);
}
.action-panel-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.action-panel-empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--rc-text-muted);
}
.action-panel-section {
  padding: 10px 10px 4px 24px;
  font-size: 12px;
  color: var(--rc-text-faint);
  user-select: none;
}
.action-panel-item {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--rc-text-secondary);
  cursor: pointer;
}
.action-panel-icon-slot {
  width: 15px;
  flex-shrink: 0;
}

.action-panel-item.is-selected {
  background: var(--rc-surface-active);
  color: var(--rc-text-primary);
  font-weight: 500;
}
.action-panel-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}
.action-panel-item.is-selected .action-panel-marker {
  background: var(--rc-accent);
  box-shadow: 0 0 8px rgba(255, 107, 61, 0.55);
}
.action-panel-icon {
  flex-shrink: 0;
  color: var(--rc-text-muted);
}
.action-panel-item.is-selected .action-panel-icon {
  color: var(--rc-accent-text);
}
.action-panel-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.action-panel-foot {
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 16px;
  border-top: 1px solid var(--rc-border);
  font-size: 11px;
  color: var(--rc-text-faint);
}
.action-panel-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.action-panel-dot {
  margin: 0 2px;
}
</style>
