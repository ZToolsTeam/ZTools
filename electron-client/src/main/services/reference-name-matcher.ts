import { errorCodes, ZToolsError } from '../../contracts/errors.js'

/** Unicode code-point wildcard matching; no regexp, path interpretation or OS case guessing.
 * One matcher has a shared work budget across the entire directory snapshot.
 */
export function referenceNameMatcher(pattern: string, caseSensitive: boolean) {
  const tokens = Array.from(caseSensitive ? pattern : pattern.toLowerCase())
  let work = 0
  return (name: string): boolean => {
    const text = Array.from(caseSensitive ? name : name.toLowerCase())
    let index = 0, token = 0, star = -1, retry = 0
    while (index < text.length) {
      if (++work > 16 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, '目录查找超过匹配工作预算')
      if (tokens[token] === '?' || (tokens[token] !== '*' && tokens[token] === text[index])) { index++; token++ }
      else if (tokens[token] === '*') { star = token++; retry = index }
      else if (star >= 0) { token = star + 1; index = ++retry }
      else return false
    }
    while (tokens[token] === '*') token++
    return token === tokens.length
  }
}
