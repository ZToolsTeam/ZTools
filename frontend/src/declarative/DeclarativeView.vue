<template>
  <div
    ref="rootRef"
    tabindex="0"
    data-declarative-root
    class="declarative-mica-shell flex flex-col h-full w-full rounded-2xl overflow-hidden focus:outline-none relative select-none"
    @keydown="handleGlobalKeyDown"
    @paste="handleRootPaste"
    @dragenter="handleFileDragEnter"
    @dragover.prevent="handleFileDragOver"
    @dragleave="handleFileDragLeave"
    @drop.prevent="handleFileDrop"
  >
    <!-- 顶部通用导航头：只显示 navigationTitle；返回入口只有底栏「返回 Esc」一个（同一功能只出现一次） -->
    <div
      v-if="hasHeader"
      class="px-4 py-2.5 border-b border-[var(--rc-border)] flex items-center justify-between bg-[var(--rc-surface-subtle)]"
    >
      <div class="flex items-center gap-2">
        <span class="font-medium text-sm text-[var(--rc-text-primary)]">
          {{ navigationTitle }}
        </span>
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
        @action-error="onActionError"
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
        @submit="handleFormSubmit"
        @trigger-action="executeAction"
      />

      <!-- 空状态 -->
      <DeclEmptyState
        v-else
        icon="document"
        title="没有可显示的内容"
        description="插件没有返回可识别的视图，或视图已关闭。"
      />
    </div>

    <!-- 底部 Fluent / Raycast 风格三段式快捷动作栏 -->
    <div class="px-4 py-2 border-t border-[var(--rc-border)] flex items-center justify-between gap-3 bg-[var(--rc-surface-subtle)] text-xs text-[var(--rc-text-muted)]">
      <!-- 左侧：返回导航与分栏切换 -->
      <div class="flex items-center gap-3 min-w-0">
        <button
          v-if="canGoBack"
          type="button"
          class="decl-foot-link"
          title="返回上一级 (Esc)"
          data-decl-back
          @click="handleBack"
        >
          <span>返回</span>
          <ShortcutKeys combo="Escape" />
        </button>
        <button
          v-else-if="!isPopout"
          type="button"
          class="decl-foot-link"
          title="返回工作台 (Esc)"
          data-decl-exit
          @click="emit('exit')"
        >
          <span>返回工作台</span>
          <ShortcutKeys combo="Escape" />
        </button>
        <span
          v-else
          class="flex items-center gap-1 text-[11px] text-[var(--rc-text-muted)] flex-shrink-0"
          title="独立窗口里按 Esc 只清空搜索框，不会关闭窗口"
          data-decl-popout-hint
        >
          <span>独立窗口</span>
          <span class="text-[var(--rc-text-faint)]">·</span>
          <ShortcutKeys combo="Escape" />
          <span>只清空搜索</span>
        </span>

        <button
          v-if="toggleDetailAction"
          type="button"
          class="decl-foot-link"
          :title="cleanUiText(toggleDetailAction.props?.title)"
          data-decl-toggle-detail
          @click="executeAction(toggleDetailAction)"
        >
          <span class="text-[var(--rc-text-secondary)]">{{ cleanUiText(toggleDetailAction.props?.title) }}</span>
          <ShortcutKeys :combo="resolvedBindings.hintOf(toggleDetailAction)" />
        </button>
      </div>

      <!-- 右侧：对齐 Raycast「主动作 (Enter) + 次动作 (Ctrl+Enter) + 动作面板 (Ctrl+K)」三段式直观按钮栏 -->
      <div class="flex items-center gap-2 flex-shrink-0">
        <RcButton
          v-if="primaryAction"
          :variant="isDestructiveAction(primaryAction) ? 'danger' : 'soft'"
          size="sm"
          class="decl-foot-btn"
          :class="isDestructiveAction(primaryAction) ? 'is-destructive' : 'is-primary'"
          :kbd="primaryShortcutCombo"
          :title="`执行首要动作 (${primaryShortcutCombo})`"
          data-decl-primary
          @click="executeAction(primaryAction)"
        >
          <span class="truncate max-w-[180px]">{{ resolveActionTitle(primaryAction) }}</span>
        </RcButton>

        <RcButton
          v-if="secondaryAction && secondaryAction !== primaryAction"
          :variant="isDestructiveAction(secondaryAction) ? 'danger' : 'secondary'"
          size="sm"
          class="decl-foot-btn"
          :class="isDestructiveAction(secondaryAction) ? 'is-destructive' : 'is-neutral'"
          :kbd="secondaryShortcutCombo"
          :title="`执行次要动作 (${secondaryShortcutCombo})`"
          data-decl-secondary
          @click="executeAction(secondaryAction)"
        >
          <span class="truncate max-w-[160px]">{{ resolveActionTitle(secondaryAction) }}</span>
        </RcButton>

        <!-- 只有还有收起的动作时才显示；数量只计没在底栏露出的动作 -->
        <RcButton
          v-if="collapsedActionCount > 0"
          variant="secondary"
          size="sm"
          class="decl-foot-btn is-neutral"
          kbd="Ctrl+K"
          title="动作面板 (Ctrl+K)"
          data-decl-action-panel
          @click="toggleActionPanel"
        >
          <span>动作面板 ({{ collapsedActionCount }})</span>
        </RcButton>
      </div>
    </div>

    <!-- 动作面板弹层 (ActionPanel) -->
    <ActionPanelModal
      :visible="actionPanelVisible"
      :actions="activeActions"
      :target-title="panelTargetTitle"
      :view-type="currentDescriptor?.type || 'List'"
      placement="corner"
      @close="closeActionPanel"
      @trigger="executeAction"
    />

    <!-- 外部文件拖入提示遮罩 -->
    <div
      v-if="isFileDragging"
      data-decl-drop-overlay
      class="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--rc-border-strong,var(--rc-border))] bg-[var(--rc-surface-elevated,var(--rc-surface-subtle))]/90 backdrop-blur-sm transition-opacity"
    >
      <div class="text-sm font-medium text-[var(--rc-text-primary)]">{{ dropOverlayTitle }}</div>
      <div class="mt-1 text-xs text-[var(--rc-text-muted)]">{{ dropOverlaySubtitle }}</div>
    </div>

    <!-- Toast 提示宿主 -->
    <ToastOverlay :toasts="toasts" />
  </div>
</template>

<script>
// 同窗口按 :key 同步切换插件时，旧组件 onUnmounted（postFlush）会晚于新组件 setup/watch 执行，
// 用实例所有权编号防止旧实例卸载时将新实例已开启的文件夹拖入拦截覆写为 false。
let nextFileInputOwnerId = 0;
let activeFileInputOwnerId = 0;
</script>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { RcButton } from '@/components/base'

import "./style/declarative-fluent.css";
import DeclEmptyState from "./components/DeclEmptyState.vue";
import ListRenderer from "./components/ListRenderer.vue";
import DetailRenderer from "./components/DetailRenderer.vue";
import FormRenderer from "./components/FormRenderer.vue";
import ActionPanelModal from "./components/ActionPanelModal.vue";
import ToastOverlay from "./components/ToastOverlay.vue";
import { getHostMethods } from "./hostMethods.js";
import { cleanUiText, isDestructiveAction, resolveActionTitle } from "./uiText.js";
import { resolveActionKeyBindings, normalizeEventShortcutKey } from "@/utils/actionKeyBindings.js";
import { filterIncomingFiles } from "./fileInputFilter.js";
import { useDeclarativeStack, assertClipboardText, hasOpenConfirm } from "./composables/useDeclarativeStack.js";
import {
  useKeymap,
  registerKeyHandler,
  KEYMAP_SCOPES,
  dispatchKeyEvent,
  isComposingEvent,
  isInputElement,
  isInteractiveControlTarget
} from "@/utils/keymap.js";
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
  },
  // 宿主页面已有标题栏（面包屑）时为 true：子页面标题通过 title-change 交给宿主显示，视图内不再叠第二条标题栏
  hostTitleBar: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(["exit", "action-executed", "native-callback", "title-change"]);

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
const isFileDragging = ref(false);
let fileDragDepth = 0;
const sessionInputPaths = new Set();

if (typeof window !== "undefined") {
  window.__ztoolsDeclarativeFeatures = {
    ...(window.__ztoolsDeclarativeFeatures || {}),
    fileInput: true
  };
}

const topFileInputHandler = computed(() => {
  const fn = currentDescriptor.value?.props?.onFileInput;
  return typeof fn === "function" ? fn : null;
});

const topFileInputConfig = computed(() => {
  const cfg = currentDescriptor.value?.props?.fileInput;
  return cfg && typeof cfg === "object" ? cfg : null;
});

const isFileInputActive = computed(() => {
  return Boolean(topFileInputHandler.value) && !actionPanelVisible.value && !hasOpenConfirm();
});

const dropOverlayTitle = computed(() => {
  const cfg = topFileInputConfig.value;
  if (cfg?.dropTitle) return String(cfg.dropTitle);
  return cfg?.allowDirectories ? "松开鼠标添加文件或文件夹" : "松开鼠标添加文件";
});

const dropOverlaySubtitle = computed(() => {
  const cfg = topFileInputConfig.value;
  if (cfg?.dropSubtitle) return String(cfg.dropSubtitle);
  return "支持拖入或按 Ctrl+V / ⌘V 粘贴输入";
});

const fileInputOwnerId = ++nextFileInputOwnerId;

function syncPreloadFileInputInterception() {
  if (typeof window === "undefined") return;
  const setInterception = window.__ztoolsElectron?.setFileInputInterception;
  if (typeof setInterception !== "function") return;
  const active = isFileInputActive.value;
  const cfg = topFileInputConfig.value;
  if (active) {
    activeFileInputOwnerId = fileInputOwnerId;
    setInterception({
      enabled: true,
      allowImage: Boolean(cfg?.allowClipboardImage),
      allowDirectories: Boolean(cfg?.allowDirectories)
    });
  } else if (activeFileInputOwnerId === fileInputOwnerId) {
    activeFileInputOwnerId = 0;
    setInterception({ enabled: false, allowImage: false, allowDirectories: false });
  }
}

watch(
  [isFileInputActive, topFileInputConfig],
  () => {
    syncPreloadFileInputInterception();
    if (!isFileInputActive.value && isFileDragging.value) {
      fileDragDepth = 0;
      isFileDragging.value = false;
    }
  },
  { immediate: true }
);

function handleHostFilesDropped(envelopeOrPayload) {
  const record = envelopeOrPayload && typeof envelopeOrPayload === "object" ? envelopeOrPayload : {};
  const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
  const rawFiles = Array.isArray(payload.files)
    ? payload.files.filter((f) => typeof f === "string" && f.trim().length > 0).map((f) => f.trim())
    : [];
  for (const p of rawFiles) {
    sessionInputPaths.add(p);
  }
  if (!isFileInputActive.value || !topFileInputHandler.value) return;

  const cfg = topFileInputConfig.value;
  const hostErrors = Array.isArray(payload.errors) ? payload.errors : [];
  // 文件夹以主进程确认的 directories 为准，名称带点的文件夹不会被当成后缀不匹配
  const filtered = filterIncomingFiles(rawFiles, payload.directories, cfg);
  const extRejected = filtered.rejected;
  const acceptedFiles = filtered.files;

  const totalRejected = hostErrors.length + extRejected;
  if (acceptedFiles.length === 0) {
    if (extRejected > 0 && Array.isArray(cfg?.extensions) && cfg.extensions.length > 0) {
      showToast?.({
        title: "文件格式不匹配",
        message: `当前工具仅支持 ${cfg.extensions.join(" / ")} 格式`,
        style: "FAILURE"
      });
    } else if (hostErrors.length > 0) {
      const firstErr = hostErrors[0]?.message || "无法读取所选文件或文件夹";
      showToast?.({
        title: "文件输入未生效",
        message: String(firstErr),
        style: "FAILURE"
      });
    }
    return;
  }

  if (totalRejected > 0) {
    showToast?.({
      title: `已接收 ${acceptedFiles.length} 项，忽略 ${totalRejected} 项不兼容内容`,
      style: "SUCCESS"
    });
  }

  try {
    topFileInputHandler.value({
      files: acceptedFiles,
      ...(filtered.directories.length > 0 ? { directories: filtered.directories } : {}),
      source: payload.source === "paste" ? "paste" : "drop",
      ...(typeof payload.targetFieldId === "string" && payload.targetFieldId ? { targetFieldId: payload.targetFieldId } : {}),
      rejectedCount: totalRejected
    });
  } catch (err) {
    onActionError(err);
  }
}

let unlistenFileDrop = null;
if (typeof window !== "undefined" && window.ztools?.events?.on) {
  const maybeOff = window.ztools.events.on("plugin_files_dropped", handleHostFilesDropped);
  unlistenFileDrop = typeof maybeOff === "function"
    ? maybeOff
    : () => window.ztools?.events?.off?.("plugin_files_dropped", handleHostFilesDropped);
}

onUnmounted(() => {
  if (typeof unlistenFileDrop === "function") {
    unlistenFileDrop();
    unlistenFileDrop = null;
  }
  if (activeFileInputOwnerId === fileInputOwnerId) {
    activeFileInputOwnerId = 0;
    if (typeof window !== "undefined" && typeof window.__ztoolsElectron?.setFileInputInterception === "function") {
      window.__ztoolsElectron.setFileInputInterception({ enabled: false, allowImage: false, allowDirectories: false });
    }
  }
});

onMounted(() => {
  syncPreloadFileInputInterception();
});

function handleRootPaste(e) {
  if (!isFileInputActive.value) return;
  const onTextPaste = topFileInputConfig.value?.onTextPaste;
  if (typeof onTextPaste !== "function") return;
  const target = e?.target;
  const tagName = String(target?.tagName || "").toUpperCase();
  const isEditable = tagName === "INPUT" || tagName === "TEXTAREA" || Boolean(target?.isContentEditable);
  const isEmptySearchInput = tagName === "INPUT" && target?.getAttribute?.("data-decl-role") === "search-input" && !target.value;
  if (isEditable && !isEmptySearchInput) return;

  const clipboardData = e?.clipboardData;
  if (!clipboardData) return;
  const types = Array.from(clipboardData.types || []);
  const hasFiles = (clipboardData.files && clipboardData.files.length > 0) || types.includes("Files");
  if (hasFiles) return;
  const plainText = clipboardData.getData("text/plain") || "";
  if (!plainText.trim()) return;

  try {
    const res = onTextPaste(plainText);
    if (res !== false) {
      e.preventDefault();
    }
  } catch (err) {
    onActionError(err);
  }
}

function getPopoutStateWithSessionPaths() {
  const base = collectRootPopoutState?.() || { state: {}, paths: [] };
  const mergedPaths = Array.from(new Set([...(Array.isArray(base.paths) ? base.paths : []), ...sessionInputPaths]));
  return {
    ...base,
    paths: mergedPaths
  };
}

function hasDraggedFiles(e) {
  const types = e?.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes("Files");
}

function handleFileDragEnter(e) {
  if (!hasDraggedFiles(e)) return;
  if (topFileInputHandler.value && !isFileInputActive.value) return;
  fileDragDepth += 1;
  isFileDragging.value = true;
}

function handleFileDragOver(e) {
  if (!hasDraggedFiles(e)) return;
  if (topFileInputHandler.value && !isFileInputActive.value) return;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "copy";
  }
  isFileDragging.value = true;
}

function handleFileDragLeave(e) {
  if (!hasDraggedFiles(e)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) {
    isFileDragging.value = false;
  }
}

function handleFileDrop() {
  fileDragDepth = 0;
  isFileDragging.value = false;
}
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

// 当前应显示的页面标题：没有标题时为空；根页面受 hideRootTitle 控制，子页面不受影响
const visibleTitle = computed(() => {
  if (!navigationTitle.value) return "";
  return canGoBack.value || !props.hideRootTitle ? navigationTitle.value : "";
});

// 顶部不放返回按钮；宿主有自己的标题栏时标题交给宿主，视图内不再显示第二条标题栏
const hasHeader = computed(() => Boolean(visibleTitle.value) && !props.hostTitleBar);

watch(
  visibleTitle,
  (title) => {
    if (props.hostTitleBar) emit("title-change", title);
  },
  { immediate: true }
);

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
  // 条目自己的动作已有同类型同标题的，合并进来的列表级动作不再重复出现
  let itemActionKeys = null;
  function add(list, node, sectionTitle, fromSubmenu) {
    const dedupeKey = `${node.type}\u0000${node.props?.title ?? ""}\u0000${sectionTitle}`;
    if (seen.has(dedupeKey)) return;
    if (itemActionKeys?.has(`${node.type}\u0000${node.props?.title ?? ""}`)) return;
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
    itemActionKeys = new Set([...flat, ...submenuFlat].map((node) => `${node.type}\u0000${node.props?.title ?? ""}`));
    extract(fallbackPanel, "全局操作");
  }
  return [...flat, ...submenuFlat];
});

const isFormView = computed(() => currentDescriptor.value?.type === "Form");

// 能映射到 Enter / ⌘Enter 的动作（子菜单里的动作只在 ⌘K 面板中出现）
const directActions = computed(() => activeActions.value.filter((act) => !act._fromSubmenu));

// 统一「所见即所按」快捷键解析器：处理显式 Ctrl+Enter 优先次动作、重复冲突去重、宿主保留热键过滤
const resolvedBindings = computed(() =>
  resolveActionKeyBindings(activeActions.value, {
    viewType: currentDescriptor.value?.type || "List"
  })
);

// 首要 Action 与次要 Action（由统一解析器决定）
const primaryAction = computed(() => resolvedBindings.value.primaryAction);
const secondaryAction = computed(() => resolvedBindings.value.secondaryAction);

const primaryShortcutCombo = computed(() => {
  if (primaryAction.value) {
    return resolvedBindings.value.hintOf(primaryAction.value) || (isFormView.value ? "Ctrl+Enter" : "Enter");
  }
  return isFormView.value ? "Ctrl+Enter" : "Enter";
});

const secondaryShortcutCombo = computed(() => {
  if (!secondaryAction.value) return "Ctrl+Enter";
  return resolvedBindings.value.hintOf(secondaryAction.value) || "Ctrl+Enter";
});

const panelTargetTitle = computed(() => {
  const desc = currentDescriptor.value;
  const target = (actionPanelVisible.value && resolveItemInDescriptor(desc, actionPanelTarget.value)) || resolvedSelectedItem.value;
  return target?.props?.title ? String(target.props.title) : "";
});

// 详情分栏切换动作：只在列表视图、且插件为它声明了未冲突非保留快捷键时放到底栏左侧；
// 按键由通用的动作快捷键处理（handleActionShortcut）负责，不再写死 Ctrl+D
const DETAIL_TOGGLE_TITLE = /详情预览分栏|预览分栏|详情分栏|Toggle Details?/i;
const toggleDetailAction = computed(() => {
  if (currentDescriptor.value?.type !== "List") return null;
  return (
    directActions.value.find(
      (act) =>
        act !== primaryAction.value &&
        act !== secondaryAction.value &&
        DETAIL_TOGGLE_TITLE.test(String(act.props?.title || "")) &&
        Boolean(resolvedBindings.value.hintOf(act))
    ) || null
  );
});

// 收起在动作面板里的动作数量：不含已在底栏露出的主 / 次动作与详情切换
const collapsedActionCount = computed(() => {
  const shown = new Set([primaryAction.value, secondaryAction.value, toggleDetailAction.value].filter(Boolean));
  return activeActions.value.filter((act) => !shown.has(act)).length;
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

/** 把焦点还给当前视图：列表聚焦搜索框，表单聚焦首个输入框，详情聚焦正文滚动容器 */
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
  } else if (type === "Detail" && detailRendererRef.value?.getScrollElement?.()) {
    detailRendererRef.value.focusScroll?.();
  } else if (typeof root.focus === "function") {
    root.focus({ preventScroll: true });
  }
}

function scheduleFocusRestore() {
  nextTick(() => restoreViewFocus());
}

onMounted(() => {
  scheduleFocusRestore();
});

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

function fileManagerName() {
  return isMacOS() ? "访达" : "资源管理器";
}

function onActionError(err) {
  showToast?.({ title: "操作失败", message: failureMessage(err), style: "FAILURE" });
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
      if (targetPath) {
        // 宿主失败会抛错，由下方 catch 如实提示；没有该能力时不能报“已定位”
        if (!electronMethods?.shell_show_item_in_folder) throw new Error("当前客户端不支持在文件管理器中定位");
        await electronMethods.shell_show_item_in_folder({ fullPath: String(targetPath) });
      }
      props?.onShow?.(targetPath);
      if (targetPath) {
        showToast?.({ title: `已在${fileManagerName()}中显示`, message: String(targetPath), style: "SUCCESS" });
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

/** 输入框里的原生编辑组合键（全选 / 复制 / 粘贴 / 剪切 / 撤销 / 重做 / 按词或整行删除）保留给输入框本身 */
function isNativeEditCombo(e) {
  const target = e.target;
  if (!isTextField(target) || e.altKey || !(e.ctrlKey || e.metaKey)) return false;
  // 使用规范化事件键以兼容 Windows 中文 IME keyCode=229 ('Process') 场景
  const keyLower = normalizeEventShortcutKey(e).toLowerCase();
  const hasValue = Boolean(target.value);
  if (!e.shiftKey) {
    if (keyLower === "c" || keyLower === "x") return hasTextSelection(target);
    // 粘贴(Ctrl/⌘+V)、撤销(Ctrl/⌘+Z)、重做(Ctrl/⌘+Y)无论输入框是否为空一律保留给原生，防止空框被插件动作抢占
    if (keyLower === "v" || keyLower === "z" || keyLower === "y") return true;
    if (keyLower === "a") return hasValue;
    // ⌘⌫ / Ctrl+Backspace 删除光标前的整行或单词，⌘⌦ / Ctrl+Delete 删除光标后的内容
    if (keyLower === "backspace" || keyLower === "delete") return hasValue;
    return false;
  }
  // ⌘⇧Z / Ctrl+Shift+Z 重做无论输入框是否为空一律保留给原生编辑
  return keyLower === "z";
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
  if (!(e.ctrlKey || e.metaKey || e.altKey)) {
    const keyName = normalizeEventShortcutKey(e);
    const allowPlainDelete =
      (keyName === "Delete" || keyName === "Backspace") &&
      (!isInputElement(e.target) || !e.target.value) &&
      !isInteractiveControlTarget(e.target, rootRef.value);
    if (!allowPlainDelete) return false;
  }
  if (!isEventForThisView(e)) return false;
  if (isNativeEditCombo(e)) return false;
  const matched = resolvedBindings.value.matchEvent(e);
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

function isFocusInListDetailScroll(e) {
  return Boolean(
    currentDescriptor.value?.type === "List" &&
    currentDescriptor.value?.props?.isShowingDetail &&
    e?.target?.closest?.("[data-decl-detail-scroll]")
  );
}

function isFocusInWorkbenchField(e) {
  return Boolean(e?.target?.closest?.("[data-decl-field-id]"));
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
      const formSubmit = resolvedBindings.value.comboToAction.get("Ctrl+Enter") || primaryAction.value;
      if (formSubmit) {
        executeAction(formSubmit);
        return true;
      }
      return false;
    }
    const targetSecondary = resolvedBindings.value.comboToAction.get("Ctrl+Enter") || secondaryAction.value;
    if (targetSecondary) {
      executeAction(targetSecondary);
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
  'ArrowDown': (e) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type === "List") {
      if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
      listRendererRef.value?.focusNextItem();
      return true;
    }
    return false;
  },
  'ArrowUp': (e) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type === "List") {
      if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
      listRendererRef.value?.focusPrevItem();
      return true;
    }
    return false;
  },
  // 布局二：焦点不在输入框时 ← / → 切换左栏导航与右栏明细；列表右侧详情预览获焦时 ← 回到搜索框
  'ArrowLeft': (e, { inInput }) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (isFocusInListDetailScroll(e)) {
      listRendererRef.value?.focusSearch?.();
      return true;
    }
    if (inInput || isInteractiveControlTarget(e.target, rootRef.value)) return false;
    return listRendererRef.value?.setActivePane?.("nav") === true;
  },
  'ArrowRight': (e, { inInput }) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (inInput || currentDescriptor.value?.type !== "List") return false;
    if (isInteractiveControlTarget(e.target, rootRef.value)) return false;
    return listRendererRef.value?.setActivePane?.("sub") === true;
  },
  'PageDown': (e) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
    listRendererRef.value?.focusPageItems?.(8);
    return true;
  },
  'PageUp': (e) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
    listRendererRef.value?.focusPageItems?.(-8);
    return true;
  },
  'Home': (e, { inInput }) => {
    if (actionPanelVisible.value || inInput || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
    listRendererRef.value?.focusFirstItem?.();
    return true;
  },
  'End': (e, { inInput }) => {
    if (actionPanelVisible.value || inInput || !isEventForThisView(e)) return false;
    if (currentDescriptor.value?.type !== "List") return false;
    if (isFocusInListDetailScroll(e) || isFocusInWorkbenchField(e)) return false;
    listRendererRef.value?.focusLastItem?.();
    return true;
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
  'Enter': (e) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (e.target && e.target.tagName === "TEXTAREA") {
      return false;
    }
    if (isInteractiveControlTarget(e.target, rootRef.value)) {
      return false;
    }
    const targetPrimary = (!isFormView.value && resolvedBindings.value.comboToAction.get("Enter")) || primaryAction.value;
    if (targetPrimary) {
      executeAction(targetPrimary);
      return true;
    }
    return false;
  },
  'Space': (e, { inInput }) => {
    if (actionPanelVisible.value || !isEventForThisView(e)) return false;
    if (isInteractiveControlTarget(e.target, rootRef.value)) {
      return false;
    }
    const declaredSpace = resolvedBindings.value.comboToAction.get("Space") || null;
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
  getPopoutState: getPopoutStateWithSessionPaths,
  showToast
});
</script>

<style scoped>
/* 底栏左侧文字入口（返回、详情切换）：button 元素，键盘可聚焦 */
.decl-foot-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 4px;
  margin: -2px -4px;
  border: 0;
  border-radius: var(--rc-radius-sm);
  background: transparent;
  color: var(--rc-text-muted);
  font: inherit;
  cursor: pointer;
  transition: color 0.12s ease;
}

.decl-foot-link:hover {
  color: var(--rc-text-primary);
}

</style>
