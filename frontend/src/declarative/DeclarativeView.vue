<template>
  <div
    tabindex="0"
    class="declarative-mica-shell flex flex-col h-full w-full rounded-2xl overflow-hidden focus:outline-none relative select-none"
    @keydown="handleGlobalKeyDown"
  >
    <!-- 顶部通用导航头 (显示 navigationTitle 与 返回按钮) -->
    <div
      v-if="hasHeader"
      class="px-4 py-2.5 border-b border-[var(--rc-border)] flex items-center justify-between bg-[var(--rc-surface-subtle)]"
    >
      <div class="flex items-center gap-2">
        <button
          v-if="canGoBack"
          class="p-1 rounded-lg text-[var(--rc-text-muted)] hover:text-[var(--rc-text-primary)] hover:bg-[var(--rc-surface-hover)] transition-colors flex items-center gap-1 text-xs"
          title="后退 (Esc)"
          @click="handleBack"
        >
          <DeclarativeIcon icon="arrow-left" :size="14" />
          <span>返回</span>
        </button>
        <span class="font-medium text-sm text-[var(--rc-text-primary)]">
          {{ navigationTitle }}
        </span>
      </div>

      <div class="text-xs text-[var(--rc-text-muted)] flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-[var(--rc-success)]"></span>
        <span>声明式运行时</span>
      </div>
    </div>

    <!-- 中间视图内容区域 -->
    <div class="flex-1 overflow-hidden relative">
      <!-- 1. List 视图 -->
      <ListRenderer
        v-if="currentDescriptor?.type === 'List'"
        ref="listRendererRef"
        :descriptor="currentDescriptor"
        :initialSnapshot="initialSnapshot"
        :activeActions="activeActions"
        @select="onItemSelected"
        @trigger-primary="triggerPrimaryAction"
        @trigger-action="executeAction"
        @action-panel-change="onActionPanelChange"
        @open-action-panel="openActionPanel"
      />

      <!-- 2. Detail 视图 -->
      <DetailRenderer
        v-else-if="currentDescriptor?.type === 'Detail'"
        ref="detailRendererRef"
        :descriptor="currentDescriptor"
        :actions="activeActions"
        @trigger-action="executeAction"
        @open-action-panel="openActionPanel"
      />

      <!-- 3. Form 视图 -->
      <FormRenderer
        v-else-if="currentDescriptor?.type === 'Form'"
        ref="formRendererRef"
        :descriptor="currentDescriptor"
        :actions="activeActions"
        :canCancel="canGoBack"
        @submit="handleFormSubmit"
        @cancel="handleBack"
        @trigger-action="executeAction"
      />

      <!-- 空状态 -->
      <div
        v-else
        class="flex flex-col items-center justify-center h-full text-[var(--rc-text-muted)] text-sm gap-2"
      >
        <DeclarativeIcon icon="document" :size="32" class="text-[var(--rc-text-muted)]" />
        <span>未识别的声明式视图或视图已卸载</span>
      </div>
    </div>

    <!-- 底部 Fluent / Raycast 风格三段式快捷动作栏 -->
    <div class="px-4 py-2 border-t border-[var(--rc-border)] flex items-center justify-between gap-3 bg-[var(--rc-surface-subtle)] text-xs text-[var(--rc-text-muted)]">
      <!-- 左侧：返回导航与分栏切换 -->
      <div class="flex items-center gap-3 min-w-0">
        <div
          v-if="canGoBack"
          class="flex items-center gap-1 text-[var(--rc-text-muted)] cursor-pointer hover:text-[var(--rc-text-primary)] transition-colors flex-shrink-0"
          title="后退上一级 (Esc)"
          @click="handleBack"
        >
          <span>后退</span>
          <ShortcutKeys combo="Escape" />
        </div>
        <div
          v-else-if="!isPopout"
          class="flex items-center gap-1 text-[var(--rc-text-muted)] cursor-pointer hover:text-[var(--rc-text-primary)] transition-colors flex-shrink-0"
          title="返回工作台 (Esc)"
          @click="emit('exit')"
        >
          <span>返回工作台</span>
          <ShortcutKeys combo="Escape" />
        </div>
        <div
          v-else
          class="flex items-center gap-1.5 text-[var(--rc-success)] font-mono text-[11px] flex-shrink-0"
          title="独立常驻模式下按 Esc 仅清空搜索框，防止误触关闭盯盘窗口"
        >
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--rc-success)]"></span>
          <span>独立常驻防误关 (Esc 仅清过滤)</span>
        </div>

        <div
          v-if="toggleDetailAction"
          class="flex items-center gap-1.5 cursor-pointer hover:text-[var(--rc-text-primary)] transition-colors flex-shrink-0"
          :title="cleanActionTitle(toggleDetailAction.props?.title)"
          @click="executeAction(toggleDetailAction)"
        >
          <span class="text-[var(--rc-text-secondary)]">{{ cleanActionTitle(toggleDetailAction.props?.title) }}</span>
          <ShortcutKeys combo="Ctrl+D" />
        </div>
      </div>

      <!-- 右侧：对齐 Raycast「主动作 (Enter) + 次动作 (Ctrl+Enter) + 动作面板 (Ctrl+K)」三段式直观按钮栏 -->
      <div class="flex items-center gap-2 flex-shrink-0">
        <button
          v-if="primaryAction"
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--rc-accent-subtle)] hover:brightness-110 text-[var(--rc-accent-text)] border border-[var(--rc-border-highlight)] font-medium transition-all cursor-pointer"
          title="执行首要动作 (Enter)"
          @click="executeAction(primaryAction)"
        >
          <span class="truncate max-w-[180px]">{{ cleanActionTitle(primaryAction.props?.title) }}</span>
          <ShortcutKeys combo="Enter" />
        </button>

        <button
          v-if="secondaryAction"
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--rc-surface-hover)] hover:bg-[var(--rc-surface-active)] text-[var(--rc-text-primary)] border border-[var(--rc-border)] transition-all cursor-pointer"
          :title="`执行次要动作 (${secondaryShortcutCombo})`"
          @click="executeAction(secondaryAction)"
        >
          <span class="truncate max-w-[160px]">{{ cleanActionTitle(secondaryAction.props?.title) }}</span>
          <ShortcutKeys :combo="secondaryShortcutCombo" />
        </button>

        <button
          type="button"
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--rc-surface-hover)] hover:bg-[var(--rc-surface-active)] text-[var(--rc-text-secondary)] border border-[var(--rc-border)] transition-colors cursor-pointer"
          @click="toggleActionPanel"
        >
          <span>动作面板{{ activeActions.length > 0 ? ` (${activeActions.length})` : '' }}</span>
          <ShortcutKeys combo="Ctrl+K" />
        </button>
      </div>
    </div>

    <!-- 动作面板弹层 (ActionPanel) -->
    <ActionPanelModal
      :visible="actionPanelVisible"
      :actions="activeActions"
      :target-title="currentSelectedItem?.props?.title || ''"
      placement="corner"
      @close="actionPanelVisible = false"
      @trigger="executeAction"
    />

    <!-- Toast 提示宿主 -->
    <ToastOverlay :toasts="toasts" />
  </div>
</template>

<script setup>
import { ref, computed, watch, provide, onUnmounted } from "vue";
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'

import "./style/declarative-fluent.css";
import DeclarativeIcon from "./components/DeclarativeIcon.vue";
import ListRenderer from "./components/ListRenderer.vue";
import DetailRenderer from "./components/DetailRenderer.vue";
import FormRenderer from "./components/FormRenderer.vue";
import ActionPanelModal from "./components/ActionPanelModal.vue";
import ToastOverlay from "./components/ToastOverlay.vue";
import { useDeclarativeStack } from "./composables/useDeclarativeStack.js";
import { useKeymap, KEYMAP_SCOPES, dispatchKeyEvent } from "@/utils/keymap.js";
import { useUIStore } from "@/stores/ui.js";

const props = defineProps({
  rootComponent: {
    type: [Function, Object],
    default: null
  },
  sessionId: {
    type: String,
    default: null
  },
  remote: {
    type: Boolean,
    default: false
  },
  initialDescriptor: {
    type: Object,
    default: null
  },
  hideRootTitle: {
    type: Boolean,
    default: false
  },
  isPopout: {
    type: Boolean,
    default: false
  },
  initialSnapshot: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(["exit", "action-executed", "native-callback"]);

// 导航栈与全局 Bridge
const {
  stack,
  currentDescriptor,
  toasts,
  showToast,
  push,
  pop,
  clear,
  replaceTopDescriptor
} = useDeclarativeStack(props.rootComponent);

watch(
  () => props.rootComponent,
  (comp) => {
    if (comp) {
      clear();
      push(comp);
    }
  }
);

// 监听外部注入初始描述符或远程推送更新
watch(
  () => props.initialDescriptor,
  (desc) => {
    if (desc) {
      if (stack.value.length === 0) {
        push(desc);
      } else {
        replaceTopDescriptor(desc);
      }
    }
  },
  { immediate: true, deep: true }
);

// 远程会话模式：监听主进程/扩展宿主推送的视图更新
let unlistenRender = null;
if (typeof window !== "undefined" && window.ztools?.on) {
  unlistenRender = window.ztools.on("extension:render", (payload) => {
    if (!payload) return;
    if ((!props.sessionId || payload.sessionId === props.sessionId) && payload.descriptor) {
      if (stack.value.length === 0) {
        push(payload.descriptor);
      } else {
        replaceTopDescriptor(payload.descriptor);
      }
    }
  });
}

onUnmounted(() => {
  if (typeof unlistenRender === "function") {
    unlistenRender();
  }
});

// 元素引用
const listRendererRef = ref(null);
const detailRendererRef = ref(null);
const formRendererRef = ref(null);

// 状态
const actionPanelVisible = ref(false);
const currentSelectedItem = ref(null);

const canGoBack = computed(() => stack.value.length > 1);

const navigationTitle = computed(() => {
  return currentDescriptor.value?.props?.navigationTitle || "";
});

const hasHeader = computed(() => {
  return canGoBack.value || (!props.hideRootTitle && Boolean(navigationTitle.value));
});

// 辅助函数：深度查找 List 描述符里的第一个 List.Item
function findFirstItem(desc) {
  if (!desc || !desc.children) return null;
  for (const child of desc.children) {
    if (child.type === "List.Item") return child;
    if (child.type === "List.Section" && child.children) {
      for (const sub of child.children) {
        if (sub.type === "List.Item") return sub;
      }
    }
  }
  return null;
}

// 解析所有可用的 Actions
const activeActions = computed(() => {
  const desc = currentDescriptor.value;
  if (!desc) return [];

  let panel = null;

  // 1. 如果是 List，优先看当前选中 item 的 actions，再合并 list 级 actions
  let fallbackPanel = null;
  if (desc.type === "List") {
    const item = currentSelectedItem.value || findFirstItem(desc);
    panel = item?.props?.actions || desc.props?.actions;
    if (item?.props?.actions && desc.props?.actions && item.props.actions !== desc.props.actions) {
      fallbackPanel = desc.props.actions;
    }
  } else if (desc.type === "Detail") {
    panel = desc.props?.actions;
  } else if (desc.type === "Form") {
    panel = desc.props?.actions;
  }

  if (!panel && !fallbackPanel) return [];

  // 展开 ActionPanel.Section 与 Action，并保留所属 Section 标题
  const flat = [];
  function extract(node, sectionTitle = "") {
    if (!node) return;
    if (node.type === "ActionPanel") {
      for (const child of node.children || []) {
        extract(child, sectionTitle);
      }
    } else if (node.type === "ActionPanel.Section") {
      const currentTitle = node.props?.title || sectionTitle;
      for (const child of node.children || []) {
        extract(child, currentTitle);
      }
    } else if (node.type && (node.type === "Action" || node.type.startsWith("Action."))) {
      if (!flat.some((existing) => existing.props?.title === node.props?.title && existing.type === node.type)) {
        flat.push({ ...node, _sectionTitle: sectionTitle });
      }
    }
  }

  extract(panel);
  if (fallbackPanel) {
    extract(fallbackPanel, "全局操作");
  }
  return flat;
});

function cleanActionTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 首要 Action (列表第一项动作)
const primaryAction = computed(() => {
  return activeActions.value[0] || null;
});

// 次要 Action (对齐 Raycast 右下角第二顺位动作 Ctrl+Enter)
const secondaryAction = computed(() => {
  return activeActions.value[1] || null;
});

const MODIFIER_COMBO = {
  cmd: "Ctrl",
  command: "Ctrl",
  meta: "Ctrl",
  ctrl: "Ctrl",
  control: "Ctrl",
  opt: "Alt",
  option: "Alt",
  alt: "Alt",
  shift: "Shift"
};

function formatActionShortcut(action) {
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

const secondaryShortcutCombo = computed(() => {
  if (!secondaryAction.value) return "Ctrl+Enter";
  return formatActionShortcut(secondaryAction.value) || "Ctrl+Enter";
});

// 详情切换 Action (例如 Ctrl+D 切换分栏预览)
const toggleDetailAction = computed(() => {
  return activeActions.value.find((act) => {
    const title = act.props?.title || "";
    const key = act.props?.shortcut?.key?.toLowerCase();
    return (
      key === "d" ||
      title.includes("详情预览分栏") ||
      title.includes("Toggle Details") ||
      title.includes("预览分栏")
    );
  }) || null;
});

function onItemSelected(item) {
  currentSelectedItem.value = item;
}

function onActionPanelChange(panel) {
  // item 级改变
}

function toggleActionPanel() {
  actionPanelVisible.value = !actionPanelVisible.value;
}

function openActionPanel() {
  actionPanelVisible.value = true;
}

function handleBack() {
  if (pop()) {
    currentSelectedItem.value = null;
  } else {
    emit("exit");
  }
}

// 执行指定 Action
async function executeAction(action) {
  if (!action) return;
  const { type, props } = action;

  emit("action-executed", { type, props });

  // 远程会话模式：如果存在 sessionId 或处于 remote 模式，派发 nativeCallback 回传给扩展宿主
  if (props?.sessionId || props?.remote) {
    const callbackId = props?.callbackId || action.id || (typeof props?.onAction === "string" ? props.onAction : null);
    emit("native-callback", {
      sessionId: props.sessionId,
      callbackId,
      actionType: type,
      props
    });
    if (props.sessionId && typeof window !== "undefined" && window.ztools?.call) {
      window.ztools.call("extension_callback", {
        sessionId: props.sessionId,
        callbackId: callbackId || "action_trigger",
        args: [{ type, ...props }]
      }).catch((err) => {
        console.warn("[DeclarativeView] Failed to dispatch nativeCallback:", err);
      });
    }
  }

  const electronMethods = typeof window !== "undefined" ? window.__ztoolsElectron?.methods : null;

  try {
    if (type === "Action.CopyToClipboard") {
      const content = String(props?.content ?? "");
      if (electronMethods?.clipboard_copy_text) {
        await electronMethods.clipboard_copy_text({ text: content });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
      }
      props?.onCopy?.(content);
      showToast?.({ title: "已复制到剪贴板", message: content.slice(0, 64), style: "SUCCESS" });
    } else if (type === "Action.Paste") {
      const content = String(props?.content ?? "");
      if (electronMethods?.clipboard_hide_and_paste_text) {
        await electronMethods.clipboard_hide_and_paste_text({ text: content });
      } else if (electronMethods?.clipboard_copy_text) {
        await electronMethods.clipboard_copy_text({ text: content });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
      }
      props?.onPaste?.(content);
      showToast?.({ title: "已粘贴到活动窗口", message: content.slice(0, 64), style: "SUCCESS" });
    } else if (type === "Action.OpenInBrowser") {
      if (props?.url) {
        if (electronMethods?.shell_open_external) {
          await electronMethods.shell_open_external({ url: String(props.url) });
        } else if (typeof window !== "undefined") {
          window.open(props.url, "_blank");
        }
        props?.onOpen?.(props.url);
      }
    } else if (type === "Action.ShowInFinder") {
      const targetPath = props?.path || props?.target;
      if (targetPath && electronMethods?.shell_show_item_in_folder) {
        await electronMethods.shell_show_item_in_folder({ fullPath: String(targetPath) });
      }
      props?.onShow?.(targetPath);
      if (targetPath) {
        showToast?.({ title: "已在文件管理器中定位", message: String(targetPath), style: "SUCCESS" });
      }
    } else if (type === "Action.Open" || type === "Action.OpenWith") {
      const targetPath = props?.target || props?.path;
      if (targetPath && electronMethods?.shell_open_path) {
        await electronMethods.shell_open_path({ fullPath: String(targetPath) });
      }
      props?.onOpen?.(targetPath);
    } else if (type === "Action.Push") {
      if (props?.target) {
        push(props.target);
      }
    } else if (type === "Action.SubmitForm") {
      const values = formRendererRef.value ? formRendererRef.value.getValues() : {};
      if (props?.sessionId && typeof window !== "undefined" && window.ztools?.call) {
        const callbackId = props?.callbackId || "submit";
        window.ztools.call("extension_callback", {
          sessionId: props.sessionId,
          callbackId,
          args: [values]
        }).catch((err) => {
          console.warn("[DeclarativeView] Failed to send form submit callback:", err);
        });
      }
      await props?.onSubmit?.(values);
    } else if (type === "Action") {
      await props?.onAction?.();
    }
  } catch (err) {
    console.error("[DeclarativeView] Error executing action:", err);
  }
}

function findFirstLeafAction(node) {
  if (!node) return null;
  if (node.type && (node.type === "Action" || node.type.startsWith("Action."))) {
    return node;
  }
  for (const child of node.children || []) {
    const found = findFirstLeafAction(child);
    if (found) return found;
  }
  return null;
}

function triggerPrimaryAction(item) {
  if (item && item.props?.actions) {
    const firstAct = findFirstLeafAction(item.props.actions);
    if (firstAct) {
      executeAction(firstAct);
      return;
    }
  }
  if (primaryAction.value) {
    executeAction(primaryAction.value);
  }
}

function handleFormSubmit(values) {
  if (primaryAction.value?.type === "Action.SubmitForm") {
    primaryAction.value.props?.onSubmit?.(values);
  }
}

import { getActivePinia } from "pinia";

let uiStore = null;
try {
  if (getActivePinia()) {
    uiStore = useUIStore();
  }
} catch {
  uiStore = null;
}

// 统一分发器注册声明式舞台按键
useKeymap(KEYMAP_SCOPES.DECLARATIVE, {
  'Ctrl+K': () => {
    toggleActionPanel();
    return true;
  },
  'Ctrl+Enter': () => {
    if (actionPanelVisible.value) return false;
    if (secondaryAction.value) {
      executeAction(secondaryAction.value);
      return true;
    }
    return false;
  },
  'Ctrl+D': () => {
    if (actionPanelVisible.value) return false;
    if (toggleDetailAction.value) {
      executeAction(toggleDetailAction.value);
      return true;
    }
    return false;
  },
  'Escape': () => {
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false;
      return true;
    }
    if (canGoBack.value) {
      handleBack();
      return true;
    }
    if (listRendererRef.value?.hasSearchText?.()) {
      listRendererRef.value.clearSearch();
      return true;
    }
    if (props.isPopout) {
      return true;
    }
    handleBack();
    return true;
  },
  'ArrowDown': (e, { inInput }) => {
    if (actionPanelVisible.value) return false;
    if (currentDescriptor.value?.type === "List") {
      listRendererRef.value?.focusNextItem();
      return true;
    }
    return false;
  },
  'ArrowUp': (e, { inInput }) => {
    if (actionPanelVisible.value) return false;
    if (currentDescriptor.value?.type === "List") {
      listRendererRef.value?.focusPrevItem();
      return true;
    }
    return false;
  },
  'Enter': (e, { inInput }) => {
    if (actionPanelVisible.value) return false;
    if (e.target && e.target.tagName === "TEXTAREA") {
      return false;
    }
    if (primaryAction.value) {
      executeAction(primaryAction.value);
      return true;
    }
    return false;
  },
  'Space': (e, { inInput }) => {
    if (actionPanelVisible.value || inInput) return false;
    const quickLookAction = activeActions.value.find((act) => {
      const sc = act.props?.shortcut;
      if (sc && (sc.key?.toLowerCase() === "space" || sc === "space")) {
        return true;
      }
      return act.props?.title?.includes("Quick Look") || act.props?.title?.includes("即时预览");
    });
    if (quickLookAction) {
      executeAction(quickLookAction);
      return true;
    }
    return false;
  }
});

// 动态联动主界面底栏首要动作
watch(
  primaryAction,
  (act) => {
    if (!uiStore) return;
    if (act) {
      uiStore.setDeclarativePrimaryAction({
        title: act.props?.title || (act.type === 'Action.SubmitForm' ? '提交' : '执行'),
        type: act.type
      });
    } else {
      uiStore.clearDeclarativePrimaryAction();
    }
  },
  { immediate: true }
);

onUnmounted(() => {
  if (uiStore) {
    uiStore.clearDeclarativePrimaryAction();
  }
});

function normalizeShortcutKeyName(k) {
  const lower = String(k || "").trim().toLowerCase();
  if (lower === "return") return "enter";
  if (lower === "del") return "delete";
  if (lower === "up") return "arrowup";
  if (lower === "down") return "arrowdown";
  if (lower === "left") return "arrowleft";
  if (lower === "right") return "arrowright";
  return lower;
}

function matchActionShortcut(e, shortcut) {
  if (!shortcut || typeof shortcut.key !== "string" || !shortcut.key.trim()) return false;
  const mods = Array.isArray(shortcut.modifiers)
    ? shortcut.modifiers.map((m) => String(m).toLowerCase())
    : [];
  const wantCtrl = mods.some((m) => m === "cmd" || m === "command" || m === "meta" || m === "ctrl" || m === "control");
  const wantAlt = mods.some((m) => m === "opt" || m === "option" || m === "alt");
  const wantShift = mods.some((m) => m === "shift");

  const hasCtrl = Boolean(e.ctrlKey || e.metaKey);
  const hasAlt = Boolean(e.altKey);
  const hasShift = Boolean(e.shiftKey);

  if (wantCtrl !== hasCtrl || wantAlt !== hasAlt || wantShift !== hasShift) {
    return false;
  }
  const targetKey = normalizeShortcutKeyName(shortcut.key);
  const eventKey = normalizeShortcutKeyName(e.key);
  return targetKey === eventKey;
}

// 根节点键盘事件统一委托至调度器，并支持免开面板直接触发 ActionPanel 中声明的快捷键
function handleGlobalKeyDown(e) {
  if (!actionPanelVisible.value && (e.ctrlKey || e.metaKey || e.altKey)) {
    const keyLower = String(e.key || "").toLowerCase();
    // 保留标准输入框内全选/复制/粘贴/剪切给原生输入框，除非当前不在文本输入或按的是其它组合键
    const inTextInput =
      e.target &&
      (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") &&
      Boolean(e.target.value);
    const isNativeEditCombo =
      !e.shiftKey && !e.altKey && (keyLower === "a" || keyLower === "v" || keyLower === "x" || keyLower === "z");

    if (!(inTextInput && isNativeEditCombo)) {
      const matched = activeActions.value.find((act) => matchActionShortcut(e, act.props?.shortcut));
      if (matched) {
        e.preventDefault();
        e.stopPropagation();
        executeAction(matched);
        return;
      }
    }
  }
  dispatchKeyEvent(e);
}

function getViewStateSnapshot() {
  return listRendererRef.value?.getViewStateSnapshot?.() || {};
}

defineExpose({
  push,
  pop,
  getStack: () => stack.value,
  getCurrentDescriptor: () => currentDescriptor.value,
  executeAction,
  triggerPrimaryAction,
  getViewStateSnapshot
});
</script>
