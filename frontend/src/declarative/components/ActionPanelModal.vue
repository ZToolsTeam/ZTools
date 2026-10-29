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
      <div class="action-panel-list declarative-scrollbar" role="listbox" aria-label="动作列表">
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
            :class="{ 'is-selected': selectedIndex === idx, 'is-destructive': isDestructiveAction(action) }"
            role="option"
            :aria-selected="selectedIndex === idx"
            @click="executeAction(action)"
            @mousemove="selectAt(idx)"
          >
            <span class="action-panel-marker" aria-hidden="true"></span>
            <template v-if="hasIcons">
              <DeclarativeIcon v-if="action.props?.icon" :icon="action.props.icon" :size="15" class="action-panel-icon" />
              <span v-else class="action-panel-icon-slot" aria-hidden="true"></span>
            </template>
            <span class="action-panel-title">{{ action.props?.title || '未命名动作' }}</span>
            <ShortcutKeys v-if="keyHintOf(action)" :combo="keyHintOf(action)" />
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
import { actionKeyHint, isDestructiveAction } from "../uiText.js";

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
  },
  /** 当前视图类型（List / Detail / Form），决定第 1、2 个动作的 Enter / ⌘Enter 提示 */
  viewType: {
    type: String,
    default: "List"
  }
});

/**
 * 每个动作的键位提示：按它在未过滤动作列表里的原始位置计算（搜索过滤后不会错位），
 * 表单里第 1 个动作是 ⌘Enter（Enter 在多行输入里是换行），子菜单里的动作没有固定键位。
 */
const keyHints = computed(() => {
  const map = new Map();
  let directIndex = 0;
  for (const action of props.actions || []) {
    if (action?._fromSubmenu) {
      map.set(action, actionKeyHint(action, -1, props.viewType));
      continue;
    }
    map.set(action, actionKeyHint(action, directIndex, props.viewType));
    directIndex += 1;
  }
  return map;
});

function keyHintOf(action) {
  return keyHints.value.get(action) || "";
}

const emit = defineEmits(["close", "trigger"]);

const query = ref("");
const selectedIndex = ref(0);
// 选中动作的稳定标识：宿主每次渲染都会传入新的动作数组（世界时钟等每秒刷新），
// 只靠下标或数组引用判断会把用户用方向键选中的项重置回第 1 项
const selectedKey = ref("");

/** 动作稳定标识：类型 + 标题 + 所在分组 + 是否来自子菜单（与 DeclarativeView 展开动作时的去重口径一致） */
function actionKey(action) {
  if (!action) return "";
  return [action.type || "", action.props?.title ?? "", action._sectionTitle ?? "", action._fromSubmenu ? "1" : ""].join("\u0000");
}

function selectAt(idx) {
  const list = filteredActions.value;
  const next = list.length > 0 ? Math.min(Math.max(idx, 0), list.length - 1) : 0;
  selectedIndex.value = next;
  selectedKey.value = actionKey(list[next]);
}
const searchInputRef = ref(null);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      query.value = "";
      selectAt(0);
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
    if (title.includes(q)) return true;
    // 子菜单里的动作也能按子菜单标题搜到（例如搜「数量」找到「快速调节生成数量」下的各项）
    return Boolean(a._fromSubmenu) && String(a._sectionTitle || "").toLowerCase().includes(q);
  });
});

// 只有动作带图标时才留图标列；没有图标的动作用空位对齐，不再用对勾冒充图标
const hasIcons = computed(() => filteredActions.value.some((action) => Boolean(action.props?.icon)));

// 只在面板打开（见上方 visible 监听）或搜索词变化时回到第 1 项；动作数组换引用但选中项仍在时保持选中，
// 选中项消失（被删除 / 标题变化）时停在原位置并夹到有效范围
watch([filteredActions, query], ([list, q], [, prevQ]) => {
  if (q !== prevQ) {
    selectAt(0);
    return;
  }
  const key = selectedKey.value;
  if (key && actionKey(list[selectedIndex.value]) === key) return;
  const idx = key ? list.findIndex((action) => actionKey(action) === key) : -1;
  selectAt(idx >= 0 ? idx : selectedIndex.value);
});

function handleKeyDown(e) {
  // 输入法组字时 Enter / 方向键 / Esc 是给候选框用的（例如用中文搜索动作），不当面板按键
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filteredActions.value.length > 0) {
      selectAt((selectedIndex.value + 1) % filteredActions.value.length);
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filteredActions.value.length > 0) {
      selectAt((selectedIndex.value - 1 + filteredActions.value.length) % filteredActions.value.length);
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    // ⌘Enter / Ctrl+Enter 在底栏是「次动作」，面板里不能把它当 Enter 执行高亮项（可能是破坏性动作）
    if (e.metaKey || e.ctrlKey) return;
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
  box-shadow: var(--rc-marker-glow);
}
.action-panel-icon {
  flex-shrink: 0;
  color: var(--rc-text-muted);
}
.action-panel-item.is-selected .action-panel-icon {
  color: var(--rc-accent-text);
}
/* 危险动作（Action.Style.Destructive）：错误色文字，选中时浅错误色底，不用强调色 */
.action-panel-item.is-destructive,
.action-panel-item.is-destructive .action-panel-icon {
  color: var(--rc-error);
}
.action-panel-item.is-destructive.is-selected {
  background: var(--rc-error-subtle);
}
.action-panel-item.is-destructive.is-selected .action-panel-marker {
  background: var(--rc-error);
  box-shadow: none;
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
