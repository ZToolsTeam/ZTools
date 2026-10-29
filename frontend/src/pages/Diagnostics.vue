<script setup>
import { ChevronDownIcon, ChevronUpIcon } from '@lucide/vue'
import { confirmDialog } from '@/utils/confirmDialog'
import { RcAlert, RcButton, RcCard, RcSegmented, RcSelect } from '@/components/base'
import { ref, onMounted, onBeforeUnmount, nextTick, reactive, computed } from 'vue'
import { message as antMessage } from 'ant-design-vue'
import { useDiagnosticsApi } from '@/composables/useDiagnosticsApi'

const {
  isNative,
  sys,
  fs,
  win,
  network,
  process,
  screen,
  simulate,
  db,
  privileged,
  trigger,
  protocol,
  storageGet,
  storageSet,
  storageDelete,
  getLocalPlugins,
  openPlugin,
  getDllPluginList,
  callDllPlugin,
  installPluginNative,
  uninstallPluginNative,
  getMarketPlugins,
  getPluginDetails,
  getDownloadSign,
  readProtocolText
} = useDiagnosticsApi()

// ==========================================
// 日志系统 (Logging System)
// ==========================================
const logRef = ref(null)
const logs = ref([])

const clearLog = () => {
  logs.value = []
}

const log = (msg, type = 'info', duration = null) => {
  const time = new Date().toLocaleTimeString()
  let content = ''
  if (typeof msg === 'string') {
    content = msg
  } else if (msg instanceof Error) {
    content = msg.message || String(msg)
  } else {
    content = JSON.stringify(msg, null, 2)
  }

  logs.value.push({
    time,
    content,
    type,
    duration: duration !== null ? `+${duration}ms` : ''
  })

  nextTick(() => {
    if (logRef.value) {
      logRef.value.scrollTop = logRef.value.scrollHeight
    }
  })
}

// ==========================================
// 批量体检系统 (Batch Test System)
// ==========================================
const testProgress = ref(0)
const passCount = ref(0)
const failCount = ref(0)
const skipCount = ref(0)
const totalCount = ref(0)
const isTesting = ref(false)
const batchPlatformStatus = ref('')
const diagnosticPlatform = ref('unknown')
const diagnosticPlatformReadFailed = ref(false)
const diagnosticRuntime = ref('unknown')
const isWindowsDiagnosticsAvailable = computed(() => diagnosticPlatform.value === 'windows')
const isInputSimulationAvailable = computed(() => false)
const windowsOnlyDiagnosticsMessage = computed(() => {
  if (diagnosticPlatformReadFailed.value) {
    return '无法确认宿主平台；为避免误读或修改文件、系统注册表，Windows 专用手动诊断已关闭。'
  }
  if (diagnosticPlatform.value === 'macos') {
    return '此组操作使用 Windows 路径、注册表或 ZToolsService；macOS 不适用。文件访问诊断需待授权文件契约完成后提供。'
  }
  return '无法确认宿主平台；Windows 专用手动诊断已关闭。'
})
const inputSimulationUnavailableMessage = computed(() => {
  if (diagnosticPlatform.value === 'macos') {
    return 'macOS 输入注入尚未接入；按键模拟已关闭。'
  }
  if (diagnosticPlatform.value === 'windows' && diagnosticRuntime.value === 'electron') {
    return '当前 Electron 宿主尚未接入按键注入 provider；按键模拟已关闭。'
  }
  return '当前宿主未启用按键注入 provider；按键模拟已关闭。'
})

const detectDiagnosticRuntime = () => {
  try {
    const host = window.ztools
    if (typeof host?.isElectron === 'function' && host.isElectron()) return 'electron'
  } catch (err) {
    // 宿主探测失败时按未知运行时处理，但保留原因便于排查
    console.warn('[Diagnostics] 读取宿主运行时失败:', err)
  }
  return 'unknown'
}

const loadDiagnosticHost = async () => {
  diagnosticRuntime.value = detectDiagnosticRuntime()
  try {
    const getInfo = window.ztools?.sys?.getInfo
    if (typeof getInfo !== 'function') throw new Error('系统信息接口不可用')
    const info = await getInfo.call(window.ztools.sys)
    if (info?.platform === 'windows' || info?.platform === 'macos') {
      diagnosticPlatform.value = info.platform
      diagnosticPlatformReadFailed.value = false
      return
    }
    diagnosticPlatform.value = 'unknown'
    diagnosticPlatformReadFailed.value = false
  } catch {
    diagnosticPlatform.value = 'unknown'
    diagnosticPlatformReadFailed.value = true
  }
}

const canRunWindowsOnlyDiagnostic = (name) => {
  if (isWindowsDiagnosticsAvailable.value) return true
  log(`${name}未执行：${windowsOnlyDiagnosticsMessage.value}`, 'warn')
  return false
}

// 定义安全的批量测试项（覆盖所有主要API，排除敏感操作）
const batchTestList = [
  // ========== 系统基础 ==========
  {
    id: 'sys.getInfo',
    name: '系统信息 (sys.getInfo)',
    run: async () => await window.ztools.sys.getInfo()
  },
  {
    id: 'sys.getNativeId',
    name: 'Native ID (sys.getNativeId)',
    run: async () => await window.ztools.sys.getNativeId()
  },
  {
    id: 'sys.resource',
    name: '资源监控 (CPU/Mem)',
    run: async () => ({
      cpu: await window.ztools.sys.getCPUUsage(),
      mem: await window.ztools.sys.getMemoryUsage()
    })
  },
  {
    id: 'sys.path.desktop',
    name: '系统路径-桌面 (sys.getPath)',
    run: async () => await window.ztools.sys.getPath('desktop')
  },
  {
    id: 'sys.path.documents',
    name: '系统路径-文档 (sys.getPath)',
    run: async () => await window.ztools.sys.getPath('documents')
  },
  {
    id: 'sys.path.temp',
    name: '系统路径-临时 (sys.getPath)',
    run: async () => await window.ztools.sys.getPath('temp')
  },

  // ========== 文件系统 ==========
  {
    id: 'fs.cwd',
    name: '当前目录 (fs.getCurrentDirectory)',
    run: async () => await window.ztools.fs.getCurrentDirectory()
  },
  {
    id: 'fs.fileExists',
    name: '文件存在性 (fs.fileExists)',
    platforms: ['windows'],
    run: async () =>
      await window.ztools.fs.fileExists('C:\\Windows\\System32\\notepad.exe')
  },
  {
    id: 'fs.readFile',
    name: '读取文件 (fs.readFile)',
    platforms: ['windows'],
    run: async () => {
      const content = await window.ztools.fs.readFile(
        'C:\\Windows\\System32\\drivers\\etc\\hosts'
      )
      return content ? `读取成功 (${content.length} bytes)` : '文件为空'
    }
  },
  {
    id: 'fs.writeRead',
    name: '写入并读取 (fs.writeFile + readFile)',
    run: async () => {
      const testPath = 'ztools_diag_test.txt'
      const testContent = 'ZTools Diagnostics Test ' + Date.now()
      await window.ztools.fs.writeFile(testPath, testContent)
      const read = await window.ztools.fs.readFile(testPath)
      await window.ztools.fs.deleteFile(testPath)
      if (read !== testContent) throw new Error('内容不匹配')
      return '写入读取验证成功'
    }
  },
  {
    id: 'fs.directory',
    name: '目录操作 (fs.createDirectory)',
    run: async () => {
      const dir = 'ztools_diag_test_dir'
      await window.ztools.fs.createDirectory(dir)
      const list = await window.ztools.fs.getDirectoryContents(
        await window.ztools.fs.getCurrentDirectory()
      )
      return `目录内容: ${list?.length || 0} 项`
    }
  },

  // ========== 数据库 ==========
  {
    id: 'db.setGet',
    name: '数据库读写 (db.set + get)',
    run: async () => {
      await window.ztools.db.setPluginId('diagnostics')
      const key = 'diag_test_' + Date.now()
      const val = { test: true, time: Date.now() }
      await window.ztools.db.put({ _id: key, ...val })
      const result = await window.ztools.db.get(key)
      await window.ztools.db.remove(key)
      return result ? '读写成功' : '读取为空'
    }
  },
  {
    id: 'db.allDocs',
    name: '数据库列表 (db.allDocs)',
    run: async () => {
      await window.ztools.db.setPluginId('diagnostics')
      const docs = await window.ztools.db.allDocs()
      return `文档数: ${docs?.length || 0}`
    }
  },
  {
    id: 'db.secure',
    name: '加密存储 (db.putSecure + getSecure)',
    run: async () => {
      await window.ztools.db.setPluginId('diagnostics')
      const key = 'secure_test_' + Date.now()
      const val = 'SecretValue_' + Date.now()
      await window.ztools.db.putSecure(key, val)
      const result = await window.ztools.db.getSecure(key)
      return result === val ? '加密读写成功' : '数据不匹配'
    }
  },

  // ========== 窗口控制 ==========
  {
    id: 'win.bounds',
    name: '获取窗口边界 (win.getBounds)',
    run: async () => await window.ztools.win.getBounds()
  },
  {
    id: 'win.opacity',
    name: '窗口透明度 (win.setOpacity)',
    run: async () => {
      await window.ztools.win.setOpacity(0.95)
      await new Promise((r) => setTimeout(r, 200))
      await window.ztools.win.setOpacity(1)
      return '透明度测试完成'
    }
  },

  // ========== 剪贴板 ==========
  {
    id: 'clipboard.text',
    name: '剪贴板文本 (clipboard.writeText + readText)',
    run: async () => {
      const testText = 'ZTools Clipboard Test ' + Date.now()
      await window.ztools.clipboard.writeText(testText)
      const read = await window.ztools.clipboard.readText()
      return read?.includes('ZTools') ? '剪贴板读写成功' : '读取结果: ' + read
    }
  },

  // ========== Shell ==========
  {
    id: 'shell.beep',
    name: '系统蜂鸣 (shell.beep)',
    run: async () => {
      await window.ztools.shell.beep()
      return 'Beep 执行成功'
    }
  },
  {
    id: 'shell.exec',
    name: 'Shell 执行 (shell.exec)',
    run: async () => {
      const result = await window.ztools.shell.exec('echo test')
      return result ? 'Shell 执行成功' : 'Shell 执行无返回'
    }
  },

  // ========== 屏幕 ==========
  {
    id: 'screen.displays',
    name: '获取显示器 (screen.getAllDisplays)',
    run: async () => {
      const displays = await window.ztools.screen.getAllDisplays()
      return `显示器数量: ${displays?.length || 0}`
    }
  },
  {
    id: 'screen.cursor',
    name: '鼠标位置 (screen.getCursorScreenPoint)',
    run: async () => {
      const pos = await window.ztools.screen.getCursorScreenPoint()
      return `位置: (${pos?.x || 0}, ${pos?.y || 0})`
    }
  },
  {
    id: 'screen.capture',
    name: '屏幕截图 (screen.captureFullScreen)',
    run: async () => {
      const base64 = await window.ztools.screen.captureFullScreen()
      return `截图成功 (${base64?.length || 0} bytes)`
    }
  },

  // ========== 网络 ==========
  {
    id: 'network.get',
    name: 'HTTP请求 (network.get)',
    run: async () => {
      const res = await window.ztools.network.get('https://www.baidu.com')
      return `HTTP 请求成功 (statusCode: ${res?.statusCode || 'unknown'})`
    }
  },

  // ========== 进程 ==========
  {
    id: 'process.list',
    name: '进程列表 (process.list)',
    run: async () => {
      const list = await window.ztools.process.list()
      return `进程数量: ${list?.length || 0}`
    }
  },
  // ========== 插件 ==========
  {
    id: 'plugin.list',
    name: '获取本地插件 (plugin.getList)',
    run: async () => {
      const result = await window.ztools.plugin.getList()
      const list = result?.data || []
      return `插件数量: ${list.length}`
    }
  },
  {
    id: 'dll.list',
    name: '获取DLL插件 (dllplugin.list)',
    run: async () => {
      const list = await window.ztools.dllplugin.list()
      return `DLL插件数量: ${list?.length || 0}`
    }
  },

  // ========== 插件市场 ==========
  {
    id: 'plugin.market',
    name: '市场插件列表 (getMarketPlugins)',
    run: async () => {
      const result = await getMarketPlugins({ per_page: 5 })
      return `获取成功: ${result.list?.length || 0}个插件, 共${result.total}个`
    }
  },
  {
    id: 'plugin.details',
    name: '插件详情 (getPluginDetails)',
    run: async () => {
      const market = await getMarketPlugins({ per_page: 1 })
      if (!market.list?.length) return '市场无可用插件'
      const pluginId = market.list[0].pluginId
      const details = await getPluginDetails(pluginId)
      return `获取成功: ${details.name} v${details.version}`
    }
  },
  {
    id: 'plugin.downloadSign',
    name: '下载签名 (getDownloadSign)',
    run: async () => {
      const market = await getMarketPlugins({ per_page: 1 })
      if (!market.list?.length) return '市场无可用插件'
      const pluginId = market.list[0].pluginId
      const sign = await getDownloadSign(pluginId)
      return sign?.downloadUrl ? '签名获取成功' : '无下载地址'
    }
  },
  {
    id: 'plugin.install',
    name: '插件安装 (installPluginNative)',
    run: async () => {
      const market = await getMarketPlugins({ per_page: 1 })
      if (!market.list?.length) return '市场无可用插件'
      const pluginId = market.list[0].pluginId
      const sign = await getDownloadSign(pluginId)
      if (!sign?.downloadUrl) return '无法获取下载地址'

      const res = await installPluginNative(pluginId, sign)
      return !!res?.success
        ? '安装请求已发送'
        : `安装失败: ${res?.error || '未知错误'}`
    }
  },
  {
    id: 'plugin.uninstall',
    name: '插件卸载 (uninstallPluginNative)',
    run: async () => {
      const localPlugins = await window.ztools.plugin.getList()
      const list = localPlugins?.data || []
      if (!list.length) return '无已安装插件可卸载'

      // 选择第一个非内置插件进行卸载测试
      const testPlugin = list.find((p) => !p.builtin) || list[0]
      const pluginId = testPlugin.pluginId

      const res = await uninstallPluginNative(pluginId)
      return !!res?.success
        ? `已卸载: ${pluginId}`
        : `卸载失败: ${res?.error || '未知错误'}`
    }
  },

  // ========== 触发器/热键 ==========
  {
    id: 'hotkey.register',
    name: '热键注册测试 (trigger.register)',
    run: async () => {
      // 注册一个测试热键然后立即注销
      await window.ztools.trigger.register({
        id: 'diag_test_hotkey',
        pluginId: 'system',
        type: 'hotkey',
        enabled: true,
        config: { key: 'Ctrl+Alt+F12' },
        actionMode: 'builtin',
        actionTarget: 'toggle_main_window',
        actionParams: {}
      })
      await window.ztools.trigger.unregister('diag_test_hotkey')
      return '热键注册/注销成功'
    }
  },
  // ========== 协议 ==========
  {
    id: 'protocol.url',
    name: '协议URL生成 (protocol.getUrl)',
    platforms: ['windows'],
    run: async () => {
      const url = `ztools://file/C:/Windows/System32/drivers/etc/hosts`
      return url?.startsWith('ztools://') ? 'URL生成成功' : 'URL格式错误'
    }
  },
  {
    id: 'protocol.read',
    name: '协议读取 (protocol.readText)',
    platforms: ['windows'],
    run: async () => {
      const url = `ztools://file/C:/Windows/System32/drivers/etc/hosts`
      const text = await readProtocolText(url)
      return text ? `协议读取成功 (${text.length} bytes)` : '读取为空'
    }
  },

  // ========== 特权服务 ==========
  {
    id: 'privileged.exec',
    name: '特权服务 (sys.privilegedExecute)',
    platforms: ['windows'],
    run: async () => {
      // 通过 ZToolsService 执行提权命令
      const res = await window.ztools.sys.privilegedExecute('system_action', {
        action: 'ping'
      })
      return res ? '特权服务可用' : '特权服务响应空'
    }
  },
  // ========== 事件系统 ==========
  {
    id: 'events.basic',
    name: '事件系统 (events.emit + on)',
    run: async () => {
      let received = false
      const handler = () => {
        received = true
      }
      await window.ztools.events.on('diag_test_event', handler)
      await window.ztools.events.emit('diag_test_event', { test: true })
      await new Promise((r) => setTimeout(r, 100))
      await window.ztools.events.off('diag_test_event', handler)

      return received ? '事件系统正常' : '未收到事件'
    }
  },

  // ========== 模拟输入 ==========
  {
    id: 'simulate.key',
    name: '按键模拟 (simulate.keyPress)',
    platforms: ['windows'],
    runtimes: ['native-input'],
    run: async () => {
      // 模拟一个常见的按键（Esc）
      await window.ztools.sys.simulateKeyPress('Esc')
      return '按键模拟执行成功'
    }
  }
]

const runBatchTest = async () => {
  if (isTesting.value) return
  if (!isNative) return log('非原生环境，无法执行体检', 'error')

  isTesting.value = true
  clearLog()
  log('开始一键批量体检...', 'info')

  passCount.value = 0
  failCount.value = 0
  skipCount.value = 0
  testProgress.value = 0

  let platform = ''
  let platformReadFailed = false
  const runtime = detectDiagnosticRuntime()
  try {
    const sysApi = window.ztools?.sys
    const getInfo = sysApi?.getInfo
    if (typeof getInfo !== 'function') {
      throw new Error('宿主平台信息接口不可用')
    }
    const info = await getInfo.call(sysApi)
    platform = info?.platform || ''
  } catch {
    platformReadFailed = true
  }

  const isKnownPlatform = platform === 'windows' || platform === 'macos'
  const platformLabel = platform || 'unknown'
  if (isKnownPlatform) {
    const runtimeLabel = runtime === 'electron' ? 'Electron' : '宿主未知'
    batchPlatformStatus.value = `检测平台：${platform === 'windows' ? 'Windows' : 'macOS'}（${runtimeLabel}）`
  } else if (platformReadFailed) {
    batchPlatformStatus.value =
      '无法读取宿主平台；Windows 专用测试已跳过，不计入成功或失败。'
  } else {
    batchPlatformStatus.value =
      `宿主平台“${platformLabel}”没有对应的专用测试；Windows 专用测试已跳过，不计入成功或失败。`
  }

  if (!isKnownPlatform) {
    log(batchPlatformStatus.value, 'warn')
  } else if (platform === 'macos') {
    log('Windows 专用测试在 macOS 上不适用，将跳过且不计入失败。', 'warn')
  }

  const getSkipReason = (item) => {
    if (item.platforms && !item.platforms.includes(platform)) {
      return platformReadFailed
        ? '无法确认宿主平台，已跳过'
        : `当前平台为 ${platformLabel}，不适用`
    }
    if (item.runtimes && !item.runtimes.includes(runtime)) {
      return `当前宿主环境为 ${runtime}，不支持此测试`
    }
    return ''
  }
  const applicableTests = batchTestList.filter((item) => !getSkipReason(item))
  totalCount.value = applicableTests.length

  for (let i = 0; i < batchTestList.length; i++) {
    const item = batchTestList[i]

    const skipReason = getSkipReason(item)
    if (skipReason) {
      skipCount.value++
      log(`[SKIP] ${item.name}: ${skipReason}`, 'warn')
      testProgress.value = Math.round(((i + 1) / batchTestList.length) * 100)
      continue
    }

    log(`正在测试: ${item.name}...`, 'info')
    const start = Date.now()
    try {
      const res = await item.run()
      const elapsed = Date.now() - start
      log(`[PASS] ${item.name}`, 'success', elapsed)
      passCount.value++
    } catch (e) {
      const elapsed = Date.now() - start
      log(`[FAIL] ${item.name}: ${e.message || e}`, 'error', elapsed)
      failCount.value++
    }
    testProgress.value = Math.round(((i + 1) / batchTestList.length) * 100)
    await new Promise((r) => setTimeout(r, 50))
  }

  const score =
    totalCount.value > 0
      ? Math.round((passCount.value / totalCount.value) * 100)
      : null
  const summary =
    score === null
      ? `体检完成：无适用项，已跳过 ${skipCount.value} 项。`
      : `体检完成：适用项成功率 ${score}%，成功 ${passCount.value}，失败 ${failCount.value}，已跳过 ${skipCount.value}。`
  log(summary, failCount.value === 0 && skipCount.value === 0 ? 'success' : 'warn')
  isTesting.value = false
}

// ==========================================
// Tab 1: 系统与基础
// ==========================================
const sysInfoResult = ref('')
const getSysInfo = async () => {
  try {
    const res = await sys.getInfo()
    sysInfoResult.value = JSON.stringify(res, null, 2)
    log('获取系统信息成功', 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const sysPathType = ref('desktop')
const sysPathResult = ref('')
const getSysPath = async () => {
  try {
    const res = await sys.getPath(sysPathType.value)
    sysPathResult.value = res
    log(`获取路径 (${sysPathType.value}): ${res}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const sendNotify = async () => {
  try {
    await sys.notify('测试通知', '这是一条来自诊断中心的测试通知')
    log('通知已发送', 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const getCpuMem = async () => {
  try {
    const cpuRes = await sys.getCPUUsage()
    const memRes = await sys.getMemoryUsage()

    const cpuUsage = typeof cpuRes === 'object' ? (cpuRes.total ?? '0') : cpuRes
    const memUsage =
      typeof memRes === 'object' ? (memRes.percent ?? '0') : memRes

    log(`CPU: ${cpuUsage}%, 内存: ${memUsage}%`, 'success')
    log({ cpu: cpuRes, memory: memRes }, 'info') // 同时记录详细数据
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 2: 电源管理
// ==========================================
const powerAction = async (action) => {
  const dangerActions = ['hibernate', 'logout', 'restart', 'shutdown']
  if (dangerActions.includes(action)) {
    confirmDialog({
      title: '危险操作确认',
      content: `确定要执行 ${action} 吗？这可能导致数据丢失！`,
      okText: '确定',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          if (action === 'hibernate') await window.ztools?.sys?.hibernate?.()
          if (action === 'logout') await window.ztools?.sys?.logout?.()
          if (action === 'restart') await window.ztools?.sys?.restart?.()
          if (action === 'shutdown') await window.ztools?.sys?.shutdown?.()
          log(`${action} 命令已发送`, 'success')
        } catch (e) {
          log(e, 'error')
        }
      }
    })
  } else {
    try {
      if (action === 'lock') await sys.lock()
      if (action === 'sleep') await sys.sleep()
      log(`${action} 命令已发送`, 'success')
    } catch (e) {
      log(e, 'error')
    }
  }
}

// ==========================================
// Tab 3: 文件系统
// ==========================================
const fsPath = ref('C:\\Windows\\System32\\drivers\\etc\\hosts')
const fsContent = ref('')
const fsWriteContent = ref('Hello ZTools!')

const fsRead = async () => {
  if (!canRunWindowsOnlyDiagnostic('文件读取')) return
  try {
    const txt = await fs.readFile(fsPath.value)
    fsContent.value = txt
      ? txt.length > 500
        ? txt.slice(0, 500) + '...'
        : txt
      : '(空)'
    log(`读取文件成功 (${txt?.length} bytes)`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsWrite = async () => {
  if (!canRunWindowsOnlyDiagnostic('文件写入')) return
  try {
    await fs.writeFile(fsPath.value, fsWriteContent.value)
    log(`写入文件成功: ${fsPath.value}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsCheckExists = async () => {
  if (!canRunWindowsOnlyDiagnostic('文件存在性检查')) return
  try {
    const exists = await fs.exists(fsPath.value)
    log(`文件存在性: ${exists}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsDeleteFile = async () => {
  if (!canRunWindowsOnlyDiagnostic('文件删除')) return
  confirmDialog({
    title: '确认删除',
    content: `确定要删除文件 ${fsPath.value} 吗？`,
    onOk: async () => {
      try {
        await fs.deleteFile(fsPath.value)
        log(`删除文件成功: ${fsPath.value}`, 'success')
      } catch (e) {
        log(e, 'error')
      }
    }
  })
}

const fsDirList = ref([])
const fsListDir = async () => {
  if (!canRunWindowsOnlyDiagnostic('目录枚举')) return
  try {
    const dir = await fs.getCurrentDirectory()
    const list = await fs.getDirectoryContents(dir)
    fsDirList.value = list || []
    log(`列出目录: ${dir} (${list?.length || 0}项)`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsMkDir = async () => {
  if (!canRunWindowsOnlyDiagnostic('创建测试目录')) return
  try {
    await fs.createDirectory('test_diag_dir')
    log('创建目录成功: test_diag_dir', 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 4: 数据库
// ==========================================
const dbKey = ref('test_diag_key')
const dbVal = ref('{"test": true, "time": ' + Date.now() + '}')
const dbResult = ref('')

const dbOps = async (op) => {
  try {
    let res
    if (op === 'set') res = await db.set('diag', dbKey.value, dbVal.value)
    if (op === 'get') res = await db.get('diag', dbKey.value)
    if (op === 'delete') res = await db.delete('diag', dbKey.value)
    if (op === 'all') res = await db.allDocs('diag')
    if (op === 'secure_set')
      res = await db.putSecure('diag', dbKey.value, dbVal.value)
    if (op === 'secure_get') res = await db.getSecure('diag', dbKey.value)
    dbResult.value = JSON.stringify(res, null, 2)
    log(`数据库操作 ${op} 成功`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 5: 窗口控制
// ==========================================
const winWidth = ref(800)
const winHeight = ref(600)
const winOpacity = ref(1)

const winTest = async (action) => {
  try {
    if (action === 'min') await win.minimize()
    if (action === 'max') await win.maximize()
    if (action === 'restore') await win.restore()
    if (action === 'top') await win.setAlwaysOnTop(true)
    if (action === 'untop') await win.setAlwaysOnTop(false)
    if (action === 'devtools') await win.toggleDevTools()
    if (action === 'setSize') await win.setSize(winWidth.value, winHeight.value)
    if (action === 'setOpacity') await win.setOpacity(winOpacity.value)
    if (action === 'getBounds') {
      const bounds = await win.getBounds()
      log(`窗口边界: ${JSON.stringify(bounds)}`, 'success')
      return
    }
    log(`执行窗口操作: ${action}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const winOpenDialog = async (type) => {
  try {
    let res
    if (type === 'open') {
      res = await win.showOpenDialog({
        title: '选择文件',
        filters: [{ name: '所有文件', extensions: ['*'] }]
      })
    }
    if (type === 'openMulti') {
      res = await win.showOpenDialog({
        title: '选择多个文件',
        multiSelections: true
      })
    }
    if (type === 'save') {
      res = await win.showSaveDialog({
        title: '保存文件',
        defaultPath: 'test.txt'
      })
    }
    if (type === 'folder') {
      res = await win.showOpenDialog({
        title: '选择文件夹',
        openDirectory: true
      })
    }
    log(`对话框结果: ${JSON.stringify(res)}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 6: 剪贴板与Shell
// ==========================================
const clipboardText = ref('Hello ZTools Clipboard!')

const clipboardOps = async (op) => {
  try {
    const clipboard = window.ztools?.clipboard
    if (!clipboard) throw new Error('Clipboard API 不可用')

    let res
    if (op === 'writeText') res = await clipboard.writeText(clipboardText.value)
    if (op === 'readText') {
      res = await clipboard.readText()
      log(`剪贴板文本: ${res}`, 'success')
      return
    }
    if (op === 'readImage') {
      res = await clipboard.readImage()
      log(`剪贴板图片: ${res ? '有图片数据' : '无图片'}`, 'success')
      return
    }
    if (op === 'readFiles') {
      res = await clipboard.readFiles()
      log(`剪贴板文件: ${JSON.stringify(res)}`, 'success')
      return
    }
    if (op === 'clear') res = await clipboard.clear()
    log(`剪贴板操作 ${op} 成功`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const shellCmd = ref('echo Hello ZTools')
const externalUrl = ref('https://www.baidu.com')

const shellOps = async (op) => {
  try {
    const shell = window.ztools?.shell
    if (op === 'openExternal') {
      await sys.openExternal(externalUrl.value)
      log(`已打开外部链接: ${externalUrl.value}`, 'success')
      return
    }
    if (!shell) throw new Error('Shell API 不可用')
    if (op === 'beep') {
      await shell.beep()
      log('Beep!', 'success')
    }
    if (op === 'exec') {
      const res = await shell.exec(shellCmd.value)
      log(`执行命令结果: ${JSON.stringify(res)}`, 'success')
    }
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 7: 事件与触发器
// ==========================================
const eventName = ref('test_event')
const eventData = ref('{"message": "Hello from Diagnostics"}')
let eventListener = null

const eventsOps = async (op) => {
  try {
    const events = window.ztools?.events
    if (!events) throw new Error('Events API 不可用')

    if (op === 'emit') {
      await events.emit(eventName.value, JSON.parse(eventData.value))
      log(`事件已发送: ${eventName.value}`, 'success')
    }
    if (op === 'on') {
      eventListener = (data) => {
        log(`收到事件 ${eventName.value}: ${JSON.stringify(data)}`, 'info')
      }
      await events.on(eventName.value, eventListener)
      log(`已开始监听事件: ${eventName.value}`, 'success')
    }
    if (op === 'off') {
      if (eventListener) {
        await events.off(eventName.value, eventListener)
        eventListener = null
      }
      log(`已停止监听事件: ${eventName.value}`, 'success')
    }
  } catch (e) {
    log(e, 'error')
  }
}

// 文件拖放监听
let fileDropListener = null
const startFileDrop = () => {
  try {
    const events = window.ztools?.events
    if (!events) throw new Error('Events API 不可用')

    fileDropListener = (files) => {
      log(`文件拖放: ${JSON.stringify(files)}`, 'info')
    }
    events.on('plugin_files_dropped', fileDropListener)
    log('已开启文件拖放监听 (10秒后自动关闭)', 'success')

    setTimeout(() => {
      if (fileDropListener) {
        events.off('plugin_files_dropped', fileDropListener)
        fileDropListener = null
        log('文件拖放监听已关闭', 'info')
      }
    }, 10000)
  } catch (e) {
    log(e, 'error')
  }
}

// 触发器
const hotkeyConfig = ref('Ctrl+Alt+T')
const triggerOps = async (op) => {
  try {
    if (op === 'register') {
      // 先检查是否已存在相同的测试触发器，避免重复注册
      const existingList = await trigger.list()
      const listArray = Array.isArray(existingList) ? existingList : []
      const existingTestTrigger = listArray.find(
        (t) =>
          t.pluginId === 'diagnostics' && t.config?.key === hotkeyConfig.value
      )

      if (existingTestTrigger) {
        log(
          `热键 ${hotkeyConfig.value} 已注册 (ID: ${existingTestTrigger.id})，无需重复注册`,
          'warn'
        )
        return
      }

      const config = {
        id:
          'diag-test-hotkey-' +
          hotkeyConfig.value.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(), // 使用固定 ID 格式
        type: 'hotkey',
        pluginId: 'diagnostics',
        config: {
          key: hotkeyConfig.value
        },
        action: {
          mode: 'builtin',
          target: 'activate',
          params: {}
        },
        enabled: true
      }
      const res = await trigger.register(config)
      log(`热键注册成功: ${JSON.stringify(res)}`, 'success')
    }
    if (op === 'list') {
      const res = await trigger.list()
      const count = Array.isArray(res) ? res.length : 0
      log(`触发器列表 (${count} 个): ${JSON.stringify(res)}`, 'success')
    }
    if (op === 'clear') {
      const list = await trigger.list()
      const listArray = Array.isArray(list) ? list : []
      for (const t of listArray) {
        await trigger.unregister(t.id)
      }
      log('已清空所有触发器', 'success')
    }
  } catch (e) {
    log(e, 'error')
  }
}

// ==========================================
// Tab 8: 高级功能
// ==========================================
// Protocol
const protoPath = ref('C:\\Windows\\System32\\drivers\\etc\\hosts')
const protoImgPath = ref('')

const testProtocol = async (type) => {
  if (!canRunWindowsOnlyDiagnostic('本地文件协议测试')) return
  try {
    if (type === 'url') {
      const url = await protocol.getUrl(protoPath.value)
      log(`生成的协议 URL: ${url}`, 'success')
    }
    if (type === 'readText') {
      const url = await protocol.getUrl(protoPath.value)
      const text = await protocol.readText(url)
      log(`协议读取文本成功: ${text.slice(0, 200)}...`, 'success')
    }
    if (type === 'readBlob') {
      const url = await protocol.getUrl(protoPath.value)
      const blob = await protocol.readBlob(url)
      log(`协议读取Blob成功: ${blob.size} bytes, type: ${blob.type}`, 'success')
    }
  } catch (e) {
    log(e, 'error')
  }
}

// Privileged Service
const privRegPath = ref('Software\\ZToolsDiagnostics')
const privRegName = ref('TestValue')
const privRegVal = ref('123456')
const privFileTarget = ref('C:\\ZTools_Privileged_Test.txt')

const testPrivileged = async (action) => {
  if (!canRunWindowsOnlyDiagnostic('特权服务测试')) return
  try {
    let res
    if (action === 'regWrite64')
      res = await privileged.regWrite(
        privRegPath.value,
        privRegName.value,
        privRegVal.value,
        64
      )
    if (action === 'regWrite32')
      res = await privileged.regWrite(
        privRegPath.value,
        privRegName.value,
        privRegVal.value,
        32
      )
    if (action === 'regDelete64')
      res = await privileged.regDelete(privRegPath.value, privRegName.value, 64)
    if (action === 'regDelete32')
      res = await privileged.regDelete(privRegPath.value, privRegName.value, 32)
    if (action === 'fileWrite')
      res = await privileged.fileWrite(
        privFileTarget.value,
        'Privileged Content ' + new Date().toISOString()
      )
    if (action === 'restartExplorer') {
      confirmDialog({
        title: '警告',
        content: '确定要重启资源管理器吗？这会导致任务栏闪烁。',
        onOk: async () => {
          await privileged.restartExplorer()
          log('已发送重启资源管理器指令', 'success')
        }
      })
      return
    }
    log(`特权操作 ${action} 结果: ${JSON.stringify(res)}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// Screen
const screenOps = async (op) => {
  try {
    if (op === 'capture') {
      const base64 = await screen.capture({})
      log(`截图成功 (Base64 length: ${base64?.length || 0})`, 'success')
    }
    if (op === 'displays') {
      const displays = await screen.getAllDisplays()
      log(`显示器列表: ${JSON.stringify(displays)}`, 'success')
    }
    if (op === 'cursor') {
      const pos = await screen.getCursorPos()
      log(`鼠标位置: ${JSON.stringify(pos)}`, 'success')
    }
  } catch (e) {
    log(e, 'error')
  }
}

// 交互模拟
const simKey = ref('A')
const simulateKey = async () => {
  if (!isInputSimulationAvailable.value) {
    log(inputSimulationUnavailableMessage.value, 'warn')
    return
  }
  try {
    await simulate.keyPress(simKey.value)
    log(`模拟按键: ${simKey.value}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// Network & Process
const httpUrl = ref('https://www.baidu.com')
const httpResult = ref('')
const sendHttp = async () => {
  try {
    const res = await network.httpRequest({ method: 'GET', url: httpUrl.value })
    httpResult.value = `Status: ${res.status}\nBody: ${res.body?.slice(0, 100)}...`
    log(`HTTP请求成功: ${res.status}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const procList = ref([])
const getProcesses = async () => {
  try {
    const list = await process.getList()
    procList.value = list?.slice(0, 10) || []
    log(`获取进程列表: ${list?.length || 0}个`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// DLL Plugin
const dllPluginName = ref('')
const dllFuncName = ref('')
const dllParams = ref('{}')
const dllResult = ref('')

const testDllPlugin = async () => {
  try {
    const params = JSON.parse(dllParams.value)
    const res = await callDllPlugin(
      dllPluginName.value,
      dllFuncName.value,
      params
    )
    dllResult.value = JSON.stringify(res, null, 2)
    log('DLL插件调用成功', 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const getDllList = async () => {
  try {
    const list = await getDllPluginList()
    log(`DLL插件列表: ${JSON.stringify(list)}`, 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// 初始化
const activeTab = ref('1')
// 左侧诊断分类（值沿用原标签页的 key，测试按 key 切换）
const tabOptions = [
  { label: '系统基础', value: '1' },
  { label: '电源管理', value: '2' },
  { label: '文件系统', value: '3' },
  { label: '数据库', value: '4' },
  { label: '窗口控制', value: '5' },
  { label: '剪贴板 / Shell', value: '6' },
  { label: '事件 / 触发器', value: '7' },
  { label: '高级功能', value: '8' }
]
const sysPathOptions = ['desktop', 'documents', 'downloads', 'temp', 'appData'].map((value) => ({
  label: value,
  value
}))

let globalHotkeyListener = null

onMounted(() => {
  void loadDiagnosticHost()
  log('诊断中心已就绪。请选择左侧功能或运行一键体检。')
  if (!isNative) log('警告：当前不在宿主环境中，API 均不可用', 'warn')

  // 监听全局热键触发事件
  const events = window.ztools?.events
  if (events) {
    globalHotkeyListener = (envelope) => {
      const payload = envelope.payload || envelope
      log(`[Global] 热键触发: ${payload.id} (${payload.keys || ''})`, 'success')
    }
    events.on('hotkey_triggered', globalHotkeyListener)
  }

  // 确保日志列表滚动到底部
  nextTick(() => {
    if (logRef.value) {
      logRef.value.scrollTop = logRef.value.scrollHeight
    }
  })
})

onBeforeUnmount(() => {
  // 清理事件监听
  if (eventListener) {
    window.ztools?.events?.off(eventName.value, eventListener)
  }
  if (fileDropListener) {
    window.ztools?.events?.off('plugin_files_dropped', fileDropListener)
  }
  if (globalHotkeyListener) {
    window.ztools?.events?.off('hotkey_triggered', globalHotkeyListener)
  }
})
</script>

<template>
  <div class="diag-page">
    <!-- 页面标题 -->
    <header class="page-header diag-header">
      <div>
        <h1 class="page-title">API 诊断中心</h1>
        <p class="page-subtitle">逐项调用宿主接口，或运行一键批量体检，结果写入右侧日志</p>
      </div>
      <span class="diag-mode" :class="{ 'is-native': isNative }">
        <span class="diag-mode-dot" aria-hidden="true"></span>
        {{ isNative ? '宿主环境' : '浏览器环境' }}
      </span>
    </header>

    <!-- 主体内容区 (双栏布局) -->
    <div class="diag-body">
      <!-- 左侧：分类切换 + 功能测试 -->
      <section class="diag-main">
        <RcSegmented
          v-model="activeTab"
          :options="tabOptions"
          aria-label="诊断分类"
          class="diag-tabs"
        />

        <div class="diag-pane">
          <!-- 分类 1: 系统与基础 -->
          <div v-if="activeTab === '1'" class="diag-stack">
            <RcCard title="系统信息 (sys)">
              <div class="diag-actions">
                <RcButton variant="primary" @click="getSysInfo">获取系统信息</RcButton>
                <RcButton variant="secondary" @click="sendNotify">发送通知</RcButton>
                <RcButton variant="secondary" @click="getCpuMem">CPU / 内存</RcButton>
              </div>
              <pre class="diag-output">{{ sysInfoResult }}</pre>
            </RcCard>

            <RcCard title="系统路径 (sys.getPath)">
              <div class="diag-actions items-center">
                <RcSelect
                  v-model:value="sysPathType"
                  :options="sysPathOptions"
                  class="w-36"
                />
                <RcButton variant="primary" @click="getSysPath">获取路径</RcButton>
              </div>
              <div class="diag-output">{{ sysPathResult }}</div>
            </RcCard>
          </div>

          <!-- 分类 2: 电源管理 -->
          <div v-else-if="activeTab === '2'" class="diag-stack">
            <RcAlert
              message="部分操作会立即执行，请谨慎测试"
              type="warning"
              show-icon
            />

            <RcCard title="安全操作">
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="powerAction('lock')">锁定屏幕</RcButton>
                <RcButton variant="secondary" @click="powerAction('sleep')">系统睡眠</RcButton>
              </div>
            </RcCard>

            <RcCard title="危险操作（需确认）">
              <div class="diag-actions mb-0">
                <RcButton variant="danger" @click="powerAction('hibernate')">休眠</RcButton>
                <RcButton variant="danger" @click="powerAction('logout')">注销</RcButton>
                <RcButton variant="danger" @click="powerAction('restart')">重启</RcButton>
                <RcButton variant="danger" @click="powerAction('shutdown')">关机</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 3: 文件系统 -->
          <div v-else-if="activeTab === '3'" class="diag-stack">
            <RcAlert
              v-if="!isWindowsDiagnosticsAvailable"
              data-test="windows-filesystem-diagnostics-disabled"
              :message="windowsOnlyDiagnosticsMessage"
              type="warning"
              show-icon
            />
            <div
              v-else
              data-test="windows-filesystem-diagnostics"
              class="diag-stack"
            >
              <RcCard title="文件操作 (fs)">
                <a-input v-model:value="fsPath" addon-before="路径" class="mb-3" />
                <div class="diag-actions">
                  <RcButton variant="primary" @click="fsRead">读取</RcButton>
                  <RcButton variant="secondary" @click="fsCheckExists">检查存在</RcButton>
                  <RcButton variant="danger" @click="fsDeleteFile">删除</RcButton>
                </div>
                <div class="diag-output">{{ fsContent }}</div>
              </RcCard>

              <RcCard title="写入文件">
                <a-textarea v-model:value="fsWriteContent" :rows="2" class="mb-3" />
                <RcButton variant="primary" @click="fsWrite">写入到上方路径</RcButton>
              </RcCard>

              <RcCard title="目录操作">
                <div class="diag-actions">
                  <RcButton variant="secondary" @click="fsListDir">列出当前目录</RcButton>
                  <RcButton variant="secondary" @click="fsMkDir">创建测试目录</RcButton>
                </div>
                <ul class="diag-list max-h-32">
                  <li v-for="(item, idx) in fsDirList" :key="idx">{{ item }}</li>
                </ul>
              </RcCard>
            </div>
          </div>

          <!-- 分类 4: 数据库 -->
          <div v-else-if="activeTab === '4'" class="diag-stack">
            <RcCard title="存储测试 (db)">
              <div class="grid grid-cols-2 gap-2 mb-3">
                <a-input v-model:value="dbKey" addon-before="键" />
                <a-input v-model:value="dbVal" addon-before="值" />
              </div>
              <div class="diag-actions">
                <RcButton variant="primary" @click="dbOps('set')">写入</RcButton>
                <RcButton variant="secondary" @click="dbOps('get')">读取</RcButton>
                <RcButton variant="secondary" @click="dbOps('delete')">删除</RcButton>
                <RcButton variant="secondary" @click="dbOps('all')">全部文档</RcButton>
                <RcButton variant="secondary" @click="dbOps('secure_set')">加密写入</RcButton>
                <RcButton variant="secondary" @click="dbOps('secure_get')">加密读取</RcButton>
              </div>
              <pre class="diag-output">{{ dbResult }}</pre>
            </RcCard>
          </div>

          <!-- 分类 5: 窗口控制 -->
          <div v-else-if="activeTab === '5'" class="diag-stack">
            <RcCard title="窗口操作 (win)">
              <div class="diag-actions mb-4">
                <RcButton variant="secondary" @click="winTest('min')">最小化</RcButton>
                <RcButton variant="secondary" @click="winTest('max')">最大化</RcButton>
                <RcButton variant="secondary" @click="winTest('restore')">还原</RcButton>
                <RcButton variant="secondary" @click="winTest('top')">置顶</RcButton>
                <RcButton variant="secondary" @click="winTest('untop')">取消置顶</RcButton>
                <RcButton variant="secondary" @click="winTest('devtools')">开发者工具</RcButton>
                <RcButton variant="secondary" @click="winTest('getBounds')">获取边界</RcButton>
              </div>

              <div class="grid grid-cols-3 gap-2 mb-3 items-center">
                <a-input-number v-model:value="winWidth" addon-before="宽" class="w-full">
                  <template #upIcon><ChevronUpIcon aria-hidden="true" /></template>
                  <template #downIcon><ChevronDownIcon aria-hidden="true" /></template>
                </a-input-number>
                <a-input-number v-model:value="winHeight" addon-before="高" class="w-full">
                  <template #upIcon><ChevronUpIcon aria-hidden="true" /></template>
                  <template #downIcon><ChevronDownIcon aria-hidden="true" /></template>
                </a-input-number>
                <RcButton variant="primary" @click="winTest('setSize')">设置尺寸</RcButton>
              </div>

              <div class="flex gap-3 items-center">
                <span class="diag-label">透明度</span>
                <a-slider
                  v-model:value="winOpacity"
                  :min="0"
                  :max="1"
                  :step="0.1"
                  class="flex-1"
                />
                <RcButton variant="secondary" size="xs" @click="winTest('setOpacity')">应用</RcButton>
              </div>
            </RcCard>

            <RcCard title="对话框 (dialog)">
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="winOpenDialog('open')">打开文件</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('openMulti')">多选文件</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('save')">保存文件</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('folder')">选择文件夹</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 6: 剪贴板与 Shell -->
          <div v-else-if="activeTab === '6'" class="diag-stack">
            <RcCard title="剪贴板 (clipboard)">
              <a-textarea
                v-model:value="clipboardText"
                :rows="2"
                class="mb-3"
                placeholder="要写入剪贴板的文本"
              />
              <div class="diag-actions mb-0">
                <RcButton variant="primary" @click="clipboardOps('writeText')">写入文本</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readText')">读取文本</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readImage')">读取图片</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readFiles')">读取文件</RcButton>
                <RcButton variant="danger" @click="clipboardOps('clear')">清空</RcButton>
              </div>
            </RcCard>

            <RcCard title="Shell 操作 (shell)">
              <a-input v-model:value="externalUrl" addon-before="URL" class="mb-2" />
              <RcButton variant="primary" class="mb-4" @click="shellOps('openExternal')">打开外部链接</RcButton>

              <a-input v-model:value="shellCmd" addon-before="命令" class="mb-2" />
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="shellOps('exec')">执行命令</RcButton>
                <RcButton variant="secondary" @click="shellOps('beep')">提示音</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 7: 事件与触发器 -->
          <div v-else-if="activeTab === '7'" class="diag-stack">
            <RcCard title="事件系统 (events)">
              <a-input v-model:value="eventName" addon-before="事件名" class="mb-2" />
              <a-textarea
                v-model:value="eventData"
                :rows="2"
                class="mb-3"
                placeholder="事件数据 (JSON)"
              />
              <div class="diag-actions">
                <RcButton variant="primary" @click="eventsOps('emit')">发送事件</RcButton>
                <RcButton variant="secondary" @click="eventsOps('on')">开始监听</RcButton>
                <RcButton variant="secondary" @click="eventsOps('off')">停止监听</RcButton>
              </div>
              <RcButton variant="secondary" @click="startFileDrop">启动文件拖放监听（10 秒）</RcButton>
            </RcCard>

            <RcCard title="触发器系统 (trigger)">
              <a-input
                v-model:value="hotkeyConfig"
                addon-before="热键"
                class="mb-3"
                placeholder="例如: Ctrl+Alt+T"
              />
              <div class="diag-actions mb-0">
                <RcButton variant="primary" @click="triggerOps('register')">注册热键</RcButton>
                <RcButton variant="secondary" @click="triggerOps('list')">列出触发器</RcButton>
                <RcButton variant="danger" @click="triggerOps('clear')">清空所有</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 8: 高级功能 -->
          <div v-else-if="activeTab === '8'" class="diag-stack">
            <RcAlert
              v-if="!isWindowsDiagnosticsAvailable"
              data-test="windows-advanced-diagnostics-disabled"
              :message="windowsOnlyDiagnosticsMessage"
              type="warning"
              show-icon
            />
            <div
              v-if="isWindowsDiagnosticsAvailable"
              data-test="windows-advanced-diagnostics"
              class="diag-stack"
            >
              <RcCard title="协议读取 (ztools://)">
                <a-input v-model:value="protoPath" addon-before="路径" class="mb-3" />
                <div class="diag-actions mb-0">
                  <RcButton variant="secondary" @click="testProtocol('url')">生成 URL</RcButton>
                  <RcButton variant="secondary" @click="testProtocol('readText')">读取文本</RcButton>
                  <RcButton variant="secondary" @click="testProtocol('readBlob')">读取 Blob</RcButton>
                </div>
              </RcCard>

              <RcCard title="特权服务 (privileged)">
                <RcAlert
                  message="通过 ZToolsService（System 权限）执行"
                  type="info"
                  show-icon
                  class="mb-3"
                />
                <div class="space-y-2">
                  <a-input v-model:value="privRegPath" addon-before="注册表路径" />
                  <div class="grid grid-cols-2 gap-2">
                    <a-input v-model:value="privRegName" addon-before="名称" />
                    <a-input v-model:value="privRegVal" addon-before="值" />
                  </div>
                  <div class="diag-actions">
                    <RcButton variant="secondary" @click="testPrivileged('regWrite64')">写入 64 位</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regWrite32')">写入 32 位</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regDelete64')">删除 64 位</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regDelete32')">删除 32 位</RcButton>
                  </div>
                  <a-input v-model:value="privFileTarget" addon-before="文件" />
                  <div class="diag-actions mb-0">
                    <RcButton variant="primary" @click="testPrivileged('fileWrite')">提权写入</RcButton>
                    <RcButton variant="danger" @click="testPrivileged('restartExplorer')">重启 Explorer</RcButton>
                  </div>
                </div>
              </RcCard>
            </div>

            <RcCard title="屏幕与模拟 (screen)">
              <div class="diag-actions">
                <RcButton variant="secondary" @click="screenOps('capture')">截图</RcButton>
                <RcButton variant="secondary" @click="screenOps('displays')">显示器列表</RcButton>
                <RcButton variant="secondary" @click="screenOps('cursor')">鼠标位置</RcButton>
              </div>
              <div v-if="isInputSimulationAvailable" class="flex gap-2 items-center">
                <a-input v-model:value="simKey" class="w-20" placeholder="按键" />
                <RcButton variant="secondary" @click="simulateKey">模拟按键</RcButton>
              </div>
              <RcAlert
                v-else
                data-test="input-simulation-disabled"
                :message="inputSimulationUnavailableMessage"
                type="warning"
                show-icon
              />
            </RcCard>

            <RcCard title="网络与进程 (network / process)">
              <a-input v-model:value="httpUrl" addon-before="URL" class="mb-2" />
              <RcButton variant="primary" class="mb-2" @click="sendHttp">发送 HTTP 请求</RcButton>
              <div class="diag-output mb-3">{{ httpResult }}</div>

              <RcButton variant="secondary" @click="getProcesses">获取进程列表</RcButton>
              <ul class="diag-list max-h-24 mt-2">
                <li v-for="(p, i) in procList" :key="i">{{ p.name || p }}</li>
              </ul>
            </RcCard>

            <RcCard title="DLL 插件调用 (dllplugin)">
              <div class="grid grid-cols-2 gap-2 mb-2">
                <a-input v-model:value="dllPluginName" addon-before="插件名" />
                <a-input v-model:value="dllFuncName" addon-before="函数名" />
              </div>
              <a-textarea
                v-model:value="dllParams"
                :rows="2"
                class="mb-3"
                placeholder="参数 (JSON)"
              />
              <div class="diag-actions">
                <RcButton variant="primary" @click="testDllPlugin">调用 DLL 函数</RcButton>
                <RcButton variant="secondary" @click="getDllList">获取 DLL 列表</RcButton>
              </div>
              <pre class="diag-output">{{ dllResult }}</pre>
            </RcCard>
          </div>
        </div>
      </section>

      <!-- 右侧：一键体检与实时日志 -->
      <aside class="diag-side">
        <!-- 一键体检面板 -->
        <div class="diag-batch">
          <h2 class="diag-section-title">批量体检</h2>
          <RcButton
            variant="primary"
            size="md"
            class="w-full mb-3"
            :loading="isTesting"
            @click="runBatchTest"
          >
            {{ isTesting ? '正在体检中...' : '开始一键批量体检' }}
          </RcButton>

          <p
            v-if="batchPlatformStatus"
            data-test="batch-platform-status"
            class="diag-batch-status"
          >
            {{ batchPlatformStatus }}
          </p>

          <div class="diag-batch-stats">
            <div class="diag-stat-row">
              <span>进度</span>
              <span class="tabular-nums">{{ Math.round((passCount / totalCount) * 100) || 0 }}%</span>
            </div>
            <div
              class="diag-progress"
              role="progressbar"
              :aria-valuenow="testProgress"
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <div class="diag-progress-fill" :style="{ width: `${testProgress}%` }"></div>
            </div>
            <div class="diag-stat-row">
              <span data-test="batch-pass-count" class="is-success">成功: {{ passCount }}</span>
              <span data-test="batch-fail-count" class="is-error">失败: {{ failCount }}</span>
            </div>
            <div class="diag-stat-row">
              <span>适用项: {{ totalCount }}</span>
              <span data-test="batch-skip-count" class="is-warn">已跳过: {{ skipCount }}</span>
            </div>
          </div>
        </div>

        <!-- 日志列表 -->
        <div class="diag-log-header">
          <span class="diag-section-title mb-0">实时日志</span>
          <RcButton variant="ghost" size="xs" @click="clearLog">清空</RcButton>
        </div>

        <div ref="logRef" class="diag-log">
          <div v-if="logs.length === 0" class="diag-log-empty">暂无日志</div>
          <div
            v-for="(l, i) in logs"
            :key="i"
            class="diag-log-line animate-fade-in"
            :class="`is-${l.type}`"
          >
            <span class="diag-log-dot" aria-hidden="true"></span>
            <span class="diag-log-time">{{ l.time }}</span>
            <div class="diag-log-content">{{ l.content }}</div>
            <span v-if="l.duration" class="diag-log-time">{{ l.duration }}</span>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 页面骨架 ---------- */
.diag-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--rc-canvas);
  color: var(--rc-text-primary);
}

.diag-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 0;
  padding: 22px 24px 16px;
  flex-shrink: 0;
}

/* 运行环境标识：中性灰阶胶囊，宿主环境时圆点为成功色 */
.diag-mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--rc-border);
  border-radius: 999px;
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font-size: 12px;
  white-space: nowrap;
}

.diag-mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rc-text-faint);
}

.diag-mode.is-native .diag-mode-dot {
  background: var(--rc-success);
}

.diag-body {
  flex: 1;
  display: flex;
  min-height: 0;
  border-top: 1px solid var(--rc-border);
}

/* ---------- 左侧功能区 ---------- */
.diag-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.diag-tabs {
  padding: 12px 20px 0;
  flex-shrink: 0;
}

.diag-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px 24px;
}

.diag-stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.diag-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.diag-actions.mb-0 {
  margin-bottom: 0;
}

.diag-label {
  font-size: 12px;
  color: var(--rc-text-secondary);
}

/* 结果区：浅底等宽字体，深色主题下同样是带边框的浅一级表面，不是纯黑条 */
.diag-output {
  margin: 0;
  min-height: 32px;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface-subtle);
  color: var(--rc-text-secondary);
  font-family: var(--rc-font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

.diag-list {
  margin: 0;
  padding-left: 18px;
  overflow: auto;
  list-style: disc;
  color: var(--rc-text-secondary);
  font-family: var(--rc-font-mono);
  font-size: 12px;
}

/* ---------- 右侧体检与日志 ---------- */
.diag-side {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--rc-border);
  background: var(--rc-surface);
}

.diag-batch {
  padding: 16px;
  border-bottom: 1px solid var(--rc-border);
}

.diag-section-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-text-primary);
}

.diag-batch-status {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.diag-batch-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diag-stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--rc-text-muted);
}

.diag-stat-row .is-success {
  color: var(--rc-success);
}

.diag-stat-row .is-error {
  color: var(--rc-error);
}

.diag-stat-row .is-warn {
  color: var(--rc-warning);
}

.diag-progress {
  height: 6px;
  border-radius: 999px;
  background: var(--rc-surface-active);
  overflow: hidden;
}

.diag-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--rc-accent);
  transition: width 0.2s ease;
}

.diag-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--rc-border);
}

.diag-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  background: var(--rc-surface-subtle);
  font-family: var(--rc-font-mono);
  font-size: 12px;
}

.diag-log-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--rc-text-muted);
  font-family: inherit;
}

/* 日志行：中性底色，仅用小圆点区分级别 */
.diag-log-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--rc-text-secondary);
}

.diag-log-line:hover {
  background: var(--rc-surface-hover);
}

.diag-log-dot {
  width: 6px;
  height: 6px;
  margin-top: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--rc-text-faint);
}

.diag-log-line.is-success .diag-log-dot {
  background: var(--rc-success);
}

.diag-log-line.is-warn .diag-log-dot {
  background: var(--rc-warning);
}

.diag-log-line.is-error .diag-log-dot {
  background: var(--rc-error);
}

.diag-log-line.is-error .diag-log-content {
  color: var(--rc-error);
}

.diag-log-time {
  flex-shrink: 0;
  color: var(--rc-text-faint);
  user-select: none;
  font-variant-numeric: tabular-nums;
}

.diag-log-content {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 滚动条 */
.diag-log::-webkit-scrollbar {
  width: 6px;
}
.diag-log::-webkit-scrollbar-thumb {
  background-color: var(--rc-border-highlight);
  border-radius: 3px;
}
.diag-log::-webkit-scrollbar-track {
  background-color: transparent;
}

/* 简单的淡入动画 */
@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.animate-fade-in {
  animation: fadeIn 0.2s ease-out forwards;
}
</style>
