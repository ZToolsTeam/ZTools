<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  ReloadOutlined,
  CopyOutlined,
  ScissorOutlined,
  SnippetsOutlined,
  ToolOutlined
} from '@ant-design/icons-vue'
import { openDevTools } from '@/utils/internalPlugins'

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const selectedText = ref('')

// 菜单项定义
const menuItems = computed(() => {
  const items = []

  // 如果有选中文本，显示复制/剪切选项
  if (selectedText.value) {
    items.push(
      {
        label: '复制',
        icon: CopyOutlined,
        action: 'copy',
        disabled: false
      },
      {
        label: '剪切',
        icon: ScissorOutlined,
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
      icon: SnippetsOutlined,
      action: 'paste',
      disabled: false
    },
    {
      type: 'separator'
    },
    {
      label: '刷新页面',
      icon: ReloadOutlined,
      action: 'reload',
      disabled: false
    },
    {
      label: '开发者工具',
      icon: ToolOutlined,
      action: 'devtools',
      disabled: false
    }
  )

  return items
})

// 显示菜单
const show = (event) => {
  event.preventDefault()
  event.stopPropagation()

  // 获取选中的文本
  selectedText.value = window.getSelection().toString()

  x.value = event.clientX
  y.value = event.clientY
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
      await openDevTools()
      break
  }
}

// 点击外部关闭菜单
const handleClickOutside = (event) => {
  if (visible.value) {
    hide()
  }
}

// 全局右键菜单事件 - 禁用右键菜单
const handleContextMenu = (event) => {
  event.preventDefault()
}

onMounted(() => {
  // 监听全局右键事件
  document.addEventListener('contextmenu', handleContextMenu)
  // 监听点击事件以关闭菜单
  document.addEventListener('click', handleClickOutside)
  window.addEventListener('blur', hide)
})

onUnmounted(() => {
  document.removeEventListener('contextmenu', handleContextMenu)
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('blur', hide)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="context-menu-fade">
      <div
        v-if="visible"
        class="context-menu"
        :style="{ left: `${x}px`, top: `${y}px` }"
        @click.stop
        @contextmenu.prevent
      >
        <template v-for="(item, index) in menuItems" :key="index">
          <div v-if="item.type === 'separator'" class="menu-separator"></div>
          <div
            v-else
            class="menu-item"
            :class="{ disabled: item.disabled }"
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

.menu-item:hover:not(.disabled) {
  background-color: var(--rc-surface-active);
}

.menu-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.menu-item.danger {
  color: var(--rc-error);
}

.menu-item.danger:hover:not(.disabled) {
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
