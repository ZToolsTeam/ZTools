<template>
  <div
    ref="rootRef"
    tabindex="0"
    data-declarative-root
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
        :key="viewKey"
        ref="listRendererRef"
        :descriptor="currentDescriptor"
        :initialSnapshot="listInitialSnapshot"
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
        :key="viewKey"
        ref="detailRendererRef"
        :descriptor="currentDescriptor"
        :actions="activeActions"
        @trigger-action="executeAction"
        @open-action-panel="openActionPanel"
      />

      <!-- 3. Form 视图 -->
      <FormRenderer
        v-else-if="currentDescriptor?.type === 'Form'"
        :key="viewKey"
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
          :title="`执行首要动作 (${primaryShortcutCombo})`"
          @click="executeAction(primaryAction)"
        >
          <span class="truncate max-w-[180px]">{{ cleanActionTitle(primaryAction.props?.title) }}</span>
          <ShortcutKeys :combo="primaryShortcutCombo" />
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
      :target-title="panelTargetTitle"
      placement="corner"
      @close="closeActionPanel"
      @trigger="executeAction"
    />

    <!-- Toast 提示宿主 -->
    <ToastOverlay :toasts="toasts" />
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'

import "./style/declarative-fluent.css";
import DeclarativeIcon from "./components/DeclarativeIcon.vue";
import ListRenderer from "./components/ListRenderer.vue";
import DetailRenderer from "./components/DetailRenderer.vue";
import FormRenderer from "./components/FormRenderer.vue";
import ActionPanelModal from "./components/ActionPanelModal.vue";
import ToastOverlay from "./components/ToastOverlay.vue";
import { getHostMethods } from "./hostMethods.js";
import { useDeclarativeStack, assertClipboardText, hasOpenConfirm } from "./composables/useDeclarativeStack.js";
import { useKeymap, registerKeyHandler, KEYMAP_SCOPES, dispatchKeyEvent, isComposingEvent } from "@/utils/keymap.js";
import { isMacOS } from "@/utils/platform.js";
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
  },
  // 独立窗口交接来的 usePopoutState 初值（只在首次挂载根页面时生效）
  initialPopoutState: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(["exit", "action-executed", "native-callback"]);

// 元素引用
const rootRef = ref(null);
const listRendererRef = ref(null);
const detailRendererRef = ref(null);
const formRendererRef = ref(null);

// 导航栈与全局 Bridge
const {
  stack,
  currentDescriptor,
  toasts,
  showToast,
  push,
  pop,
  clear,
  replaceTopDescriptor,
  collectRootPopoutState
} = useDeclarativeStack(props.rootComponent, {
  handoffSeed: props.initialPopoutState,
  // 推入新页面前记下当前列表的搜索词与选中项，返回时原样恢复
  captureViewState: () => (currentDescriptor.value?.type === "List" ? listRendererRef.value?.getViewStateSnapshot?.() || null : null),
  // 站内确认框关闭后把焦点还给当前视图，否则快捷键与打字全部失效
  onOverlayClosed: () => scheduleFocusRestore()
});

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

// 状态
const actionPanelVisible = ref(false);
const currentSelectedItem = ref(null);
// 右键某一行打开动作面板时，面板展示该行的动作（布局二左栏条目不参与底栏选中）
const actionPanelTarget = ref(null);

const canGoBack = computed(() => stack.value.length > 1);

// 每一层页面各用一个渲染组件实例：List → List 推入时不会沿用上一层的搜索词、选中项与表单值
const viewKey = computed(() => `level-${stack.value.length}`);

// 返回到上一层列表时恢复推入前的搜索词与选中项（只恢复界面，不回调插件，插件自身状态并未改变）
const listInitialSnapshot = computed(() => {
  const top = stack.value[stack.value.length - 1];
  if (top?.savedViewState) return top.savedViewState;
  // 外部传入的快照（独立窗口接力）只属于根页面，推入的下一层列表不能再套用
  return stack.value.length <= 1 ? props.initialSnapshot : null;
});

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

function getSubListItems(desc) {
  const sl = desc?.props?.subList;
  const data = sl ? (sl.props || sl) : null;
  return Array.isArray(data?.items) ? data.items : null;
}

function itemKey(it) {
  if (!it) return "";
  return String(it.id ?? it.props?.id ?? it.key ?? it.props?.title ?? "");
}

/** 在当前描述符里找回某个条目：同一对象直接返回，否则按 key 找新节点；已不在列表中返回 null */
function resolveItemInDescriptor(desc, item) {
  if (!desc || !item) return null;
  const candidates = [];
  for (const child of desc.children || []) {
    if (child.type === "List.Item") candidates.push(child);
    else if (child.type === "List.Section") {
      for (const sub of child.children || []) {
        if (sub.type === "List.Item") candidates.push(sub);
      }
    }
  }
  for (const sub of getSubListItems(desc) || []) candidates.push(sub);
  if (candidates.includes(item)) return item;
  const key = itemKey(item);
  if (!key) return null;
  return candidates.find((it) => itemKey(it) === key) || null;
}

const resolvedSelectedItem = computed(() => {
  const desc = currentDescriptor.value;
  if (!desc || desc.type !== "List") return null;
  return resolveItemInDescriptor(desc, currentSelectedItem.value);
});

// 解析所有可用的 Actions
const activeActions = computed(() => {
  const desc = currentDescriptor.value;
  if (!desc) return [];

  let panel = null;

  // 1. 如果是 List，优先看当前选中 item 的 actions，再合并 list 级 actions
  let fallbackPanel = null;
  if (desc.type === "List") {
    const panelTarget = actionPanelVisible.value ? resolveItemInDescriptor(desc, actionPanelTarget.value) : null;
    let item = panelTarget || resolvedSelectedItem.value;
    // 选中项已不在列表里（过滤为空等）：有右栏子列表时只回退到 List 级动作，不能落到看不见的左栏条目上
    if (!item && !getSubListItems(desc)) item = findFirstItem(desc);
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

  // 展开 ActionPanel.Section、ActionPanel.Submenu 与 Action，并保留所属 Section 标题；
  // 子菜单里的动作排在最后，且不参与 Enter / ⌘Enter 主次动作映射
  const flat = [];
  const submenuFlat = [];
  const seen = new Set();
  function add(list, node, sectionTitle, fromSubmenu) {
    const dedupeKey = `${node.type}\u0000${node.props?.title ?? ""}\u0000${sectionTitle}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    list.push(fromSubmenu ? { ...node, _sectionTitle: sectionTitle, _fromSubmenu: true } : { ...node, _sectionTitle: sectionTitle });
  }
  function extract(node, sectionTitle = "", fromSubmenu = false) {
    if (!node) return;
    if (node.type === "ActionPanel") {
      for (const child of node.children || []) {
        extract(child, sectionTitle, fromSubmenu);
      }
    } else if (node.type === "ActionPanel.Section") {
      const currentTitle = node.props?.title || sectionTitle;
      for (const child of node.children || []) {
        extract(child, currentTitle, fromSubmenu);
      }
    } else if (node.type === "ActionPanel.Submenu") {
      const submenuTitle = node.props?.title || sectionTitle;
      for (const child of node.children || []) {
        extract(child, submenuTitle, true);
      }
    } else if (node.type && (node.type === "Action" || node.type.startsWith("Action."))) {
      add(fromSubmenu ? submenuFlat : flat, node, sectionTitle, fromSubmenu);
    } else if (node.type && node.type.startsWith("ActionPanel.")) {
      console.warn("[DeclarativeView] 不支持的动作面板节点类型:", node.type);
    }
  }

  extract(panel);
  if (fallbackPanel) {
    extract(fallbackPanel, "全局操作");
  }
  return [...flat, ...submenuFlat];
});

function cleanActionTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const isFormView = computed(() => currentDescriptor.value?.type === "Form");

// 能映射到 Enter / ⌘Enter 的动作（子菜单里的动作只在 ⌘K 面板中出现）
const directActions = computed(() => activeActions.value.filter((act) => !act._fromSubmenu));

// 首要 Action (列表第一项动作)
const primaryAction = computed(() => {
  return directActions.value[0] || null;
});

// 次要 Action (对齐 Raycast 右下角第二顺位动作 Ctrl+Enter)；表单里 ⌘Enter 用于提交，第 2 个动作只进动作面板
const secondaryAction = computed(() => {
  if (isFormView.value) return null;
  return directActions.value[1] || null;
});

const primaryShortcutCombo = computed(() => (isFormView.value ? "Ctrl+Enter" : "Enter"));

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

const panelTargetTitle = computed(() => {
  const desc = currentDescriptor.value;
  const target = (actionPanelVisible.value && resolveItemInDescriptor(desc, actionPanelTarget.value)) || resolvedSelectedItem.value;
  return target?.props?.title ? String(target.props.title) : "";
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
  currentSelectedItem.value = item || null;
}

function onActionPanelChange(panel) {
  // item 级改变
}

function closeActionPanel() {
  actionPanelVisible.value = false;
}

function toggleActionPanel() {
  if (actionPanelVisible.value) {
    closeActionPanel();
    return;
  }
  actionPanelTarget.value = null;
  actionPanelVisible.value = true;
}

function openActionPanel(target) {
  actionPanelTarget.value = target && typeof target === "object" && typeof target.type === "string" ? target : null;
  actionPanelVisible.value = true;
}

/** 把焦点还给当前视图：列表聚焦搜索框，表单聚焦首个输入框，详情聚焦根节点 */
function restoreViewFocus() {
  if (actionPanelVisible.value) return;
  if (typeof document === "undefined") return;
  // 动作里刚弹出了确认框：焦点归确认框，关闭后再回焦
  if (hasOpenConfirm()) return;
  const root = rootRef.value;
  if (!root || !root.isConnected) return;
  const active = document.activeElement;
  // 焦点仍在当前视图里的有效元素上（例如用户正在操作下拉框），不抢焦点
  if (active && active !== document.body && active !== root && root.contains(active)) return;
  const type = currentDescriptor.value?.type;
  if (type === "List" && listRendererRef.value?.focusSearch) {
    listRendererRef.value.focusSearch();
  } else if (type === "Form" && formRendererRef.value?.focusFirstField?.()) {
    // 已聚焦首个输入框
  } else if (typeof root.focus === "function") {
    root.focus({ preventScroll: true });
  }
}

function scheduleFocusRestore() {
  nextTick(() => restoreViewFocus());
}

watch(actionPanelVisible, (visible, wasVisible) => {
  if (!visible) actionPanelTarget.value = null;
  if (wasVisible && !visible) scheduleFocusRestore();
});

watch(() => stack.value.length, () => {
  actionPanelVisible.value = false;
  scheduleFocusRestore();
});

function handleBack() {
  if (pop()) {
    currentSelectedItem.value = null;
  } else {
    emit("exit");
  }
}

function failureMessage(err) {
  const message = err && typeof err.message === "string" ? err.message.trim() : "";
  return message || "未知错误";
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

  const electronMethods = getHostMethods();

  try {
    if (type === "Action.CopyToClipboard") {
      const content = assertClipboardText(props?.content);
      if (electronMethods?.clipboard_copy_text) {
        await electronMethods.clipboard_copy_text({ text: content });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(content);
      } else {
        throw Object.assign(new Error("当前环境不支持写入剪贴板"), { code: "NOT_SUPPORTED" });
      }
      props?.onCopy?.(content);
      showToast?.({ title: "已复制到剪贴板", message: content.slice(0, 64), style: "SUCCESS" });
    } else if (type === "Action.Paste") {
      const content = assertClipboardText(props?.content);
      if (electronMethods?.clipboard_hide_and_paste_text) {
        await electronMethods.clipboard_hide_and_paste_text({ text: content });
      } else {
        throw Object.assign(new Error("当前系统不支持粘贴到前台应用"), { code: "NOT_SUPPORTED" });
      }
      props?.onPaste?.(content);
      showToast?.({ title: "已发送粘贴请求", message: content.slice(0, 64), style: "SUCCESS" });
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
    // 失败一律如实提示，不能让用户以为操作已经成功
    showToast?.({
      title: type === "Action.Paste" ? "粘贴失败" : "操作失败",
      message: failureMessage(err),
      style: "FAILURE"
    });
  }
}

function findFirstLeafAction(node) {
  if (!node) return null;
  if (node.type && (node.type === "Action" || node.type.startsWith("Action."))) {
    return node;
  }
  for (const child of node.children || []) {
    if (child?.type === "ActionPanel.Submenu") continue;
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

// 表单内联主按钮与键盘 Enter / ⌘Enter 走同一条路径：SubmitForm 带表单值提交，其它动作直接执行
function handleFormSubmit() {
  if (primaryAction.value) {
    executeAction(primaryAction.value);
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

function normalizeShortcutKeyName(k) {
  const lower = String(k || "").trim().toLowerCase();
  if (lower === "return") return "enter";
  if (lower === "del") return "delete";
  if (lower === "up") return "arrowup";
  if (lower === "down") return "arrowdown";
  if (lower === "left") return "arrowleft";
  if (lower === "right") return "arrowright";
  if (lower === " " || lower === "spacebar") return "space";
  return lower;
}

/**
 * 插件动作快捷键匹配。cmd / ctrl 声明在 macOS 上只对应 ⌘（metaKey），⌃ 不再误触；
 * Windows 上只对应 Ctrl（ctrlKey）。
 */
function matchActionShortcut(e, shortcut) {
  if (!shortcut || typeof shortcut.key !== "string" || !shortcut.key.trim()) return false;
  const mods = Array.isArray(shortcut.modifiers)
    ? shortcut.modifiers.map((m) => String(m).toLowerCase())
    : [];
  const wantPrimary = mods.some((m) => m === "cmd" || m === "command" || m === "meta" || m === "ctrl" || m === "control");
  const wantAlt = mods.some((m) => m === "opt" || m === "option" || m === "alt");
  const wantShift = mods.some((m) => m === "shift");

  const mac = isMacOS();
  const hasPrimary = Boolean(mac ? e.metaKey : e.ctrlKey);
  const hasOther = Boolean(mac ? e.ctrlKey : e.metaKey);
  const hasAlt = Boolean(e.altKey);
  const hasShift = Boolean(e.shiftKey);

  if (hasOther || wantPrimary !== hasPrimary || wantAlt !== hasAlt || wantShift !== hasShift) {
    return false;
  }
  const targetKey = normalizeShortcutKeyName(shortcut.key);
  const eventKey = normalizeShortcutKeyName(e.key);
  return targetKey === eventKey;
}

function isTextField(el) {
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "TEXTAREA" || (tag === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(String(el.type || "").toLowerCase()));
}

function hasTextSelection(el) {
  try {
    return typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd;
  } catch {
    return false;
  }
}

/** 输入框里的原生编辑组合键（全选 / 复制 / 粘贴 / 剪切 / 撤销 / 重做）保留给输入框本身 */
function isNativeEditCombo(e) {
  const target = e.target;
  if (!isTextField(target) || e.altKey) return false;
  const keyLower = String(e.key || "").toLowerCase();
  const hasValue = Boolean(target.value);
  if (!e.shiftKey) {
    if (keyLower === "c" || keyLower === "x") return hasTextSelection(target);
    if (keyLower === "a" || keyLower === "v" || keyLower === "z" || keyLower === "y") return hasValue;
    return false;
  }
  // ⌘⇧Z 重做
  return keyLower === "z" && hasValue;
}

/** 事件是否属于本视图：目标在本视图根节点内，或焦点已丢到 body 上 */
function isEventForThisView(e) {
  const root = rootRef.value;
  const target = e?.target;
  if (!root || !target || typeof document === "undefined") return true;
  if (target === document.body || target === document.documentElement || target === document) return true;
  if (typeof target.closest === "function" && target.closest("[data-declarative-root]")) {
    return root.contains(target);
  }
  return false;
}

/** 免开面板直接触发动作快捷键；在窗口级 keymap 中匹配，焦点落在 body 上也能命中 */
function handleActionShortcut(e) {
  if (actionPanelVisible.value) return false;
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return false;
  if (!isEventForThisView(e)) return false;
  if (isNativeEditCombo(e)) return false;
  const matched = activeActions.value.find((act) => matchActionShortcut(e, act.props?.shortcut));
  if (!matched) return false;
  executeAction(matched);
  return true;
}

// 先注册动作快捷键处理器、再注册键位表：同一作用域后注册的先执行，⌘K / ⌘Enter 等固定键位仍然优先
const unregisterActionShortcuts = registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, handleActionShortcut);
onUnmounted(() => unregisterActionShortcuts());

function currentListHasCheckableTarget() {
  const item = resolvedSelectedItem.value;
  return item && item.props?.checkable && typeof (item.props.onCheckChange || item.props.onToggleCheck) === "function" ? item : null;
}

// 统一分发器注册声明式舞台按键
useKeymap(KEYMAP_SCOPES.DECLARATIVE, {
  'Ctrl+K': () => {
    toggleActionPanel();
    return true;
  },
  'Ctrl+Enter': () => {
    if (actionPanelVisible.value) return false;
    // 表单：⌘Enter 提交（textarea 内 Enter 是换行，这是唯一的键盘保存方式）
    if (isFormView.value) {
      if (primaryAction.value) {
        executeAction(primaryAction.value);
        return true;
      }
      return false;
    }
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
      closeActionPanel();
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
  // 布局二：焦点不在输入框时 ← / → 切换左栏导航与右栏明细（搜索框里由 ListRenderer 按光标位置处理）
  'ArrowLeft': (e, { inInput }) => {
    if (actionPanelVisible.value || inInput || currentDescriptor.value?.type !== "List") return false;
    return listRendererRef.value?.setActivePane?.("nav") === true;
  },
  'ArrowRight': (e, { inInput }) => {
    if (actionPanelVisible.value || inInput || currentDescriptor.value?.type !== "List") return false;
    return listRendererRef.value?.setActivePane?.("sub") === true;
  },
  // 焦点不在输入框（例如刚点过列表行）时直接打字：把焦点交回搜索框，字符照常输入进去
  onKeyDown: (e, { inInput }) => {
    if (inInput || actionPanelVisible.value) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (typeof e.key !== "string" || e.key.length !== 1) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (String(e.target?.tagName || "").toUpperCase() === "SELECT") return false;
    if (!isEventForThisView(e)) return false;
    listRendererRef.value?.focusSearch?.();
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
    if (actionPanelVisible.value) return false;
    const declaredSpace = activeActions.value.find((act) => {
      const sc = act.props?.shortcut;
      return sc === "space" || (sc && normalizeShortcutKeyName(sc.key) === "space" && !(sc.modifiers || []).length);
    });
    if (inInput) {
      // 搜索框为空时，空格用于勾选当前条目（布局二 / 三的可勾选列表）；有文字时照常输入空格
      const emptySearch = currentDescriptor.value?.type === "List" && e.target?.tagName === "INPUT" && !e.target.value;
      const checkable = emptySearch && !declaredSpace ? currentListHasCheckableTarget() : null;
      if (checkable) {
        listRendererRef.value?.toggleItemCheck?.(checkable);
        return true;
      }
      return false;
    }
    if (declaredSpace) {
      executeAction(declaredSpace);
      return true;
    }
    const checkable = currentListHasCheckableTarget();
    if (checkable) {
      listRendererRef.value?.toggleItemCheck?.(checkable);
      return true;
    }
    const quickLookAction = activeActions.value.find((act) => {
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

// 根节点键盘事件统一委托至调度器（窗口级监听已分发过的同一事件不会重复处理）
function handleGlobalKeyDown(e) {
  if (isComposingEvent(e)) return;
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
  getViewStateSnapshot,
  getPopoutState: collectRootPopoutState,
  showToast
});
</script>
