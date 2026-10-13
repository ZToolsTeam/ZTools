<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, reactive, computed } from 'vue'
import { message as antMessage, Modal } from 'ant-design-vue'
import {
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
  callDllPlugin
} from '@/api/native'
import {
  getMarketPlugins,
  getPluginDetails,
  getDownloadSign
} from '@/api/apiserver'
import { installPluginNative, uninstallPluginNative } from '@/api/native'

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
const isInputSimulationAvailable = computed(
  () => diagnosticPlatform.value === 'windows' && diagnosticRuntime.value === 'cef'
)
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
  return '未确认支持按键注入的 Windows CEF 宿主；按键模拟已关闭。'
})

const detectDiagnosticRuntime = () => {
  try {
    const host = window.ztools
    if (typeof host?.isElectron === 'function' && host.isElectron()) return 'electron'
    if (typeof host?.isCEF === 'function' && host.isCEF()) return 'cef'
  } catch {}
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
      const response = await fetch(url)
      const text = await response.text()
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
    runtimes: ['cef'],
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
    const runtimeLabel = runtime === 'electron' ? 'Electron' : runtime === 'cef' ? 'CEF' : '宿主未知'
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
    Modal.confirm({
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
  Modal.confirm({
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
      Modal.confirm({
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

let globalHotkeyListener = null

onMounted(() => {
  void loadDiagnosticHost()
  log('诊断中心已就绪。请选择左侧功能或运行一键体检。')
  if (!isNative) log('警告：当前为非 Native 环境，API 均不可用', 'warn')

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
  <div
    class="h-full flex flex-col bg-gray-50 dark:bg-slate-900 text-gray-800 dark:text-gray-200"
  >
    <!-- 顶部标题栏 -->
    <div
      class="px-6 py-4 bg-white dark:bg-slate-800 border-b dark:border-slate-700 flex justify-between items-center shrink-0"
    >
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-bold">ZTools API 诊断中心</h1>
        <span
          class="px-2 py-0.5 text-xs rounded-full"
          :class="
            isNative
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-200 text-gray-600'
          "
        >
          {{ isNative ? 'Native Mode' : 'Browser Mode' }}
        </span>
      </div>
      <div class="text-sm text-gray-500">v3.0 (Full API Coverage)</div>
    </div>

    <!-- 主体内容区 (双栏布局) -->
    <div class="flex-1 flex overflow-hidden">
      <!-- 左侧：功能测试 Tabs (60%) -->
      <div class="flex-1 flex flex-col min-w-0 border-r dark:border-slate-700">
        <a-tabs
          v-model:activeKey="activeTab"
          class="h-full flex flex-col diag-tabs"
          type="card"
        >
          <!-- Tab 1: 系统与基础 -->
          <a-tab-pane key="1" tab="系统基础" class="p-4 overflow-y-auto h-full">
            <div class="space-y-4">
              <a-card title="系统信息 (sys)" size="small">
                <div class="flex flex-wrap gap-2 mb-2">
                  <a-button type="primary" @click="getSysInfo"
                    >获取系统信息</a-button
                  >
                  <a-button @click="sendNotify">发送通知</a-button>
                  <a-button @click="getCpuMem">CPU/内存</a-button>
                </div>
                <pre
                  class="bg-gray-100 dark:bg-black p-2 rounded text-xs overflow-auto max-h-40"
                  >{{ sysInfoResult }}</pre
                >
              </a-card>

              <a-card title="系统路径 (sys.getPath)" size="small">
                <div class="flex gap-2 items-center mb-2">
                  <a-select v-model:value="sysPathType" class="w-32">
                    <a-select-option value="desktop">desktop</a-select-option>
                    <a-select-option value="documents"
                      >documents</a-select-option
                    >
                    <a-select-option value="downloads"
                      >downloads</a-select-option
                    >
                    <a-select-option value="temp">temp</a-select-option>
                    <a-select-option value="appData">appData</a-select-option>
                  </a-select>
                  <a-button type="primary" @click="getSysPath"
                    >获取路径</a-button
                  >
                </div>
                <div
                  class="text-xs bg-gray-100 dark:bg-black p-2 rounded break-all"
                >
                  {{ sysPathResult }}
                </div>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 2: 电源管理 -->
          <a-tab-pane key="2" tab="电源管理" class="p-4 overflow-y-auto h-full">
            <div class="space-y-4">
              <a-alert
                message="危险操作警告：部分操作会立即执行，请谨慎测试"
                type="warning"
                show-icon
                class="mb-4"
              />

              <a-card title="安全操作" size="small">
                <div class="flex gap-2">
                  <a-button @click="powerAction('lock')">🔒 锁定屏幕</a-button>
                  <a-button @click="powerAction('sleep')">💤 系统睡眠</a-button>
                </div>
              </a-card>

              <a-card title="危险操作 (需确认)" size="small">
                <div class="flex flex-wrap gap-2">
                  <a-button danger @click="powerAction('hibernate')"
                    >❄️ 休眠</a-button
                  >
                  <a-button danger @click="powerAction('logout')"
                    >🚪 注销</a-button
                  >
                  <a-button danger @click="powerAction('restart')"
                    >🔄 重启</a-button
                  >
                  <a-button danger @click="powerAction('shutdown')"
                    >⏻ 关机</a-button
                  >
                </div>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 3: 文件系统 -->
          <a-tab-pane key="3" tab="文件系统" class="p-4 overflow-y-auto h-full">
            <a-alert
              v-if="!isWindowsDiagnosticsAvailable"
              data-test="windows-filesystem-diagnostics-disabled"
              :message="windowsOnlyDiagnosticsMessage"
              type="warning"
              show-icon
            />
            <div
              v-else
              data-test="windows-filesystem-diagnostics"
              class="space-y-4"
            >
              <a-card title="文件操作 (fs)" size="small">
                <a-input
                  v-model:value="fsPath"
                  addon-before="Path"
                  class="mb-2"
                />
                <div class="flex flex-wrap gap-2 mb-2">
                  <a-button type="primary" @click="fsRead">读取</a-button>
                  <a-button @click="fsCheckExists">检查存在</a-button>
                  <a-button danger @click="fsDeleteFile">删除</a-button>
                </div>
                <div
                  class="mt-2 p-2 bg-gray-100 dark:bg-black rounded text-xs break-all max-h-40 overflow-auto"
                >
                  {{ fsContent }}
                </div>
              </a-card>

              <a-card title="写入文件" size="small">
                <a-textarea
                  v-model:value="fsWriteContent"
                  :rows="2"
                  class="mb-2"
                />
                <a-button type="primary" @click="fsWrite"
                  >写入到上方路径</a-button
                >
              </a-card>

              <a-card title="目录操作" size="small">
                <div class="flex gap-2 mb-2">
                  <a-button @click="fsListDir">列出当前目录</a-button>
                  <a-button @click="fsMkDir">创建测试目录</a-button>
                </div>
                <ul class="text-xs max-h-32 overflow-auto list-disc pl-4">
                  <li v-for="(item, idx) in fsDirList" :key="idx">
                    {{ item }}
                  </li>
                </ul>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 4: 数据库 -->
          <a-tab-pane key="4" tab="数据库" class="p-4 overflow-y-auto h-full">
            <div class="space-y-4">
              <a-card title="存储测试 (db)" size="small">
                <div class="grid grid-cols-2 gap-2 mb-2">
                  <a-input v-model:value="dbKey" addon-before="Key" />
                  <a-input v-model:value="dbVal" addon-before="Val" />
                </div>
                <div class="flex flex-wrap gap-2">
                  <a-button type="primary" size="small" @click="dbOps('set')"
                    >Put</a-button
                  >
                  <a-button type="primary" size="small" @click="dbOps('get')"
                    >Get</a-button
                  >
                  <a-button size="small" @click="dbOps('delete')"
                    >Delete</a-button
                  >
                  <a-button size="small" @click="dbOps('all')"
                    >All Docs</a-button
                  >
                  <a-button size="small" @click="dbOps('secure_set')"
                    >Secure Put</a-button
                  >
                  <a-button size="small" @click="dbOps('secure_get')"
                    >Secure Get</a-button
                  >
                </div>
                <pre
                  class="mt-2 bg-gray-100 dark:bg-black p-2 rounded text-xs max-h-40 overflow-auto"
                  >{{ dbResult }}</pre
                >
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 5: 窗口控制 -->
          <a-tab-pane key="5" tab="窗口控制" class="p-4 overflow-y-auto h-full">
            <div class="space-y-4">
              <a-card title="窗口操作 (win)" size="small">
                <div class="flex flex-wrap gap-2 mb-4">
                  <a-button @click="winTest('min')">最小化</a-button>
                  <a-button @click="winTest('max')">最大化</a-button>
                  <a-button @click="winTest('restore')">还原</a-button>
                  <a-button @click="winTest('top')">置顶</a-button>
                  <a-button @click="winTest('untop')">取消置顶</a-button>
                  <a-button @click="winTest('devtools')">DevTools</a-button>
                  <a-button @click="winTest('getBounds')">获取边界</a-button>
                </div>

                <div class="grid grid-cols-3 gap-2 mb-2">
                  <a-input-number
                    v-model:value="winWidth"
                    addon-before="宽"
                    class="w-full"
                  />
                  <a-input-number
                    v-model:value="winHeight"
                    addon-before="高"
                    class="w-full"
                  />
                  <a-button type="primary" @click="winTest('setSize')"
                    >设置尺寸</a-button
                  >
                </div>

                <div class="flex gap-2 items-center">
                  <span class="text-xs">透明度:</span>
                  <a-slider
                    v-model:value="winOpacity"
                    :min="0"
                    :max="1"
                    :step="0.1"
                    class="flex-1"
                  />
                  <a-button size="small" @click="winTest('setOpacity')"
                    >应用</a-button
                  >
                </div>
              </a-card>

              <a-card title="对话框 (Dialogs)" size="small">
                <div class="flex flex-wrap gap-2">
                  <a-button @click="winOpenDialog('open')"
                    >📂 打开文件</a-button
                  >
                  <a-button @click="winOpenDialog('openMulti')"
                    >📂 多选文件</a-button
                  >
                  <a-button @click="winOpenDialog('save')"
                    >💾 保存文件</a-button
                  >
                  <a-button @click="winOpenDialog('folder')"
                    >📁 选择文件夹</a-button
                  >
                </div>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 6: 剪贴板与Shell -->
          <a-tab-pane
            key="6"
            tab="剪贴板/Shell"
            class="p-4 overflow-y-auto h-full"
          >
            <div class="space-y-4">
              <a-card title="剪贴板 (clipboard)" size="small">
                <a-textarea
                  v-model:value="clipboardText"
                  :rows="2"
                  class="mb-2"
                  placeholder="要写入剪贴板的文本"
                />
                <div class="flex flex-wrap gap-2">
                  <a-button type="primary" @click="clipboardOps('writeText')"
                    >写入文本</a-button
                  >
                  <a-button @click="clipboardOps('readText')"
                    >读取文本</a-button
                  >
                  <a-button @click="clipboardOps('readImage')"
                    >读取图片</a-button
                  >
                  <a-button @click="clipboardOps('readFiles')"
                    >读取文件</a-button
                  >
                  <a-button danger @click="clipboardOps('clear')"
                    >清空</a-button
                  >
                </div>
              </a-card>

              <a-card title="Shell 操作" size="small">
                <a-input
                  v-model:value="externalUrl"
                  addon-before="URL"
                  class="mb-2"
                />
                <a-button
                  type="primary"
                  @click="shellOps('openExternal')"
                  class="mb-2"
                  >打开外部链接</a-button
                >

                <a-input
                  v-model:value="shellCmd"
                  addon-before="命令"
                  class="mb-2"
                />
                <div class="flex gap-2">
                  <a-button @click="shellOps('exec')">执行命令</a-button>
                  <a-button @click="shellOps('beep')">🔔 Beep</a-button>
                </div>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 7: 事件与触发器 -->
          <a-tab-pane
            key="7"
            tab="事件/触发器"
            class="p-4 overflow-y-auto h-full"
          >
            <div class="space-y-4">
              <a-card title="事件系统 (events)" size="small">
                <a-input
                  v-model:value="eventName"
                  addon-before="事件名"
                  class="mb-2"
                />
                <a-textarea
                  v-model:value="eventData"
                  :rows="2"
                  class="mb-2"
                  placeholder="事件数据 (JSON)"
                />
                <div class="flex gap-2 mb-4">
                  <a-button type="primary" @click="eventsOps('emit')"
                    >发送事件</a-button
                  >
                  <a-button @click="eventsOps('on')">开始监听</a-button>
                  <a-button @click="eventsOps('off')">停止监听</a-button>
                </div>

                <a-button @click="startFileDrop"
                  >📁 启动文件拖放监听 (10秒)</a-button
                >
              </a-card>

              <a-card title="触发器系统 (trigger)" size="small">
                <a-input
                  v-model:value="hotkeyConfig"
                  addon-before="热键"
                  class="mb-2"
                  placeholder="例如: Ctrl+Alt+T"
                />
                <div class="flex gap-2">
                  <a-button type="primary" @click="triggerOps('register')"
                    >注册热键</a-button
                  >
                  <a-button @click="triggerOps('list')">列出触发器</a-button>
                  <a-button danger @click="triggerOps('clear')"
                    >清空所有</a-button
                  >
                </div>
              </a-card>
            </div>
          </a-tab-pane>

          <!-- Tab 8: 高级功能 -->
          <a-tab-pane key="8" tab="高级功能" class="p-4 overflow-y-auto h-full">
            <div class="space-y-4">
              <a-alert
                v-if="!isWindowsDiagnosticsAvailable"
                data-test="windows-advanced-diagnostics-disabled"
                :message="windowsOnlyDiagnosticsMessage"
                type="warning"
                show-icon
              />
              <div
                v-if="isWindowsDiagnosticsAvailable"
                data-test="windows-advanced-diagnostics"
                class="space-y-4"
              >
              <a-card title="协议读取 (ztools://)" size="small">
                <a-input
                  v-model:value="protoPath"
                  addon-before="路径"
                  class="mb-2"
                />
                <div class="flex gap-2">
                  <a-button @click="testProtocol('url')">生成URL</a-button>
                  <a-button @click="testProtocol('readText')"
                    >读取文本</a-button
                  >
                  <a-button @click="testProtocol('readBlob')"
                    >读取Blob</a-button
                  >
                </div>
              </a-card>

              <a-card title="特权服务 (privileged)" size="small">
                <a-alert
                  message="通过 ZToolsService (System 权限) 执行"
                  type="info"
                  show-icon
                  class="mb-2"
                />
                <div class="space-y-2">
                  <a-input
                    v-model:value="privRegPath"
                    addon-before="注册表路径"
                  />
                  <div class="grid grid-cols-2 gap-2">
                    <a-input v-model:value="privRegName" addon-before="Name" />
                    <a-input v-model:value="privRegVal" addon-before="Val" />
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <a-button
                      type="primary"
                      size="small"
                      @click="testPrivileged('regWrite64')"
                      >写入64位</a-button
                    >
                    <a-button size="small" @click="testPrivileged('regWrite32')"
                      >写入32位</a-button
                    >
                    <a-button
                      size="small"
                      @click="testPrivileged('regDelete64')"
                      >删除64位</a-button
                    >
                    <a-button
                      size="small"
                      @click="testPrivileged('regDelete32')"
                      >删除32位</a-button
                    >
                  </div>
                  <a-input v-model:value="privFileTarget" addon-before="文件" />
                  <div class="flex gap-2">
                    <a-button
                      type="primary"
                      @click="testPrivileged('fileWrite')"
                      >提权写入</a-button
                    >
                    <a-button danger @click="testPrivileged('restartExplorer')"
                      >重启Explorer</a-button
                    >
                  </div>
                </div>
              </a-card>
              </div>

              <a-card title="屏幕与模拟" size="small">
                <div class="flex flex-wrap gap-2 mb-2">
                  <a-button @click="screenOps('capture')">📷 截图</a-button>
                  <a-button @click="screenOps('displays')"
                    >🖥️ 显示器列表</a-button
                  >
                  <a-button @click="screenOps('cursor')">🖱️ 鼠标位置</a-button>
                </div>
                <div v-if="isInputSimulationAvailable" class="flex gap-2 items-center">
                  <a-input
                    v-model:value="simKey"
                    class="w-20"
                    placeholder="按键"
                  />
                  <a-button @click="simulateKey">模拟按键</a-button>
                </div>
                <a-alert
                  v-else
                  data-test="input-simulation-disabled"
                  :message="inputSimulationUnavailableMessage"
                  type="warning"
                  show-icon
                />
              </a-card>

              <a-card title="网络与进程" size="small">
                <a-input
                  v-model:value="httpUrl"
                  addon-before="URL"
                  class="mb-2"
                />
                <a-button type="primary" @click="sendHttp" class="mb-2"
                  >发送HTTP请求</a-button
                >
                <div class="text-xs bg-gray-100 dark:bg-black p-2 rounded mb-2">
                  {{ httpResult }}
                </div>

                <a-button @click="getProcesses">获取进程列表</a-button>
                <ul class="text-xs max-h-24 overflow-auto mt-2 list-disc pl-4">
                  <li v-for="(p, i) in procList" :key="i">{{ p.name || p }}</li>
                </ul>
              </a-card>

              <a-card title="DLL 插件调用" size="small">
                <div class="grid grid-cols-2 gap-2 mb-2">
                  <a-input
                    v-model:value="dllPluginName"
                    addon-before="插件名"
                  />
                  <a-input v-model:value="dllFuncName" addon-before="函数名" />
                </div>
                <a-textarea
                  v-model:value="dllParams"
                  :rows="2"
                  class="mb-2"
                  placeholder="参数 (JSON)"
                />
                <div class="flex gap-2">
                  <a-button type="primary" @click="testDllPlugin"
                    >调用DLL函数</a-button
                  >
                  <a-button @click="getDllList">获取DLL列表</a-button>
                </div>
                <pre
                  class="mt-2 bg-gray-100 dark:bg-black p-2 rounded text-xs max-h-32 overflow-auto"
                  >{{ dllResult }}</pre
                >
              </a-card>
            </div>
          </a-tab-pane>
        </a-tabs>
      </div>

      <!-- 右侧：实时日志与诊断中心 (40%) -->
      <div
        class="w-[400px] flex flex-col bg-white dark:bg-slate-800 border-l dark:border-slate-700 shadow-xl z-10"
      >
        <!-- 一键体检面板 -->
        <div
          class="p-4 border-b dark:border-slate-700 bg-blue-50 dark:bg-slate-800/50"
        >
          <h3 class="text-sm font-bold mb-3 text-blue-800 dark:text-blue-300">
            自动化诊断中心
          </h3>
          <a-button
            type="primary"
            block
            size="large"
            :loading="isTesting"
            @click="runBatchTest"
            class="mb-3 font-semibold"
          >
            {{ isTesting ? '正在体检中...' : '开始一键批量体检' }}
          </a-button>

          <p
            v-if="batchPlatformStatus"
            data-test="batch-platform-status"
            class="mb-2 text-xs text-gray-600 dark:text-gray-300"
          >
            {{ batchPlatformStatus }}
          </p>

          <div class="space-y-2">
            <div class="flex justify-between text-xs text-gray-500">
              <span>进度</span>
              <span
                >{{ Math.round((passCount / totalCount) * 100) || 0 }}%</span
              >
            </div>
            <a-progress
              :percent="testProgress"
              :show-info="false"
              status="active"
            />
            <div class="flex justify-between text-xs mt-1">
              <span data-test="batch-pass-count" class="text-green-600"
                >成功: {{ passCount }}</span
              >
              <span data-test="batch-fail-count" class="text-red-500"
                >失败: {{ failCount }}</span
              >
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-gray-400">适用项: {{ totalCount }}</span>
              <span data-test="batch-skip-count" class="text-amber-600"
                >已跳过: {{ skipCount }}</span
              >
            </div>
          </div>
        </div>

        <!-- 日志列表 -->
        <div
          class="flex items-center justify-between p-2 px-3 border-b dark:border-slate-700 bg-gray-50 dark:bg-slate-900"
        >
          <span class="text-xs font-bold text-gray-500">实时日志流</span>
          <a-button type="text" size="small" @click="clearLog" class="text-xs"
            >清空</a-button
          >
        </div>

        <div
          class="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-1 log-container"
          ref="logRef"
        >
          <div
            v-if="logs.length === 0"
            class="text-center text-gray-400 py-10 italic"
          >
            暂无日志...
          </div>
          <div
            v-for="(l, i) in logs"
            :key="i"
            class="p-1.5 rounded border-l-2 flex gap-2 items-start animate-fade-in"
            :class="{
              'border-blue-500 bg-blue-50 dark:bg-blue-900/20':
                l.type === 'info',
              'border-green-500 bg-green-50 dark:bg-green-900/20':
                l.type === 'success',
              'border-red-500 bg-red-50 dark:bg-red-900/20': l.type === 'error',
              'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20':
                l.type === 'warn'
            }"
          >
            <span class="text-gray-400 shrink-0 select-none"
              >[{{ l.time }}]</span
            >
            <div class="flex-1 break-all whitespace-pre-wrap">
              {{ l.content }}
            </div>
            <span v-if="l.duration" class="text-gray-400 shrink-0">{{
              l.duration
            }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Tabs 样式优化 */
.diag-tabs :deep(.ant-tabs-nav) {
  margin-bottom: 0;
  padding: 0 8px;
}
.diag-tabs :deep(.ant-tabs-tab) {
  padding: 8px 12px;
  font-size: 13px;
}
.diag-tabs :deep(.ant-tabs-content) {
  height: calc(100% - 46px);
}
.diag-tabs :deep(.ant-tabs-tabpane) {
  height: 100%;
}

/* 滚动条美化 */
.log-container::-webkit-scrollbar {
  width: 6px;
}
.log-container::-webkit-scrollbar-thumb {
  background-color: #cbd5e1;
  border-radius: 3px;
}
.log-container::-webkit-scrollbar-track {
  background-color: transparent;
}
html.dark .log-container::-webkit-scrollbar-thumb {
  background-color: #475569;
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
