<template>
  <div
    tabindex="0"
    class="declarative-mica-shell flex flex-col h-full w-full rounded-2xl overflow-hidden focus:outline-none relative select-none"
    @keydown="handleGlobalKeyDown"
  >
    <!-- 顶部通用导航头 (显示 navigationTitle 与 返回按钮) -->
    <div
      v-if="hasHeader"
      class="px-4 py-2.5 border-b border-white/10 flex items-center justify-between bg-white/[0.03]"
    >
      <div class="flex items-center gap-2">
        <button
          v-if="canGoBack"
          class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-1 text-xs"
          title="后退 (Esc)"
          @click="handleBack"
        >
          <DeclarativeIcon icon="arrow-left" :size="14" />
          <span>返回</span>
        </button>
        <span class="font-medium text-sm text-slate-200">
          {{ navigationTitle }}
        </span>
      </div>

      <div class="text-xs text-slate-500 flex items-center gap-1.5">
        <span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
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
        @select="onItemSelected"
        @trigger-primary="triggerPrimaryAction"
        @action-panel-change="onActionPanelChange"
        @open-action-panel="openActionPanel"
      />

      <!-- 2. Detail 视图 -->
      <DetailRenderer
        v-else-if="currentDescriptor?.type === 'Detail'"
        ref="detailRendererRef"
        :descriptor="currentDescriptor"
      />

      <!-- 3. Form 视图 -->
      <FormRenderer
        v-else-if="currentDescriptor?.type === 'Form'"
        ref="formRendererRef"
        :descriptor="currentDescriptor"
        @submit="handleFormSubmit"
      />

      <!-- 空状态 -->
      <div
        v-else
        class="flex flex-col items-center justify-center h-full text-slate-400 text-sm gap-2"
      >
        <DeclarativeIcon icon="document" :size="32" class="text-slate-500" />
        <span>未识别的声明式视图或视图已卸载</span>
      </div>
    </div>

    <!-- 底部 Fluent 风格快捷栏 -->
    <div class="px-4 py-2 border-t border-white/10 flex items-center justify-between bg-black/30 text-xs text-slate-400">
      <!-- 左侧：主要 Action 提示与分栏切换 -->
      <div class="flex items-center gap-4">
        <div
          v-if="primaryAction"
          class="flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
          title="执行首要动作 (Enter)"
          @click="executeAction(primaryAction)"
        >
          <span class="text-slate-200 font-medium">{{ primaryAction.props?.title }}</span>
          <kbd class="px-1.5 py-0.5 bg-white/10 text-slate-300 rounded font-mono text-[10px]">Enter</kbd>
        </div>
        <div
          v-if="toggleDetailAction"
          class="flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors"
          :title="toggleDetailAction.props?.title"
          @click="executeAction(toggleDetailAction)"
        >
          <span class="text-slate-300">{{ toggleDetailAction.props?.title }}</span>
          <kbd class="px-1.5 py-0.5 bg-white/10 text-slate-300 rounded font-mono text-[10px]">Ctrl+D</kbd>
        </div>
        <div
          v-if="canGoBack"
          class="flex items-center gap-1 text-slate-400 cursor-pointer hover:text-white transition-colors"
          title="后退上一级 (Esc)"
          @click="handleBack"
        >
          <span>后退</span>
          <kbd class="px-1.5 py-0.5 bg-white/10 text-slate-300 rounded font-mono text-[10px]">Esc</kbd>
        </div>
        <div
          v-else-if="!isPopout"
          class="flex items-center gap-1 text-slate-400 cursor-pointer hover:text-white transition-colors"
          title="返回工作台 (Esc)"
          @click="emit('exit')"
        >
          <span>返回工作台</span>
          <kbd class="px-1.5 py-0.5 bg-white/10 text-slate-300 rounded font-mono text-[10px]">Esc</kbd>
        </div>
        <div
          v-else
          class="flex items-center gap-1.5 text-emerald-400/90 font-mono text-[11px]"
          title="独立常驻模式下按 Esc 仅清空搜索框，防止误触关闭盯盘窗口"
        >
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>独立常驻防误关 (Esc 仅清过滤)</span>
        </div>
      </div>

      <!-- 右侧：ActionPanel 呼出按钮 -->
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors cursor-pointer"
          @click="toggleActionPanel"
        >
          <span>动作面板</span>
          <kbd class="px-1 py-0.5 bg-white/10 text-slate-400 rounded font-mono text-[10px]">Ctrl+K</kbd>
        </button>
      </div>
    </div>

    <!-- 动作面板弹层 (ActionPanel) -->
    <ActionPanelModal
      :visible="actionPanelVisible"
      :actions="activeActions"
      :target-title="currentSelectedItem?.props?.title || ''"
      @close="actionPanelVisible = false"
      @trigger="executeAction"
    />

    <!-- Toast 提示宿主 -->
    <ToastOverlay :toasts="toasts" />
  </div>
</template>

<script setup>
import { ref, computed, watch, provide, onUnmounted } from "vue";
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

  // 1. 如果是 List，优先看当前选中 item 的 actions，再看首项或 list 级 actions
  if (desc.type === "List") {
    const item = currentSelectedItem.value || findFirstItem(desc);
    panel = item?.props?.actions || desc.props?.actions;
  } else if (desc.type === "Detail") {
    panel = desc.props?.actions;
  } else if (desc.type === "Form") {
    panel = desc.props?.actions;
  }

  if (!panel) return [];

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
      flat.push({ ...node, _sectionTitle: sectionTitle });
    }
  }

  extract(panel);
  return flat;
});

// 首要 Action (列表第一项动作)
const primaryAction = computed(() => {
  return activeActions.value[0] || null;
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
  if (props.sessionId || props.remote) {
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

  try {
    if (type === "Action.CopyToClipboard") {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(props?.content ?? ""));
      }
      props?.onCopy?.();
    } else if (type === "Action.OpenInBrowser") {
      if (props?.url && typeof window !== "undefined") {
        window.open(props.url, "_blank");
      }
    } else if (type === "Action.Push") {
      if (props?.target) {
        push(props.target);
      }
    } else if (type === "Action.SubmitForm") {
      const values = formRendererRef.value ? formRendererRef.value.getValues() : {};
      if (props.sessionId && typeof window !== "undefined" && window.ztools?.call) {
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

function triggerPrimaryAction(item) {
  if (item && item.props?.actions) {
    const actions = (item.props.actions.children || []);
    if (actions[0]) {
      executeAction(actions[0]);
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

// 根节点键盘事件统一委托至调度器
function handleGlobalKeyDown(e) {
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
