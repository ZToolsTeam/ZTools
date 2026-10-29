<template>
  <div
    class="launcher-window-root flex flex-col h-screen w-screen overflow-hidden select-none"
    @keydown="handleKeyDown"
  >
    <!-- 悬浮搜索条主体：克制的中性面板，橙色只用于标志、选中标记与匹配高亮 -->
    <div class="launcher-panel">
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
            placeholder="搜索插件、命令与文件"
            class="launcher-input"
            autocomplete="off"
            spellcheck="false"
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
            <ShortcutKeys combo="Ctrl+M" />
          </button>
        </div>
        <div class="launcher-hairline" aria-hidden="true"></div>

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
              :active="activeIndex === index"
              :parts="highlightParts(item)"
              @mouseenter="activeIndex = index"
              @click="executeItem(item)"
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
import { routeUtils } from '@/router/routes'
import {
  useCommandSearch,
  isDeclarativePluginItem,
  normalizePluginFeatures,
  copyInlineAnswerToClipboard
} from '@/composables/useCommandSearch'
import { useKeymap, KEYMAP_SCOPES, dispatchKeyEvent } from '@/utils/keymap'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import { requestPopoutWindow } from '@/declarative/popoutHandoff'
import BrandMark from '@/components/BrandMark.vue'
import { RcButton } from '@/components/base'
import SearchResultRow from '@/components/SearchResultRow.vue'
import { shortcutLabel, isMacOS, isPluginSupportedOnCurrentPlatform } from '@/utils/platform'
import { win as nativeWin } from '@/api/apiserver'

const router = useRouter()
const pluginsStore = usePluginsStore()
// 悬停提示是纯文本，按平台格式化（键帽展示统一走 ShortcutKeys）
const workbenchHint = shortcutLabel('Ctrl+M')

const inputRef = ref(null)
const listContainerRef = ref(null)
const declarativeViewRef = ref(null)
const activeIndex = ref(0)
const actionPanelVisible = ref(false)
const activeDeclarativePlugin = ref(null)
// 悬浮条里原位渲染的已安装声明式插件持有会话归属
useDeclarativePluginSession(activeDeclarativePlugin)
const loadingDeclarative = ref(false)
const declarativeLoadError = ref('')
const noViewStatus = ref(null)
const itemElements = new Map()

let declarativeLoadToken = 0
let executingNoViewKey = ''
let noViewStatusTimer = null

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
} = useCommandSearch({ enableFileSearch: true })

// 结果再多也只渲染前 50 条：键盘上下选择、Enter 与动作面板都只在这 50 条里进行
const MAX_VISIBLE_ITEMS = 50
const visibleItems = computed(() => filteredItems.value.slice(0, MAX_VISIBLE_ITEMS))

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
  if (isBundledPlugin(pid) || getOfficialPlugin(pid)) return true
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

const activeItemActions = computed(() => {
  const item = visibleItems.value[activeIndex.value]
  if (!item) return []

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
    return [
      {
        type: 'Action',
        props: {
          title: item.isApplication ? '打开应用' : item.isDir ? '打开文件夹' : '打开文件',
          onAction: () => {
            actionPanelVisible.value = false
            openFile(item.path)
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
            showInFolder(item.path)
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
      },
      {
        type: 'Action',
        props: {
          title: '展开为完整工作台',
          shortcut: { modifiers: ['Ctrl'], key: 'M' },
          onAction: () => {
            actionPanelVisible.value = false
            expandToDashboard()
          }
        }
      }
    ]
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
        shortcut: { modifiers: ['Ctrl', 'Shift'], key: 'O' },
        onAction: () => {
          actionPanelVisible.value = false
          popoutDeclarativePlugin(item.pluginId, item.featureCode || '')
        }
      }
    })
  }

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
      shortcut: { modifiers: ['Ctrl'], key: 'M' },
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

watch(query, (newVal) => {
  activeIndex.value = 0
  scrollToActiveItem()
  search(newVal)
})

// 输入没变时列表也会变短（文件结果到达替换掉保留的旧结果）：选中项不能落到列表外
watch(() => visibleItems.value.length, (length) => {
  if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
})

function clearQuery() {
  clearSearch()
  activeIndex.value = 0
}

function exitDeclarative() {
  declarativeLoadToken++
  loadingDeclarative.value = false
  declarativeLoadError.value = ''
  activeDeclarativePlugin.value = null
  nextTick(() => {
    inputRef.value?.focus()
  })
}

// 统一注册极客工具条按键 (PAGE 作用域)
useKeymap(KEYMAP_SCOPES.PAGE, {
  'ArrowDown': () => {
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    if (visibleItems.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % visibleItems.value.length
      scrollToActiveItem()
      return true
    }
    return false
  },
  'ArrowUp': () => {
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    if (visibleItems.value.length > 0) {
      activeIndex.value = (activeIndex.value - 1 + visibleItems.value.length) % visibleItems.value.length
      scrollToActiveItem()
      return true
    }
    return false
  },
  'Enter': () => {
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
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
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    const cur = visibleItems.value[activeIndex.value]
    if (cur && cur.type === 'file') {
      showInFolder(cur.path)
      return true
    } else if (cur) {
      executeItem(cur)
      return true
    }
    return false
  },
  'Ctrl+K': () => {
    if (activeDeclarativePlugin.value || loadingDeclarative.value || declarativeLoadError.value) return false
    toggleActionPanel()
    return true
  },
  'Ctrl+M': () => {
    expandToDashboard()
    return true
  },
  'Ctrl+Shift+O': () => {
    if (activeDeclarativePlugin.value) {
      popoutDeclarativePlugin(
        activeDeclarativePlugin.value.pluginId,
        activeDeclarativePlugin.value.featureCode || '',
        collectDeclarativeQuery(activeDeclarativePlugin.value)
      )
      return true
    }
    const cur = visibleItems.value[activeIndex.value]
    if (cur && cur.pluginId && isDeclarativeTarget(cur.pluginId, cur) && cur.mode !== 'no-view') {
      popoutDeclarativePlugin(cur.pluginId, cur.featureCode || '')
      return true
    }
    return false
  },
  'Escape': () => {
    if (loadingDeclarative.value || declarativeLoadError.value) {
      exitDeclarative()
      return true
    }
    if (activeDeclarativePlugin.value) return false
    if (actionPanelVisible.value) {
      actionPanelVisible.value = false
      return true
    } else if (query.value) {
      clearQuery()
      return true
    } else {
      hideLauncher()
      return true
    }
  }
})

function handleKeyDown(e) {
  dispatchKeyEvent(e)
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

function showInFolder(filePath) {
  return runFileAction(filePath, 'showItemInFolder', '定位文件失败')
}

function executeItem(item) {
  if (!item) return
  if (!item.omitFromFrecencyTracking) {
    recordUsage(item.key || item.pluginId)
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
  if (item.type === 'file') {
    openFile(item.path)
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

  // 正在悬浮条里运行的插件：一并交接 usePopoutState（必须在 hideLauncher 卸载插件之前读取）
  const collected = snapshotQuery ? declarativeViewRef.value?.getPopoutState?.() || null : null
  if (collected) {
    hideLauncher()
    const result = await requestPopoutWindow({ pluginId: pid, query: qObj, collected })
    if (result.outcome === 'opened') return
    // 建窗失败：回退到工作台打开（工作台是另一个窗口，交接状态带不过去）
    expandToDashboard(routeUtils.toPopout(pid, qObj))
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
  if (noViewStatusTimer) {
    clearTimeout(noViewStatusTimer)
    noViewStatusTimer = null
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

/* 余烬发丝线：从左侧淡入淡出，暗示「从这里点亮」 */
.launcher-hairline {
  height: 1px;
  flex-shrink: 0;
  background: linear-gradient(90deg, rgba(255, 107, 61, 0), rgba(255, 107, 61, 0.42) 14%, rgba(255, 107, 61, 0) 55%);
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
