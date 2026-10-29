import { confirmDialog } from "@/utils/confirmDialog";
import { ref, computed, shallowRef, onUnmounted, toRaw, h } from "vue";
import { setDeclarativeBridge, renderDeclarativeRoot, getComponentFactory } from "@ztools/declarative-ui";
import { createScreenColorPicker } from "../screenColorPicker.js";
import { getHostMethods } from "../hostMethods.js";


/** 当前打开着的确认框，按打开顺序；最上面的才处理按键。插件页面卸载时一并关闭 */
const openConfirms = [];

/**
 * 校验要写入剪贴板 / 粘贴的文本：只接受字符串或数字，空内容直接报错（不能提示“已复制”却什么也没写）。
 * 注：DeclarativeView 已引用此函数但当时未实现（其他批次的未完成改动），这里补上最小实现以保证可构建。
 */
export function assertClipboardText(content) {
  if (typeof content === "number" && Number.isFinite(content)) return String(content);
  if (typeof content !== "string") {
    throw Object.assign(new Error("要复制的内容不是文本"), { code: "INVALID_PARAMS" });
  }
  if (content.length === 0) {
    throw Object.assign(new Error("没有可复制的内容"), { code: "EMPTY_CONTENT" });
  }
  return content;
}

/** 是否有插件确认框正打开着（此时不能把焦点抢回页面） */
export function hasOpenConfirm() {
  return openConfirms.length > 0;
}

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
      } catch (err) {
        console.warn("[declarative] 销毁确认框实例异常:", err);
      }
      settle(false);
    }
    try {
      instance = confirmDialog({
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

/**
 * @param {Function|Object} initialRoot
 * @param {object} [options]
 * @param {() => void} [options.onOverlayClosed] 站内确认框关闭后回调（宿主据此把焦点还给当前视图）
 * @param {() => object|null} [options.captureViewState] 推入新页面前读取当前页面的界面状态（搜索词、选中项），返回时恢复
 * @param {object|null} [options.handoffSeed] 独立窗口交接来的 usePopoutState 初值：只给第一次挂载的根页面用一次
 */
export function useDeclarativeStack(initialRoot, options = {}) {
  const screenColorPicker = createScreenColorPicker();
  const onOverlayClosed = typeof options?.onOverlayClosed === "function" ? options.onOverlayClosed : null;
  const captureViewState = typeof options?.captureViewState === "function" ? options.captureViewState : null;
  let pendingHandoffSeed =
    options?.handoffSeed && typeof options.handoffSeed === "object" && !Array.isArray(options.handoffSeed)
      ? options.handoffSeed
      : null;
  // 导航栈数组，每一项存储当前层级的 { descriptor, component, root }
  const stack = ref([]);
  const currentDescriptor = shallowRef(null);
  const activeIndex = computed(() => stack.value.length - 1);
  const currentLevel = computed(() => stack.value[activeIndex.value] || null);
  let disposed = false;

  // 当前 Toast：与 Raycast 一致，同一时间只显示一条，新提示替换旧提示（避免加载提示叠在一起）
  const toasts = ref([]);
  const TOAST_AUTO_HIDE_MS = 3000;
  let toastTimer = null;

  function clearToastTimer() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  // ANIMATED（加载中）一直显示，直到插件 hide 或被新提示替换；其余样式 3 秒后自动消失
  function scheduleToastHide(id, style) {
    clearToastTimer();
    if (style === "ANIMATED") return;
    toastTimer = setTimeout(() => {
      toastTimer = null;
      hideToast(id);
    }, TOAST_AUTO_HIDE_MS);
  }

  let toastSeq = 0;
  function showToast(options) {
    const id = "toast_" + (++toastSeq).toString(36);
    const toastItem = {
      id,
      title: options.title,
      message: options.message,
      style: options.style
    };

    toasts.value = [toastItem];
    scheduleToastHide(id, options.style);

    return {
      id,
      update: (u) => {
        const item = toasts.value.find((t) => t.id === id);
        if (!item) return;
        Object.assign(item, u);
        // 加载提示改成成功/失败后要能自动消失；改回 ANIMATED 则取消倒计时
        if (u && Object.prototype.hasOwnProperty.call(u, "style")) {
          scheduleToastHide(id, item.style);
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
      if (toasts.value.length === 0) clearToastTimer();
    }
  }

  function clear() {
    screenColorPicker.cancel();
    closeAllConfirms();
    while (stack.value.length > 0) {
      const item = stack.value.pop();
      const rawItem = toRaw(item);
      rawItem?.root?.unmount();
    }
    currentDescriptor.value = null;
  }

  function push(target) {
    if (disposed) return;
    let descriptor = null;
    let component = null;
    let root = null;

    // 记下当前页面的搜索词与选中项，pop 回来时原样恢复（存在栈帧原始对象上）
    const below = stack.value[stack.value.length - 1];
    if (below?.root && captureViewState) {
      try {
        const snapshot = captureViewState();
        below.savedViewState = snapshot && typeof snapshot === "object" ? { ...snapshot, fromStack: true } : null;
      } catch (error) {
        console.warn("[DeclarativeStack] 保存页面状态失败:", error);
      }
    }

    const rawTarget = toRaw(target);
    const targetFn =
      typeof rawTarget === "function"
        ? rawTarget
        : typeof getComponentFactory === "function"
          ? getComponentFactory(rawTarget)
          : undefined;

    if (typeof targetFn === "function") {
      component = targetFn;
      // 交接初值只属于根页面（栈为空时推入的那一页），用过即清，推入的二级页面与换根后都不再使用
      const handoffSeed = stack.value.length === 0 ? pendingHandoffSeed : null;
      if (handoffSeed) pendingHandoffSeed = null;
      const startIndex = stack.value.length;
      try {
        const node = {
          descriptor: null,
          component,
          root: null
        };
        // 首次渲染会同步执行 useEffect；先登记父层，effect 推入的子层才能留在栈顶。
        stack.value.push(node);
        root = renderDeclarativeRoot(targetFn, {
          onUpdate: (newDesc) => {
            node.descriptor = newDesc;
            const top = stack.value[stack.value.length - 1];
            if (top && toRaw(top) === node) {
              currentDescriptor.value = newDesc;
            }
          },
          // 视图树 JSON 不变、只有回调闭包变化（例如只改了选中项 state）时 SDK 不发 onUpdate；
          // 宿主若继续持有首帧描述符，Enter / 顶栏按钮 / onSelectionChange 会执行旧闭包。
          // SDK 的描述符是冻结对象，不能就地替换回调，这里换成最新描述符（内容相同，界面不变）。
          onRenderEmpty: () => {
            const latest = node.root?.getLatest?.();
            if (!latest || latest === node.descriptor) return;
            node.descriptor = latest;
            const top = stack.value[stack.value.length - 1];
            if (top && toRaw(top) === node) currentDescriptor.value = latest;
          },
          navigation: {
            push: (next) => {
              if (!disposed && toRaw(stack.value[stack.value.length - 1]) === node) push(next);
            },
            pop: () => {
              if (!disposed && toRaw(stack.value[stack.value.length - 1]) === node) return pop();
              return false;
            }
          },
          ...(handoffSeed ? { handoffSeed } : {})
        });
        if (!stack.value.some((frame) => toRaw(frame) === node)) {
          root.unmount();
          return;
        }
        descriptor = root.getLatest();
        node.descriptor = descriptor;
        node.root = root;
        if (toRaw(stack.value[stack.value.length - 1]) === node) currentDescriptor.value = descriptor;
        return;
      } catch (e) {
        for (const frame of stack.value.splice(startIndex).reverse()) toRaw(frame)?.root?.unmount();
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

  /** 根页面（导航栈第一层）usePopoutState 登记的最新值；没有根页面或 SDK 不支持时返回 null */
  function collectRootPopoutState() {
    const rootLevel = toRaw(stack.value[0]);
    const root = rootLevel?.root ? toRaw(rootLevel.root) : null;
    if (!root || typeof root.collectPopoutState !== "function") return null;
    try {
      return root.collectPopoutState();
    } catch (error) {
      console.warn("[DeclarativeStack] 读取独立窗口交接状态失败:", error);
      return null;
    }
  }

  function replaceTopDescriptor(newDesc) {
    if (currentLevel.value) {
      currentLevel.value.descriptor = newDesc;
      currentDescriptor.value = newDesc;
    }
  }

  // 注册全局 Bridge，使子组件无论直接调用 showToast、useNavigation 还是内置服务都能与宿主连通
  const getElectronMethods = () => getHostMethods();

  const unwrapIpc = async (callPromise, fallback) => {
    try {
      const res = await callPromise;
      if (res && typeof res === "object") {
        if (res.ok === false) {
          console.warn("[DeclarativeStack] IPC 调用失败:", res?.error || res);
          return fallback;
        }
        if ("success" in res && "data" in res) {
          if (!res.success) {
            console.warn("[DeclarativeStack] IPC 调用失败:", res?.error || res);
          }
          return res.success ? res.data : fallback;
        }
      }
      return res ?? fallback;
    } catch (err) {
      console.warn("[DeclarativeStack] IPC 调用失败:", err);
      return fallback;
    }
  };

  setDeclarativeBridge({
    showToast,
    navigation: {
      push,
      pop
    },
    // 写剪贴板失败（宿主拒绝、超过上限、系统剪贴板被占用）必须抛给插件，插件才不会提示“已复制”
    copyToClipboard: async (text) => {
      const content = assertClipboardText(text);
      const methods = getElectronMethods();
      if (methods?.clipboard_copy_text) {
        await methods.clipboard_copy_text({ text: content });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
        return;
      }
      throw Object.assign(new Error("当前环境不支持写入剪贴板"), { code: "NOT_SUPPORTED" });
    },
    clearClipboard: async () => {
      const methods = getElectronMethods();
      if (methods?.clipboard_clear) {
        await methods.clipboard_clear({});
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText("");
        return;
      }
      throw Object.assign(new Error("当前环境不支持清空剪贴板"), { code: "NOT_SUPPORTED" });
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
        // 粘贴失败（如 macOS 未授权辅助功能）必须抛给插件，不能吞掉后让插件提示“已粘贴”
        await methods.clipboard_hide_and_paste_text({ text: String(text) });
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(text));
        throw Object.assign(new Error("当前宿主不支持自动粘贴，内容已复制，请手动粘贴"), { code: "NOT_SUPPORTED" });
      }
      throw Object.assign(new Error("当前宿主不支持自动粘贴"), { code: "NOT_SUPPORTED" });
    },
    pickScreenColor: () => screenColorPicker.pick(),
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
    confirmAlert: async (confirmOptions) => {
      try {
        return await showInAppConfirm(confirmOptions);
      } finally {
        try {
          onOverlayClosed?.();
        } catch (error) {
          console.warn("[declarative] 确认框关闭回调执行失败:", error);
        }
      }
    }
  });

  if (initialRoot) {
    push(initialRoot);
  }

  onUnmounted(() => {
    disposed = true;
    clearToastTimer();
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
    replaceTopDescriptor,
    collectRootPopoutState
  };
}

