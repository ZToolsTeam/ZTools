/**
 * 第一批（Phase 1）16 款插件优化全链路整合回归测试套件
 *
 * 覆盖范围：
 * - A 组（安全红线 7 款）：disk-analyzer、shredder、folder-sync、cleaner、qq-cleaner、wechat-cleaner、network-rescue
 * - B 组（敏感剪贴板 2 款）：google-auth、wifi-password-reveal
 * - C 组（能力回流 2 款）：timestamp、crypto-tool
 * - D 组（单点 Bug 5 款）：mover、dns-benchmark、quicklinks、snippets、screen-color-picker
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'plugins')

const PHASE1_PLUGINS = [
  // A 组：安全红线
  'disk-analyzer',
  'shredder',
  'folder-sync',
  'cleaner',
  'qq-cleaner',
  'wechat-cleaner',
  'network-rescue',
  // B 组：敏感剪贴板
  'google-auth',
  'wifi-password-reveal',
  // C 组：合并退化能力回流
  'timestamp',
  'crypto-tool',
  // D 组：高频单点 Bug 修复
  'mover',
  'dns-benchmark',
  'quicklinks',
  'snippets',
  'screen-color-picker'
]

function distFile(pluginId, rel = 'index.js') {
  return path.join(pluginsRoot, pluginId, 'dist', rel)
}

function readDist(pluginId, rel = 'index.js') {
  return fs.readFileSync(distFile(pluginId, rel), 'utf8')
}

test('Phase 1 全量契约：16 款插件均具备合法 plugin.json 与最新 dist/index.js 产物', () => {
  for (const id of PHASE1_PLUGINS) {
    const manifestPath = path.join(pluginsRoot, id, 'plugin.json')
    const entryPath = distFile(id, 'index.js')
    assert.equal(fs.existsSync(manifestPath), true, `${id} 缺少 plugin.json`)
    assert.equal(fs.existsSync(entryPath), true, `${id} 缺少构建产物 dist/index.js`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.revoked === true, false, `${id} 不应为 revoked 状态`)
    assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, `${id} manifest.name 缺失`)
  }
})

test('A 组安全红线链路：移除假样本数据、SSD 提示与高危 confirmAlert 门禁', () => {
  // 1. disk-analyzer 不得残留非真实宿主硬编码假样本
  const diskDist = readDist('disk-analyzer')
  assert.equal(diskDist.includes('init-disk-sample-1'), false, 'disk-analyzer 不应残留硬编码假样本数据')

  // 2. shredder 确认弹窗必须包含 SSD 磨损均衡与 TRIM 局限提示（中英文）
  const shredderI18n = readDist('shredder', 'i18n.js')
  assert.match(shredderI18n, /SSD|磨损均衡|TRIM/, 'shredder 中文提示缺少 SSD 磨损均衡/TRIM 警示')
  assert.match(shredderI18n, /wear leveling|TRIM/i, 'shredder 英文提示缺少 SSD wear leveling/TRIM 警示')

  // 3. folder-sync 执行前必须接入 confirmAlert
  const folderSyncDist = readDist('folder-sync')
  assert.match(folderSyncDist, /confirmAlert/, 'folder-sync 必须调用 confirmAlert 确认同步操作')

  // 4. network-rescue 高危修复必须接入 confirmAlert
  const networkRescueDist = readDist('network-rescue')
  assert.match(networkRescueDist, /confirmAlert/, 'network-rescue 必须对高危修复接入 confirmAlert')
  assert.match(networkRescueDist, /reset-winsock/, 'network-rescue 应覆盖 reset-winsock 风险拦截')
  assert.match(networkRescueDist, /reset-firewall/, 'network-rescue 应覆盖 reset-firewall 风险拦截')
})

test('B 组敏感剪贴板链路：google-auth 与 wifi-password-reveal 统一透传 sensitive: true', () => {
  const googleAuthDist = readDist('google-auth')
  assert.match(googleAuthDist, /clipboard_copy_text/, 'google-auth 复制密钥应调用宿主 clipboard_copy_text')
  assert.match(googleAuthDist, /sensitive:\s*true/, 'google-auth 复制密钥必须显式透传 sensitive: true')

  const wifiDist = readDist('wifi-password-reveal')
  assert.match(wifiDist, /clipboard_copy_text/, 'wifi-password-reveal 复制密码应调用宿主 clipboard_copy_text')
  assert.match(wifiDist, /sensitive:\s*true/, 'wifi-password-reveal 复制密码必须显式透传 sensitive: true')
})

test('C 组能力回流链路：timestamp 世界时钟 320+ 城市库、本机时区与跨日标签', async () => {
  const wcMod = await import(pathToFileURL(distFile('timestamp', 'world-clock.js')).href)
  assert.equal(typeof wcMod.detectLocalTimeZone, 'function')
  assert.equal(typeof wcMod.searchWorldZones, 'function')
  assert.equal(typeof wcMod.getDayDiff, 'function')
  assert.equal(typeof wcMod.formatDayDiffLabel, 'function')

  const localTz = wcMod.detectLocalTimeZone()
  assert.equal(typeof localTz, 'string')
  assert.ok(localTz.includes('/') || localTz === 'UTC', `本机时区检测异常: ${localTz}`)

  // 检索超过旧版 20 城市范围的全球中英文城市
  const allZones = Intl.supportedValuesOf('timeZone')
  const zurichZh = wcMod.searchWorldZones('苏黎世', allZones, 'zh-CN')
  const reykjavikEn = wcMod.searchWorldZones('Reykjavik', allZones, 'en-US')
  assert.ok(zurichZh.some((z) => z.zone === 'Europe/Zurich'), '应能检索中文城市“苏黎世”')
  assert.ok(reykjavikEn.some((z) => z.zone === 'Atlantic/Reykjavik'), '应能检索英文城市 Reykjavik')

  // 跨日标签验证（getDayDiff(date, targetZone, refZone)：北京 6/16 02:00 相对纽约 6/15 14:00 为 +1 天）
  const sampleDate = new Date('2026-06-15T18:00:00Z')
  assert.equal(wcMod.getDayDiff(sampleDate, 'Asia/Shanghai', 'America/New_York'), 1)
  assert.equal(wcMod.getDayDiff(sampleDate, 'America/New_York', 'Asia/Shanghai'), -1)
  assert.ok(wcMod.formatDayDiffLabel(-1).includes('-1'))
  assert.ok(wcMod.formatDayDiffLabel(1).includes('+1'))
  assert.equal(wcMod.formatDayDiffLabel(0), '')
})

test('C 组能力回流链路：crypto-tool UUID v1/v4/v7 生成、4 种格式与边界异常', async () => {
  const uuidMod = await import(pathToFileURL(distFile('crypto-tool', 'uuid-logic.js')).href)
  assert.equal(typeof uuidMod.generateUuidBatch, 'function')

  // v4 标准小写
  const v4List = uuidMod.generateUuidBatch({ version: 'v4', format: 'standard', count: 5 })
  assert.equal(v4List.length, 5)
  assert.equal(new Set(v4List).size, 5)
  for (const id of v4List) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  }

  // v7 时间有序 + 无连字符大写
  const v7List = uuidMod.generateUuidBatch({ version: 'v7', format: 'no-dash-upper', count: 5 })
  assert.equal(v7List.length, 5)
  for (const id of v7List) {
    assert.match(id, /^[0-9A-F]{12}7[0-9A-F]{3}[89AB][0-9A-F]{15}$/)
  }

  // v1 标准大写
  const v1List = uuidMod.generateUuidBatch({ version: 'v1', format: 'uppercase', count: 3 })
  assert.equal(v1List.length, 3)
  for (const id of v1List) {
    assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-1[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/)
  }

  // 边界异常断言：count = 0 / 负数 / 超上限 必须显式报错
  assert.throws(() => uuidMod.generateUuidBatch({ version: 'v4', format: 'standard', count: 0 }))
  assert.throws(() => uuidMod.generateUuidBatch({ version: 'v4', format: 'standard', count: -3 }))
  assert.throws(() => uuidMod.generateUuidBatch({ version: 'v4', format: 'standard', count: 9999 }))
})

test('D 组单点 Bug 回归链路：mover / dns-benchmark / quicklinks / snippets / screen-color-picker', async () => {
  // 1. mover：放宽扫描深度 + 抽样估算 1.25x 安全冗余空间预检
  const moverMod = await import(pathToFileURL(distFile('mover', 'logic.js')).href)
  assert.ok(moverMod.MOVER_SCAN_OPTIONS.maxDepth >= 8, 'mover 扫描深度应大于历史硬限 2')
  assert.ok(moverMod.MOVER_SCAN_OPTIONS.maxFiles >= 200, 'mover 扫描文件数上限应不低于 200')
  const moverItem = {
    id: 'wechat',
    name: 'WeChat',
    sourcePath: 'C:\\Users\\demo\\Documents\\WeChat Files',
    sizeBytes: 1000,
    isApproximate: true,
    exists: true
  }
  const approxErr = moverMod.validateMoveSelection([moverItem], 'D:\\ZToolsMoved', 1100)
  assert.equal(typeof approxErr, 'string', '抽样估算目录在目标盘剩余空间不足 1.25 倍安全冗余时应返回阻断错误')
  assert.ok(approxErr.length > 0)
  const enoughErr = moverMod.validateMoveSelection([moverItem], 'D:\\ZToolsMoved', 1500)
  assert.equal(enoughErr, null, '目标盘剩余空间超过 1.25 倍安全冗余时应放行')

  // 2. dns-benchmark：Win 侧必须处理 dns-reset-dhcp 且刷新快捷键使用 ctrl
  const dnsDist = readDist('dns-benchmark')
  assert.match(dnsDist, /dns-reset-dhcp/, 'dns-benchmark Windows 入口必须处理 dns-reset-dhcp')

  // 3. quicklinks：导入导出网址组往返保真
  const qlStorage = await import(pathToFileURL(distFile('quicklinks', 'quicklinks-storage.js')).href)
  const payload = JSON.stringify([
    {
      id: 'g1',
      title: '早间工作台',
      link: 'https://a.example',
      alias: 'morning',
      isGroup: true,
      urls: ['https://a.example', 'https://b.example']
    }
  ])
  const parsed = qlStorage.importQuicklinksJson(payload, [])
  assert.equal(parsed.success, true)
  assert.equal(parsed.importedCount, 1)
  const importedGroup = parsed.result.find((it) => it.alias === 'morning')
  assert.equal(importedGroup.isGroup, true)
  assert.deepEqual(importedGroup.urls, ['https://a.example', 'https://b.example'])

  // 4. snippets：下拉筛选必须包含 general 分类
  const snippetsDist = readDist('snippets')
  assert.match(snippetsDist, /value:\s*["']general["']/, 'snippets 分类筛选下拉框应包含 general 分类')

  // 5. screen-color-picker：真实 OKLCH 色值精度（纯红 #FF0000 约 oklch(62.8% 0.258 29.2)）
  const colorMod = await import(pathToFileURL(distFile('screen-color-picker', 'converter.js')).href)
  assert.equal(typeof colorMod.rgbToOklch, 'function')
  const red = colorMod.rgbToOklch({ r: 255, g: 0, b: 0 })
  assert.ok(Math.abs(red.l - 62.8) < 0.2, `纯红 OKLCH L 应约 62.8%，实得 ${red.l}`)
  assert.ok(Math.abs(red.c - 0.258) < 0.005, `纯红 OKLCH C 应约 0.258，实得 ${red.c}`)
  assert.ok(Math.abs(red.h - 29.2) < 1.0, `纯红 OKLCH H 应约 29.2，实得 ${red.h}`)
  const white = colorMod.rgbToOklch({ r: 255, g: 255, b: 255 })
  assert.ok(Math.abs(white.l - 100) < 0.2 && white.c < 0.001, `纯白 OKLCH 应为 L≈100, C≈0，实得 ${JSON.stringify(white)}`)
})
