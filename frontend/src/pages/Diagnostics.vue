<script setup>
import { ChevronDownIcon, ChevronUpIcon } from '@lucide/vue'
import { confirmDialog } from '@/utils/confirmDialog'
import { RcAlert, RcButton, RcCard, RcSegmented, RcSelect } from '@/components/base'
import { ref, onMounted, onBeforeUnmount, onDeactivated, nextTick, reactive, computed } from 'vue'
import { message as antMessage } from 'ant-design-vue'
import { useDiagnosticsApi } from '@/composables/useDiagnosticsApi'
import { useAppI18n, getCurrentLocale } from '@/i18n'
import { resolveErrorMessage } from '@/utils/errorMessage'

const { t } = useAppI18n()

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
  getDllPluginList,
  callDllPlugin,
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
  const time = new Date().toLocaleTimeString(getCurrentLocale())
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
let batchGeneration = 0
// 记录批量体检最近一次识别出的平台状态，用于随语言热切换实时渲染
const batchPlatformMeta = ref(null)
const batchPlatformStatus = computed(() => {
  const meta = batchPlatformMeta.value
  if (!meta) return ''
  if (meta.kind === 'known') {
    const runtimeLabel = meta.runtime === 'electron' ? 'Electron' : t('diagnostics.batch.runtimeUnknown')
    return t('diagnostics.batch.platformDetected', {
      platform: meta.platform === 'windows' ? 'Windows' : 'macOS',
      runtime: runtimeLabel
    })
  }
  if (meta.kind === 'read-failed') {
    return t('diagnostics.batch.platformReadFailed')
  }
  return t('diagnostics.batch.platformUnsupported', { platform: meta.platformLabel })
})
const diagnosticPlatform = ref('unknown')
const diagnosticPlatformReadFailed = ref(false)
const diagnosticRuntime = ref('unknown')
const isWindowsDiagnosticsAvailable = computed(() => diagnosticPlatform.value === 'windows')
const isInputSimulationAvailable = computed(() => false)
const windowsOnlyDiagnosticsMessage = computed(() => {
  if (diagnosticPlatformReadFailed.value) {
    return t('diagnostics.platformHints.windowsReadFailed')
  }
  if (diagnosticPlatform.value === 'macos') {
    return t('diagnostics.platformHints.windowsOnMacos')
  }
  return t('diagnostics.platformHints.windowsUnknown')
})
const inputSimulationUnavailableMessage = computed(() => {
  if (diagnosticPlatform.value === 'macos') {
    return t('diagnostics.platformHints.inputMacos')
  }
  if (diagnosticPlatform.value === 'windows' && diagnosticRuntime.value === 'electron') {
    return t('diagnostics.platformHints.inputWindowsElectron')
  }
  return t('diagnostics.platformHints.inputUnavailable')
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
    if (typeof getInfo !== 'function') throw new Error(t('diagnostics.platformHints.sysInfoUnavailable'))
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
  log(t('diagnostics.platformHints.windowsOnlyNotExecuted', { name, reason: windowsOnlyDiagnosticsMessage.value }), 'warn')
  return false
}

// 一键体检只读取本机状态。写入性检查由使用临时数据目录的集成测试覆盖。
const hasText = value => typeof value === 'string' && value.trim().length > 0
const batchTestList = [
  {
    nameKey: 'diagnostics.batchTests.sysGetInfo',
    read: () => window.ztools.sys.getInfo(),
    valid: info => hasText(info?.platform)
  },
  {
    nameKey: 'diagnostics.batchTests.sysResource',
    read: () => Promise.all([window.ztools.sys.getCPUUsage(), window.ztools.sys.getMemoryUsage()]),
    valid: ([cpu, memory]) => cpu?.success === true && memory?.success === true &&
      Number.isFinite(cpu.data?.total) && Number.isFinite(memory.data?.total)
  },
  ...[
    ['desktop', 'diagnostics.batchTests.sysPathDesktop'],
    ['documents', 'diagnostics.batchTests.sysPathDocuments'],
    ['temp', 'diagnostics.batchTests.sysPathTemp']
  ].map(([pathName, nameKey]) => ({
    nameKey,
    read: () => window.ztools.sys.getPath(pathName),
    valid: hasText
  })),
  {
    nameKey: 'diagnostics.batchTests.fsCwd',
    read: () => window.ztools.fs.getCurrentDirectory(),
    valid: hasText
  },
  {
    nameKey: 'diagnostics.batchTests.winBounds',
    read: () => window.ztools.win.getBounds(),
    valid: bounds => Number.isFinite(bounds?.width) && bounds.width > 0 &&
      Number.isFinite(bounds.height) && bounds.height > 0
  },
  {
    nameKey: 'diagnostics.batchTests.screenDisplays',
    read: () => window.ztools.screen.getAllDisplays(),
    valid: Array.isArray
  },
  {
    nameKey: 'diagnostics.batchTests.screenCursor',
    read: () => window.ztools.screen.getCursorScreenPoint(),
    valid: point => Number.isFinite(point?.x) && Number.isFinite(point?.y)
  },
  {
    nameKey: 'diagnostics.batchTests.processList',
    read: () => window.ztools.process.list(),
    valid: Array.isArray
  },
  {
    nameKey: 'diagnostics.batchTests.pluginList',
    read: () => window.ztools.plugin.getList(),
    valid: response => response?.success === true && Array.isArray(response.data)
  },
  {
    nameKey: 'diagnostics.batchTests.dllList',
    platforms: ['windows'],
    read: () => window.ztools.dllplugin.list(),
    valid: Array.isArray
  },
  {
    nameKey: 'diagnostics.batchTests.protocolRead',
    read: () => readProtocolText('ztools://web/index.html'),
    valid: hasText
  }
]

const runBatchTest = async () => {
  if (isTesting.value) return
  if (!isNative) return log(t('diagnostics.batch.nonNativeError'), 'error')

  const generation = ++batchGeneration
  isTesting.value = true
  clearLog()
  log(t('diagnostics.batch.started'), 'info')

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
      throw new Error(t('diagnostics.platformHints.hostPlatformApiUnavailable'))
    }
    const info = await getInfo.call(sysApi)
    platform = info?.platform || ''
  } catch {
    platformReadFailed = true
  }
  if (generation !== batchGeneration) return

  const isKnownPlatform = platform === 'windows' || platform === 'macos'
  const platformLabel = platform || 'unknown'
  if (isKnownPlatform) {
    batchPlatformMeta.value = { kind: 'known', platform, runtime }
  } else if (platformReadFailed) {
    batchPlatformMeta.value = { kind: 'read-failed' }
  } else {
    batchPlatformMeta.value = { kind: 'unsupported', platformLabel }
  }

  if (!isKnownPlatform) {
    log(batchPlatformStatus.value, 'warn')
  } else if (platform === 'macos') {
    log(t('diagnostics.batch.macosSkipNotice'), 'warn')
  }

  const getSkipReason = (item) => {
    if (item.platforms && !item.platforms.includes(platform)) {
      return platformReadFailed
        ? t('diagnostics.batch.skipReasonPlatformReadFailed')
        : t('diagnostics.batch.skipReasonPlatformMismatch', { platform: platformLabel })
    }
    return ''
  }
  const applicableTests = batchTestList.filter((item) => !getSkipReason(item))
  totalCount.value = applicableTests.length

  for (let i = 0; i < batchTestList.length; i++) {
    const item = batchTestList[i]
    const itemName = t(item.nameKey)

    const skipReason = getSkipReason(item)
    if (skipReason) {
      skipCount.value++
      log(`[SKIP] ${itemName}: ${skipReason}`, 'warn')
      testProgress.value = Math.round(((i + 1) / batchTestList.length) * 100)
      continue
    }

    log(t('diagnostics.batch.testingItem', { name: itemName }), 'info')
    const start = Date.now()
    try {
      const result = await item.read()
      if (generation !== batchGeneration) return
      if (result?.success === false) {
        throw new Error(resolveErrorMessage(result, 'diagnostics.batch.invalidResponse'))
      }
      if (!item.valid(result)) throw new Error(t('diagnostics.batch.invalidResponse'))
      const elapsed = Date.now() - start
      log(`[PASS] ${itemName}`, 'success', elapsed)
      passCount.value++
    } catch (e) {
      if (generation !== batchGeneration) return
      const elapsed = Date.now() - start
      log(`[FAIL] ${itemName}: ${resolveErrorMessage(e, 'diagnostics.batch.invalidResponse')}`, 'error', elapsed)
      failCount.value++
    }
    testProgress.value = Math.round(((i + 1) / batchTestList.length) * 100)
  }

  const score =
    totalCount.value > 0
      ? Math.round((passCount.value / totalCount.value) * 100)
      : null
  const summary =
    score === null
      ? t('diagnostics.batch.summaryNoApplicable', { skipped: skipCount.value })
      : t('diagnostics.batch.summaryResult', {
          score,
          passed: passCount.value,
          failed: failCount.value,
          skipped: skipCount.value
        })
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
    log(t('diagnostics.system.getInfoSuccess'), 'success')
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
    log(t('diagnostics.system.getPathSuccess', { type: sysPathType.value, path: res }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const sendNotify = async () => {
  try {
    await sys.notify(t('diagnostics.system.testNotifyTitle'), t('diagnostics.system.testNotifyBody'))
    log(t('diagnostics.system.notifySent'), 'success')
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

    log(t('diagnostics.system.cpuMemLog', { cpu: cpuUsage, mem: memUsage }), 'success')
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
      title: t('diagnostics.power.dangerConfirmTitle'),
      content: t('diagnostics.power.dangerConfirmContent', { action }),
      okText: t('common.ok'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          if (action === 'hibernate') await window.ztools?.sys?.hibernate?.()
          if (action === 'logout') await window.ztools?.sys?.logout?.()
          if (action === 'restart') await window.ztools?.sys?.restart?.()
          if (action === 'shutdown') await window.ztools?.sys?.shutdown?.()
          log(t('diagnostics.power.commandSent', { action }), 'success')
        } catch (e) {
          log(e, 'error')
        }
      }
    })
  } else {
    try {
      if (action === 'lock') await sys.lock()
      if (action === 'sleep') await sys.sleep()
      log(t('diagnostics.power.commandSent', { action }), 'success')
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
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opRead'))) return
  try {
    const txt = await fs.readFile(fsPath.value)
    fsContent.value = txt
      ? txt.length > 500
        ? txt.slice(0, 500) + '...'
        : txt
      : t('diagnostics.fs.emptyContent')
    log(t('diagnostics.fs.readSuccess', { bytes: txt?.length ?? 0 }, txt?.length ?? 0), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsWrite = async () => {
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opWrite'))) return
  try {
    await fs.writeFile(fsPath.value, fsWriteContent.value)
    log(t('diagnostics.fs.writeSuccess', { path: fsPath.value }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsCheckExists = async () => {
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opCheckExists'))) return
  try {
    const exists = await fs.exists(fsPath.value)
    log(t('diagnostics.fs.existsResult', { exists }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsDeleteFile = async () => {
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opDelete'))) return
  confirmDialog({
    title: t('diagnostics.fs.deleteConfirmTitle'),
    content: t('diagnostics.fs.deleteConfirmContent', { path: fsPath.value }),
    okText: t('common.ok'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      try {
        await fs.deleteFile(fsPath.value)
        log(t('diagnostics.fs.deleteSuccess', { path: fsPath.value }), 'success')
      } catch (e) {
        log(e, 'error')
      }
    }
  })
}

const fsDirList = ref([])
const fsListDir = async () => {
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opListDir'))) return
  try {
    const dir = await fs.getCurrentDirectory()
    const list = await fs.getDirectoryContents(dir)
    fsDirList.value = list || []
    log(t('diagnostics.fs.listDirSuccess', { dir, count: list?.length || 0 }, list?.length || 0), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const fsMkDir = async () => {
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.fs.opMkDir'))) return
  try {
    await fs.createDirectory('test_diag_dir')
    log(t('diagnostics.fs.mkDirSuccess', { dir: 'test_diag_dir' }), 'success')
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
    log(t('diagnostics.db.opSuccess', { op }), 'success')
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
      log(t('diagnostics.win.boundsLog', { bounds: JSON.stringify(bounds) }), 'success')
      return
    }
    log(t('diagnostics.win.actionLog', { action }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const winOpenDialog = async (type) => {
  try {
    let res
    if (type === 'open') {
      res = await win.showOpenDialog({
        title: t('diagnostics.win.dialogOpenTitle'),
        filters: [{ name: t('diagnostics.win.dialogAllFiles'), extensions: ['*'] }]
      })
    }
    if (type === 'openMulti') {
      res = await win.showOpenDialog({
        title: t('diagnostics.win.dialogOpenMultiTitle'),
        multiSelections: true
      })
    }
    if (type === 'save') {
      res = await win.showSaveDialog({
        title: t('diagnostics.win.dialogSaveTitle'),
        defaultPath: 'test.txt'
      })
    }
    if (type === 'folder') {
      res = await win.showOpenDialog({
        title: t('diagnostics.win.dialogFolderTitle'),
        openDirectory: true
      })
    }
    log(t('diagnostics.win.dialogResultLog', { result: JSON.stringify(res) }), 'success')
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
    if (!clipboard) throw new Error(t('diagnostics.clipboard.apiUnavailable'))

    let res
    if (op === 'writeText') res = await clipboard.writeText(clipboardText.value)
    if (op === 'readText') {
      res = await clipboard.readText()
      log(t('diagnostics.clipboard.textLog', { text: res }), 'success')
      return
    }
    if (op === 'readImage') {
      res = await clipboard.readImage()
      log(
        t('diagnostics.clipboard.imageLog', {
          status: res ? t('diagnostics.clipboard.hasImage') : t('diagnostics.clipboard.noImage')
        }),
        'success'
      )
      return
    }
    if (op === 'readFiles') {
      res = await clipboard.readFiles()
      log(t('diagnostics.clipboard.filesLog', { files: JSON.stringify(res) }), 'success')
      return
    }
    if (op === 'clear') res = await clipboard.clear()
    log(t('diagnostics.clipboard.opSuccess', { op }), 'success')
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
      log(t('diagnostics.shell.externalOpened', { url: externalUrl.value }), 'success')
      return
    }
    if (!shell) throw new Error(t('diagnostics.shell.apiUnavailable'))
    if (op === 'beep') {
      await shell.beep()
      log('Beep!', 'success')
    }
    if (op === 'exec') {
      const res = await shell.exec(shellCmd.value)
      log(t('diagnostics.shell.execResult', { result: JSON.stringify(res) }), 'success')
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
    if (!events) throw new Error(t('diagnostics.events.apiUnavailable'))

    if (op === 'emit') {
      await events.emit(eventName.value, JSON.parse(eventData.value))
      log(t('diagnostics.events.emitted', { name: eventName.value }), 'success')
    }
    if (op === 'on') {
      eventListener = (data) => {
        log(t('diagnostics.events.received', { name: eventName.value, data: JSON.stringify(data) }), 'info')
      }
      await events.on(eventName.value, eventListener)
      log(t('diagnostics.events.listening', { name: eventName.value }), 'success')
    }
    if (op === 'off') {
      if (eventListener) {
        await events.off(eventName.value, eventListener)
        eventListener = null
      }
      log(t('diagnostics.events.stopped', { name: eventName.value }), 'success')
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
    if (!events) throw new Error(t('diagnostics.events.apiUnavailable'))

    fileDropListener = (files) => {
      log(t('diagnostics.events.fileDropped', { files: JSON.stringify(files) }), 'info')
    }
    events.on('plugin_files_dropped', fileDropListener)
    log(t('diagnostics.events.fileDropStarted'), 'success')

    setTimeout(() => {
      if (fileDropListener) {
        events.off('plugin_files_dropped', fileDropListener)
        fileDropListener = null
        log(t('diagnostics.events.fileDropClosed'), 'info')
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
        (item) =>
          item.pluginId === 'diagnostics' && item.config?.key === hotkeyConfig.value
      )

      if (existingTestTrigger) {
        log(
          t('diagnostics.trigger.alreadyRegistered', {
            hotkey: hotkeyConfig.value,
            id: existingTestTrigger.id
          }),
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
      log(t('diagnostics.trigger.registered', { result: JSON.stringify(res) }), 'success')
    }
    if (op === 'list') {
      const res = await trigger.list()
      const count = Array.isArray(res) ? res.length : 0
      log(t('diagnostics.trigger.listLog', { count, list: JSON.stringify(res) }), 'success')
    }
    if (op === 'clear') {
      const list = await trigger.list()
      const listArray = Array.isArray(list) ? list : []
      for (const item of listArray) {
        await trigger.unregister(item.id)
      }
      log(t('diagnostics.trigger.cleared'), 'success')
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
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.protocol.opName'))) return
  try {
    if (type === 'url') {
      const url = await protocol.getUrl(protoPath.value)
      log(t('diagnostics.protocol.urlLog', { url }), 'success')
    }
    if (type === 'readText') {
      const url = await protocol.getUrl(protoPath.value)
      const text = await protocol.readText(url)
      log(t('diagnostics.protocol.readTextLog', { preview: text.slice(0, 200) }), 'success')
    }
    if (type === 'readBlob') {
      const url = await protocol.getUrl(protoPath.value)
      const blob = await protocol.readBlob(url)
      log(t('diagnostics.protocol.readBlobLog', { size: blob.size, type: blob.type }, blob.size), 'success')
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
  if (!canRunWindowsOnlyDiagnostic(t('diagnostics.privileged.opName'))) return
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
        title: t('diagnostics.privileged.restartConfirmTitle'),
        content: t('diagnostics.privileged.restartConfirmContent'),
        okText: t('common.ok'),
        cancelText: t('common.cancel'),
        onOk: async () => {
          await privileged.restartExplorer()
          log(t('diagnostics.privileged.restartSent'), 'success')
        }
      })
      return
    }
    log(t('diagnostics.privileged.actionResult', { action, result: JSON.stringify(res) }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// Screen
const screenOps = async (op) => {
  try {
    if (op === 'capture') {
      const base64 = await screen.capture({})
      log(t('diagnostics.screen.captureLog', { length: base64?.length || 0 }), 'success')
    }
    if (op === 'displays') {
      const displays = await screen.getAllDisplays()
      log(t('diagnostics.screen.displaysLog', { displays: JSON.stringify(displays) }), 'success')
    }
    if (op === 'cursor') {
      const pos = await screen.getCursorPos()
      log(t('diagnostics.screen.cursorLog', { pos: JSON.stringify(pos) }), 'success')
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
    log(t('diagnostics.screen.simulateKeyLog', { key: simKey.value }), 'success')
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
    log(t('diagnostics.network.httpSuccess', { status: res.status }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const procList = ref([])
const getProcesses = async () => {
  try {
    const list = await process.getList()
    procList.value = list?.slice(0, 10) || []
    log(t('diagnostics.network.processListLog', { count: list?.length || 0 }), 'success')
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
    log(t('diagnostics.dll.callSuccess'), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

const getDllList = async () => {
  try {
    const list = await getDllPluginList()
    log(t('diagnostics.dll.listLog', { list: JSON.stringify(list) }), 'success')
  } catch (e) {
    log(e, 'error')
  }
}

// 初始化
const activeTab = ref('1')
// 左侧诊断分类（值沿用原标签页的 key，测试按 key 切换）
const tabOptions = computed(() => [
  { label: t('diagnostics.tabs.system'), value: '1' },
  { label: t('diagnostics.tabs.power'), value: '2' },
  { label: t('diagnostics.tabs.filesystem'), value: '3' },
  { label: t('diagnostics.tabs.database'), value: '4' },
  { label: t('diagnostics.tabs.window'), value: '5' },
  { label: t('diagnostics.tabs.clipboardShell'), value: '6' },
  { label: t('diagnostics.tabs.eventsTrigger'), value: '7' },
  { label: t('diagnostics.tabs.advanced'), value: '8' }
])
const sysPathOptions = ['desktop', 'documents', 'downloads', 'temp', 'appData'].map((value) => ({
  label: value,
  value
}))

let globalHotkeyListener = null

onMounted(() => {
  void loadDiagnosticHost()
  log(t('diagnostics.logs.ready'))
  if (!isNative) log(t('diagnostics.logs.nonNativeWarn'), 'warn')

  // 监听全局热键触发事件
  const events = window.ztools?.events
  if (events) {
    globalHotkeyListener = (envelope) => {
      const payload = envelope.payload || envelope
      log(
        t('diagnostics.logs.globalHotkeyTriggered', {
          id: payload.id,
          keys: payload.keys || ''
        }),
        'success'
      )
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

function cancelBatch() {
  batchGeneration++
  isTesting.value = false
}

onDeactivated(cancelBatch)
onBeforeUnmount(() => {
  cancelBatch()
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
        <h1 class="page-title">{{ t('diagnostics.title') }}</h1>
        <p class="page-subtitle">{{ t('diagnostics.subtitle') }}</p>
      </div>
      <span class="diag-mode" :class="{ 'is-native': isNative }">
        <span class="diag-mode-dot" aria-hidden="true"></span>
        {{ isNative ? t('diagnostics.modeNative') : t('diagnostics.modeBrowser') }}
      </span>
    </header>

    <!-- 主体内容区 (双栏布局) -->
    <div class="diag-body">
      <!-- 左侧：分类切换 + 功能测试 -->
      <section class="diag-main">
        <RcSegmented
          v-model="activeTab"
          :options="tabOptions"
          :aria-label="t('diagnostics.tabs.ariaLabel')"
          class="diag-tabs"
        />

        <div class="diag-pane">
          <!-- 分类 1: 系统与基础 -->
          <div v-if="activeTab === '1'" class="diag-stack">
            <RcCard :title="t('diagnostics.system.infoCardTitle')">
              <div class="diag-actions">
                <RcButton variant="secondary" @click="getSysInfo">{{ t('diagnostics.system.getInfoBtn') }}</RcButton>
                <RcButton variant="secondary" @click="sendNotify">{{ t('diagnostics.system.sendNotifyBtn') }}</RcButton>
                <RcButton variant="secondary" @click="getCpuMem">{{ t('diagnostics.system.cpuMemBtn') }}</RcButton>
              </div>
              <pre class="diag-output">{{ sysInfoResult }}</pre>
            </RcCard>

            <RcCard :title="t('diagnostics.system.pathCardTitle')">
              <div class="diag-actions items-center">
                <RcSelect
                  v-model:value="sysPathType"
                  :options="sysPathOptions"
                  class="w-36"
                />
                <RcButton variant="secondary" @click="getSysPath">{{ t('diagnostics.system.getPathBtn') }}</RcButton>
              </div>
              <div class="diag-output">{{ sysPathResult }}</div>
            </RcCard>
          </div>

          <!-- 分类 2: 电源管理 -->
          <div v-else-if="activeTab === '2'" class="diag-stack">
            <RcAlert
              :message="t('diagnostics.power.warningAlert')"
              type="warning"
              show-icon
            />

            <RcCard :title="t('diagnostics.power.safeCardTitle')">
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="powerAction('lock')">{{ t('diagnostics.power.lockBtn') }}</RcButton>
                <RcButton variant="secondary" @click="powerAction('sleep')">{{ t('diagnostics.power.sleepBtn') }}</RcButton>
              </div>
            </RcCard>

            <RcCard :title="t('diagnostics.power.dangerCardTitle')">
              <div class="diag-actions mb-0">
                <RcButton variant="danger" @click="powerAction('hibernate')">{{ t('diagnostics.power.hibernateBtn') }}</RcButton>
                <RcButton variant="danger" @click="powerAction('logout')">{{ t('diagnostics.power.logoutBtn') }}</RcButton>
                <RcButton variant="danger" @click="powerAction('restart')">{{ t('diagnostics.power.restartBtn') }}</RcButton>
                <RcButton variant="danger" @click="powerAction('shutdown')">{{ t('diagnostics.power.shutdownBtn') }}</RcButton>
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
              <RcCard :title="t('diagnostics.fs.cardTitle')">
                <a-input v-model:value="fsPath" :addon-before="t('diagnostics.fs.pathAddon')" class="mb-3" />
                <div class="diag-actions">
                  <RcButton variant="secondary" @click="fsRead">{{ t('diagnostics.fs.readBtn') }}</RcButton>
                  <RcButton variant="secondary" @click="fsCheckExists">{{ t('diagnostics.fs.checkExistsBtn') }}</RcButton>
                  <RcButton variant="danger" @click="fsDeleteFile">{{ t('diagnostics.fs.deleteBtn') }}</RcButton>
                </div>
                <div class="diag-output">{{ fsContent }}</div>
              </RcCard>

              <RcCard :title="t('diagnostics.fs.writeCardTitle')">
                <a-textarea v-model:value="fsWriteContent" :rows="2" class="mb-3" />
                <RcButton variant="secondary" @click="fsWrite">{{ t('diagnostics.fs.writeBtn') }}</RcButton>
              </RcCard>

              <RcCard :title="t('diagnostics.fs.dirCardTitle')">
                <div class="diag-actions">
                  <RcButton variant="secondary" @click="fsListDir">{{ t('diagnostics.fs.listDirBtn') }}</RcButton>
                  <RcButton variant="secondary" @click="fsMkDir">{{ t('diagnostics.fs.mkDirBtn') }}</RcButton>
                </div>
                <ul class="diag-list max-h-32">
                  <li v-for="(item, idx) in fsDirList" :key="idx">{{ item }}</li>
                </ul>
              </RcCard>
            </div>
          </div>

          <!-- 分类 4: 数据库 -->
          <div v-else-if="activeTab === '4'" class="diag-stack">
            <RcCard :title="t('diagnostics.db.cardTitle')">
              <div class="grid grid-cols-2 gap-2 mb-3">
                <a-input v-model:value="dbKey" :addon-before="t('diagnostics.db.keyAddon')" />
                <a-input v-model:value="dbVal" :addon-before="t('diagnostics.db.valueAddon')" />
              </div>
              <div class="diag-actions">
                <RcButton variant="secondary" @click="dbOps('set')">{{ t('diagnostics.db.setBtn') }}</RcButton>
                <RcButton variant="secondary" @click="dbOps('get')">{{ t('diagnostics.db.getBtn') }}</RcButton>
                <RcButton variant="secondary" @click="dbOps('delete')">{{ t('diagnostics.db.deleteBtn') }}</RcButton>
                <RcButton variant="secondary" @click="dbOps('all')">{{ t('diagnostics.db.allBtn') }}</RcButton>
                <RcButton variant="secondary" @click="dbOps('secure_set')">{{ t('diagnostics.db.secureSetBtn') }}</RcButton>
                <RcButton variant="secondary" @click="dbOps('secure_get')">{{ t('diagnostics.db.secureGetBtn') }}</RcButton>
              </div>
              <pre class="diag-output">{{ dbResult }}</pre>
            </RcCard>
          </div>

          <!-- 分类 5: 窗口控制 -->
          <div v-else-if="activeTab === '5'" class="diag-stack">
            <RcCard :title="t('diagnostics.win.cardTitle')">
              <div class="diag-actions mb-4">
                <RcButton variant="secondary" @click="winTest('min')">{{ t('diagnostics.win.minBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('max')">{{ t('diagnostics.win.maxBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('restore')">{{ t('diagnostics.win.restoreBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('top')">{{ t('diagnostics.win.topBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('untop')">{{ t('diagnostics.win.untopBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('devtools')">{{ t('diagnostics.win.devtoolsBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winTest('getBounds')">{{ t('diagnostics.win.getBoundsBtn') }}</RcButton>
              </div>

              <div class="grid grid-cols-3 gap-2 mb-3 items-center">
                <a-input-number v-model:value="winWidth" :addon-before="t('diagnostics.win.widthAddon')" class="w-full">
                  <template #upIcon><ChevronUpIcon aria-hidden="true" /></template>
                  <template #downIcon><ChevronDownIcon aria-hidden="true" /></template>
                </a-input-number>
                <a-input-number v-model:value="winHeight" :addon-before="t('diagnostics.win.heightAddon')" class="w-full">
                  <template #upIcon><ChevronUpIcon aria-hidden="true" /></template>
                  <template #downIcon><ChevronDownIcon aria-hidden="true" /></template>
                </a-input-number>
                <RcButton variant="secondary" @click="winTest('setSize')">{{ t('diagnostics.win.setSizeBtn') }}</RcButton>
              </div>

              <div class="flex gap-3 items-center">
                <span class="diag-label">{{ t('diagnostics.win.opacityLabel') }}</span>
                <a-slider
                  v-model:value="winOpacity"
                  :min="0"
                  :max="1"
                  :step="0.1"
                  class="flex-1"
                />
                <RcButton variant="secondary" size="xs" @click="winTest('setOpacity')">{{ t('diagnostics.win.applyBtn') }}</RcButton>
              </div>
            </RcCard>

            <RcCard :title="t('diagnostics.win.dialogCardTitle')">
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="winOpenDialog('open')">{{ t('diagnostics.win.openFileBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('openMulti')">{{ t('diagnostics.win.openMultiBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('save')">{{ t('diagnostics.win.saveFileBtn') }}</RcButton>
                <RcButton variant="secondary" @click="winOpenDialog('folder')">{{ t('diagnostics.win.selectFolderBtn') }}</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 6: 剪贴板与 Shell -->
          <div v-else-if="activeTab === '6'" class="diag-stack">
            <RcCard :title="t('diagnostics.clipboard.cardTitle')">
              <a-textarea
                v-model:value="clipboardText"
                :rows="2"
                class="mb-3"
                :placeholder="t('diagnostics.clipboard.placeholder')"
              />
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="clipboardOps('writeText')">{{ t('diagnostics.clipboard.writeTextBtn') }}</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readText')">{{ t('diagnostics.clipboard.readTextBtn') }}</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readImage')">{{ t('diagnostics.clipboard.readImageBtn') }}</RcButton>
                <RcButton variant="secondary" @click="clipboardOps('readFiles')">{{ t('diagnostics.clipboard.readFilesBtn') }}</RcButton>
                <RcButton variant="danger" @click="clipboardOps('clear')">{{ t('diagnostics.clipboard.clearBtn') }}</RcButton>
              </div>
            </RcCard>

            <RcCard :title="t('diagnostics.shell.cardTitle')">
              <a-input v-model:value="externalUrl" :addon-before="t('diagnostics.shell.urlAddon')" class="mb-2" />
              <RcButton variant="secondary" class="mb-4" @click="shellOps('openExternal')">{{ t('diagnostics.shell.openExternalBtn') }}</RcButton>

              <a-input v-model:value="shellCmd" :addon-before="t('diagnostics.shell.cmdAddon')" class="mb-2" />
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="shellOps('exec')">{{ t('diagnostics.shell.execBtn') }}</RcButton>
                <RcButton variant="secondary" @click="shellOps('beep')">{{ t('diagnostics.shell.beepBtn') }}</RcButton>
              </div>
            </RcCard>
          </div>

          <!-- 分类 7: 事件与触发器 -->
          <div v-else-if="activeTab === '7'" class="diag-stack">
            <RcCard :title="t('diagnostics.events.cardTitle')">
              <a-input v-model:value="eventName" :addon-before="t('diagnostics.events.nameAddon')" class="mb-2" />
              <a-textarea
                v-model:value="eventData"
                :rows="2"
                class="mb-3"
                :placeholder="t('diagnostics.events.dataPlaceholder')"
              />
              <div class="diag-actions">
                <RcButton variant="secondary" @click="eventsOps('emit')">{{ t('diagnostics.events.emitBtn') }}</RcButton>
                <RcButton variant="secondary" @click="eventsOps('on')">{{ t('diagnostics.events.onBtn') }}</RcButton>
                <RcButton variant="secondary" @click="eventsOps('off')">{{ t('diagnostics.events.offBtn') }}</RcButton>
              </div>
              <RcButton variant="secondary" @click="startFileDrop">{{ t('diagnostics.events.fileDropBtn') }}</RcButton>
            </RcCard>

            <RcCard :title="t('diagnostics.trigger.cardTitle')">
              <a-input
                v-model:value="hotkeyConfig"
                :addon-before="t('diagnostics.trigger.hotkeyAddon')"
                class="mb-3"
                :placeholder="t('diagnostics.trigger.hotkeyPlaceholder')"
              />
              <div class="diag-actions mb-0">
                <RcButton variant="secondary" @click="triggerOps('register')">{{ t('diagnostics.trigger.registerBtn') }}</RcButton>
                <RcButton variant="secondary" @click="triggerOps('list')">{{ t('diagnostics.trigger.listBtn') }}</RcButton>
                <RcButton variant="danger" @click="triggerOps('clear')">{{ t('diagnostics.trigger.clearBtn') }}</RcButton>
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
              <RcCard :title="t('diagnostics.protocol.cardTitle')">
                <a-input v-model:value="protoPath" :addon-before="t('diagnostics.protocol.pathAddon')" class="mb-3" />
                <div class="diag-actions mb-0">
                  <RcButton variant="secondary" @click="testProtocol('url')">{{ t('diagnostics.protocol.urlBtn') }}</RcButton>
                  <RcButton variant="secondary" @click="testProtocol('readText')">{{ t('diagnostics.protocol.readTextBtn') }}</RcButton>
                  <RcButton variant="secondary" @click="testProtocol('readBlob')">{{ t('diagnostics.protocol.readBlobBtn') }}</RcButton>
                </div>
              </RcCard>

              <RcCard :title="t('diagnostics.privileged.cardTitle')">
                <RcAlert
                  :message="t('diagnostics.privileged.systemAlert')"
                  type="info"
                  show-icon
                  class="mb-3"
                />
                <div class="space-y-2">
                  <a-input v-model:value="privRegPath" :addon-before="t('diagnostics.privileged.regPathAddon')" />
                  <div class="grid grid-cols-2 gap-2">
                    <a-input v-model:value="privRegName" :addon-before="t('diagnostics.privileged.regNameAddon')" />
                    <a-input v-model:value="privRegVal" :addon-before="t('diagnostics.privileged.regValAddon')" />
                  </div>
                  <div class="diag-actions">
                    <RcButton variant="secondary" @click="testPrivileged('regWrite64')">{{ t('diagnostics.privileged.regWrite64Btn') }}</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regWrite32')">{{ t('diagnostics.privileged.regWrite32Btn') }}</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regDelete64')">{{ t('diagnostics.privileged.regDelete64Btn') }}</RcButton>
                    <RcButton variant="secondary" @click="testPrivileged('regDelete32')">{{ t('diagnostics.privileged.regDelete32Btn') }}</RcButton>
                  </div>
                  <a-input v-model:value="privFileTarget" :addon-before="t('diagnostics.privileged.fileAddon')" />
                  <div class="diag-actions mb-0">
                    <RcButton variant="secondary" @click="testPrivileged('fileWrite')">{{ t('diagnostics.privileged.fileWriteBtn') }}</RcButton>
                    <RcButton variant="danger" @click="testPrivileged('restartExplorer')">{{ t('diagnostics.privileged.restartExplorerBtn') }}</RcButton>
                  </div>
                </div>
              </RcCard>
            </div>

            <RcCard :title="t('diagnostics.screen.cardTitle')">
              <div class="diag-actions">
                <RcButton variant="secondary" @click="screenOps('capture')">{{ t('diagnostics.screen.captureBtn') }}</RcButton>
                <RcButton variant="secondary" @click="screenOps('displays')">{{ t('diagnostics.screen.displaysBtn') }}</RcButton>
                <RcButton variant="secondary" @click="screenOps('cursor')">{{ t('diagnostics.screen.cursorBtn') }}</RcButton>
              </div>
              <div v-if="isInputSimulationAvailable" class="flex gap-2 items-center">
                <a-input v-model:value="simKey" class="w-20" :placeholder="t('diagnostics.screen.keyPlaceholder')" />
                <RcButton variant="secondary" @click="simulateKey">{{ t('diagnostics.screen.simulateKeyBtn') }}</RcButton>
              </div>
              <RcAlert
                v-else
                data-test="input-simulation-disabled"
                :message="inputSimulationUnavailableMessage"
                type="warning"
                show-icon
              />
            </RcCard>

            <RcCard :title="t('diagnostics.network.cardTitle')">
              <a-input v-model:value="httpUrl" :addon-before="t('diagnostics.network.urlAddon')" class="mb-2" />
              <RcButton variant="secondary" class="mb-2" @click="sendHttp">{{ t('diagnostics.network.sendHttpBtn') }}</RcButton>
              <div class="diag-output mb-3">{{ httpResult }}</div>

              <RcButton variant="secondary" @click="getProcesses">{{ t('diagnostics.network.getProcessesBtn') }}</RcButton>
              <ul class="diag-list max-h-24 mt-2">
                <li v-for="(p, i) in procList" :key="i">{{ p.name || p }}</li>
              </ul>
            </RcCard>

            <RcCard :title="t('diagnostics.dll.cardTitle')">
              <div class="grid grid-cols-2 gap-2 mb-2">
                <a-input v-model:value="dllPluginName" :addon-before="t('diagnostics.dll.pluginAddon')" />
                <a-input v-model:value="dllFuncName" :addon-before="t('diagnostics.dll.funcAddon')" />
              </div>
              <a-textarea
                v-model:value="dllParams"
                :rows="2"
                class="mb-3"
                :placeholder="t('diagnostics.dll.paramsPlaceholder')"
              />
              <div class="diag-actions">
                <RcButton variant="secondary" @click="testDllPlugin">{{ t('diagnostics.dll.callBtn') }}</RcButton>
                <RcButton variant="secondary" @click="getDllList">{{ t('diagnostics.dll.listBtn') }}</RcButton>
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
          <h2 class="diag-section-title">{{ t('diagnostics.batch.title') }}</h2>
          <RcButton
            variant="primary"
            size="md"
            class="w-full mb-3"
            :loading="isTesting"
            @click="runBatchTest"
          >
            {{ isTesting ? t('diagnostics.batch.running') : t('diagnostics.batch.start') }}
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
              <span>{{ t('diagnostics.batch.progress') }}</span>
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
              <span data-test="batch-pass-count" class="is-success">{{ t('diagnostics.batch.passCount', { count: passCount }) }}</span>
              <span data-test="batch-fail-count" class="is-error">{{ t('diagnostics.batch.failCount', { count: failCount }) }}</span>
            </div>
            <div class="diag-stat-row">
              <span>{{ t('diagnostics.batch.applicableCount', { count: totalCount }) }}</span>
              <span data-test="batch-skip-count" class="is-warn">{{ t('diagnostics.batch.skipCount', { count: skipCount }) }}</span>
            </div>
          </div>
        </div>

        <!-- 日志列表 -->
        <div class="diag-log-header">
          <span class="diag-section-title">{{ t('diagnostics.logs.title') }}</span>
          <RcButton variant="ghost" size="xs" @click="clearLog">{{ t('diagnostics.logs.clear') }}</RcButton>
        </div>

        <div ref="logRef" class="diag-log">
          <div v-if="logs.length === 0" class="diag-log-empty">{{ t('diagnostics.logs.empty') }}</div>
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
  /* 环境胶囊与标题同一中线，不悬在标题和副标题之间 */
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 0;
  /* 与 .rc-page 共用页边距变量，使标题左边缘、上边距与其它页一致 */
  padding: var(--rc-page-pad-top) var(--rc-page-pad-x) 16px;
  flex-shrink: 0;
}

/* 运行环境标识：中性灰阶胶囊，宿主环境时圆点为成功色 */
.diag-mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  /* 标题行高约 28px，下移 2px 与标题文字同中线 */
  margin-top: 2px;
  padding: 0 10px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-full);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font-size: var(--rc-fs-small);
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
  padding: 12px var(--rc-page-pad-x) 0;
  flex-shrink: 0;
}

.diag-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px var(--rc-page-pad-x) 24px;
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
  font-size: var(--rc-fs-small);
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
  font-size: var(--rc-fs-small);
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
  font-size: var(--rc-fs-small);
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
  font-size: var(--rc-fs-body);
  font-weight: 600;
  color: var(--rc-text-primary);
}

.diag-batch-status {
  margin: 0 0 8px;
  font-size: var(--rc-fs-small);
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
  font-size: var(--rc-fs-small);
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
  border-radius: var(--rc-radius-full);
  background: var(--rc-surface-active);
  overflow: hidden;
}

.diag-progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--rc-accent);
  transition: width var(--rc-dur-slow) ease;
}

.diag-log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 8px 16px;
  border-bottom: 1px solid var(--rc-border);
}

/* 标题自带的下边距会把它顶离按钮的中线；标题行内清零，让「实时日志」与「清空」垂直居中 */
.diag-log-header .diag-section-title {
  margin: 0;
  line-height: 28px;
}

.diag-log {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  background: var(--rc-surface-subtle);
  font-family: var(--rc-font-mono);
  font-size: var(--rc-fs-small);
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
  border-radius: var(--rc-radius-sm);
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
  border-radius: var(--rc-radius-full);
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
  animation: fadeIn var(--rc-dur-slow) var(--rc-ease-out) forwards;
}
</style>
