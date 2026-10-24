<template>
  <div class="devtools-container" :class="{ dark: isDark }">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="title">🔧 DevTools</span>
        <a-tag :color="connected ? 'success' : 'error'">
          {{ connected ? '已连接' : '未连接' }}
        </a-tag>
      </div>
      <div class="toolbar-right">
        <a-button size="small" @click="clearConsole">清空</a-button>
        <a-button size="small" @click="toggleDark">
          {{ isDark ? '☀️' : '🌙' }}
        </a-button>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="main-content">
      <!-- 侧边栏 -->
      <div class="sidebar">
        <div class="sidebar-section">
          <div class="sidebar-title">快捷操作</div>
          <div class="sidebar-item" @click="quickExec('ztools.sys.getInfo()')">
            ℹ️ 系统信息
          </div>
          <div
            class="sidebar-item"
            @click="quickExec('ztools.sys.getAppVersion()')"
          >
            📦 版本号
          </div>
          <div
            class="sidebar-item"
            @click="quickExec('ztools.plugin.getList()')"
          >
            🔌 插件列表
          </div>
          <div
            class="sidebar-item"
            @click="quickExec(`ztools.sys.notify('测试', 'Hello!')`)"
          >
            🔔 测试通知
          </div>
          <div
            class="sidebar-item"
            @click="quickExec(`ztools.sys.toast('success', '测试成功')`)"
          >
            ✅ 测试 Toast
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-title">数据库</div>
          <div class="sidebar-item" @click="quickExec(`ztools.db.allDocs('')`)">
            📄 所有文档
          </div>
          <div class="sidebar-item" @click="insertCode(`ztools.db.get('key')`)">
            🔍 获取文档
          </div>
          <div
            class="sidebar-item"
            @click="insertCode(`ztools.db.put({_id:'key',data:'value'})`)"
          >
            💾 存储文档
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sidebar-title">DLL 插件</div>
          <div
            class="sidebar-item"
            @click="
              insertCode(`ztools.dllplugin.call('PluginName','FuncName',{})`)
            "
          >
            ⚡ 调用 DLL
          </div>
        </div>
      </div>

      <!-- 控制台 -->
      <div class="console-area">
        <div class="console" ref="consoleRef">
          <div
            v-for="(line, index) in consoleLines"
            :key="index"
            :class="['console-line', line.type]"
          >
            <span class="prefix">{{ getPrefix(line.type) }}</span>
            <span class="content" v-html="formatContent(line.content)"></span>
          </div>
        </div>

        <!-- 输入区 -->
        <div class="input-area">
          <input
            ref="inputRef"
            v-model="inputCode"
            type="text"
            placeholder="输入 JavaScript 代码... (Enter 执行, ↑↓ 历史)"
            @keydown="handleKeyDown"
          />
          <a-button type="primary" @click="executeCode">执行</a-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick, watch } from 'vue'

// 状态
const isDark = ref(true)
const connected = ref(false)
const inputCode = ref('')
const consoleLines = ref([])
const history = ref([])
const historyIndex = ref(-1)
const consoleRef = ref(null)
const inputRef = ref(null)

// 初始化
onMounted(() => {
  // 检查 ztools API 是否可用
  connected.value = typeof window.ztools !== 'undefined'

  log('info', '欢迎使用 ZTools 内置调试工具')
  log(
    'info',
    connected.value ? 'ZTools API 已就绪' : '⚠️ ZTools API 不可用（浏览器环境）'
  )

  inputRef.value?.focus()
})

// 日志输出
function log(type, content) {
  consoleLines.value.push({ type, content })
  scrollToBottom()
}

// 滚动到底部
async function scrollToBottom() {
  await nextTick()
  if (consoleRef.value) {
    consoleRef.value.scrollTop = consoleRef.value.scrollHeight
  }
}

// 获取前缀
function getPrefix(type) {
  const prefixes = {
    input: '> ',
    output: '← ',
    error: '✗ ',
    info: 'ℹ '
  }
  return prefixes[type] || ''
}

// 格式化内容
function formatContent(content) {
  if (typeof content === 'object') {
    try {
      return escapeHtml(JSON.stringify(content, null, 2))
    } catch {
      return escapeHtml(String(content))
    }
  }
  return escapeHtml(String(content))
}

// HTML 转义
function escapeHtml(text) {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML.replace(/\n/g, '<br>')
}

// 执行代码
async function executeCode() {
  const code = inputCode.value.trim()
  if (!code) return

  // 保存历史
  if (history.value[history.value.length - 1] !== code) {
    history.value.push(code)
  }
  historyIndex.value = history.value.length

  log('input', code)
  inputCode.value = ''

  if (!connected.value) {
    log('error', 'ZTools API 不可用')
    return
  }

  try {
    // 使用 AsyncFunction 支持 await
    const AsyncFunction = Object.getPrototypeOf(
      async function () {}
    ).constructor
    const fn = new AsyncFunction('ztools', `return ${code}`)
    const result = await fn(window.ztools)

    if (result !== undefined) {
      log('output', result)
    }
  } catch (e) {
    log('error', e.message || String(e))
  }
}

// 快捷执行
async function quickExec(code) {
  inputCode.value = code
  await executeCode()
}

// 插入代码
function insertCode(code) {
  inputCode.value = code
  inputRef.value?.focus()
}

// 键盘事件
function handleKeyDown(e) {
  if (e.key === 'Enter') {
    executeCode()
  } else if (e.key === 'ArrowUp') {
    if (historyIndex.value > 0) {
      historyIndex.value--
      inputCode.value = history.value[historyIndex.value]
    }
    e.preventDefault()
  } else if (e.key === 'ArrowDown') {
    if (historyIndex.value < history.value.length - 1) {
      historyIndex.value++
      inputCode.value = history.value[historyIndex.value]
    } else {
      historyIndex.value = history.value.length
      inputCode.value = ''
    }
    e.preventDefault()
  }
}

// 清空控制台
function clearConsole() {
  consoleLines.value = []
}

// 切换暗黑模式
function toggleDark() {
  isDark.value = !isDark.value
}
</script>

<style scoped>
.devtools-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  font-family: 'Segoe UI', Consolas, monospace;
  --bg: #1e1e1e;
  --panel-bg: #252526;
  --border: #3c3c3c;
  --text: #cccccc;
  --text-secondary: #808080;
  --primary: #0e639c;
  --success: #4ec9b0;
  --error: #f14c4c;
}

.devtools-container:not(.dark) {
  --bg: #ffffff;
  --panel-bg: #f3f3f3;
  --border: #e0e0e0;
  --text: #333333;
  --text-secondary: #666666;
}

.toolbar {
  background: var(--panel-bg);
  border-bottom: 1px solid var(--border);
  padding: 8px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar-right {
  display: flex;
  gap: 8px;
}

.title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  background: var(--bg);
}

.sidebar {
  width: 180px;
  background: var(--panel-bg);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.sidebar-section {
  border-bottom: 1px solid var(--border);
}

.sidebar-title {
  padding: 8px 12px;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--bg);
}

.sidebar-item {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.sidebar-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.console-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.console {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  font-family: Consolas, monospace;
  font-size: 13px;
}

.console-line {
  padding: 2px 0;
  display: flex;
  gap: 8px;
  color: var(--text);
}

.console-line.input {
  color: var(--primary);
}
.console-line.output {
  color: var(--success);
}
.console-line.error {
  color: var(--error);
}
.console-line.info {
  color: var(--text-secondary);
}

.prefix {
  color: var(--text-secondary);
  user-select: none;
}

.content {
  white-space: pre-wrap;
  word-break: break-all;
}

.input-area {
  border-top: 1px solid var(--border);
  padding: 8px;
  display: flex;
  gap: 8px;
  background: var(--panel-bg);
}

.input-area input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 12px;
  border-radius: 4px;
  font-family: Consolas, monospace;
  font-size: 13px;
}

.input-area input:focus {
  outline: none;
  border-color: var(--primary);
}
</style>
