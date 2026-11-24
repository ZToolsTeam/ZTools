/**
 * 第二批（Phase 2）19 款核心高频插件闭环整合回归测试套件
 *
 * 覆盖范围：
 * - 2-A 组（效率资产 6 款）：todo、calendar、text-formatter、memo、pomodoro-focus、caffeine
 * - 2-B 组（开发套件 5 款）：json-format、git-helper、linux-http-dict、sqlite-plugin、jwt-url-codec
 * - 2-C 组（桌面运维 4 款）：window-manager、quick-folders、vscode-projects、system-backup
 * - 2-D 组（文档安全 4 款）：base64image、md-to-office、font-manager、password-vault
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.join(repoRoot, 'plugins')

const PHASE2_PLUGINS = [
  // 2-A 组
  'todo',
  'calendar',
  'text-formatter',
  'memo',
  'pomodoro-focus',
  'caffeine',
  // 2-B 组
  'json-format',
  'git-helper',
  'linux-http-dict',
  'sqlite-plugin',
  'jwt-url-codec',
  // 2-C 组
  'window-manager',
  'quick-folders',
  'vscode-projects',
  'system-backup',
  // 2-D 组
  'base64image',
  'md-to-office',
  'font-manager',
  'password-vault'
]

function distFile(pluginId, rel = 'index.js') {
  return path.join(pluginsRoot, pluginId, 'dist', rel)
}

function readDist(pluginId, rel = 'index.js') {
  return fs.readFileSync(distFile(pluginId, rel), 'utf8')
}

function readManifest(pluginId) {
  return JSON.parse(fs.readFileSync(path.join(pluginsRoot, pluginId, 'plugin.json'), 'utf8'))
}

test('Phase 2 全量契约：19 款插件均具备合法 plugin.json 与最新 dist/index.js 产物', () => {
  for (const id of PHASE2_PLUGINS) {
    const manifest = readManifest(id)
    assert.equal(manifest.revoked === true, false, `${id} 不应为 revoked 状态`)
    assert.equal(fs.existsSync(distFile(id, 'index.js')), true, `${id} 缺少 dist/index.js`)
  }
})

test('2-A 组效率资产链路：todo/calendar/text-formatter/memo/pomodoro-focus/caffeine', async () => {
  // todo：编辑待办 + 清空已完成 confirmAlert
  const todoLogic = await import(pathToFileURL(distFile('todo', 'logic.js')).href)
  assert.equal(typeof todoLogic.updateTodoItem, 'function')
  assert.match(readDist('todo'), /confirmAlert/, 'todo 清空已完成应接入 confirmAlert')

  // calendar：编辑日程 + isAllDay 全天事件
  const calDist = readDist('calendar')
  assert.match(calDist, /updateCalendarEvent/, 'calendar 应具备编辑更新日程逻辑')
  assert.match(calDist, /isAllDay/, 'calendar 表单应支持全天事件开关')

  // text-formatter & memo：Clipboard.paste 上屏 + memo 置顶
  assert.match(readDist('text-formatter'), /Clipboard\.paste/, 'text-formatter 应支持直接粘贴回前台')
  const memoDist = readDist('memo')
  assert.match(memoDist, /Clipboard\.paste/, 'memo 应支持直接粘贴正文回前台')
  assert.match(memoDist, /pinned/, 'memo 应支持置顶')

  // pomodoro-focus：按年循环 + 自定义专注时长解析
  const pomoService = await import(pathToFileURL(distFile('pomodoro-focus', 'pomodoro-service.js')).href)
  assert.equal(typeof pomoService.parseCustomFocusMinutes, 'function')
  assert.equal(pomoService.parseCustomFocusMinutes('45'), 45)
  assert.equal(pomoService.parseCustomFocusMinutes('0'), null)
  assert.equal(pomoService.parseCustomFocusMinutes('999'), null)

  // caffeine：自定义常亮时长解析 + caffeine-toggle no-view
  const cafManifest = readManifest('caffeine')
  const toggleFeature = (cafManifest.features || []).find((f) => f.code === 'caffeine-toggle')
  assert.equal(toggleFeature?.mode, 'no-view', 'caffeine-toggle 应为 no-view 静默直达')
  const cafService = await import(pathToFileURL(distFile('caffeine', 'caffeine-service.js')).href)
  assert.equal(cafService.parseCustomCaffeineMinutes('45'), 45)
  assert.equal(cafService.parseCustomCaffeineMinutes('0'), null)
})

test('2-B 组开发者套件链路：json-format/git-helper/linux-http-dict/sqlite-plugin/jwt-url-codec', async () => {
  // json-format：escapeJson / unescapeJson / sortJsonKeys
  const jsonLogic = await import(pathToFileURL(distFile('json-format', 'logic.js')).href)
  const escapedRes = jsonLogic.escapeJson('{"b":1,"a":2}')
  const escaped = typeof escapedRes === 'string' ? escapedRes : (escapedRes.value ?? '')
  assert.ok(escaped.includes('\\"b\\"'), `escapeJson 输出异常: ${JSON.stringify(escapedRes)}`)
  const unescapedRes = jsonLogic.unescapeJson(escaped)
  const unescaped = typeof unescapedRes === 'string' ? unescapedRes : (unescapedRes.value ?? '')
  assert.equal(unescaped, '{"b":1,"a":2}')
  const sortedRes = jsonLogic.sortJsonKeys('{"z":1,"a":{"d":2,"c":3}}', 2)
  const sorted = typeof sortedRes === 'string' ? sortedRes : (sortedRes.value ?? '')
  assert.ok(sorted.indexOf('"a"') < sorted.indexOf('"z"'))
  assert.ok(sorted.indexOf('"c"') < sorted.indexOf('"d"'))

  // git-helper：紧急自救 >= 15 条 + Breaking Change
  const gitSvc = await import(pathToFileURL(distFile('git-helper', 'git-helper-service.js')).href)
  const emergencyList = gitSvc.getEmergencyDatabase ? gitSvc.getEmergencyDatabase() : (gitSvc.GIT_EMERGENCY_DATABASE || [])
  assert.ok(emergencyList.length >= 15, `git-helper 紧急自救应 >= 15 条，实得 ${emergencyList.length}`)

  // linux-http-dict：Linux 40+ / HTTP 35+ / 端口 40+
  const dictSvc = await import(pathToFileURL(distFile('linux-http-dict', 'dict-service.js')).href)
  assert.ok(dictSvc.searchLinuxCommands('').length >= 40, 'Linux 词库应 >= 40 条')
  assert.ok(dictSvc.searchHttpStatus('').length >= 35, 'HTTP 状态码词库应 >= 35 条')
  assert.ok(dictSvc.searchCommonPorts('').length >= 40, '常见端口词库应 >= 40 条')

  // sqlite-plugin：features 补齐 + 分页 offset + LocalStorage 持久化
  const sqliteManifest = readManifest('sqlite-plugin')
  assert.ok(Array.isArray(sqliteManifest.features) && sqliteManifest.features.length >= 1, 'sqlite-plugin 应声明 features')
  const sqliteDist = readDist('sqlite-plugin')
  assert.match(sqliteDist, /LocalStorage/, 'sqlite-plugin 应持久化最近打开的数据库')

  // jwt-url-codec：HS256/384/512 验签 + URL Query 重组
  const jwtSvc = await import(pathToFileURL(distFile('jwt-url-codec', 'jwt-url-service.js')).href)
  assert.equal(typeof jwtSvc.verifyJwtHmac, 'function')
  assert.equal(typeof jwtSvc.rebuildUrlWithQueryParams, 'function')
  const rebuilt = jwtSvc.rebuildUrlWithQueryParams(
    { protocol: 'https:', encodedFullUrl: 'https://example.com/api?a=1#sec', hash: '#sec' },
    [
      { key: 'a', value: '2' },
      { key: 'b', value: 'hello' }
    ]
  )
  assert.equal(rebuilt, 'https://example.com/api?a=2&b=hello#sec')
})

test('2-C 组桌面运维链路：window-manager/quick-folders/vscode-projects/system-backup', () => {
  // window-manager：高频分屏 no-view 直达命令
  const wmManifest = readManifest('window-manager')
  const noViewCodes = (wmManifest.features || []).filter((f) => f.mode === 'no-view').map((f) => f.code)
  for (const code of ['win-left-half', 'win-right-half', 'win-maximize', 'win-center', 'win-next-display']) {
    assert.ok(noViewCodes.includes(code), `window-manager 应声明 no-view 直达命令 ${code}`)
  }

  // quick-folders：自定义收藏 LocalStorage + 复制终端 cd 命令
  const qfDist = readDist('quick-folders')
  assert.match(qfDist, /LocalStorage/, 'quick-folders 应持久化自定义收藏文件夹')

  // vscode-projects：定位目录 + 置顶持久化
  const vscDist = readDist('vscode-projects', 'mac-service.js')
  assert.match(vscDist, /shell_show_item_in_folder/, 'vscode-projects 应支持在资源管理器/访达定位')
  assert.match(readDist('vscode-projects', 'mac-command.js'), /LocalStorage/, 'vscode-projects 应支持置顶持久化')

  // system-backup：更名配置快照备份 + showToast + 删除二次确认
  const sbManifest = readManifest('system-backup')
  assert.equal(sbManifest.name, '配置快照备份', 'system-backup 中文名应更正为「配置快照备份」')
  const sbDist = readDist('system-backup')
  assert.match(sbDist, /showToast/, 'system-backup 应补齐 Toast 即时反馈')
  assert.match(sbDist, /confirmAlert/, 'system-backup 删除快照应接入 confirmAlert')
})

test('2-D 组文档安全链路：base64image/md-to-office/font-manager/password-vault', () => {
  // base64image：反向保存图片文件
  assert.match(readDist('base64image', 'host.js'), /saveDecodedImage/, 'base64image 应支持保存解码后的图片文件')

  // md-to-office：导出后记录路径并提供打开/定位
  const mdDist = readDist('md-to-office')
  assert.match(mdDist, /lastExported/, 'md-to-office 导出成功后应记录路径')
  assert.match(mdDist, /ShowInFinder/, 'md-to-office 应提供定位导出文件动作')

  // font-manager：去“免费商用”误导 + 收藏持久化
  const fmManifest = readManifest('font-manager')
  const featureCodes = (fmManifest.features || []).map((f) => f.code)
  assert.equal(featureCodes.includes('font-manager-free-commercial'), false, 'font-manager 不应保留误导性 free-commercial 标识')
  assert.match(readDist('font-manager'), /LocalStorage/, 'font-manager 应持久化收藏字体')

  // password-vault：主密码二次确认 + 导出加密备份
  const pvDist = readDist('password-vault')
  assert.match(pvDist, /confirmMasterPassword/, 'password-vault 新建保险箱必须二次确认主密码')
  assert.match(pvDist, /serializeEncryptedBackup/, 'password-vault 应支持导出纯密文加密备份')
})
