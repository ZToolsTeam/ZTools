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
 *          → package:dmg:darwin（本脚本）→ notarytool 提交 DMG 并 staple。
 * 本脚本只负责 DMG 的生成、完整性校验与可选签名，不提交公证（需要发布者的 Apple 账号）。
 */

const VOLUME_NAME = 'ZTools'
const TOOL_OPTIONS = Object.freeze({ encoding: 'utf8', shell: false, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })

export const DMG_USAGE = 'npm run package:dmg:darwin -- --app <绝对路径/ZTools.app> --output <绝对路径/ZTools-<版本>-darwin-universal.dmg> [--sign-identity "Developer ID Application: <名称> (<Team ID>)"] [--allow-unsigned]'

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
  return {
    help: false,
    app: path.resolve(values.app),
    output: path.resolve(values.output),
    signIdentity,
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

export function createMacDmg(options, {
  platform = process.platform,
  fsApi = fs,
  exec = execFileSync,
  tmpdir = os.tmpdir,
  log = console.log
} = {}) {
  if (platform !== 'darwin') throw new Error(`DMG 只能在 macOS 上生成，当前平台: ${platform}`)
  const { app, output, signIdentity, allowUnsigned } = options
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
  } catch (error) {
    // 失败时不留下半成品，避免被误当作可发布产物
    fsApi.rmSync(output, { force: true })
    throw error
  } finally {
    fsApi.rmSync(staging, { recursive: true, force: true })
  }

  const sha256 = createHash('sha256').update(fsApi.readFileSync(output)).digest('hex')
  fsApi.writeFileSync(`${output}.sha256`, `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' })
  const result = { status: 'PASS', dmg: output, sha256, appSigned, dmgSigned: Boolean(signIdentity) }
  log(JSON.stringify(result))
  if (signIdentity) {
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
