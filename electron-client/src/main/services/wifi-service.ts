import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { runCommand as runDecodedCommand } from './host-plugins/shared-utils.js'

export interface SystemWifiProfile {
  ssid: string
  current?: boolean | undefined
  security?: string | undefined
}
export type WifiCommandRunner = (command: string, args: string[], timeout: number) => Promise<string>
const execFileAsync = promisify(execFile)
const runCommand: WifiCommandRunner = async (command, args, timeout) => {
  const { stdout, stderr } = await execFileAsync(command, args, { encoding: 'utf8', timeout, windowsHide: true })
  // -g 的密码位于 stderr；stdout 是账户属性，不能与密码回执混合解析。
  return command === '/usr/bin/security' && args[0] === 'find-generic-password' && args.includes('-g') ? stderr : stdout
}
const netsh = () => path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netsh.exe')

/** Windows 依赖：命令执行永不抛错（返回退出码，124 超时、130 取消），临时目录用于 netsh 导出 XML。 */
export interface WindowsWifiDeps { run: (command: string, args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>; tempRoot: string }
const windowsDeps: WindowsWifiDeps = { run: (command, args, timeoutMs) => runDecodedCommand(command, args, timeoutMs), tempRoot: os.tmpdir() }
export interface WindowsWlanProfile { name: string; ssid?: string; authentication?: string; encryption?: string; useOneX?: boolean; keyProtected?: boolean; keyMaterial?: string }
const xmlEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function xmlText(value: string): string {
  if (/<|\]\]>/.test(value)) throw new Error('无线网络配置导出文件包含无法识别的嵌套内容')
  return value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-z]+));/g, (all, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named !== undefined) { const known = xmlEntities[named]; if (known === undefined) throw new Error('无线网络配置导出文件包含未知实体'); return known }
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec)
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error(`无线网络配置导出文件包含无效字符 ${all}`)
    return String.fromCodePoint(code)
  })
}
const element = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]
function decodeXmlBytes(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) } catch { throw new Error('无线网络配置导出文件不是有效的 UTF-8/UTF-16 文本') }
}
/** 解析 netsh wlan export profile 导出的 WLANProfile XML；只取元素文本，名称与密钥保留首尾空白，不按系统语言解析。 */
export function parseWlanProfileXml(content: Buffer | string): WindowsWlanProfile {
  const xml = typeof content === 'string' ? content : decodeXmlBytes(content)
  if (!/<WLANProfile[\s>]/.test(xml) || !/<\/WLANProfile>\s*$/.test(xml)) throw new Error('无线网络配置导出文件格式无法识别')
  const ssidConfig = element(xml, 'SSIDConfig'), outer = ssidConfig === undefined ? xml : xml.replace(/<SSIDConfig(?:\s[^>]*)?>[\s\S]*?<\/SSIDConfig>/, '')
  const rawName = element(outer, 'name')
  if (rawName === undefined || !rawName.length) throw new Error('无线网络配置导出文件缺少配置名称')
  const profile: WindowsWlanProfile = { name: xmlText(rawName) }
  const ssidBlock = ssidConfig === undefined ? undefined : element(ssidConfig, 'SSID')
  if (ssidBlock !== undefined) {
    const hex = element(ssidBlock, 'hex')?.trim(), plain = element(ssidBlock, 'name')
    let decoded: string | undefined
    if (hex && /^(?:[0-9a-fA-F]{2}){1,32}$/.test(hex)) { try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex')) } catch { decoded = undefined } }
    const ssid = decoded ?? (plain === undefined ? undefined : xmlText(plain))
    if (ssid) profile.ssid = ssid
  }
  const auth = element(xml, 'authentication')?.trim(), encryption = element(xml, 'encryption')?.trim(), oneX = element(xml, 'useOneX')?.trim().toLowerCase()
  if (auth) profile.authentication = xmlText(auth)
  if (encryption) profile.encryption = xmlText(encryption)
  if (oneX === 'true' || oneX === 'false') profile.useOneX = oneX === 'true'
  const sharedKey = element(xml, 'sharedKey')
  if (sharedKey !== undefined) {
    const protectedValue = element(sharedKey, 'protected')?.trim().toLowerCase(), key = element(sharedKey, 'keyMaterial')
    if (protectedValue === 'true' || protectedValue === 'false') profile.keyProtected = protectedValue === 'true'
    if (key !== undefined) profile.keyMaterial = xmlText(key)
  }
  return profile
}
/** 只把 XML 中明确的认证方式映射为界面可识别的名称；无法确定时不返回，不猜测。 */
export function windowsWifiSecurity(profile: WindowsWlanProfile): string | undefined {
  const auth = profile.authentication?.toLowerCase(), encryption = profile.encryption?.toLowerCase()
  if (!auth) return undefined
  if (auth.startsWith('wpa3') && auth !== 'wpa3sae') return 'WPA3-Enterprise'
  if (profile.useOneX === true || auth === 'wpa2' || auth === 'wpa') return auth === 'wpa2' ? 'WPA2-Enterprise' : auth === 'wpa' ? 'WPA-Enterprise' : undefined
  if (auth === 'open') return encryption === 'none' ? 'Open' : encryption === 'wep' ? 'WEP' : undefined
  return ({ shared: 'WEP', wpapsk: 'WPA-Personal', wpa2psk: 'WPA2-Personal', wpa3sae: 'WPA3-Personal', owe: 'OWE' } as Record<string, string>)[auth]
}
const mac = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i, guid = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i
/**
 * 从 netsh wlan show interfaces 中取已连接的 SSID。标签随系统语言变化，只依赖不翻译的 "SSID" 键和 GUID、MAC 值：
 * 没有 GUID（无法确认输出结构）或出现了 BSSID 类 MAC 却找不到 SSID 键（标签被翻译）时返回 undefined，表示未知。
 */
export function parseWlanInterfaceSsids(output: string): Set<string> | undefined {
  const ssids = new Set<string>(); let guids = 0, macs = 0
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([^:：]+?)\s*[:：] ?(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!, value = match[2]!.replace(/\s+$/, '')
    if (guid.test(value)) guids++
    else if (mac.test(value)) macs++
    else if (key === 'SSID' && value) ssids.add(value)
  }
  if (!guids || (macs > guids && !ssids.size)) return undefined
  return ssids
}
function netshFailure(action: string, result: { stdout: string; stderr: string; exitCode: number }) {
  if (result.exitCode === 124) return `${action}超时，请稍后重试`
  if (result.exitCode === 130) return `${action}已取消`
  const detail = (result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(0, 200)
  return `${action}失败（netsh 退出码 ${result.exitCode}）；请确认 WLAN AutoConfig 服务已启动且有无线网卡${detail ? `：${detail}` : ''}`
}
/** netsh 导出到私有临时目录后立即删除；删除失败时报错并给出位置，避免含密钥的文件静默残留。 */
async function exportWlanProfiles(deps: WindowsWifiDeps, extra: string[], action: string): Promise<WindowsWlanProfile[]> {
  const directory = await fs.mkdtemp(path.join(deps.tempRoot, 'ztools-wlan-'))
  let profiles: WindowsWlanProfile[] | undefined, failure: unknown
  try {
    const result = await deps.run(netsh(), ['wlan', 'export', 'profile', ...extra, `folder=${directory}`], 15_000)
    if (result.exitCode !== 0) throw new Error(netshFailure(action, result))
    const files = (await fs.readdir(directory)).filter(name => name.toLowerCase().endsWith('.xml'))
    if (files.length > 1024) throw new Error('导出的无线网络配置过多，停止读取')
    profiles = []
    for (const file of files.sort()) {
      const bytes = await fs.readFile(path.join(directory, file))
      if (bytes.length > 256 * 1024) throw new Error('无线网络配置导出文件过大')
      profiles.push(parseWlanProfileXml(bytes))
    }
  } catch (error) { failure = error }
  try { await fs.rm(directory, { recursive: true, force: true }) }
  catch { throw new Error(`临时导出目录清理失败，其中可能包含无线网络配置，请手动删除：${directory}`) }
  if (failure !== undefined || !profiles) throw failure
  return profiles
}
export async function readWindowsWifiProfiles(deps: WindowsWifiDeps = windowsDeps): Promise<SystemWifiProfile[]> {
  // 不带 key=clear：导出文件中的密钥保持系统加密，列表不接触明文密码。
  const exported = await exportWlanProfiles(deps, [], '读取已保存的无线网络')
  const interfaces = await deps.run(netsh(), ['wlan', 'show', 'interfaces'], 6_000)
  // 当前连接读取失败或无法解析时保持未知，不伪造“未连接”。
  const connected = interfaces.exitCode === 0 ? parseWlanInterfaceSsids(interfaces.stdout) : undefined
  // netsh 按系统代码页输出，代码页外的字符会变成 "?"。有已连接 SSID 与所有配置都对不上时，无法判断它对应哪个配置：
  // 对上的仍标为已连接，其余一律未知（全部对不上即全部未知），不能把真正连着的网络报成“未连接”。
  const known = new Set(exported.map(profile => profile.ssid ?? profile.name))
  const unmatched = connected !== undefined && [...connected].some(ssid => !known.has(ssid))
  const result = new Map<string, SystemWifiProfile>()
  for (const profile of exported) {
    const previous = result.get(profile.name), security = windowsWifiSecurity(profile)
    const matched = connected?.has(profile.ssid ?? profile.name) === true || previous?.current === true
    const current = connected === undefined || (unmatched && !matched) ? previous?.current : matched
    result.set(profile.name, { ssid: profile.name, ...(current === undefined ? {} : { current }), ...(security ?? previous?.security ? { security: security ?? previous?.security } : {}) })
  }
  return [...result.values()]
}
export async function readWindowsWifiPassword(name: string, deps: WindowsWifiDeps = windowsDeps): Promise<string> {
  const exported = (await exportWlanProfiles(deps, [`name=${name}`, 'key=clear'], '读取该无线网络配置')).filter(profile => profile.name === name)
  if (!exported.length) throw new Error('系统没有导出所选网络的配置，请刷新列表后重试')
  const clear = exported.find(profile => profile.keyProtected === false && profile.keyMaterial !== undefined && profile.keyMaterial.length > 0)
  if (clear) return clear.keyMaterial!
  if (exported.some(profile => profile.keyProtected === true)) throw new Error('Windows 未提供明文密钥；读取明文密码可能需要以管理员身份运行客户端')
  throw new Error('未找到该网络的可共享密码；开放网络与企业认证网络可能没有预共享密码')
}

function parseMacPassword(output: string): string {
  // -w 无标记地输出纯文本或十六进制，无法区分 "616263" 与编码后的 "abc"。
  // -g 的引号/0x 标记可无歧义还原，十六进制后的可读预览不作为密码使用。
  const text = /^password: "([\x20-\x7e]*)"\n$/.exec(output)
  if (text) return text[1]!
  const hex = /^password: 0x((?:[\da-fA-F]{2})+)(?: |  "[\x20-\x7e]*")\n$/.exec(output)
  if (hex) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(hex[1]!, 'hex'))
  if (output === 'password: \n') return ''
  throw new Error('系统未返回可识别的密码格式')
}

export async function readWifiProfiles(platform: NodeJS.Platform, run: WifiCommandRunner = runCommand, windows: WindowsWifiDeps = windowsDeps): Promise<SystemWifiProfile[]> {
  if (platform === 'darwin') {
    const ports = await run('/usr/sbin/networksetup', ['-listallhardwareports'], 4_000)
    const block = ports.split(/\r?\n\r?\n/).find(value => /Hardware Port: (?:Wi-Fi|AirPort)\r?\n/.test(value))
    const device = block?.match(/^Device: ([a-z0-9]+)\r?$/im)?.[1]
    if (!device) throw new Error('未找到无线网络接口')
    const [saved, connection] = await Promise.all([
      run('/usr/sbin/networksetup', ['-listpreferredwirelessnetworks', device], 5_000),
      run('/usr/sbin/networksetup', ['-getairportnetwork', device], 4_000).then(
        output => output.match(/^Current (?:Wi-Fi|AirPort) Network: (.*)\r?$/m)?.[1]?.replace(/\r$/, ''),
        () => undefined // 当前连接信息不可用不影响已保存列表；保持未知，不伪造连接状态。
      )
    ])
    if (!/^Preferred networks on /i.test(saved)) throw new Error('系统未返回有效的已保存无线网络列表')
    return [...new Set(saved.split(/\r?\n/).slice(1).filter(line => line.startsWith('\t')).map(line => line.slice(1)))]
      .filter(ssid => ssid.length > 0)
      .map(ssid => ({ ssid, ...(connection === undefined ? {} : { current: ssid === connection }) }))
  }
  if (platform === 'win32') return readWindowsWifiProfiles(windows)
  throw new Error('当前系统不支持读取无线网络配置')
}

/** 仅由用户主动操作调用；密码不记录日志、不裁剪空白。 */
export async function readWifiPassword(ssid: string, platform: NodeJS.Platform, run: WifiCommandRunner = runCommand, windows: WindowsWifiDeps = windowsDeps): Promise<{ ssid: string; password: string }> {
  if (typeof ssid !== 'string' || !ssid.length || ssid.includes('\0')) throw new ZToolsError(errorCodes.invalidRequest, 'Wi-Fi SSID 无效')
  let password: string | undefined
  if (platform === 'darwin') {
    try {
      const output = await run('/usr/bin/security', ['find-generic-password', '-D', 'AirPort network password', '-a', ssid, '-g'], 30_000)
      password = parseMacPassword(output)
    } catch {
      throw new Error('未能读取 Wi-Fi 密码：授权取消或超时、钥匙串中没有该记录，或密钥格式不支持')
    }
  } else if (platform === 'win32') {
    password = await readWindowsWifiPassword(ssid, windows)
  } else throw new Error('当前系统不支持读取 Wi-Fi 密码')
  if (!password) throw new Error('未找到该网络的可共享密码；开放网络与企业认证网络可能没有预共享密码')
  return { ssid, password }
}
