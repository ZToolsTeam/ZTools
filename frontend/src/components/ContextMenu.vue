<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ClipboardPasteIcon, CopyIcon, RotateCwIcon, ScissorsIcon, WrenchIcon } from '@lucide/vue'
import { isHostDevBuild, toggleHostDevTools } from '@/utils/hostDevTools'
import { registerKeyHandler, KEYMAP_SCOPES } from '@/utils/keymap'

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const selectedText = ref('')
const focusedIndex = ref(0)
// 「开发者工具」只在开发版显示
const showDevTools = ref(false)

// 菜单项定义
const menuItems = computed(() => {
  const items = []

  // 如果有选中文本，显示复制/剪切选项
  if (selectedText.value) {
    items.push(
      {
        label: '复制',
        icon: CopyIcon,
        action: 'copy',
        disabled: false
      },
      {
        label: '剪切',
        icon: ScissorsIcon,
        action: 'cut',
        disabled: false
      },
      {
        type: 'separator'
      }
    )
  }

  // 通用选项
  items.push(
    {
      label: '粘贴',
      icon: ClipboardPasteIcon,
      action: 'paste',
      disabled: false
    },
    {
      type: 'separator'
    },
    {
      label: '刷新页面',
      icon: RotateCwIcon,
      action: 'reload',
      disabled: false
    }
  )
  if (showDevTools.value) {
    items.push({
      label: '开发者工具',
      icon: WrenchIcon,
      action: 'devtools',
      disabled: false
    })
  }

  return items
})

const isNavigableItem = (item) => Boolean(item && item.type !== 'separator' && !item.disabled)

const getNavigableIndices = () => {
  const indices = []
  menuItems.value.forEach((item, index) => {
    if (isNavigableItem(item)) indices.push(index)
  })
  return indices
}

// 显示菜单
const show = (event) => {
  event?.preventDefault?.()
  event?.stopPropagation?.()

  // 获取选中的文本
  selectedText.value = window.getSelection?.()?.toString?.() || ''

  x.value = event?.clientX ?? 0
  y.value = event?.clientY ?? 0

  const validIndices = getNavigableIndices()
  focusedIndex.value = validIndices.length > 0 ? validIndices[0] : -1
  visible.value = true

  // 调整位置防止超出屏幕
  requestAnimationFrame(() => {
    const menu = document.querySelector('.context-menu')
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    const windowWidth = window.innerWidth
    const windowHeight = window.innerHeight

    if (rect.right > windowWidth) {
      x.value = windowWidth - rect.width - 5
    }

    if (rect.bottom > windowHeight) {
      y.value = windowHeight - rect.height - 5
    }
  })
}

// 隐藏菜单
const hide = () => {
  visible.value = false
  selectedText.value = ''
}

// 处理菜单项点击
const handleClick = async (action) => {
  hide()

  switch (action) {
    case 'copy':
      document.execCommand('copy')
      break
    case 'cut':
      document.execCommand('cut')
      break
    case 'paste':
      // 粘贴需要特殊处理，因为需要权限
      try {
        const text = await navigator.clipboard.readText()
        document.execCommand('insertText', false, text)
      } catch (err) {
        console.warn('粘贴失败:', err)
      }
      break
    case 'reload':
      window.location.reload()
      break
    case 'devtools':
      await toggleHostDevTools()
      break
  }
}

const moveFocus = (step) => {
  const validIndices = getNavigableIndices()
  if (!validIndices.length) return false
  const currentPos = validIndices.indexOf(focusedIndex.value)
  if (currentPos === -1) {
    focusedIndex.value = step >= 0 ? validIndices[0] : validIndices[validIndices.length - 1]
  } else {
    const nextPos = (currentPos + step + validIndices.length) % validIndices.length
    focusedIndex.value = validIndices[nextPos]
  }
  return true
}

const executeFocused = () => {
  const item = menuItems.value[focusedIndex.value]
  if (!isNavigableItem(item)) return false
  void handleClick(item.action)
  return true
}

// 注册模态级右键菜单键盘导航（初始停用，随 visible 同步启停，组件卸载时成对销毁）
const unregisterKeymap = registerKeyHandler(
  KEYMAP_SCOPES.ACTION_PANEL,
  {
    ArrowDown: () => moveFocus(1),
    ArrowUp: () => moveFocus(-1),
    Home: () => {
      const validIndices = getNavigableIndices()
      if (!validIndices.length) return false
      focusedIndex.value = validIndices[0]
      return true
    },
    End: () => {
      const validIndices = getNavigableIndices()
      if (!validIndices.length) return false
      focusedIndex.value = validIndices[validIndices.length - 1]
      return true
    },
    Enter: executeFocused,
    Space: executeFocused,
    Escape: () => {
      hide()
      return true
    }
  },
  { modal: true }
)

watch(
  visible,
  (isOpen) => {
    if (isOpen) unregisterKeymap.activate()
    else unregisterKeymap.deactivate()
  },
  { immediate: true, flush: 'sync' }
)

// 点击外部关闭菜单
const handleClickOutside = () => {
  if (visible.value) {
    hide()
  }
}

// 全局右键菜单事件 - 禁用右键菜单
const handleContextMenu = (event) => {
  event.preventDefault()
}

onMounted(() => {
  void isHostDevBuild().then((isDev) => { showDevTools.value = isDev })
  // 监听全局右键事件
  document.addEventListener('contextmenu', handleContextMenu)
  // 监听点击事件以关闭菜单
  document.addEventListener('click', handleClickOutside)
  window.addEventListener('blur', hide)
})

onUnmounted(() => {
  unregisterKeymap()
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('blur', hide)
})

defineExpose({ show, hide, visible, focusedIndex })
</script>

<template>
  <Teleport to="body">
    <Transition name="context-menu-fade">
      <div
        v-if="visible"
        class="context-menu"
        role="menu"
        :style="{ left: `${x}px`, top: `${y}px` }"
        @click.stop
        @contextmenu.prevent
      >
        <template v-for="(item, index) in menuItems" :key="index">
          <div v-if="item.type === 'separator'" class="menu-separator" role="separator"></div>
          <div
            v-else
            class="menu-item"
            role="menuitem"
            :class="{ disabled: item.disabled, 'is-focused': focusedIndex === index }"
            @mouseenter="!item.disabled && (focusedIndex = index)"
            @click="!item.disabled && handleClick(item.action)"
          >
            <component :is="item.icon" class="menu-icon" />
            <span class="menu-label">{{ item.label }}</span>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: var(--rc-surface);
  border: 1px solid var(--rc-border-highlight);
  border-radius: 10px;
  box-shadow: var(--rc-shadow-lg);
  padding: 4px;
  user-select: none;
  font-size: 13px;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  color: var(--rc-text-primary);
}

.menu-item:hover:not(.disabled),
.menu-item.is-focused:not(.disabled) {
  background-color: var(--rc-surface-active);
}

.menu-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.menu-item.danger {
  color: var(--rc-error);
}

.menu-item.danger:hover:not(.disabled),
.menu-item.danger.is-focused:not(.disabled) {
  background-color: var(--rc-error-subtle);
}

.menu-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.menu-label {
  flex: 1;
  white-space: nowrap;
}

.menu-separator {
  height: 1px;
  background-color: var(--rc-border);
  margin: 4px 6px;
}

/* 动画效果 */
.context-menu-fade-enter-active,
.context-menu-fade-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.context-menu-fade-enter-from {
  opacity: 0;
  transform: scale(0.95);
}

.context-menu-fade-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
