import { type SshDirective, type SshDocuments, type SshDocument } from './ssh-config-reader.js'
import { validSshAlias } from '../../contracts/ssh-proxy.js'
export { validSshAlias } from '../../contracts/ssh-proxy.js'

export interface SshProfile {
  alias: string; hostName?: string; user?: string; port?: number; identityFiles: string[]
  proxyJump?: string; localForwards: string[]; previewComplete: boolean; notices: string[]
}
/** 星号回退只移动文本位置；不生成有指数回溯风险的正则。整轮扫描另有限额。 */
function wildcard(host: string, pattern: string, spend: () => void): boolean {
  if (pattern.length > 1024) throw new Error('SSH Host 匹配模式超过 1024 字符')
  const text = Array.from(host.toLowerCase()), glob = Array.from(pattern.toLowerCase())
  let i = 0, j = 0, star = -1, retry = 0
  while (i < text.length) {
    spend()
    if (glob[j] === '?' || glob[j] === text[i]) { i++; j++ }
    else if (glob[j] === '*') { star = j++; retry = i }
    else if (star >= 0) { j = star + 1; i = ++retry }
    else return false
  }
  while (glob[j] === '*') { spend(); j++ }
  return j === glob.length
}
function match(host: string, patterns: string[], spend: () => void) {
  let positive = false
  for (const original of patterns) {
    spend()
    const negative = original.startsWith('!'), pattern = negative ? original.slice(1) : original
    if (wildcard(host, pattern, spend)) { if (negative) return false; positive = true }
  }
  return positive
}
const fields = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'localforward'])
/** 仅解释确定的静态规则；Match 等条件不会通过启动 shell 来求值。 */
export function sshProfiles(config: SshDocuments): { hosts: SshProfile[]; warnings: string[] } {
  const aliases = new Set<string>(), warnings = new Set(config.warnings)
  let work = 0, previewBytes = 0
  const spend = () => { if (++work > 2_000_000) throw new Error('SSH 配置匹配工作量超过限制，停止预览') }
  // 按 JSON 字符最坏转义长度预留容量；限制整轮累积内容，避免共享规则被每个主机放大。
  const reserve = (length: number, overhead = 3) => {
    previewBytes += length * 6 + overhead
    if (previewBytes > 2 * 1024 * 1024) throw new Error('SSH 配置预览容量超过限制，停止预览')
  }
  for (const warning of warnings) reserve(warning.length)
  function collect(document: SshDocument) {
    for (const item of document.directives) {
      spend()
      if (item.key === 'host') for (const name of item.args) {
        if (/[!*?]/.test(name)) continue
        if (validSshAlias(name)) aliases.add(name)
        else warnings.add('部分主机别名含不支持的字符，未提供一键连接')
      }
      for (const child of item.includes ?? []) collect(child)
    }
  }
  for (const document of config.documents) collect(document)
  if (aliases.size > 1024) throw new Error('SSH 主机条目超过 1024，停止读取')
  const hosts: SshProfile[] = []
  for (const alias of aliases) {
    reserve(alias.length, 256)
    const values = new Map<string, string[]>(), uncertain = new Set<string>(), notices = new Set<string>()
    let declared = false
    function assign(item: SshDirective, active: boolean | 'unknown') {
      if (!fields.has(item.key) || active === false) return
      if (active === 'unknown') { uncertain.add(item.key); return }
      if (item.key !== 'localforward' && item.args.length !== 1) throw new Error(`SSH ${item.key} 参数数量无效`)
      if (item.key === 'port' && (!/^\d+$/.test(item.args[0]!) || Number(item.args[0]) < 1 || Number(item.args[0]) > 65535)) throw new Error('SSH 端口必须在 1 到 65535 之间')
      if (item.key === 'identityfile' || item.key === 'localforward') {
        const entries = values.get(item.key) ?? []
        if (entries.length >= 256) throw new Error('SSH 累积配置条目超过 256，停止预览')
        for (const part of item.args) reserve(part.length, 6)
        entries.push(item.args.join(' ')); values.set(item.key, entries)
      }
      else if (!values.has(item.key)) { reserve(item.args[0]!.length); values.set(item.key, item.args) }
    }
    function visit(document: SshDocument, initial: boolean | 'unknown', guard: boolean | 'unknown' = true) {
      let active = initial
      const guarded = (next: boolean | 'unknown') => guard === false || next === false ? false : guard === 'unknown' ? 'unknown' : next
      for (const item of document.directives) {
        spend()
        if (item.key === 'host') {
          active = guard === false ? false : guarded(match(alias, item.args, spend))
          if (active !== false && item.args.includes(alias)) declared = true
        }
        else if (item.key === 'match') {
          active = guarded(item.args.length === 1 && item.args[0]!.toLowerCase() === 'all' ? true : 'unknown')
          if (active === 'unknown') notices.add('含 Match 条件；相关字段不作确定预览，实际连接由系统 SSH 解释')
        } else if (item.key === 'include') {
          if (item.unresolved && active !== false) { for (const name of fields) uncertain.add(name); notices.add('动态 Include 尚未展开') }
          // OpenSSH 对每个包含文件恢复外层 active；非活动 Include 内的 Host 不能重新激活。
          for (const child of item.includes ?? []) visit(child, active, guarded(active))
        } else {
          if (item.key === 'canonicalizehostname' && active !== false && item.args[0] !== 'no') { for (const name of fields) uncertain.add(name); notices.add('启用了目标主机名规范化，连接参数需由系统 SSH 确定') }
          assign(item, active)
        }
      }
    }
    for (const document of config.documents) visit(document, true)
    if (!declared) continue
    for (const notice of notices) reserve(notice.length)
    const get = (key: string) => uncertain.has(key) ? undefined : values.get(key)?.[0]
    const host: SshProfile = { alias, identityFiles: uncertain.has('identityfile') ? [] : values.get('identityfile') ?? [], localForwards: uncertain.has('localforward') ? [] : values.get('localforward') ?? [], previewComplete: !uncertain.size && !config.warnings.length && !notices.size, notices: [...notices] }
    if (!uncertain.has('hostname')) {
      const name = get('hostname') ?? alias
      reserve(name.length)
      host.hostName = name.replace(/%%|%h/g, token => { const value = token === '%%' ? '%' : alias; reserve(value.length); return value })
    }
    const user = get('user'), port = get('port'), jump = get('proxyjump')
    if (user) host.user = user
    if (port) host.port = Number(port)
    if (jump) host.proxyJump = jump
    hosts.push(host)
  }
  return { hosts, warnings: [...warnings] }
}
