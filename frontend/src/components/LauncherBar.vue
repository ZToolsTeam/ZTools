<template>
  <div
    class="launcher-window-root flex flex-col h-screen w-screen overflow-hidden select-none"
    @keydown="handleKeyDown"
  >
    <!-- 悬浮搜索条主体：克制的中性面板，橙色只用于标志、选中标记与匹配高亮 -->
    <div class="launcher-panel" :class="{ 'uses-native-corners': nativeCorners }">
      <!-- 声明式运行时形态（激活官方扩展或第三方 V2 声明式扩展时直接在悬浮条内打开） -->
      <template v-if="activeDeclarativePlugin && activeDeclarativePlugin.command">
        <div class="flex-1 flex flex-col overflow-hidden p-2">
          <DeclarativeView
            ref="declarativeViewRef"
            :key="`${activeDeclarativePlugin.pluginId}:${activeDeclarativePlugin.featureCode || ''}`"
            :rootComponent="activeDeclarativePlugin.command"
            @exit="exitDeclarative"
          />
        </div>
      </template>

      <!-- 动态加载中或加载异常兜底态 -->
      <template v-else-if="loadingDeclarative || declarativeLoadError">
        <div class="launcher-empty flex-1">
          <template v-if="loadingDeclarative">
            <p class="launcher-empty-title">正在加载声明式扩展...</p>
            <p class="launcher-empty-desc">按 Esc 可随时取消并返回搜索</p>
          </template>
          <template v-else>
            <p class="launcher-empty-title">无法打开该扩展</p>
            <p class="launcher-empty-desc">{{ declarativeLoadError }}</p>
            <RcButton variant="primary" size="sm" class="launcher-primary-btn" kbd="Escape" @click="exitDeclarative">
              返回搜索
            </RcButton>
          </template>
        </div>
      </template>

      <template v-else>
        <!-- 1. 搜索栏 -->
        <div class="launcher-head">
          <BrandMark :size="22" />
          <label for="launcherQuery" class="sr-only">搜索</label>
          <input
            id="launcherQuery"
            ref="inputRef"
            v-model="query"
            type="text"
            placeholder="搜索插件、本地软件、系统工具或文件"
            class="launcher-input"
            autocomplete="off"
            spellcheck="false"
            @mousedown="resetPinnedFocus"
          />
          <button
            v-if="query"
            type="button"
            class="launcher-icon-btn"
            title="清空"
            aria-label="清空"
            @click="clearQuery"
          >
            <XIcon class="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="launcher-workbench-btn"
            :title="`展开为工作台 ${workbenchHint}`"
            @click="expandToDashboard()"
          >
            工作台
            <ShortcutKeys :combo="TOGGLE_MODE_SHORTCUT" />
          </button>
        </div>
        <div class="launcher-hairline" aria-hidden="true"></div>

        <!-- 1.5 首屏固定磁贴宫格（搜索词为空且存在固定项时展示，输入搜索词自动收起让位） -->
        <div
          v-if="!query.trim() && displayedPinnedItems.length > 0"
          class="launcher-pinned-section"
          aria-label="固定常用"
        >
          <div class="launcher-pinned-header">
            <span class="launcher-pinned-title">固定常用 ({{ displayedPinnedItems.length }})</span>
            <span class="launcher-pinned-hint">{{ pinnedHeaderHint }}</span>
          </div>
          <div
            ref="pinnedGridRef"
            class="launcher-pinned-grid"
            :class="{ 'is-two-rows': displayedPinnedItems.length >= 10 }"
            tabindex="-1"
          >
            <div
              v-for="(pinItem, pinIdx) in displayedPinnedItems"
              :key="pinItem.pinKey || pinItem.key || pinItem.id || pinIdx"
              class="launcher-pinned-tile"
              :class="{ 'is-focused': pinnedFocusIndex === pinIdx, 'is-unavailable': pinItem.available === false }"
              :data-nav-index="pinIdx"
              data-nav-group="pinned"
              role="button"
              tabindex="-1"
              :title="pinItem.available === false ? `${pinItem.name || pinItem.title}（已失效）` : (pinItem.name || pinItem.title)"
              @click="executeItem(pinItem)"
            >
              <button
                type="button"
                tabindex="-1"
                class="launcher-pinned-unpin"
                title="取消固定"
                aria-label="取消固定"
                @click.stop="handleTogglePin(pinItem)"
              >
                ×
              </button>
              <img
                v-if="pinItem.isApplication && isTileImageIcon(pinItem.icon) && !failedTileIconKeys.has(tileIconKey(pinItem, pinIdx))"
                :src="pinItem.icon"
                class="launcher-pinned-app-icon"
                alt=""
                @error="markTileIconFailed(tileIconKey(pinItem, pinIdx))"
              />
              <RcSquircle
                v-else
                class="launcher-pinned-icon"
                :glyph="resolveItemGlyph(pinItem)"
                :fallback-glyph="resolveKeywordGlyph(pinItem.name || pinItem.title)"
                :src="!pinItem.isApplication && isTileImageIcon(pinItem.icon) ? pinItem.icon : ''"
                :size="24"
              />
              <span class="launcher-pinned-name">{{ pinItem.name || pinItem.title }}</span>
              <span v-if="pinItem.available === false" class="launcher-pinned-unavailable-tag">已失效</span>
            </div>
          </div>
        </div>

        <!-- 2. 候选结果 -->
        <div
          ref="listContainerRef"
          class="launcher-list custom-scrollbar"
          tabindex="-1"
        >
          <template v-if="visibleItems.length > 0">
            <SearchResultRow
              v-for="(item, index) in visibleItems"
              :key="item.key || item.pluginId || index"
              :ref="el => registerItemEl(index, el)"
              :item="item"
              :active="pinnedFocusIndex < 0 && activeIndex === index"
              :parts="highlightParts(item)"
              @mouseenter="pinnedFocusIndex = -1; activeIndex = index"
              @click="pinnedFocusIndex = -1; executeItem(item)"
            />
          </template>

          <div v-else class="launcher-empty" role="status">
            <p v-if="isSearching" class="launcher-empty-title">正在搜索文件与应用…</p>
            <p v-else-if="fileSearchError" class="launcher-empty-title">{{ fileSearchError }}</p>
            <p v-else class="launcher-empty-title">未找到与「{{ query }}」匹配的结果</p>
            <p v-if="!isSearching && !fileSearchError" class="launcher-empty-desc">
              {{ fileSearchDegraded ? '系统索引暂不可用，当前结果可能不完整' : '试试文件名、应用名或扩展名；也可以到插件市场查找工具' }}
            </p>
            <RcButton v-if="!isSearching && !fileSearchError" variant="primary" size="sm" class="launcher-primary-btn" kbd="Enter" @click="searchInMarket">
              在插件市场搜索
            </RcButton>
          </div>
        </div>

        <!-- 3. 底栏 -->
        <div class="launcher-foot">
          <span v-if="noViewStatus" :class="noViewStatus.isError ? 'text-[var(--rc-error)]' : 'text-[var(--rc-accent-text)]'">
            {{ noViewStatus.text }}
          </span>
          <span v-else-if="isSearching" role="status">正在搜索…</span>
          <span v-else-if="fileSearchError" role="status">{{ fileSearchError }}</span>
          <span v-else-if="fileSearchDegraded" role="status">{{ filteredItems.length }} 个结果 · 系统索引暂不可用，结果可能不完整</span>
          <span v-else>{{ filteredItems.length }} 个结果</span>
          <div class="flex items-center gap-4">
            <span class="launcher-foot-hint is-primary">打开 <ShortcutKeys combo="Enter" /></span>
            <button
              v-if="currentFocusedItem?.type === 'file' && currentFocusedItem?.available !== false"
              type="button"
              class="launcher-foot-hint"
              @click="revealFocusedFile"
            >
              定位 <ShortcutKeys combo="Ctrl+Enter" />
            </button>
            <button
              v-if="canPinActiveItem"
              type="button"
              class="launcher-foot-hint"
              @click="handleTogglePin(currentFocusedItem)"
            >
              {{ currentFocusedItem?.pinned ? '取消固定' : '固定' }} <ShortcutKeys combo="Ctrl+P" />
            </button>
            <button type="button" class="launcher-foot-hint" @click="toggleActionPanel">
              动作 <ShortcutKeys combo="Ctrl+K" />
            </button>
            <span class="launcher-foot-hint">关闭 <ShortcutKeys combo="Escape" /></span>
          </div>
        </div>
      </template>
    </div>

    <!-- 动作面板 -->
    <ActionPanelModal
      v-if="actionPanelVisible"
      :visible="actionPanelVisible"
      :actions="activeItemActions"
      :reserved-combos="LAUNCHER_PANEL_RESERVED_SHORTCUTS"
      @close="actionPanelVisible = false"
      @trigger="runLauncherAction"
    />
  </div>
</template>

<script setup>
import { XIcon } from '@lucide/vue'
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { useRouter } from 'vue-router'
import { usePluginsStore } from '@/stores/plugins'
import { switchWindowMode, WINDOW_MODES, windowModeState } from '@/utils/windowMode'
import { getOfficialPlugin } from '@/utils/officialPlugins'
import { isBundledPlugin, resolveBundledReplacement, resolveBundledReplacementFeature } from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
import {
  loadInstalledDeclarativePlugin,
  executeDeclarativeNoViewCommand
} from '@/utils/declarativePluginLoader'
import { useDeclarativePluginSession } from '@/declarative/composables/useDeclarativePluginSession'
import { ROUTES, routeUtils } from '@/router/routes'
import {
  useCommandSearch,
  isDeclarativePluginItem,
  normalizePluginFeatures,
  copyInlineAnswerToClipboard,
  PINNED_GRID_COLUMNS,
  canPinItem,
  resolvePinKey
} from '@/composables/useCommandSearch'
import {
  useKeymap,
  registerKeyHandler,
  KEYMAP_SCOPES,
  OPEN_SETTINGS_SHORTCUT,
  dispatchKeyEvent,
  isComposingEvent,
  isInputElement
} from '@/utils/keymap'
import {
  TOGGLE_MODE_SHORTCUT,
  POPOUT_WINDOW_SHORTCUT,
  SHELL_SHORTCUTS
} from '@/utils/shellShortcuts'
import {
  resolveActionKeyBindings,
  normalizeEventShortcutKey
} from '@/utils/actionKeyBindings'
import { collectVisualRowsFromDOM, computeVisualNavStep } from '@/composables/useVisualGridNav'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import { requestPopoutWindow } from '@/declarative/popoutHandoff'
import BrandMark from '@/components/BrandMark.vue'
import { RcButton, RcSquircle } from '@/components/base'
import { resolveItemGlyph, resolveKeywordGlyph } from '@/utils/brandIcons'
import SearchResultRow from '@/components/SearchResultRow.vue'
import { shortcutLabel, isMacOS, isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { win as nativeWin } from '@/api/apiserver'
import { track } from '@edition'

const router = useRouter()
const pluginsStore = usePluginsStore()
// 由宿主选择圆角策略；系统裁切时页面铺满窗口，避免两层圆角和边框互相露底。
const nativeCorners = new URLSearchParams(window.location.search).get('nativeCorners') === '1'
// 悬停提示是纯文本，按平台格式化（键帽展示统一走 ShortcutKeys）
const workbenchHint = shortcutLabel(TOGGLE_MODE_SHORTCUT)

const inputRef = ref(null)
const pinnedGridRef = ref(null)
const listContainerRef = ref(null)
const declarativeViewRef = ref(null)
const activeIndex = ref(0)
const pinnedFocusIndex = ref(-1)
const pinnedAnchorX = ref(null)
const actionPanelVisible = ref(false)
const activeDeclarativePlugin = ref(null)
// 悬浮条里原位渲染的已安装声明式插件持有会话归属
useDeclarativePluginSession(activeDeclarativePlugin, { onInvalidated: exitDeclarative })
const loadingDeclarative = ref(false)
const declarativeLoadError = ref('')
const noViewStatus = ref(null)
const failedTileIconKeys = ref(new Set())
const itemElements = new Map()

let declarativeLoadToken = 0
let executingNoViewKey = ''
let noViewStatusTimer = null
let reorderTimer = null
let pendingReorderBaseline = null
let reorderGeneration = 0

const commandSearch = useCommandSearch({ enableFileSearch: true })
const {
  query,
  fileResults,
  filteredItems,
  isSearching,
  fileSearchError,
  fileSearchDegraded,
  search,
  clearSearch,
  recordUsage,
  highlightParts
} = commandSearch
const pinnedEntries = commandSearch.pinnedEntries || computed(() => [])
const pinnedItems = commandSearch.pinnedItems || computed(() => [])
const toggleItemPin = commandSearch.toggleItemPin || (async () => ({ success: false }))
const setItemPinned = commandSearch.setItemPinned
  || ((item, pinned) => (Boolean(pinned) !== Boolean(item?.pinned) ? toggleItemPin(item) : Promise.resolve({ success: true, pinned: Boolean(pinned) })))
const reorderPinned = commandSearch.reorderPinned || (async () => ({ success: true }))
const swapPinnedKeys = commandSearch.swapPinnedKeys || null
const restorePinnedEntries = commandSearch.restorePinnedEntries || null
const refreshPanelData = commandSearch.refreshPanelData || (() => Promise.resolve())
const prepareItemForLaunch = commandSearch.prepareItemForLaunch || (async (item) => item)

function isTileImageIcon(icon) {
  return typeof icon === 'string' && /^(https?:|data:image\/|ztools:)/.test(icon)
}

function tileIconKey(item, idx) {
  return `${item?.pinKey || item?.key || idx}:${item?.icon || ''}`
}

function markTileIconFailed(key) {
  if (!key || failedTileIconKeys.value.has(key)) return
  const next = new Set(failedTileIconKeys.value)
  next.add(key)
  failedTileIconKeys.value = next
}

const displayedPinnedItems = computed(() => {
  if (query.value.trim()) return []
  return pinnedItems.value || []
})

const pinnedHeaderHint = computed(() => {
  const pinShortcut = shortcutLabel('Ctrl+P')
  if (pinnedFocusIndex.value >= 0) {
    const reorderShortcut = isMacOS()
      ? `${shortcutLabel('Ctrl+Shift')}←/→`
      : `${shortcutLabel('Ctrl+Shift')}+←/→`
    return `方向键选择 · Enter 打开 · ${reorderShortcut} 调整顺序 · ${pinShortcut} 取消固定`
  }
  return `↑ 进入固定区 · ${pinShortcut} 固定/取消`
})

async function handleTogglePin(item) {
  if (!canPinItem(item)) return
  const targetPinned = !item.pinned
  const res = await setItemPinned(item, targetPinned)
  if (res?.success) {
    showNoViewFeedback(
      res.pinned
        ? `✓ 已固定「${item.name || item.title}」到悬浮条首屏`
        : `✓ 已取消固定「${item.name || item.title}」`,
      false
    )
  } else if (res?.error) {
    showNoViewFeedback(res.error, true)
  }
}

// 结果再多也只渲染前 50 条：键盘上下选择、Enter 与动作面板都只在这 50 条里进行
const MAX_VISIBLE_ITEMS = 50
const visibleItems = computed(() => filteredItems.value.slice(0, MAX_VISIBLE_ITEMS))

const currentFocusedItem = computed(() => {
  if (pinnedFocusIndex.value >= 0 && displayedPinnedItems.value[pinnedFocusIndex.value]) {
    return displayedPinnedItems.value[pinnedFocusIndex.value]
  }
  return visibleItems.value[activeIndex.value] || null
})

const canPinActiveItem = computed(() => canPinItem(currentFocusedItem.value))

function registerItemEl(index, el) {
  const node = el?.$el ?? el
  if (node) itemElements.set(index, node)
  else itemElements.delete(index)
}

function showNoViewFeedback(text, isError = false) {
  if (noViewStatusTimer) {
    clearTimeout(noViewStatusTimer)
    noViewStatusTimer = null
  }
  noViewStatus.value = { text: String(text || ''), isError: Boolean(isError) }
  noViewStatusTimer = setTimeout(() => {
    noViewStatus.value = null
    noViewStatusTimer = null
  }, 2600)
}

function findInstalledPluginMeta(pluginId) {
  const pid = String(pluginId || '').trim().toLowerCase()
  if (!pid) return null
  return (pluginsStore.installedPlugins || []).find(
    (p) => String(p?.pluginId || p?.id || '').trim().toLowerCase() === pid
  ) || null
}

function isDeclarativeTarget(pluginId, item = null) {
  if (item && item.isDeclarative === true) return true
  const pid = String(pluginId || '').trim()
  if (!pid) return false
  if ((isBundledPlugin(pid) && !pluginsStore.isBundledHidden(pid)) || getOfficialPlugin(pid)) return true
  const installed = findInstalledPluginMeta(pid)
  return isDeclarativePluginItem(installed)
}

// 当前聚焦项的 ActionPanel 动作
// 动作面板只负责选择，执行交给动作自己的 onAction；单个动作出错不影响悬浮条
const runLauncherAction = (action) => {
  try {
    action?.props?.onAction?.()
  } catch (error) {
    console.warn('[LauncherBar] 执行动作失败:', error)
  }
}

function appendPinnedTileActions(actions, item) {
  if (pinnedFocusIndex.value < 0) return
  if (canPinItem(item) && !actions.some((a) => a.props?.title === '从悬浮条首屏取消固定' || a.props?.title === '固定到悬浮条首屏')) {
    actions.push({
      type: 'Action',
      props: {
        title: item.pinned ? '从悬浮条首屏取消固定' : '固定到悬浮条首屏',
        shortcut: { modifiers: ['Ctrl'], key: 'P' },
        onAction: () => {
          actionPanelVisible.value = false
          handleTogglePin(item)
        }
      }
    })
  }
  const total = displayedPinnedItems.value.length
  if (total <= 1) return
  if (pinnedFocusIndex.value > 0) {
    actions.push({
      type: 'Action',
      props: {
        title: '前移',
        shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'ArrowLeft' },
        onAction: () => {
          actionPanelVisible.value = false
          handlePinnedReorder(-1, true)
        }
      }
    })
  }
  if (pinnedFocusIndex.value < total - 1) {
    actions.push({
      type: 'Action',
      props: {
        title: '后移',
        shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'ArrowRight' },
        onAction: () => {
          actionPanelVisible.value = false
          handlePinnedReorder(1, true)
        }
      }
    })
  }
}

const activeItemActions = computed(() => {
  const item = currentFocusedItem.value
  if (!item) return []

  if (item.available === false) {
    const unavailableActions = []
    appendPinnedTileActions(unavailableActions, item)
    return unavailableActions
  }

  if (item.type === 'inline-calculator' || item.type === 'inline-color') {
    const calcActions = [
      {
        type: 'Action',
        props: {
          title: `复制结果 (${item.answer})`,
          shortcut: { modifiers: [], key: 'Enter' },
          onAction: () => {
            actionPanelVisible.value = false
            executeItem(item)
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: `复制完整等式 (${item.expression} = ${item.answer})`,
          shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'C' },
          onAction: async () => {
            actionPanelVisible.value = false
            const eq = `${item.expression} = ${item.answer}`
            const ok = await copyInlineAnswerToClipboard(eq)
            if (ok !== false) {
              showNoViewFeedback(`✓ 已复制等式: ${eq}`, false)
            } else {
              showNoViewFeedback("复制等式失败，请重试", true)
            }
          }
        }
      }
    ]

    if (item.type === 'inline-color' && item.colorResult) {
      calcActions.push(
        {
          type: 'Action',
          props: {
            title: `复制 RGB (${item.colorResult.rgb})`,
            onAction: async () => {
              actionPanelVisible.value = false
              const ok = await copyInlineAnswerToClipboard(item.colorResult.rgb)
              if (ok !== false) {
                showNoViewFeedback(`✓ 已复制 RGB: ${item.colorResult.rgb}`, false)
              } else {
                showNoViewFeedback("复制 RGB 失败，请重试", true)
              }
            }
          }
        },
        {
          type: 'Action',
          props: {
            title: `复制 HSL (${item.colorResult.hsl})`,
            onAction: async () => {
              actionPanelVisible.value = false
              const ok = await copyInlineAnswerToClipboard(item.colorResult.hsl)
              if (ok !== false) {
                showNoViewFeedback(`✓ 已复制 HSL: ${item.colorResult.hsl}`, false)
              } else {
                showNoViewFeedback("复制 HSL 失败，请重试", true)
              }
            }
          }
        }
      )
    }

    calcActions.push({
      type: 'Action',
      props: {
        title: '打开完整计算器与历史视图',
        shortcut: { modifiers: ['Ctrl'], key: 'O' },
        onAction: () => {
          actionPanelVisible.value = false
          launchPlugin('calculator', { isDeclarative: true })
        }
      }
    })

    return calcActions
  }

  if (item.type === 'file') {
    const fileActions = [
      {
        type: 'Action',
        props: {
          title: item.isApplication ? '打开应用' : item.isDir ? '打开文件夹' : '打开文件',
          onAction: () => {
            actionPanelVisible.value = false
            if (item.isPinnedTile && item.pinKey) {
              void openPinnedFileItem(item, 'open')
            } else {
              openFile(item.path)
            }
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: isMacOS() ? '在访达中显示' : '在资源管理器中定位',
          shortcut: { modifiers: ['Ctrl'], key: 'Enter' },
          onAction: () => {
            actionPanelVisible.value = false
            if (item.isPinnedTile && item.pinKey) {
              void openPinnedFileItem(item, 'reveal')
            } else {
              showInFolder(item.path)
            }
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '复制文件绝对路径',
          shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'C' },
          onAction: () => {
            actionPanelVisible.value = false
            copyFileText(item.path, '文件路径')
          }
        }
      },
      {
        type: 'Action',
        props: {
          title: '复制文件名',
          shortcut: { modifiers: ['Ctrl'], key: 'C' },
          onAction: () => {
            actionPanelVisible.value = false
            copyFileText(item.fileName || item.name, '文件名')
          }
        }
      }
    ]
    if (canPinItem(item)) {
      fileActions.push({
        type: 'Action',
        props: {
          title: item.pinned ? '从悬浮条首屏取消固定' : '固定到悬浮条首屏',
          shortcut: { modifiers: ['Ctrl'], key: 'P' },
          onAction: () => {
            actionPanelVisible.value = false
            handleTogglePin(item)
          }
        }
      })
    }
    appendPinnedTileActions(fileActions, item)
    fileActions.push({
      type: 'Action',
      props: {
        title: '展开为完整工作台',
        shortcut: { modifiers: ['Ctrl'], key: 'U' },
        onAction: () => {
          actionPanelVisible.value = false
          expandToDashboard()
        }
      }
    })
    return fileActions
  }

  const actions = [
    {
      type: 'Action',
      props: {
        title: item.actionLabel || '执行操作',
        onAction: () => {
          actionPanelVisible.value = false
          executeItem(item)
        }
      }
    }
  ]

  // 聚合插件声明的 features 子命令到 Ctrl+K 动作面板
  const features = Array.isArray(item.features)
    ? item.features
    : item.pluginId
      ? normalizePluginFeatures(findInstalledPluginMeta(item.pluginId))
      : []

  for (const feat of features) {
    if (item.featureCode && item.featureCode === feat.code) continue
    actions.push({
      type: 'Action',
      props: {
        title: `${feat.mode === 'no-view' ? '执行' : '打开'}：${feat.explain}`,
        onAction: () => {
          actionPanelVisible.value = false
          executeItem({
            key: `${item.pluginId}:${feat.code}`,
            type: 'plugin-feature',
            pluginId: item.pluginId,
            featureCode: feat.code,
            name: feat.explain,
            mode: feat.mode,
            isDeclarative: isDeclarativeTarget(item.pluginId, item)
          })
        }
      }
    })
  }

  if (item.pluginId && isDeclarativeTarget(item.pluginId, item) && item.mode !== 'no-view') {
    actions.push({
      type: 'Action',
      props: {
        title: '在独立常驻窗口中打开',
        shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'P' },
        onAction: () => {
          actionPanelVisible.value = false
          popoutDeclarativePlugin(item.pluginId, item.featureCode || '')
        }
      }
    })
  }

  if (canPinItem(item)) {
    actions.push({
      type: 'Action',
      props: {
        title: item.pinned ? '从悬浮条首屏取消固定' : '固定到悬浮条首屏',
        shortcut: { modifiers: ['Ctrl'], key: 'P' },
        onAction: () => {
          actionPanelVisible.value = false
          handleTogglePin(item)
        }
      }
    })
  }

  appendPinnedTileActions(actions, item)

  if (item.pluginId) {
    actions.push({
      type: 'Action',
      props: {
        title: '在完整工作台查看详情',
        shortcut: { modifiers: ['Ctrl'], key: 'O' },
        onAction: () => {
          actionPanelVisible.value = false
          expandToDashboard(`/details/${item.pluginId}`)
        }
      }
    })
  }

  actions.push({
    type: 'Action',
    props: {
      title: '展开为完整应用中心大窗口',
      shortcut: { modifiers: ['Ctrl'], key: 'U' },
      onAction: () => {
        actionPanelVisible.value = false
        expandToDashboard()
      }
    }
  })

  return actions
})

function scrollToActiveItem() {
  nextTick(() => {
    const el = itemElements.get(activeIndex.value)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
}

function resetPinnedFocus() {
  pinnedFocusIndex.value = -1
  pinnedAnchorX.value = null
}

function resetPinnedScroll() {
  if (pinnedGridRef.value) {
    pinnedGridRef.value.scrollTop = 0
  }
}

function scrollPinnedTileIntoView(index = pinnedFocusIndex.value) {
  if (index < 0) return
  nextTick(() => {
    const el = pinnedGridRef.value?.querySelector?.(`[data-nav-index="${index}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    }
  })
}

function focusPinnedGrid() {
  inputRef.value?.blur?.()
  pinnedGridRef.value?.focus?.({ preventScroll: true })
}

function focusSearchInputFromPinned() {
  resetPinnedFocus()
  inputRef.value?.focus?.()
}

function getPinnedVisualRows() {
  const count = displayedPinnedItems.value.length
  if (count <= 0) return []
  return collectVisualRowsFromDOM(pinnedGridRef.value, {
    totalCount: count,
    fallbackColumns: PINNED_GRID_COLUMNS || 9,
    getGroup: () => 'pinned'
  })
}

/**
 * 计算按 ↑ 进入固定宫格时的目标磁贴：当前可见区域最后一排第 1 项；
 * 在 JSDOM 无真实几何时安全回退为最后一排第 1 项。
 */
function resolveLastVisiblePinnedRowFirstCell(rows) {
  if (!rows.length) return null
  const container = pinnedGridRef.value
  if (!container) return rows[rows.length - 1][0]

  const clientHeight = Number(container.clientHeight) || 0
  const scrollTop = Number(container.scrollTop) || 0
  const containerRect = typeof container.getBoundingClientRect === 'function'
    ? container.getBoundingClientRect()
    : { top: 0, bottom: 0, height: 0 }

  if (containerRect.height > 0) {
    const visibleRows = rows.filter((row) => {
      const cell = row[0]
      return cell.height > 0 && cell.top >= containerRect.top - 4 && (cell.top + cell.height) <= containerRect.bottom + 4
    })
    if (visibleRows.length > 0) return visibleRows[visibleRows.length - 1][0]
  }

  if (clientHeight > 0 && typeof container.querySelector === 'function') {
    const visibleRows = rows.filter((row) => {
      const el = container.querySelector(`[data-nav-index="${row[0].index}"]`)
      if (!el) return false
      const top = Number(el.offsetTop) || 0
      const height = Number(el.offsetHeight) || 0
      return height > 0 && top >= scrollTop - 4 && (top + height) <= (scrollTop + clientHeight + 4)
    })
    if (visibleRows.length > 0) return visibleRows[visibleRows.length - 1][0]
  }

  return rows[rows.length - 1][0]
}

watch(query, (newVal) => {
  if (newVal.trim()) {
    resetPinnedFocus()
  } else {
    nextTick(resetPinnedScroll)
  }
  activeIndex.value = 0
  scrollToActiveItem()
  search(newVal)
})

// 固定项减少或清空时钳制宫格焦点索引；回退到 <= 9 项时复位滚动位置
watch(
  () => displayedPinnedItems.value.length,
  (len) => {
    if (len <= PINNED_GRID_COLUMNS) {
      resetPinnedScroll()
      nextTick(resetPinnedScroll)
    }
    if (pinnedFocusIndex.value < 0) return
    if (len <= 0) {
      focusSearchInputFromPinned()
    } else if (pinnedFocusIndex.value >= len) {
      pinnedFocusIndex.value = len - 1
    }
  }
)

// 输入没变时列表也会变短（文件结果到达替换掉保留的旧结果）：选中项不能落到列表外
watch(() => visibleItems.value.length, (length) => {
  if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
})

function clearQuery() {
  resetPinnedFocus()
  resetPinnedScroll()
  clearSearch()
  activeIndex.value = 0
  nextTick(resetPinnedScroll)
}

function exitDeclarative() {
  declarativeLoadToken++
  loadingDeclarative.value = false
  declarativeLoadError.value = ''
  activeDeclarativePlugin.value = null
  resetPinnedFocus()
  nextTick(() => {
    inputRef.value?.focus()
  })
}

function isLauncherNavBlocked() {
  return Boolean(
    actionPanelVisible.value ||
    activeDeclarativePlugin.value ||
    loadingDeclarative.value ||
    declarativeLoadError.value
  )
}

function handleLauncherArrowDown() {
  if (isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value >= 0) {
    const rows = getPinnedVisualRows()
    if (rows.length === 0) {
      focusSearchInputFromPinned()
      return false
    }
    const step = computeVisualNavStep(rows, pinnedFocusIndex.value, 'ArrowDown', {
      preferredCenterX: pinnedAnchorX.value
    })
    if (step.reachBottom) {
      resetPinnedFocus()
      activeIndex.value = 0
      scrollToActiveItem()
      inputRef.value?.focus?.()
      return true
    }
    if (step.nextIndex >= 0) {
      pinnedFocusIndex.value = step.nextIndex
    }
    if (step.nextAnchorX !== null) {
      pinnedAnchorX.value = step.nextAnchorX
    }
    scrollPinnedTileIntoView(pinnedFocusIndex.value)
    return true
  }

  if (visibleItems.value.length > 0) {
    activeIndex.value = (activeIndex.value + 1) % visibleItems.value.length
    scrollToActiveItem()
    return true
  }
  return false
}

function handleLauncherArrowUp() {
  if (isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value >= 0) {
    const rows = getPinnedVisualRows()
    if (rows.length === 0) {
      focusSearchInputFromPinned()
      return true
    }
    const step = computeVisualNavStep(rows, pinnedFocusIndex.value, 'ArrowUp', {
      preferredCenterX: pinnedAnchorX.value
    })
    if (step.reachTop) {
      focusSearchInputFromPinned()
      return true
    }
    if (step.nextIndex >= 0) {
      pinnedFocusIndex.value = step.nextIndex
    }
    if (step.nextAnchorX !== null) {
      pinnedAnchorX.value = step.nextAnchorX
    }
    scrollPinnedTileIntoView(pinnedFocusIndex.value)
    return true
  }

  // 空搜索词且存在首屏固定宫格时，从列表第 0 行按 ↑ 进入当前可见区域最后一排第 1 项
  if (
    !query.value.trim() &&
    displayedPinnedItems.value.length > 0 &&
    (visibleItems.value.length === 0 || activeIndex.value === 0)
  ) {
    const rows = getPinnedVisualRows()
    const targetCell = resolveLastVisiblePinnedRowFirstCell(rows)
    if (targetCell) {
      pinnedFocusIndex.value = targetCell.index
      pinnedAnchorX.value = targetCell.centerX
      focusPinnedGrid()
      scrollPinnedTileIntoView(targetCell.index)
      return true
    }
  }

  if (visibleItems.value.length > 0) {
    activeIndex.value = (activeIndex.value - 1 + visibleItems.value.length) % visibleItems.value.length
    scrollToActiveItem()
    return true
  }
  return false
}

function handleLauncherHorizontalKey(key) {
  if (isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value < 0) return false
  const rows = getPinnedVisualRows()
  if (rows.length === 0) return false
  const step = computeVisualNavStep(rows, pinnedFocusIndex.value, key, {
    preferredCenterX: pinnedAnchorX.value
  })
  if (step.nextIndex >= 0) {
    pinnedFocusIndex.value = step.nextIndex
  }
  if (step.nextAnchorX !== null) {
    pinnedAnchorX.value = step.nextAnchorX
  }
  scrollPinnedTileIntoView(pinnedFocusIndex.value)
  return true
}

function handleLauncherHomeEnd(key) {
  if (isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value >= 0) {
    const rows = getPinnedVisualRows()
    if (rows.length === 0) return false
    const step = computeVisualNavStep(rows, pinnedFocusIndex.value, key, {
      preferredCenterX: pinnedAnchorX.value
    })
    if (step.nextIndex >= 0) {
      pinnedFocusIndex.value = step.nextIndex
    }
    if (step.nextAnchorX !== null) {
      pinnedAnchorX.value = step.nextAnchorX
    }
    scrollPinnedTileIntoView(pinnedFocusIndex.value)
    return true
  }

  if (visibleItems.value.length > 0) {
    activeIndex.value = key === 'Home' ? 0 : visibleItems.value.length - 1
    scrollToActiveItem()
    return true
  }
  return false
}

function handleLauncherPageStep(delta) {
  if (isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value >= 0) {
    if (delta > 0 && visibleItems.value.length > 0) {
      resetPinnedFocus()
      activeIndex.value = 0
      scrollToActiveItem()
      inputRef.value?.focus?.()
      return true
    }
    if (delta < 0) {
      pinnedFocusIndex.value = 0
      scrollPinnedTileIntoView(0)
      return true
    }
    return false
  }

  if (visibleItems.value.length > 0) {
    activeIndex.value = Math.min(visibleItems.value.length - 1, Math.max(0, activeIndex.value + delta))
    scrollToActiveItem()
    return true
  }
  return false
}

/**
 * 调整固定磁贴顺序（跨行连续交换相邻可见项，跳过隐藏/下架项并维持其在底层数组的位置）；
 * 本地乐观更新后 150ms 防抖提交主进程，失败或 stale 时回滚并提示。
 */
function handlePinnedReorder(delta, allowFromPanel = false) {
  if (!allowFromPanel && isLauncherNavBlocked()) return false
  if (pinnedFocusIndex.value < 0) return false
  const list = displayedPinnedItems.value
  const curIdx = pinnedFocusIndex.value
  const targetIdx = curIdx + delta
  if (list.length <= 1 || targetIdx < 0 || targetIdx >= list.length) return true

  const curItem = list[curIdx]
  const adjItem = list[targetIdx]
  if (!curItem || !adjItem) return true

  const curPinKey = curItem.pinKey || resolvePinKey(curItem)
  const adjPinKey = adjItem.pinKey || resolvePinKey(adjItem)
  if (!curPinKey || !adjPinKey) return true

  const movedKind = curItem.pinEntry?.kind || resolvePinKey(curItem).split(':')[0] || 'unknown'
  if (reorderTimer === null && !pendingReorderBaseline && Array.isArray(pinnedEntries.value) && pinnedEntries.value.length > 0) {
    pendingReorderBaseline = [...pinnedEntries.value]
  }

  let nextOrder = null
  if (typeof swapPinnedKeys === 'function' && Array.isArray(pinnedEntries.value) && pinnedEntries.value.length > 0) {
    nextOrder = swapPinnedKeys(curPinKey, adjPinKey)
  } else {
    const keys = list.map((item) => item.pinKey || resolvePinKey(item)).filter(Boolean)
    const temp = keys[curIdx]
    keys[curIdx] = keys[targetIdx]
    keys[targetIdx] = temp
    nextOrder = keys
  }
  if (!Array.isArray(nextOrder) || nextOrder.length === 0) return true

  pinnedFocusIndex.value = targetIdx
  pinnedAnchorX.value = null
  scrollPinnedTileIntoView(targetIdx)

  if (reorderTimer) {
    clearTimeout(reorderTimer)
    reorderTimer = null
  }
  const generation = ++reorderGeneration
  const baseline = pendingReorderBaseline
  reorderTimer = setTimeout(() => {
    reorderTimer = null
    pendingReorderBaseline = null
    void commitPinnedReorder(nextOrder, movedKind, baseline, generation)
  }, 150)

  return true
}

async function commitPinnedReorder(order, kind, baseline, generation) {
  const res = await reorderPinned(order, { kind, baselineEntries: baseline })
  if (res?.success === false || res?.stale) {
    if (generation === reorderGeneration || res?.stale) {
      if (!Array.isArray(res?.pinnedEntries) && baseline && typeof restorePinnedEntries === 'function') {
        restorePinnedEntries(baseline)
      }
      showNoViewFeedback(res?.error || '调整固定顺序失败，已恢复原顺序', true)
    }
  }
}

// 悬浮条动作面板专属保留键：不屏蔽 Ctrl+U（展开工作台）与 Ctrl+Shift+P（独立窗），使其在面板中可见且可直达
const LAUNCHER_PANEL_RESERVED_SHORTCUTS = new Set([
  SHELL_SHORTCUTS.ACTION_PANEL,
  SHELL_SHORTCUTS.OPEN_SETTINGS,
  'Escape'
])

// 悬浮条「所见即所按」快捷键解析器
const resolvedLauncherBindings = computed(() =>
  resolveActionKeyBindings(activeItemActions.value, {
    viewType: 'List',
    reservedCombos: LAUNCHER_PANEL_RESERVED_SHORTCUTS
  })
)

function revealFocusedFile() {
  const cur = currentFocusedItem.value
  if (!cur || cur.type !== 'file' || cur.available === false) return
  if (cur.isPinnedTile && cur.pinKey) {
    void openPinnedFileItem(cur, 'reveal')
  } else {
    showInFolder(cur.path)
  }
}

function hasLauncherInputSelection(el) {
  try {
    return typeof el?.selectionStart === 'number' && el.selectionStart !== el.selectionEnd
  } catch {
    return false
  }
}

/** 悬浮条搜索框里的原生编辑键保留给输入框（有选区保护 Ctrl+C/X；粘贴/撤销/重做始终保护） */
function isLauncherNativeEditCombo(e) {
  const target = e?.target
  if (!target || typeof target.tagName !== 'string') return false
  const tag = target.tagName.toUpperCase()
  const isText =
    tag === 'TEXTAREA' ||
    (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(String(target.type || '').toLowerCase()))
  if (!isText || e.altKey || !(e.ctrlKey || e.metaKey)) return false

  const keyLower = normalizeEventShortcutKey(e).toLowerCase()
  const hasValue = Boolean(target.value)
  if (!e.shiftKey) {
    if (keyLower === 'c' || keyLower === 'x') return hasLauncherInputSelection(target)
    if (keyLower === 'v' || keyLower === 'z' || keyLower === 'y') return true
    if (keyLower === 'a' || keyLower === 'backspace' || keyLower === 'delete') return hasValue
    return false
  }
  return keyLower === 'z'
}

/** 悬浮条非编辑态直达当前聚焦条目的动作快捷键（如 Ctrl+Shift+C、Ctrl+C、Ctrl+O 等） */
function handleLauncherActionShortcut(e) {
  if (actionPanelVisible.value) return false
  if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
  if (!(e.ctrlKey || e.metaKey || e.altKey)) {
    if (isInputElement(e.target)) return false
    const keyName = normalizeEventShortcutKey(e)
    if (['Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(keyName)) {
      return false
    }
  }
  if (isLauncherNativeEditCombo(e)) return false
  const matched = resolvedLauncherBindings.value.matchEvent(e)
  if (!matched) return false
  runLauncherAction(matched)
  return true
}

// 宿主保留热键：高于 DECLARATIVE 作用域，保证悬浮条内嵌运行插件时 Ctrl+Shift+P 仍能弹出独立常驻窗口
useKeymap(KEYMAP_SCOPES.HOST_RESERVED, {
  [POPOUT_WINDOW_SHORTCUT]: () => {
    if (actionPanelVisible.value) return false
    if (activeDeclarativePlugin.value) {
      popoutDeclarativePlugin(
        activeDeclarativePlugin.value.pluginId,
        activeDeclarativePlugin.value.featureCode || '',
        collectDeclarativeQuery(activeDeclarativePlugin.value)
      )
      return true
    }
    const cur = currentFocusedItem.value
    if (cur && cur.pluginId && isDeclarativeTarget(cur.pluginId, cur) && cur.mode !== 'no-view') {
      popoutDeclarativePlugin(cur.pluginId, cur.featureCode || '')
      return true
    }
    return false
  }
})

// 跨窗口级直达热键（非模态挂载于顶层作用域，保证动作面板打开期间按 Ctrl+, / Ctrl+U 仍能立即收起面板并跳转主窗口）
useKeymap(KEYMAP_SCOPES.ACTION_PANEL, {
  [TOGGLE_MODE_SHORTCUT]: () => {
    expandToDashboard()
    return true
  },
  [OPEN_SETTINGS_SHORTCUT]: () => {
    expandToDashboard(ROUTES.ADVANCED_SETTINGS)
    return true
  }
})

// 先注册通用动作快捷键解析器，再注册固定页级按键表（LIFO 确保 Enter / Ctrl+K / Ctrl+P 等固定键优先）
const unregisterLauncherActionShortcuts = registerKeyHandler(KEYMAP_SCOPES.PAGE, handleLauncherActionShortcut)
onBeforeUnmount(() => unregisterLauncherActionShortcuts())

// 统一注册极客工具条按键 (PAGE 作用域)
useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowDown': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherArrowDown()
  },
  'ArrowUp': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherArrowUp()
  },
  'ArrowLeft': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherHorizontalKey('ArrowLeft')
  },
  'ArrowRight': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherHorizontalKey('ArrowRight')
  },
  'Home': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherHomeEnd('Home')
  },
  'End': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherHomeEnd('End')
  },
  'PageUp': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherPageStep(-8)
  },
  'PageDown': () => {
    if (actionPanelVisible.value) return false
    return handleLauncherPageStep(8)
  },
  'Enter': () => {
    if (actionPanelVisible.value) return false
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    if (pinnedFocusIndex.value >= 0) {
      const pinTarget = displayedPinnedItems.value[pinnedFocusIndex.value]
      if (pinTarget) {
        executeItem(pinTarget)
        return true
      }
    }
    if (visibleItems.value.length > 0) {
      executeItem(visibleItems.value[activeIndex.value])
      return true
    } else if (query.value.trim() && !isSearching.value && !fileSearchError.value) {
      searchInMarket()
      return true
    }
    return false
  },
  'Ctrl+Enter': () => {
    if (actionPanelVisible.value) return false
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    const cur = currentFocusedItem.value
    if (!cur) return false
    if (cur.available === false) {
      executeItem(cur)
      return true
    }
    if (cur.type === 'file') {
      revealFocusedFile()
      return true
    } else {
      executeItem(cur)
      return true
    }
  },
  'Ctrl+K': () => {
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    toggleActionPanel()
    return true
  },
  'Ctrl+P': () => {
    if (actionPanelVisible.value) return false
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    const cur = currentFocusedItem.value
    if (canPinItem(cur)) {
      handleTogglePin(cur)
      return true
    }
    return false
  },
  'Ctrl+Shift+ArrowLeft': () => handlePinnedReorder(-1),
  'Ctrl+Shift+ArrowRight': () => handlePinnedReorder(1),
  'Escape': () => {
    if (loadingDeclarative.value || declarativeLoadError.value) {
      exitDeclarative()
      return true
    }
    if (activeDeclarativePlugin.value) return false
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
      return true
    } else if (pinnedFocusIndex.value >= 0) {
      focusSearchInputFromPinned()
      return true
    } else if (query.value) {
      clearQuery()
      return true
    } else {
      resetPinnedFocus()
      hideLauncher()
      return true
    }
  }
})

function handleKeyDown(e) {
  if (isComposingEvent(e)) return
  // 焦点位于固定宫格时敲击可打印字符或退格键，自动将焦点交还顶部搜索框以无缝继续输入
  if (
    pinnedFocusIndex.value >= 0 &&
    !isLauncherNavBlocked() &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    ((typeof e.key === 'string' && e.key.length === 1) || e.key === 'Backspace')
  ) {
    focusSearchInputFromPinned()
  }

  if (dispatchKeyEvent(e)) return

  // 补充处理单行搜索框无需占用的列表翻页键，以及空搜索框或宫格激活期间的受保护方向/首尾键
  if (isLauncherNavBlocked() || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  if (e.key === 'PageUp') {
    if (handleLauncherPageStep(-8)) e.preventDefault()
  } else if (e.key === 'PageDown') {
    if (handleLauncherPageStep(8)) e.preventDefault()
  } else if (pinnedFocusIndex.value >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (handleLauncherHorizontalKey(e.key)) e.preventDefault()
  } else if ((pinnedFocusIndex.value >= 0 || !query.value) && (e.key === 'Home' || e.key === 'End')) {
    if (handleLauncherHomeEnd(e.key)) e.preventDefault()
  }
}

let fileActionPending = false
let externalPluginPending = false

function finishExternalLaunch(searchAtStart) {
  // 打开期间用户可能已经开始下一次搜索，旧请求不能清空或关闭新的搜索。
  if (query.value !== searchAtStart) return
  clearQuery()
  hideLauncher()
}

async function copyFileText(text, label) {
  const copied = await copyInlineAnswerToClipboard(text)
  showNoViewFeedback(copied ? `已复制${label}` : `复制${label}失败，请重试`, !copied)
}

async function runFileAction(filePath, action, failureMessage) {
  if (fileActionPending) return
  fileActionPending = true
  const searchAtStart = query.value
  try {
    const bridge = typeof window.__ztoolsLauncher?.[action] === 'function'
      ? window.__ztoolsLauncher : window.ztools?.shell
    if (typeof bridge?.[action] !== 'function') throw new Error('文件操作接口不可用')
    const result = await bridge[action](filePath)
    if (result !== true && result?.success !== true) {
      throw new Error(result?.error?.message || result?.error || failureMessage)
    }
    finishExternalLaunch(searchAtStart)
  } catch (error) {
    console.warn('[LauncherBar] 文件操作失败:', error)
    showNoViewFeedback(error?.message || failureMessage, true)
  } finally {
    fileActionPending = false
  }
}

function openFile(filePath) {
  return runFileAction(filePath, 'openPath', '打开文件失败')
}

/** 冷启动时用使用记录占位的程序：等程序列表返回、拿到打开授权后再打开 */
async function openPendingApplication(item) {
  const ready = await prepareItemForLaunch(item)
  if (!ready) {
    showNoViewFeedback('程序列表读取失败或该程序已卸载', true)
    return
  }
  await openFile(ready.path)
}

function showInFolder(filePath) {
  return runFileAction(filePath, 'showItemInFolder', '定位文件失败')
}

async function openPinnedFileItem(item, action = 'open') {
  if (!item?.pinKey || fileActionPending) return
  fileActionPending = true
  const searchAtStart = query.value
  const failureMessage = action === 'reveal' ? '定位文件失败' : '打开文件失败'
  try {
    const bridge = window.__ztoolsLauncher
    if (typeof bridge?.openPanelItem !== 'function') {
      throw new Error('当前环境不支持启动该条目')
    }
    const res = await bridge.openPanelItem(item.pinKey, 'pinned', '', action)
    if (res?.success === false) {
      throw new Error(res?.error?.message || res?.error || failureMessage)
    }
    finishExternalLaunch(searchAtStart)
  } catch (err) {
    console.warn('[LauncherBar] 打开固定文件条目失败:', err)
    showNoViewFeedback(err?.message || failureMessage, true)
  } finally {
    fileActionPending = false
  }
}

async function openPanelEntry(item) {
  if (!item?.id) return
  const searchAtStart = query.value
  try {
    const bridge = window.__ztoolsLauncher
    if (typeof bridge?.openPanelItem !== 'function') {
      throw new Error('当前环境不支持启动该条目')
    }
    const itemType = item.panelItemType || 'system_tool'
    const res = await bridge.openPanelItem(item.id, itemType, query.value)
    if (res?.success === false) {
      throw new Error(res?.error?.message || res?.error || '打开条目失败')
    }
    finishExternalLaunch(searchAtStart)
  } catch (err) {
    console.warn('[LauncherBar] 打开面板条目失败:', err)
    showNoViewFeedback(err?.message || '打开条目失败', true)
  }
}

function executeItem(item) {
  if (!item) return
  if (item.available === false) {
    showNoViewFeedback(item.unavailableReason || '该固定项已失效，可按 Ctrl+P 或点击 × 取消固定', true)
    return
  }
  if (!item.omitFromFrecencyTracking) {
    recordUsage(item.key || item.pluginId, item)
  }
  if (item.type === 'inline-calculator' || item.type === 'inline-color') {
    Promise.resolve(item.action?.()).then((ok) => {
      if (ok !== false) {
        showNoViewFeedback(`✓ 已复制结果: ${item.answer}`, false)
      } else {
        showNoViewFeedback("复制结果失败，请重试", true)
      }
    })
    return
  }
  if (item.type === 'system-tool') {
    openPanelEntry(item)
    return
  }
  if (item.type === 'file') {
    if (item.isPinnedTile && item.pinKey) {
      void openPinnedFileItem(item, 'open')
    } else if (item.pendingGrant) {
      void openPendingApplication(item)
    } else {
      openFile(item.path)
    }
  } else if (typeof item.action === 'function') {
    item.action()
  } else if (item.mode === 'no-view' && item.pluginId) {
    runNoViewCommand(item)
  } else if (item.pluginId) {
    launchPlugin(item.pluginId, {
      featureCode: item.featureCode || '',
      isDeclarative: isDeclarativeTarget(item.pluginId, item)
    })
  }
}

async function runNoViewCommand(item) {
  const lockKey = `${item.pluginId}:${item.featureCode || ''}`
  if (executingNoViewKey === lockKey) return
  executingNoViewKey = lockKey

  try {
    await pluginsStore.markRecent?.(item.pluginId)
    const res = await executeDeclarativeNoViewCommand(item.pluginId, {
      featureCode: item.featureCode || '',
      query: query.value
    })
    showNoViewFeedback(`✓ ${res.message || `${item.name || item.title} 已执行`}`, false)
  } catch (err) {
    showNoViewFeedback(err?.message || '执行极速动作失败', true)
  } finally {
    if (executingNoViewKey === lockKey) {
      executingNoViewKey = ''
    }
  }
}

async function launchPlugin(pluginId, options = {}) {
  // 已合并进内置插件的旧插件（如 notes → memo, dictionary → translator:translate-dict）直接打开保留的那个
  const rawPluginId = String(pluginId || '').trim()
  const pid = resolveBundledReplacement(rawPluginId)
  if (!pid) return { success: false, error: '插件标识符不存在' }

  const featureCode = resolveBundledReplacementFeature(rawPluginId, options.featureCode)
  if (!isPluginVisible(pid)) {
    declarativeLoadError.value = '该插件暂未开放'
    return { success: false, error: declarativeLoadError.value }
  }
  // 别名跳转、历史记录可能指向当前系统不支持的插件（例如只声明了 Windows 的内置插件）
  if (!isPluginSupportedOnCurrentPlatform(pid)) {
    declarativeLoadError.value = '该插件在当前系统上暂不可用'
    return { success: false, error: declarativeLoadError.value }
  }
  const official = getOfficialPlugin(pid)
  if (official) {
    // 官方标杆应用：直接在 Launcher 内秒开以声明式模式运行
    declarativeLoadToken++
    loadingDeclarative.value = false
    declarativeLoadError.value = ''
    activeDeclarativePlugin.value = featureCode ? { ...official, featureCode } : official
    track('plugin_open', official.pluginId || pid, { source: 'launcher', plugin_type: 'declarative' })
    clearQuery()
    pluginsStore.markRecent?.(pid)?.catch?.(() => {})
    return { success: true }
  }

  // 第三方已安装 V2 声明式插件：直接在悬浮条内通过安全沙箱加载并原位渲染
  if (options.isDeclarative || isDeclarativeTarget(pid)) {
    const token = ++declarativeLoadToken
    activeDeclarativePlugin.value = null
    declarativeLoadError.value = ''
    loadingDeclarative.value = true

    try {
      const loaded = await loadInstalledDeclarativePlugin(pid, { featureCode })
      if (token !== declarativeLoadToken) return { success: false, cancelled: true }
      activeDeclarativePlugin.value = loaded
      track('plugin_open', loaded.pluginId || pid, { source: 'launcher', plugin_type: 'declarative' })
      clearQuery()
      pluginsStore.markRecent?.(pid)?.catch?.(() => {})
      return { success: true }
    } catch (err) {
      if (token !== declarativeLoadToken) return { success: false, cancelled: true }
      declarativeLoadError.value = err?.message || String(err) || '加载声明式扩展失败'
      return { success: false, error: declarativeLoadError.value }
    } finally {
      if (token === declarativeLoadToken) {
        loadingDeclarative.value = false
      }
    }
    return
  }

  if (externalPluginPending) return { success: false, busy: true }
  externalPluginPending = true
  const searchAtStart = query.value
  try {
    const result = await pluginsStore.openPlugin(pid)
    if (result?.success === true && !result.isDeclarative) {
      finishExternalLaunch(searchAtStart)
    } else if (result?.success !== true && !result?.cancelled) {
      showNoViewFeedback(result?.error?.message || result?.error || '启动插件失败，请重试', true)
    }
    return result
  } catch (err) {
    console.error('[Launcher] 启动插件失败:', err)
    showNoViewFeedback(err?.message || '启动插件失败，请重试', true)
    return { success: false, error: err?.message || '启动插件失败' }
  } finally {
    externalPluginPending = false
  }
}

function searchInMarket() {
  const q = query.value.trim()
  expandToDashboard({ name: 'list', query: { q } })
}

function toggleActionPanel() {
  actionPanelVisible.value = !actionPanelVisible.value
}

function collectDeclarativeQuery(pluginObj) {
  const snap = declarativeViewRef.value?.getViewStateSnapshot?.() || {}
  const qObj = {}
  if (snap.searchText) qObj.q = String(snap.searchText)
  if (snap.segmentedValue) qObj.seg = String(snap.segmentedValue)
  if (snap.dropdownValue) qObj.drop = String(snap.dropdownValue)
  if (snap.selectedId) qObj.sel = String(snap.selectedId)
  if (pluginObj?.featureCode) qObj.feature = String(pluginObj.featureCode)
  return qObj
}

async function popoutDeclarativePlugin(pluginId, featureCode = '', snapshotQuery = null) {
  const pid = String(pluginId || '').trim()
  if (!pid) return

  const qObj = snapshotQuery
    ? { ...snapshotQuery }
    : featureCode
      ? { feature: String(featureCode) }
      : {}

  // 正在悬浮条里运行的插件：一并交接 usePopoutState（必须在 hideLauncher 卸载插件之前读取），并携带 handoff 避免独立窗口重复上报 plugin_open
  if (snapshotQuery) {
    const collected = declarativeViewRef.value?.getPopoutState?.() || null
    hideLauncher()
    const result = await requestPopoutWindow({ pluginId: pid, query: qObj, collected })
    if (result.outcome === 'opened') return
    // 建窗失败：回退到工作台打开
    expandToDashboard(routeUtils.toPopout(pid, result.query || qObj))
    return
  }

  const searchParams = new URLSearchParams(qObj).toString()
  const hashRoute = `#/popout/${encodeURIComponent(pid)}${searchParams ? `?${searchParams}` : ''}`
  const popoutUrl = `ztools://web/index.html${hashRoute}`

  hideLauncher()
  try {
    if (typeof nativeWin?.open === 'function') {
      const res = await nativeWin.open(popoutUrl)
      if (res && res.success !== false) {
        return
      }
    }
  } catch (err) {
    console.warn("[LauncherBar] 打开独立窗口失败，回退工作台:", err)
  }

  expandToDashboard(routeUtils.toPopout(pid, qObj))
}

// 悬浮条与工作台是两个窗口：目标页面要交给主窗口去跳转，不能在悬浮条自己的路由里 push
function expandToDashboard(target) {
  declarativeLoadToken++
  actionPanelVisible.value = false
  loadingDeclarative.value = false
  declarativeLoadError.value = ''
  const currentDeclarative = activeDeclarativePlugin.value
  const snapQuery = currentDeclarative ? collectDeclarativeQuery(currentDeclarative) : {}
  activeDeclarativePlugin.value = null
  const location = target || (currentDeclarative ? routeUtils.toDeclarative(currentDeclarative.pluginId, snapQuery) : null)
  const route = location ? router.resolve(location).fullPath : undefined
  if (window.__ztoolsLauncher?.expandToDashboard) {
    const request = route ? window.__ztoolsLauncher.expandToDashboard(route) : window.__ztoolsLauncher.expandToDashboard()
    Promise.resolve(request).catch((err) => console.warn("[LauncherBar] 异步操作失败:", err))
  } else {
    switchWindowMode(WINDOW_MODES.DASHBOARD)
    if (route) router.push(route)
    else if (router.currentRoute.value.path === '/launcher') router.push('/')
  }
}

function hideLauncher() {
  declarativeLoadToken++
  loadingDeclarative.value = false
  declarativeLoadError.value = ''
  activeDeclarativePlugin.value = null
  if (window.__ztoolsLauncher?.hide) {
    window.__ztoolsLauncher.hide().catch((err) => console.warn("[LauncherBar] 异步操作失败:", err))
  } else if (window.ztools?.window?.hide) {
    window.ztools.window.hide().catch((err) => console.warn("[LauncherBar] 异步操作失败:", err))
  }
}

function handleWindowFocus() {
  actionPanelVisible.value = false
  resetPinnedFocus()
  resetPinnedScroll()
  void refreshPanelData()
  if (!activeDeclarativePlugin.value && !loadingDeclarative.value && !declarativeLoadError.value) {
    inputRef.value?.focus()
    inputRef.value?.select?.()
  }
}

onMounted(async () => {
  window.__ztoolsOpenLauncherDeclarative = (pluginId, options = {}) => {
    return launchPlugin(pluginId, { ...options, isDeclarative: true })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', handleWindowFocus)
  }

  if (windowModeState.launcherInitialQuery) {
    query.value = windowModeState.launcherInitialQuery
  }

  inputRef.value?.focus()
  await pluginsStore.init()
  await nextTick()
  if (!activeDeclarativePlugin.value && !loadingDeclarative.value && !declarativeLoadError.value) {
    inputRef.value?.focus()
  }
})

onBeforeUnmount(() => {
  declarativeLoadToken++
  reorderGeneration++
  if (noViewStatusTimer) {
    clearTimeout(noViewStatusTimer)
    noViewStatusTimer = null
  }
  if (reorderTimer) {
    clearTimeout(reorderTimer)
    reorderTimer = null
    pendingReorderBaseline = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', handleWindowFocus)
    delete window.__ztoolsOpenLauncherDeclarative
  }
})

watch(
  () => windowModeState.launcherInitialQuery,
  (val) => {
    if (val) {
      query.value = val
    }
  }
)
</script>

<style scoped>
.launcher-window-root {
  background: transparent;
  box-sizing: border-box;
}

.launcher-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid var(--rc-border-highlight);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
}

.launcher-panel.uses-native-corners {
  border: none;
  border-radius: 0;
}

.launcher-head {
  height: 60px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 14px 0 20px;
}

.launcher-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 18px;
  letter-spacing: -0.01em;
  color: var(--rc-text-primary);
  caret-color: var(--rc-accent);
}

.launcher-input::placeholder {
  color: var(--rc-text-faint);
}

.launcher-icon-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--rc-text-faint);
  cursor: pointer;
}

.launcher-icon-btn:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

.launcher-workbench-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 4px 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  font: inherit;
  font-size: 12px;
  color: var(--rc-text-muted);
  cursor: pointer;
}

.launcher-workbench-btn:hover {
  background: var(--rc-surface-hover);
  color: var(--rc-text-primary);
}

/* 主题强调发丝线：从左侧淡入淡出，暗示「从这里点亮」 */
.launcher-hairline {
  height: 1px;
  flex-shrink: 0;
  background: linear-gradient(90deg, rgba(var(--rc-accent-rgb), 0), rgba(var(--rc-accent-rgb), 0.42) 14%, rgba(var(--rc-accent-rgb), 0) 55%);
}

.launcher-pinned-section {
  flex-shrink: 0;
  padding: 8px 14px 10px;
  border-bottom: 1px solid var(--rc-border);
  background: var(--rc-surface);
}

.launcher-pinned-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  padding: 0 2px;
}

.launcher-pinned-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--rc-text-muted);
}

.launcher-pinned-hint {
  font-size: 11px;
  color: var(--rc-text-faint);
}

.launcher-pinned-grid {
  --pinned-tile-h: 55px;
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  grid-auto-rows: var(--pinned-tile-h);
  gap: 6px;
  max-height: var(--pinned-tile-h);
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  outline: none;
}

.launcher-pinned-grid.is-two-rows {
  max-height: calc(var(--pinned-tile-h) * 2 + 6px);
}

.launcher-pinned-tile {
  position: relative;
  height: 100%;
  min-width: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 4px 5px;
  border-radius: 8px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface-hover);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}

.launcher-pinned-tile:hover {
  border-color: var(--rc-border-highlight);
  background: var(--rc-surface-active);
}

.launcher-pinned-tile.is-focused {
  outline: none;
  border-color: var(--rc-accent);
  background: var(--rc-surface-active);
  box-shadow: var(--rc-focus-ring);
}

.launcher-pinned-tile.is-unavailable {
  opacity: 0.56;
}

.launcher-pinned-tile.is-unavailable .launcher-pinned-icon,
.launcher-pinned-tile.is-unavailable .launcher-pinned-app-icon {
  filter: grayscale(1);
}

.launcher-pinned-app-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  object-fit: contain;
}

.launcher-pinned-unavailable-tag {
  position: absolute;
  top: 2px;
  left: 3px;
  padding: 0 3px;
  border-radius: 3px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  font-size: 9px;
  line-height: 12px;
  color: var(--rc-text-faint);
  pointer-events: none;
}

.launcher-pinned-unpin {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--rc-text-faint);
  font-size: 12px;
  line-height: 1;
  opacity: 0;
  cursor: pointer;
}

.launcher-pinned-tile:hover .launcher-pinned-unpin,
.launcher-pinned-tile.is-unavailable .launcher-pinned-unpin {
  opacity: 1;
}

.launcher-pinned-unpin:hover {
  background: var(--rc-surface);
  color: var(--rc-text-primary);
}

.launcher-pinned-name {
  max-width: 100%;
  font-size: 11px;
  line-height: 14px;
  color: var(--rc-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.launcher-list {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: auto;
  scrollbar-color: auto;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  outline: none;
}

.launcher-list::-webkit-scrollbar {
  width: 14px;
}

.launcher-list::-webkit-scrollbar-thumb {
  border: 4px solid transparent;
  border-top: 0;
  border-bottom: 0;
  border-radius: 7px;
  background-clip: padding-box;
}

.launcher-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 16px;
  text-align: center;
}

.launcher-empty-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--rc-text-primary);
}

.launcher-empty-desc {
  margin: 4px 0 14px;
  font-size: 12px;
  color: var(--rc-text-muted);
}

.launcher-foot {
  height: 42px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px 0 20px;
  border-top: 1px solid var(--rc-border);
  font-size: 12px;
  color: var(--rc-text-muted);
}

.launcher-foot-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  padding: 0;
  background: transparent;
  font: inherit;
  color: var(--rc-text-muted);
}

button.launcher-foot-hint {
  cursor: pointer;
}

button.launcher-foot-hint:hover,
.launcher-foot-hint.is-primary {
  color: var(--rc-text-secondary);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
