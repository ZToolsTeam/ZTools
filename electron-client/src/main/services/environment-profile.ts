import { validEnvironmentKey, validEnvironmentValue } from '../../contracts/environment-manager.js'
export const ENV_BEGIN = '# >>> ZTools environment >>>'
export const ENV_END = '# <<< ZTools environment <<<'
export interface ProfileBlock { before: string; after: string; entries: Map<string, string>; present: boolean }
export function quoteEnvironmentValue(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'" }
/** 只解析本工具生成的字面量导出段；不执行或猜测用户的 shell 脚本。 */
export function readEnvironmentProfile(text: string): ProfileBlock {
  const starts = [...text.matchAll(/^# >>> ZTools environment >>>\r?$/gm)], ends = [...text.matchAll(/^# <<< ZTools environment <<<\r?$/gm)]
  if (!starts.length && !ends.length) return { before: text, after: '', entries: new Map(), present: false }
  if (starts.length !== 1 || ends.length !== 1 || ends[0]!.index! <= starts[0]!.index!) throw new Error('Shell environment block is duplicated or incomplete; inspect the profile file first')
  const start = starts[0]!.index!, end = ends[0]!.index!, bodyStart = start + starts[0]![0].length + 1
  const body = text.slice(bodyStart, end), entries = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]{0,127})=/.exec(body.slice(offset))
    if (!match) throw new Error('Shell environment block contains unrecognized content; original file was not modified')
    const key = match[1]!; offset += match[0].length
    let value = '', segment = false
    while (body[offset] === "'") {
      segment = true; const close = body.indexOf("'", offset + 1)
      if (close < 0) throw new Error('Unterminated quote in shell environment variable')
      value += body.slice(offset + 1, close); offset = close + 1
      if (body.slice(offset, offset + 2) === "\\'") { value += "'"; offset += 2 }
    }
    if (!segment || !validEnvironmentValue(value) || entries.has(key) || body[offset] !== '\n') throw new Error('Shell environment block is invalid; original file was not modified')
    entries.set(key, value); offset++
  }
  return { before: text.slice(0, start), after: text.slice(end + ends[0]![0].length + (text[end + ends[0]![0].length] === '\n' ? 1 : 0)), entries, present: true }
}
/**
 * macOS 终端配置里的 PATH 按字面量导出（单引号，不展开），会整体替换终端原有 PATH。
 * 返回会破坏终端的原因（英文），没问题返回空字符串；规则与插件 env-manager 的 darwinPathProblem 一致：
 * 不能含 $ 或反引号（不会展开）、不能有 ~ 开头或相对目录（空项保持原样允许）、必须保留 /usr/bin 与 /bin。
 */
export function darwinPathProblem(value: string): string {
  if (/[$`]/.test(value)) return 'PATH is saved literally: $PATH, $HOME, and backticks are not expanded and would drop existing shell directories; enter full colon-separated paths'
  const parts = value.split(':')
  if (parts.some(p => p.startsWith('~'))) return 'PATH is saved literally: ~ is not expanded to the home directory; use full paths starting with /'
  if (parts.some(p => p && !p.startsWith('/'))) return 'Every directory in PATH must start with /'
  if (!parts.includes('/usr/bin') || !parts.includes('/bin')) return 'PATH replaces the shell PATH entirely and must keep /usr/bin and /bin, otherwise new terminals cannot run basic commands'
  return ''
}
export function replaceEnvironmentProfile(text: string, entries: ReadonlyMap<string, string>): string {
  const block = readEnvironmentProfile(text)
  for (const [key, value] of entries) {
    if (!validEnvironmentKey(key) || !validEnvironmentValue(value)) throw new Error('Cannot write invalid environment variable')
    if (/^# (?:>>> ZTools environment >>>|<<< ZTools environment <<<)\r?$/m.test(value)) throw new Error('Variable value cannot contain environment block boundary markers; original configuration was not modified')
  }
  const prefix = block.before + (block.before && !block.before.endsWith('\n') ? '\n' : '')
  const body = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `export ${key}=${quoteEnvironmentValue(value)}\n`).join('')
  return `${prefix}${ENV_BEGIN}\n${body}${ENV_END}\n${block.after}`
}
