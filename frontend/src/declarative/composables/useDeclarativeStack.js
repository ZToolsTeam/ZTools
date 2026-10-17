import { ref, computed, shallowRef, onUnmounted, toRaw, h } from "vue";
import { setDeclarativeBridge, renderDeclarativeRoot, getComponentFactory } from "@ztools/declarative-ui";
import { Modal } from "ant-design-vue";


/** 当前打开着的确认框，按打开顺序；最上面的才处理按键。插件页面卸载时一并关闭 */
const openConfirms = [];

/** 关闭所有插件确认框，按取消处理 */
export function closeAllConfirms() {
  for (const cancel of [...openConfirms].reverse()) cancel();
}

/** 按钮文字包一层 span：Ant Design 会在两个汉字的按钮文字中间插空格（「取 消」） */
function buttonText(text) {
  return h("span", text);
}

/**
 * 插件 confirmAlert 的宿主实现：用站内 Modal 确认框，返回用户是否点了主操作。
 * - 危险操作默认聚焦「取消」，误按回车不会执行；Esc、点遮罩都按取消处理；只结算一次
 * - 确认框打开期间先拦下键盘事件：Esc 只关确认框，其余按键也不再触发页面快捷键（如 Esc 返回、⌘K）
 */
export function showInAppConfirm(options = {}) {
  const title = typeof options.title === "string" && options.title.trim() ? options.title : "确认操作";
  const primary = options.primaryAction || {};
  const dismiss = options.dismissAction || {};
  const destructive = primary.style === "destructive";
  return new Promise((resolve) => {
    let settled = false;
    let instance = null;
    const onKeydown = (event) => {
      // 叠了多个确认框时只由最上面的处理（先注册的监听先执行，不是最上面就放行）
      if (openConfirms[openConfirms.length - 1] !== cancel) return;
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    const cleanup = () => {
      const index = openConfirms.indexOf(cancel);
      if (index !== -1) openConfirms.splice(index, 1);
      if (typeof window !== "undefined") window.removeEventListener("keydown", onKeydown, true);
    };
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (ok) primary.onAction?.();
        else dismiss.onAction?.();
      } catch (error) {
        console.warn("[declarative] 确认框回调执行失败:", error);
      }
      resolve(ok);
    };
    function cancel() {
      try {
        instance?.destroy?.();
      } catch {
        // 已经关闭
      }
      settle(false);
    }
    try {
      instance = Modal.confirm({
        title,
        content: typeof options.message === "string" ? options.message : undefined,
        okText: buttonText(primary.title || "确定"),
        cancelText: buttonText(dismiss.title || "取消"),
        okButtonProps: destructive ? { danger: true } : undefined,
        autoFocusButton: destructive ? "cancel" : "ok",
        maskClosable: true,
        keyboard: false,
        onOk: () => settle(true),
        onCancel: () => settle(false),
        afterClose: () => settle(false)
      });
      openConfirms.push(cancel);
      if (typeof window !== "undefined") window.addEventListener("keydown", onKeydown, true);
    } catch (error) {
      console.warn("[declarative] 无法弹出确认框，按取消处理:", error);
      settle(false);
    }
  });
}

export function useDeclarativeStack(initialRoot) {
  // 导航栈数组，每一项存储当前层级的 { descriptor, component, root }
  const stack = ref([]);
  const currentDescriptor = shallowRef(null);
  const activeIndex = computed(() => stack.value.length - 1);
  const currentLevel = computed(() => stack.value[activeIndex.value] || null);

  // 活跃 Toast 列表
  const toasts = ref([]);

  function showToast(options) {
    const id = "toast_" + Math.random().toString(36).slice(2, 9);
    const toastItem = {
      id,
      title: options.title,
      message: options.message,
      style: options.style
    };

    toasts.value.push(toastItem);

    // 默认如果不是 ANIMATED，则 3 秒后自动消失
    if (options.style !== "ANIMATED") {
      setTimeout(() => {
        hideToast(id);
      }, 3000);
    }

    return {
      id,
      update: (u) => {
        const item = toasts.value.find((t) => t.id === id);
        if (item) {
          Object.assign(item, u);
        }
      },
      hide: () => {
        hideToast(id);
      }
    };
  }

  function hideToast(id) {
    const idx = toasts.value.findIndex((t) => t.id === id);
    if (idx !== -1) {
      toasts.value.splice(idx, 1);
    }
  }

  function clear() {
    closeAllConfirms();
    while (stack.value.length > 0) {
      const item = stack.value.pop();
      const rawItem = toRaw(item);
      rawItem?.root?.unmount();
    }
    currentDescriptor.value = null;
  }

  function push(target) {
    let descriptor = null;
    let component = null;
    let root = null;

    const rawTarget = toRaw(target);
    const targetFn =
      typeof rawTarget === "function"
        ? rawTarget
        : typeof getComponentFactory === "function"
          ? getComponentFactory(rawTarget)
          : undefined;

    if (typeof targetFn === "function") {
      component = targetFn;
      try {
        const node = {
          descriptor: null,
          component,
          root: null
        };
        root = renderDeclarativeRoot(targetFn, {
          onUpdate: (newDesc) => {
            node.descriptor = newDesc;
            const top = stack.value[stack.value.length - 1];
            if (top && (toRaw(top) === node || top.root === root || toRaw(top?.root) === root)) {
              currentDescriptor.value = newDesc;
            }
          },
          navigation: {
            push,
            pop
          }
        });
        descriptor = root.getLatest();
        node.descriptor = descriptor;
        node.root = root;
        stack.value.push(node);
        currentDescriptor.value = descriptor;
        return;
      } catch (e) {
        console.error("[DeclarativeStack] Error executing target component:", e);
      }
    } else {
      descriptor = target;
    }

    stack.value.push({
      descriptor,
      component,
      root: null
    });
    currentDescriptor.value = descriptor;
  }

  function pop() {
    if (stack.value.length > 1) {
      const item = stack.value.pop();
      const rawItem = toRaw(item);
      rawItem?.root?.unmount();
      const top = stack.value[stack.value.length - 1];
      const rawTop = toRaw(top);
      currentDescriptor.value = rawTop?.descriptor || null;
      return true;
    }
    return false;
  }

  function replaceTopDescriptor(newDesc) {
    if (currentLevel.value) {
      currentLevel.value.descriptor = newDesc;
      currentDescriptor.value = newDesc;
    }
  }

  // 注册全局 Bridge，使子组件无论直接调用 showToast、useNavigation 还是内置服务都能与宿主连通
  const getElectronMethods = () =>
    typeof window !== "undefined" ? window.__ztoolsElectron?.methods : null;

  const unwrapIpc = async (callPromise, fallback) => {
    try {
      const res = await callPromise;
      if (res && typeof res === "object" && "success" in res && "data" in res) {
        return res.success ? res.data : fallback;
      }
      return res ?? fallback;
    } catch {
      return fallback;
    }
  };

  setDeclarativeBridge({
    showToast,
    navigation: {
      push,
      pop
    },
    copyToClipboard: async (text) => {
      const methods = getElectronMethods();
      if (methods?.clipboard_copy_text) {
        await unwrapIpc(methods.clipboard_copy_text({ text: String(text) }), undefined);
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(text));
      }
    },
    readClipboardText: async () => {
      const methods = getElectronMethods();
      if (methods?.clipboard_read_text) {
        const res = await unwrapIpc(methods.clipboard_read_text({}), "");
        return typeof res === "string" ? res : String(res?.text ?? "");
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return "";
    },
    pasteToActive: async (text) => {
      const methods = getElectronMethods();
      if (methods?.clipboard_hide_and_paste_text) {
        await unwrapIpc(methods.clipboard_hide_and_paste_text({ text: String(text) }), undefined);
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(text));
      }
    },
    manageWindow: async (action) => {
      const methods = getElectronMethods();
      if (methods?.window_manage_action) {
        const res = await unwrapIpc(methods.window_manage_action({ action }), null);
        return Boolean(res?.applied ?? res?.success ?? res);
      }
      return false;
    },
    clipboardHistory: {
      query: async (options = {}) => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_query) return [];
        const res = await unwrapIpc(methods.clipboard_history_query(options), []);
        return Array.isArray(res) ? res : [];
      },
      togglePin: async (id) => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_toggle_pin) return false;
        const res = await unwrapIpc(methods.clipboard_history_toggle_pin({ id }), null);
        return Boolean(res?.success ?? res);
      },
      delete: async (id) => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_delete) return false;
        const res = await unwrapIpc(methods.clipboard_history_delete({ id }), null);
        return Boolean(res?.success ?? res);
      },
      clearUnpinned: async () => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_clear_unpinned) return 0;
        const res = await unwrapIpc(methods.clipboard_history_clear_unpinned({}), null);
        return Number(res?.count ?? res ?? 0);
      },
      pasteSequential: async () => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_paste_sequential) return { success: false };
        return await unwrapIpc(methods.clipboard_history_paste_sequential({}), { success: false });
      },
      resetSequence: async () => {
        const methods = getElectronMethods();
        if (!methods?.clipboard_history_reset_sequence) return { success: false };
        return await unwrapIpc(methods.clipboard_history_reset_sequence({}), { success: false });
      }
    },
    snippets: {
      list: async (query) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_list) return [];
        const res = await unwrapIpc(methods.snippets_list(query ? { query } : {}), []);
        return Array.isArray(res) ? res : [];
      },
      create: async (snippet) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_create) return null;
        return await unwrapIpc(methods.snippets_create(snippet), null);
      },
      update: async (id, snippet) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_update) return null;
        return await unwrapIpc(methods.snippets_update({ id, ...snippet }), null);
      },
      delete: async (id) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_delete) return false;
        const res = await unwrapIpc(methods.snippets_delete({ id }), null);
        return Boolean(res?.success ?? res);
      },
      toggle: async (id) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_toggle) return false;
        const res = await unwrapIpc(methods.snippets_toggle({ id }), null);
        return Boolean(res?.success ?? res);
      },
      matchAndExpand: async (typedText, clipboardContent) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_match_and_expand) return { matched: false };
        return await unwrapIpc(
          methods.snippets_match_and_expand({ typedText, clipboardContent }),
          { matched: false }
        );
      },
      import: async (data) => {
        const methods = getElectronMethods();
        if (!methods?.snippets_import) return { total: 0, imported: 0, updated: 0, failed: 0 };
        return await unwrapIpc(methods.snippets_import({ snippets: data }), {
          total: 0,
          imported: 0,
          updated: 0,
          failed: 0
        });
      },
      export: async () => {
        const methods = getElectronMethods();
        if (!methods?.snippets_export) return [];
        const res = await unwrapIpc(methods.snippets_export({}), []);
        return Array.isArray(res) ? res : [];
      }
    },
    // 站内确认框（跟随主题），不用系统原生 window.confirm
    confirmAlert: (options) => showInAppConfirm(options)
  });

  if (initialRoot) {
    push(initialRoot);
  }

  onUnmounted(() => {
    clear();
  });

  return {
    stack,
    currentDescriptor,
    currentLevel,
    toasts,
    showToast,
    push,
    pop,
    clear,
    replaceTopDescriptor
  };
}

