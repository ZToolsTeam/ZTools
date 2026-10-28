import { validEnvironmentKey, validEnvironmentValue } from '../../contracts/environment-manager.js'
export const ENV_BEGIN = '# >>> ZTools environment >>>'
export const ENV_END = '# <<< ZTools environment <<<'
export interface ProfileBlock { before: string; after: string; entries: Map<string, string>; present: boolean }
export function quoteEnvironmentValue(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'" }
/** 只解析本工具生成的字面量导出段；不执行或猜测用户的 shell 脚本。 */
export function readEnvironmentProfile(text: string): ProfileBlock {
  const starts = [...text.matchAll(/^# >>> ZTools environment >>>\r?$/gm)], ends = [...text.matchAll(/^# <<< ZTools environment <<<\r?$/gm)]
  if (!starts.length && !ends.length) return { before: text, after: '', entries: new Map(), present: false }
  if (starts.length !== 1 || ends.length !== 1 || ends[0]!.index! <= starts[0]!.index!) throw new Error('终端变量配置段重复或不完整，请先检查配置文件')
  const start = starts[0]!.index!, end = ends[0]!.index!, bodyStart = start + starts[0]![0].length + 1
  const body = text.slice(bodyStart, end), entries = new Map<string, string>()
  let offset = 0
  while (offset < body.length) {
    const match = /^export ([A-Za-z_][A-Za-z0-9_]{0,127})=/.exec(body.slice(offset))
    if (!match) throw new Error('终端变量配置段包含无法识别的内容，未修改原文件')
    const key = match[1]!; offset += match[0].length
    let value = '', segment = false
    while (body[offset] === "'") {
      segment = true; const close = body.indexOf("'", offset + 1)
      if (close < 0) throw new Error('终端变量的引号不完整')
      value += body.slice(offset + 1, close); offset = close + 1
      if (body.slice(offset, offset + 2) === "\\'") { value += "'"; offset += 2 }
    }
    if (!segment || !validEnvironmentValue(value) || entries.has(key) || body[offset] !== '\n') throw new Error('终端变量配置段无效，未修改原文件')
    entries.set(key, value); offset++
  }
  return { before: text.slice(0, start), after: text.slice(end + ends[0]![0].length + (text[end + ends[0]![0].length] === '\n' ? 1 : 0)), entries, present: true }
}
export function replaceEnvironmentProfile(text: string, entries: ReadonlyMap<string, string>): string {
  const block = readEnvironmentProfile(text)
  for (const [key, value] of entries) {
    if (!validEnvironmentKey(key) || !validEnvironmentValue(value)) throw new Error('不能写入无效环境变量')
    if (/^# (?:>>> ZTools environment >>>|<<< ZTools environment <<<)\r?$/m.test(value)) throw new Error('变量值不能包含配置段边界标记，原配置未修改')
  }
  const prefix = block.before + (block.before && !block.before.endsWith('\n') ? '\n' : '')
  const body = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `export ${key}=${quoteEnvironmentValue(value)}\n`).join('')
  return `${prefix}${ENV_BEGIN}\n${body}${ENV_END}\n${block.after}`
}
