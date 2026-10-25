import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BuiltinPluginHostService
} from '../electron-client/out/main/services/builtin-plugin-host-service.js'

import {
  MonitorControlCommand,
  clampBrightnessValue,
  filterMonitorDisplays,
  listMonitorDisplays,
  setMonitorBrightness,
  syncAllMonitorsBrightness,
  triggerSleepAllMonitors
} from '../packages/declarative-ui/dist/examples/monitor-control/index.js'

import {
  CaffeineCommand,
  formatRemainingDuration,
  getCaffeineStatus,
  startCaffeineSession,
  stopCaffeineSession,
  toggleCaffeineSession
} from '../packages/declarative-ui/dist/examples/caffeine/index.js'

import {
  AudioDeviceCommand,
  AudioDeviceManager,
  clampVolume
} from '../packages/declarative-ui/dist/examples/audio-device/index.js'

import {
  WifiPasswordRevealCommand,
  escapeWifiQrField,
  fetchSavedWifiProfiles,
  filterAndSortWifiProfiles,
  generateWifiQrString,
  generateWifiQrSvgDataUrl,
  parseNetshWlanProfiles,
  parseWindowsWlanProfileDetail,
  revealWifiPasswordFromHost
} from '../packages/declarative-ui/dist/examples/wifi-password-reveal/index.js'

import {
  CleanKeyboardCommand,
  KeyboardLockManager,
  formatCleanDuration
} from '../packages/declarative-ui/dist/examples/clean-keyboard/index.js'

function createHostBridge(hostService, extraByFunc = {}) {
  return {
    async dllplugin_call({ plugin, func, params }) {
      const merged = { ...(params || {}), ...(extraByFunc[func] || {}) }
      const data = await hostService.handlePluginCall(plugin, func, merged)
      return { success: true, data }
    }
  }
}

test('04-monitor-control: 多显示器枚举、筛选、亮度步进与多屏同步集成测试', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService, {
    listDisplays: {
      mockDisplays: [
        {
          id: 'disp-internal-1',
          name: '内置 Retina 显示屏',
          isPrimary: true,
          protocol: 'wmi',
          brightness: 70,
          contrast: null,
          resolution: '2560x1600'
        },
        {
          id: 'disp-dell-4k',
          name: 'Dell U2723QE (DP)',
          isPrimary: false,
          protocol: 'ddcci',
          brightness: 60,
          contrast: 75,
          resolution: '3840x2160'
        },
        {
          id: 'disp-legacy-hdmi',
          name: 'Legacy Projector (HDMI)',
          isPrimary: false,
          protocol: 'unsupported',
          brightness: null,
          contrast: null,
          resolution: '1920x1080'
        }
      ]
    },
    setBrightness: { dryRun: true },
    sleepMonitors: { dryRun: true }
  })

  const scanRes = await listMonitorDisplays(bridge)
  assert.equal(scanRes.ok, true)
  assert.equal(scanRes.displays.length, 3)

  const ddcciOnly = filterMonitorDisplays(scanRes.displays, 'ddcci', '')
  assert.equal(ddcciOnly.length, 1)
  assert.equal(ddcciOnly[0].id, 'disp-dell-4k')

  const internalOnly = filterMonitorDisplays(scanRes.displays, 'internal', '')
  assert.equal(internalOnly.length, 1)
  assert.equal(internalOnly[0].id, 'disp-internal-1')

  // 调节 Dell 显示器亮度 +15% -> 75%
  const stepRes = await setMonitorBrightness(
    scanRes.displays[1],
    75,
    scanRes.displays,
    bridge
  )
  assert.equal(stepRes.ok, true)
  assert.equal(stepRes.brightness, 75)
  assert.equal(
    stepRes.updatedDisplays?.find((d) => d.id === 'disp-dell-4k')?.brightness,
    75
  )

  // 多屏同步设为 50%
  const syncRes = await syncAllMonitorsBrightness(50, stepRes.updatedDisplays, bridge)
  assert.equal(syncRes.ok, true)
  assert.equal(syncRes.brightness, 50)
  assert.equal(
    syncRes.updatedDisplays?.find((d) => d.id === 'disp-internal-1')?.brightness,
    50
  )
  assert.equal(
    syncRes.updatedDisplays?.find((d) => d.id === 'disp-dell-4k')?.brightness,
    50
  )
  // 不支持 DDC/CI 的投影仪保持 null
  assert.equal(
    syncRes.updatedDisplays?.find((d) => d.id === 'disp-legacy-hdmi')?.brightness,
    null
  )

  // 一键熄屏
  const sleepRes = await triggerSleepAllMonitors(bridge, true)
  assert.equal(sleepRes.ok, true)
})

test('04-monitor-control: 异常测试 — 不支持 DDC/CI、越界值钳制、NaN 与非法 ID 注入拦截', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService, {
    setBrightness: { dryRun: true }
  })

  const unsupportedDisplay = {
    id: 'disp-unsupported',
    name: 'Old VGA Monitor',
    isPrimary: false,
    protocol: 'unsupported',
    protocolLabel: '不支持 DDC/CI',
    brightness: null,
    contrast: null,
    resolution: '1920x1080',
    scaleFactor: 1,
    supportsBrightness: false
  }

  const unsupRes = await setMonitorBrightness(unsupportedDisplay, 80, [unsupportedDisplay], bridge)
  assert.equal(unsupRes.ok, false)
  assert.equal(unsupRes.errorCode, 'DDC_UNSUPPORTED')

  // 越界值 >100 钳制为 100，<0 钳制为 0
  assert.equal(clampBrightnessValue(150).clamped, 100)
  assert.equal(clampBrightnessValue(-30).clamped, 0)

  // NaN 拒绝
  const nanCheck = clampBrightnessValue(Number.NaN)
  assert.equal(nanCheck.valid, false)
  assert.equal(nanCheck.errorCode, 'INVALID_BRIGHTNESS')

  // 宿主侧非法 ID 注入拦截
  const injectRes = await hostService.handlePluginCall('monitor-control', 'setBrightness', {
    id: 'disp-1; rm -rf /',
    brightness: 50
  })
  assert.equal(injectRes.ok, false)
  assert.equal(injectRes.errorCode, 'INVALID_DISPLAY_ID')
})

test('05-caffeine: 定时防休眠生命周期、重复开启单例收敛与到期自动释放测试', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService, {
    start: { dryRun: true },
    stop: { dryRun: true },
    toggle: { dryRun: true }
  })

  try {
    // 1. 初始状态未激活
    const initRes = await getCaffeineStatus(bridge)
    assert.equal(initRes.ok, true)
    assert.equal(initRes.status?.active, false)

    // 2. 开启 15 分钟常亮
    const start15 = await startCaffeineSession(15, 'display', bridge, { dryRun: true })
    assert.equal(start15.ok, true)
    assert.equal(start15.status?.active, true)
    assert.equal(start15.status?.durationMinutes, 15)
    const firstSessionId = start15.status?.sessionId

    // 3. 未手动停止直接再次开启 60 分钟（验证单例替换）
    const start60 = await startCaffeineSession(60, 'system', bridge, { dryRun: true })
    assert.equal(start60.ok, true)
    assert.equal(start60.status?.active, true)
    assert.equal(start60.status?.durationMinutes, 60)
    assert.equal(start60.status?.mode, 'system')
    assert.equal(start60.status?.sessionId, firstSessionId + 1)

    // 4. 短定时 60ms 到期自动关闭验证
    const shortStart = await startCaffeineSession(1, 'display', bridge, {
      dryRun: true,
      durationMs: 60
    })
    assert.equal(shortStart.ok, true)
    assert.equal(shortStart.status?.active, true)
    await new Promise((r) => setTimeout(r, 90))
    const afterExpire = await getCaffeineStatus(bridge)
    assert.equal(afterExpire.status?.active, false)

    // 5. toggle 切换验证
    const toggledOn = await toggleCaffeineSession('display', bridge, { dryRun: true })
    assert.equal(toggledOn.status?.active, true)
    const toggledOff = await toggleCaffeineSession('display', bridge, { dryRun: true })
    assert.equal(toggledOff.status?.active, false)
  } finally {
    await stopCaffeineSession(bridge, { dryRun: true })
    await hostService.stop()
  }
})

test('05-caffeine: 异常测试 — 负数/NaN 时长、非法模式与底层进程启动失败回滚', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

  const negRes = await startCaffeineSession(-10, 'display', bridge)
  assert.equal(negRes.ok, false)
  assert.equal(negRes.errorCode, 'INVALID_DURATION')

  const nanRes = await startCaffeineSession(Number.NaN, 'display', bridge)
  assert.equal(nanRes.ok, false)
  assert.equal(nanRes.errorCode, 'INVALID_DURATION')

  const badModeRes = await hostService.handlePluginCall('caffeine', 'start', {
    durationMinutes: 15,
    mode: 'invalid-mode'
  })
  assert.equal(badModeRes.ok, false)
  assert.equal(badModeRes.errorCode, 'INVALID_MODE')

  const failStart = await startCaffeineSession(30, 'display', bridge, {
    simulateFailure: true
  })
  assert.equal(failStart.ok, false)
  assert.equal(failStart.errorCode, 'EXECUTION_STATE_FAILED')

  const statusAfterFail = await getCaffeineStatus(bridge)
  assert.equal(statusAfterFail.status?.active, false)
})

test('06-audio-device: 声卡枚举、主输出切换、音量调节与异常设备拔出回滚测试', async () => {
  const hostService = new BuiltinPluginHostService()
  const mockDevices = [
    {
      id: 'out-speakers',
      uid: 'uid-speakers',
      name: 'Realtek HD Audio Speakers',
      type: 'output',
      isDefault: true,
      volume: 70,
      isMuted: false,
      transportType: 'BuiltIn'
    },
    {
      id: 'out-airpods',
      uid: 'uid-airpods',
      name: 'AirPods Pro Stereo',
      type: 'output',
      isDefault: false,
      volume: 55,
      isMuted: true,
      transportType: 'Bluetooth'
    },
    {
      id: 'in-shure',
      uid: 'uid-shure',
      name: 'Shure MV7 USB Mic',
      type: 'input',
      isDefault: true,
      volume: 85,
      isMuted: false,
      transportType: 'USB'
    }
  ]
  const bridge = createHostBridge(hostService, {
    listDevices: { mockDevices }
  })

  const mgr = new AudioDeviceManager([])
  const synced = await mgr.syncDevicesFromHost(bridge)
  assert.equal(synced.length, 3)
  assert.equal(mgr.getDefaultOutputDevice()?.id, 'out-speakers')

  // 切换默认输出至 AirPods Pro
  const swRes = await mgr.setDefaultDevice('out-airpods', bridge)
  assert.equal(swRes.success, true)
  assert.equal(mgr.getDefaultOutputDevice()?.id, 'out-airpods')

  // 调节音量至 80% 并自动解除静音
  const volRes = await mgr.setDeviceVolume('out-airpods', 80, bridge)
  assert.equal(volRes.success, true)
  assert.equal(volRes.device?.volume, 80)
  assert.equal(volRes.device?.isMuted, false)

  // 异常 1：切换不存在的设备 ID
  const notFound = await mgr.setDefaultDevice('non-existent-id', bridge)
  assert.equal(notFound.success, false)
  assert.equal(notFound.errorCode, 'DEVICE_NOT_FOUND')

  // 异常 2：模拟蓝牙设备中途断开，验证默认状态回滚到 out-airpods
  const disconnectBridge = createHostBridge(hostService, {
    setDefault: { simulateDisconnected: true }
  })
  const discRes = await mgr.setDefaultDevice('out-speakers', disconnectBridge)
  assert.equal(discRes.success, false)
  assert.equal(discRes.errorCode, 'DEVICE_DISCONNECTED')
  assert.equal(mgr.getDefaultOutputDevice()?.id, 'out-airpods')

  // 异常 3：非法音量 NaN
  const nanVol = await mgr.setDeviceVolume('out-airpods', Number.NaN, bridge)
  assert.equal(nanVol.success, false)
  assert.equal(nanVol.errorCode, 'INVALID_VOLUME')
  assert.throws(() => clampVolume(Number.NaN))
})

test('07-wifi-password-reveal: 中英文 netsh 解析、QR 协议特殊字符转义与企业网/无权限异常测试', async () => {
  const cnProfilesOut = `
接口 WLAN 上的配置文件:
组策略配置文件(只读)
    <无>
用户配置文件
    所有用户配置文件 : ZTools-Office-5G
    所有用户配置文件 : Special;WiFi:Name"Test
    所有用户配置文件 : Corp-8021X
  `
  const ssids = parseNetshWlanProfiles(cnProfilesOut)
  assert.deepEqual(ssids, ['ZTools-Office-5G', 'Special;WiFi:Name"Test', 'Corp-8021X'])

  const detailNormal = parseWindowsWlanProfileDetail(
    'ZTools-Office-5G',
    `
    SSID 名称              : "ZTools-Office-5G"
    身份验证               : WPA3-个人
    加密                   : GCMP
    安全密钥               : 存在
    关键内容               : Pass;word:123"\\!
    `
  )
  assert.equal(detailNormal.password, 'Pass;word:123"\\!')
  assert.equal(detailNormal.isOpenNetwork, false)

  // 验证二维码特殊字符转义
  const qr = generateWifiQrString(detailNormal.ssid, detailNormal.password, 'WPA3-Personal')
  assert.equal(qr, 'WIFI:T:WPA;S:ZTools-Office-5G;P:Pass\\;word\\:123\\"\\\\!;;')
  const svgUrl = generateWifiQrSvgDataUrl({
    id: '1',
    ssid: detailNormal.ssid,
    password: detailNormal.password,
    authType: 'WPA3-Personal'
  })
  assert.ok(svgUrl.startsWith('data:image/svg+xml;utf8,'))

  // 异常 1：802.1X 企业认证网络无预共享密钥
  const detailEnt = parseWindowsWlanProfileDetail(
    'Corp-8021X',
    `
    SSID name              : "Corp-8021X"
    Authentication         : WPA2-Enterprise
    Cipher                 : CCMP
    Security key           : Absent
    `
  )
  assert.equal(detailEnt.isEnterprise, true)
  assert.equal(detailEnt.error?.code, 'EnterpriseNetwork')

  // 异常 2：权限不足未返回 Key Content
  const detailDenied = parseWindowsWlanProfileDetail(
    'Secret-WiFi',
    `
    SSID 名称              : "Secret-WiFi"
    身份验证               : WPA2-个人
    安全密钥               : 存在
    `
  )
  assert.equal(detailDenied.error?.code, 'PermissionDenied')

  // 异常 3：宿主无无线网卡返回空数组
  const hostService = new BuiltinPluginHostService()
  const noAdapterBridge = createHostBridge(hostService, {
    listSavedNetworks: { simulateNoAdapter: true }
  })
  const emptyList = await fetchSavedWifiProfiles({ hostOverride: noAdapterBridge })
  assert.deepEqual(emptyList, [])
})

test('08-clean-keyboard: 五步锁定状态机、误触计数、紧急热键解锁与异常边界测试', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)
  const mgr = new KeyboardLockManager()

  try {
    // 异常 1：未锁定时调用解锁拒绝
    const earlyUnlock = await mgr.unlockKeyboard('manual', bridge)
    assert.equal(earlyUnlock.success, false)
    assert.equal(earlyUnlock.code, 'NOT_LOCKED')

    // 异常 2：非法时长 (0, -10, NaN) 拒绝
    const zeroLock = await mgr.lockKeyboard(0, { hostOverride: bridge })
    assert.equal(zeroLock.success, false)
    assert.equal(zeroLock.code, 'INVALID_DURATION')

    const negLock = await mgr.lockKeyboard(-15, { hostOverride: bridge })
    assert.equal(negLock.success, false)
    assert.equal(negLock.code, 'INVALID_DURATION')

    // 正常加锁 30 秒
    const lockRes = await mgr.lockKeyboard(30, {
      presetTitle: '30 秒标准清洁',
      hostOverride: bridge
    })
    assert.equal(lockRes.success, true)
    assert.equal(lockRes.status, 'locked')

    // 异常 3：锁定期间重复加锁拦截
    const dupLock = await mgr.lockKeyboard(60, { hostOverride: bridge })
    assert.equal(dupLock.success, false)
    assert.equal(dupLock.code, 'ALREADY_LOCKED')

    // 模拟误触按键拦截计数
    const k1 = await mgr.interceptKeystroke('a', [])
    assert.equal(k1.blocked, true)
    assert.equal(k1.unlocked, false)
    assert.equal(k1.state.blockedKeystrokes, 1)

    // 模拟按下紧急解锁组合键 Ctrl + U
    const emergency = await mgr.interceptKeystroke('u', ['ctrl'])
    assert.equal(emergency.unlocked, true)
    assert.equal(emergency.state.status, 'unlocked')
    assert.equal(mgr.getStats().totalBlockedKeystrokes, 1)
  } finally {
    await mgr.resetAll()
    await hostService.stop()
  }
})
