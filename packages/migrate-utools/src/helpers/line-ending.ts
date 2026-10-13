/**
 * line-ending.ts
 * Line ending detection and preservation engine
 * Follows AGENTS.md: .bat uses CRLF, other files use LF
 */

import path from 'node:path'

export class LineEndingHelper {
  /**
   * Detect line ending in content
   */
  static detect(content: string | Buffer | null | undefined): 'CRLF' | 'LF' {
    if (!content) return 'LF'
    const str = typeof content === 'string' ? content : content.toString('utf8')
    const sample = str.slice(0, 8192)
    const crlfCount = (sample.match(/\r\n/g) || []).length
    const lfCount = (sample.match(/[^\r]\n/g) || []).length

    if (crlfCount > 0 && lfCount === 0) return 'CRLF'
    if (lfCount > 0 && crlfCount === 0) return 'LF'
    if (crlfCount > 0 && crlfCount >= lfCount) return 'CRLF'
    return 'LF'
  }

  /**
   * Convert string to target line ending
   */
  static convert(content: string, targetEnding: 'CRLF' | 'LF' = 'LF'): string {
    if (typeof content !== 'string') return content
    if (targetEnding === 'CRLF') {
      return content.replace(/\r?\n/g, '\r\n')
    }
    return content.replace(/\r\n/g, '\n')
  }

  /**
   * Preserve original content's line ending on new content
   */
  static preserve(originalContent: string | Buffer, newContent: string): string {
    const ending = LineEndingHelper.detect(originalContent)
    return LineEndingHelper.convert(newContent, ending)
  }

  /**
   * Get default line ending for newly created file
   */
  static getDefaultEnding(filePath: string): 'CRLF' | 'LF' {
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.bat' || ext === '.cmd') {
      return 'CRLF'
    }
    return 'LF'
  }
}
