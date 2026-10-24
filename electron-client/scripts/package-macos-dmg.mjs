import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

/**
 * 从已签名（并建议已公证 / staple）的 ZTools.app 生成可拖拽安装的 DMG。
 *
 * 发布顺序：package:app:darwin:universal → sign:mac:prototype（签名、公证、staple .app）
 *          → package:dmg:darwin（本脚本：生成 DMG、签名，传 --notary-profile 时提交公证并 staple DMG）。
 * 公证会改写 DMG（staple 写入公证票据），所以 SHA-256 在公证之后才计算。
 */

const VOLUME_NAME = 'ZTools'
const TOOL_OPTIONS = Object.freeze({ encoding: 'utf8', shell: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })
// 苹果公证排队偶尔要二三十分钟
const NOTARY_OPTIONS = Object.freeze({ ...TOOL_OPTIONS, timeout: 3_600_000 })
const NOTARY_PROFILE = /^[A-Za-z0-9_.-]{1,128}$/

export const DMG_USAGE = 'npm run package:dmg:darwin -- --app <绝对路径/ZTools.app> --output <绝对路径/ZTools-<版本>-darwin-universal.dmg> [--sign-identity "Developer ID Application: <名称> (<Team ID>)" [--notary-profile <notarytool 凭据名>]] [--allow-unsigned]'

export function parseDmgArguments(argv) {
  const seen = new Set()
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const name = arg.split('=')[0]
    if (seen.has(name)) throw new Error(`参数重复: ${name}`)
    seen.add(name)
  }
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      help: { type: 'boolean' },
      app: { type: 'string' },
      output: { type: 'string' },
      'sign-identity': { type: 'string' },
      'notary-profile': { type: 'string' },
      'allow-unsigned': { type: 'boolean' }
    }
  })
  if (values.help) return { help: true }
  if (!values.app || !path.isAbsolute(values.app) || path.extname(values.app) !== '.app') {
    throw new Error('--app 必须是 .app 的绝对路径')
  }
  if (!values.output || !path.isAbsolute(values.output) || path.extname(values.output).toLowerCase() !== '.dmg') {
    throw new Error('--output 必须是 .dmg 的绝对路径')
  }
  const signIdentity = values['sign-identity']
  if (signIdentity !== undefined && !/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(signIdentity)) {
    throw new Error('--sign-identity 必须是「Developer ID Application: 名称 (Team ID)」格式')
  }
  if (signIdentity && values['allow-unsigned']) {
    throw new Error('--sign-identity 与 --allow-unsigned 不能同时使用：签名发布包必须来自已签名的 .app')
  }
  const notaryProfile = values['notary-profile']
  if (notaryProfile !== undefined && (!signIdentity || !NOTARY_PROFILE.test(notaryProfile))) {
    throw new Error('--notary-profile 必须与 --sign-identity 一起使用，且只能包含字母、数字、点、下划线和横线')
  }
  return {
    help: false,
    app: path.resolve(values.app),
    output: path.resolve(values.output),
    signIdentity,
    ...(notaryProfile ? { notaryProfile } : {}),
    allowUnsigned: values['allow-unsigned'] === true
  }
}

function assertAppBundle(fsApi, appPath) {
  let stats
  try {
    stats = fsApi.lstatSync(appPath)
  } catch {
    throw new Error(`找不到 .app: ${appPath}`)
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`.app 必须是真实目录: ${appPath}`)
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist')
  if (!fsApi.existsSync(infoPlist)) throw new Error(`.app 缺少 Contents/Info.plist: ${appPath}`)
}

/**
 * 提交 DMG 公证并把票据 staple 进 DMG，最后用 Gatekeeper 规则验一遍。
 * 未通过时取回公证日志（只含问题文件与原因，不含凭据）方便排查。
 */
function notarizeDmg(exec, output, notaryProfile, log) {
  log(`正在提交 DMG 公证（通常几分钟）：${path.basename(output)}`)
  let raw
  try {
    raw = exec('/usr/bin/xcrun', ['notarytool', 'submit', output, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], NOTARY_OPTIONS)
  } catch (error) {
    // 公证结果为 Invalid 时 notarytool 以非 0 退出，结果 JSON 仍在 stdout 里
    raw = typeof error?.stdout === 'string' && error.stdout.trim() ? error.stdout : null
    if (!raw) throw new Error('NOTARY_SUBMIT_FAILED：提交公证失败（检查 Apple API 密钥与网络）')
  }
  let submission
  try {
    submission = JSON.parse(raw)
  } catch {
    throw new Error('NOTARY_RESPONSE_INVALID：公证返回的不是合法 JSON')
  }
  const id = typeof submission?.id === 'string' && /^[a-f0-9-]{36}$/i.test(submission.id) ? submission.id : ''
  if (submission?.status !== 'Accepted') {
    let detail = ''
    if (id) {
      try {
        detail = exec('/usr/bin/xcrun', ['notarytool', 'log', id, '--keychain-profile', notaryProfile], TOOL_OPTIONS)
      } catch {
        detail = '（公证日志获取失败）'
      }
    }
    throw new Error(`NOTARY_NOT_ACCEPTED：DMG 公证未通过（状态 ${submission?.status ?? '未知'}${id ? `，提交 ID ${id}` : ''}）${detail ? `\n${detail}` : ''}`)
  }
  exec('/usr/bin/xcrun', ['stapler', 'staple', output], TOOL_OPTIONS)
  exec('/usr/bin/xcrun', ['stapler', 'validate', output], TOOL_OPTIONS)
  exec('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', output], TOOL_OPTIONS)
  log(`✔ DMG 公证通过并已 staple（提交 ID ${id}）`)
}

export function createMacDmg(options, {
  platform = process.platform,
  fsApi = fs,
  exec = execFileSync,
  tmpdir = os.tmpdir,
  log = console.log
} = {}) {
  if (platform !== 'darwin') throw new Error(`DMG 只能在 macOS 上生成，当前平台: ${platform}`)
  const { app, output, signIdentity, notaryProfile, allowUnsigned } = options
  assertAppBundle(fsApi, app)
  if (fsApi.existsSync(output)) throw new Error(`输出文件已存在，请先归档后重试: ${output}`)
  if (!fsApi.existsSync(path.dirname(output))) throw new Error(`输出目录不存在: ${path.dirname(output)}`)

  // 先确认 .app 签名完整：DMG 内的应用决定 Gatekeeper 是否放行
  let appSigned = true
  try {
    exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], TOOL_OPTIONS)
  } catch {
    appSigned = false
  }
  if (!appSigned && !allowUnsigned) {
    throw new Error('MAC_APP_NOT_SIGNED：.app 签名校验失败；发布前请先执行 sign:mac:prototype，仅本地测试可加 --allow-unsigned')
  }

  const staging = path.join(tmpdir(), `ztools-dmg-${randomUUID()}`)
  try {
    fsApi.mkdirSync(staging)
    // ditto 保留签名、扩展属性与资源分叉，避免复制后签名失效
    exec('/usr/bin/ditto', [app, path.join(staging, path.basename(app))], TOOL_OPTIONS)
    fsApi.symlinkSync('/Applications', path.join(staging, 'Applications'))
    exec('/usr/bin/hdiutil', ['create', '-volname', VOLUME_NAME, '-srcfolder', staging, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', output], TOOL_OPTIONS)
    exec('/usr/bin/hdiutil', ['verify', output], TOOL_OPTIONS)
    if (signIdentity) {
      exec('/usr/bin/codesign', ['--sign', signIdentity, '--timestamp', output], TOOL_OPTIONS)
      exec('/usr/bin/codesign', ['--verify', '--strict', output], TOOL_OPTIONS)
    }
    if (notaryProfile) notarizeDmg(exec, output, notaryProfile, log)
  } catch (error) {
    // 失败时不留下半成品，避免被误当作可发布产物
    fsApi.rmSync(output, { force: true })
    throw error
  } finally {
    fsApi.rmSync(staging, { recursive: true, force: true })
  }

  const sha256 = createHash('sha256').update(fsApi.readFileSync(output)).digest('hex')
  fsApi.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' })
  const result = { status: 'PASS', dmg: output, sha256, appSigned, dmgSigned: Boolean(signIdentity), dmgNotarized: Boolean(notaryProfile) }
  log(JSON.stringify(result))
  if (signIdentity && !notaryProfile) {
    log(`下一步（需要发布者 Apple 账号）：xcrun notarytool submit "${output}" --keychain-profile <profile> --wait && xcrun stapler staple "${output}"`)
  } else if (!appSigned) {
    log('提示：本 DMG 内的 .app 未签名，只能用于本地测试，不能对外发布。')
  }
  return result
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const options = parseDmgArguments(argv)
    if (options.help) {
      console.log(DMG_USAGE)
      return 0
    }
    createMacDmg(options, dependencies)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
