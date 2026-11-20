<template>
  <div
    v-if="visible"
    class="action-panel-scrim"
    :class="`is-${placement}`"
    @click.self="emit('close')"
  >
    <div ref="panelRef" class="action-panel" role="dialog" aria-modal="true" :aria-label="t('declarative.actionPanel.dialogLabel')" @keydown.stop="handleKeyDown">
      <!-- 搜索框 -->
      <div class="action-panel-search">
        <label for="action-panel-query" class="sr-only">{{ t('declarative.actionPanel.searchLabel') }}</label>
        <input
          id="action-panel-query"
          ref="searchInputRef"
          v-model="query"
          type="text"
          :placeholder="targetTitle ? t('declarative.actionPanel.searchTargetPlaceholder', { target: targetTitle }) : t('declarative.actionPanel.searchPlaceholder')"
          class="action-panel-input"
        />
        <ShortcutKeys combo="Ctrl+K" />
      </div>

      <!-- Action 列表 -->
      <div class="action-panel-list declarative-scrollbar" role="listbox" :aria-label="t('declarative.actionPanel.listLabel')">
        <div v-if="filteredActions.length === 0" class="action-panel-empty">{{ t('declarative.actionPanel.empty') }}</div>

        <template v-for="(action, idx) in filteredActions" :key="idx">
          <div
            v-if="action._sectionTitle && (idx === 0 || filteredActions[idx - 1]._sectionTitle !== action._sectionTitle)"
            class="action-panel-section"
          >
            {{ action._sectionTitle }}
          </div>

          <div
            :ref="el => setItemRef(idx, el)"
            class="action-panel-item"
            :class="{ 'is-selected': selectedIndex === idx, 'is-destructive': isDestructiveAction(action) }"
            role="option"
            :aria-selected="selectedIndex === idx"
            @click="executeAction(action)"
            @mousemove="onItemMouseMove($event, idx)"
          >
            <span class="action-panel-marker" aria-hidden="true"></span>
            <template v-if="hasIcons">
              <DeclarativeIcon v-if="action.props?.icon" :icon="action.props.icon" :size="15" class="action-panel-icon" />
              <span v-else class="action-panel-icon-slot" aria-hidden="true"></span>
            </template>
            <span class="action-panel-title">{{ resolveActionTitle(action) }}</span>
            <ShortcutKeys v-if="keyHintOf(action)" :combo="keyHintOf(action)" />
          </div>
        </template>
      </div>

      <!-- 底部提示 -->
      <div class="action-panel-foot">
        <span class="action-panel-hint">
          <ShortcutKeys combo="ArrowUp+ArrowDown" /> {{ t('declarative.actionPanel.select') }}
          <span class="action-panel-dot">·</span>
          <ShortcutKeys combo="Enter" /> {{ t('declarative.actionPanel.execute') }}
        </span>
        <span class="action-panel-hint"><ShortcutKeys combo="Escape" /> {{ t('declarative.actionPanel.close') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import DeclarativeIcon from "./DeclarativeIcon.vue";
import { isDestructiveAction, resolveActionTitle } from "../uiText.js";
import {
  registerKeyHandler,
  KEYMAP_SCOPES,
  isComposingEvent,
  normalizeEventKeyCombo
} from "@/utils/keymap.js";
import { resolveActionKeyBindings, normalizeEventShortcutKey } from "@/utils/actionKeyBindings.js";
import { useAppI18n } from "@/i18n";

const { t } = useAppI18n();

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
  },
  /** 可选自定义保留键集合；默认走声明式插件保留热键集，宿主面板可按需覆写 */
  reservedCombos: {
    type: Object,
    default: undefined
  }
});

/**
 * 统一「所见即所按」键位解析：保证动作面板键帽与视图底栏完全一致、去除重复与保留冲突徽标。
 */
const resolvedBindings = computed(() =>
  resolveActionKeyBindings(props.actions || [], {
    viewType: props.viewType,
    ...(props.reservedCombos !== undefined ? { reservedCombos: props.reservedCombos } : {})
  })
);

function keyHintOf(action) {
  return resolvedBindings.value.hintOf(action);
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

const itemRefs = new Map();
function setItemRef(idx, el) {
  if (el) {
    itemRefs.set(idx, el);
  } else {
    itemRefs.delete(idx);
  }
}

// 防止列表滚动重绘触发同屏幕坐标的合成 mousemove 事件抢走键盘选中高亮
let lastPointerPos = { x: null, y: null };
let lockedPointerPos = null;

function lockPointerAtCurrentPos() {
  if (lastPointerPos.x !== null && lastPointerPos.y !== null) {
    lockedPointerPos = { x: lastPointerPos.x, y: lastPointerPos.y };
  }
}

function onItemMouseMove(event, idx) {
  const sx = typeof event?.screenX === "number" ? event.screenX : 0;
  const sy = typeof event?.screenY === "number" ? event.screenY : 0;
  if (
    lockedPointerPos !== null &&
    sx === lockedPointerPos.x &&
    sy === lockedPointerPos.y
  ) {
    return;
  }
  lastPointerPos = { x: sx, y: sy };
  lockedPointerPos = null;
  selectAt(idx);
}

const filteredActions = computed(() => {
  if (!query.value.trim()) return props.actions;
  const q = query.value.toLowerCase();
  return props.actions.filter((a) => {
    const title = resolveActionTitle(a).toLowerCase();
    if (title.includes(q)) return true;
    // 子菜单里的动作也能按子菜单标题搜到（例如搜「数量」找到「快速调节生成数量」下的各项）
    return Boolean(a._fromSubmenu) && String(a._sectionTitle || "").toLowerCase().includes(q);
  });
});

// 只有动作带图标时才留图标列；没有图标的动作用空位对齐，不再用对勾冒充图标
const hasIcons = computed(() => filteredActions.value.some((action) => Boolean(action.props?.icon)));

function selectAt(idx) {
  const list = filteredActions.value;
  const next = list.length > 0 ? Math.min(Math.max(idx, 0), list.length - 1) : 0;
  selectedIndex.value = next;
  selectedKey.value = actionKey(list[next]);
  if (list.length > 0) {
    nextTick(() => {
      itemRefs.get(next)?.scrollIntoView?.({ block: "nearest" });
    });
  }
}
const panelRef = ref(null);
const searchInputRef = ref(null);

// 记录已处理的事件对象，防止窗口捕获阶段 keymap 与面板根节点 @keydown 重复执行两次
const handledEvents = new WeakSet();

function isPanelTextField(el) {
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return (
    tag === "TEXTAREA" ||
    (tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(String(el.type || "").toLowerCase()))
  );
}

function hasInputSelection(el) {
  try {
    return typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd;
  } catch {
    return false;
  }
}

/** 获取面板内可聚焦元素，实现模态 Tab / Shift+Tab 焦点环 */
function getPanelFocusableElements() {
  const root = panelRef.value;
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(
    root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
}

function handlePanelTab(e) {
  const focusables = getPanelFocusableElements();
  if (focusables.length === 0) {
    searchInputRef.value?.focus?.();
    return;
  }
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const idx = active ? focusables.indexOf(active) : -1;
  const nextIdx =
    idx === -1
      ? e.shiftKey
        ? focusables.length - 1
        : 0
      : (idx + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
  focusables[nextIdx]?.focus?.();
}

/**
 * 判断面板搜索框内的输入/原生编辑冲突：
 * - 无修饰单键：单字符和空格保留给搜索输入；框非空时 Delete/Backspace/方向键保留给文本编辑；
 * - 带 Ctrl/⌘ 组合键：有选区时保留复制/剪切；框非空时保留全选/粘贴/撤销/重做/按词删，其余或空框直接允许命中动作快捷键。
 */
function isPanelInputEditConflict(e) {
  const target = e?.target;
  const inPanelInput = isPanelTextField(target) || (searchInputRef.value && target === searchInputRef.value);
  if (!inPanelInput) return false;

  const hasModifier = Boolean(e.ctrlKey || e.metaKey || e.altKey);
  const hasValue = Boolean(target?.value);
  const key = normalizeEventShortcutKey(e);
  const keyLower = key.toLowerCase();

  if (!hasModifier) {
    if (key === "Space" || (typeof e.key === "string" && e.key.length === 1)) return true;
    if (hasValue && ["Delete", "Backspace", "ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
      return true;
    }
    return false;
  }

  if (e.altKey) return false;
  if (!e.shiftKey) {
    if (keyLower === "c" || keyLower === "x") return hasInputSelection(target);
    if (["a", "v", "z", "y", "backspace", "delete"].includes(keyLower)) return hasValue;
    return false;
  }
  return keyLower === "z" && hasValue;
}

function matchVisibleShortcutAction(e, list) {
  const matched = resolvedBindings.value.matchEvent(e);
  if (!matched || !list.includes(matched)) return null;
  return matched;
}

function processPanelKeyEvent(e, precomputedCombo) {
  if (!props.visible || !e) return false;
  // 输入法组字时 Enter / 方向键 / Esc 是给候选框用的（例如用中文搜索动作），不当面板按键
  if (isComposingEvent(e)) return false;
  if (handledEvents.has(e)) return true;

  const combo = precomputedCombo ?? normalizeEventKeyCombo(e);
  if (combo === "Ctrl+K") {
    handledEvents.add(e);
    emit("close");
    return true;
  }
  if (e.key === "Escape" || e.key === "Esc") {
    handledEvents.add(e);
    emit("close");
    return true;
  }
  if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    handledEvents.add(e);
    handlePanelTab(e);
    return true;
  }

  const list = filteredActions.value;
  const len = list.length;
  const inSearchWithText =
    Boolean(e.target?.value) &&
    (isPanelTextField(e.target) || (searchInputRef.value && e.target === searchInputRef.value));

  if (e.key === "ArrowDown") {
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt((selectedIndex.value + 1) % len);
    }
    return true;
  }
  if (e.key === "ArrowUp") {
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt((selectedIndex.value - 1 + len) % len);
    }
    return true;
  }
  if (e.key === "Home" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // 搜索框内有文字时放行 Home 让光标回到行首，不跳转到动作列表首项
    if (inSearchWithText) return false;
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt(0);
    }
    return true;
  }
  if (e.key === "End" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // 搜索框内有文字时放行 End 让光标移至行尾，不跳转到动作列表末项
    if (inSearchWithText) return false;
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt(len - 1);
    }
    return true;
  }
  if (e.key === "PageDown") {
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt(Math.min(selectedIndex.value + 6, len - 1));
    }
    return true;
  }
  if (e.key === "PageUp") {
    handledEvents.add(e);
    if (len > 0) {
      lockPointerAtCurrentPos();
      selectAt(Math.max(selectedIndex.value - 6, 0));
    }
    return true;
  }
  if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
    handledEvents.add(e);
    if (e.metaKey || e.ctrlKey) {
      // 显式绑定了 Ctrl+Enter 的动作允许在面板内按 Ctrl+Enter 直达；无显式绑定时不误把 Ctrl+Enter 当成 Enter 执行高亮项
      const explicitCtrlEnter = matchVisibleShortcutAction(e, list);
      if (explicitCtrlEnter) {
        executeAction(explicitCtrlEnter);
      }
      return true;
    }
    const action = list[selectedIndex.value];
    if (action) {
      executeAction(action);
    }
    return true;
  }

  // 在面板打开态支持直接按列表内任一动作的显式快捷键立即触发并关闭面板
  if (!isPanelInputEditConflict(e)) {
    const matched = matchVisibleShortcutAction(e, list);
    if (matched) {
      handledEvents.add(e);
      executeAction(matched);
      return true;
    }
  }
  return false;
}

// 注册 ACTION_PANEL 模态作用域处理器，并紧接在 immediate watch 中按 visible 同步控制激活/停用
const unregisterKeymap = registerKeyHandler(
  KEYMAP_SCOPES.ACTION_PANEL,
  (e, meta) => processPanelKeyEvent(e, meta?.combo),
  { modal: true }
);

watch(
  () => props.visible,
  (val) => {
    if (val) {
      lastPointerPos = { x: null, y: null };
      lockedPointerPos = null;
      unregisterKeymap.activate();
      query.value = "";
      selectAt(0);
      nextTick(() => {
        searchInputRef.value?.focus();
      });
    } else {
      unregisterKeymap.deactivate();
      itemRefs.clear();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  unregisterKeymap();
  itemRefs.clear();
});

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
  if (processPanelKeyEvent(e)) {
    e.preventDefault();
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
  border-radius: var(--rc-radius-xl);
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
  font-size: var(--rc-fs-emph);
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
  font-size: var(--rc-fs-body);
  color: var(--rc-text-muted);
}
.action-panel-section {
  padding: 10px 10px 4px 24px;
  font-size: var(--rc-fs-small);
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
  border-radius: var(--rc-radius-md);
  font-size: var(--rc-fs-body);
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
  border-radius: var(--rc-marker-radius);
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
  font-size: var(--rc-fs-caption);
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
