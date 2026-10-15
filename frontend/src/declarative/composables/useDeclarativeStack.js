import { ref, computed, shallowRef, onUnmounted, toRaw } from "vue";
import { setDeclarativeBridge, renderDeclarativeRoot } from "@ztools/declarative-ui";

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

    if (typeof target === "function") {
      component = target;
      try {
        const node = {
          descriptor: null,
          component,
          root: null
        };
        root = renderDeclarativeRoot(target, {
          onUpdate: (newDesc) => {
            node.descriptor = newDesc;
            const top = stack.value[stack.value.length - 1];
            if (top && (toRaw(top) === node || top.root === root)) {
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

  // 注册全局 Bridge，使子组件无论直接调用 showToast 还是 useNavigation 都能与此栈连通
  setDeclarativeBridge({
    showToast,
    navigation: {
      push,
      pop
    },
    copyToClipboard: async (text) => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(String(text));
      }
    },
    readClipboardText: async () => {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        return await navigator.clipboard.readText();
      }
      return "";
    }
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
    push,
    pop,
    clear,
    replaceTopDescriptor
  };
}
