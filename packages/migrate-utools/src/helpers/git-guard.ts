/**
 * git-guard.ts
 * Git working tree safety check
 */

import fs from 'node:fs'
import { execSync } from 'node:child_process'

export interface GitStatusResult {
  isGit: boolean
  isClean: boolean
  dirtyFiles: string[]
  warning: string | null
}

export class GitSafetyGuard {
  static check(dirPath: string): GitStatusResult {
    if (!fs.existsSync(dirPath)) {
      return { isGit: false, isClean: true, dirtyFiles: [], warning: null }
    }

    try {
      const statusOut = execSync('git status --porcelain', {
        cwd: dirPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8'
      }).trim()

      if (!statusOut) {
        return { isGit: true, isClean: true, dirtyFiles: [], warning: null }
      }

      const dirtyFiles = statusOut
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

      return {
        isGit: true,
        isClean: false,
        dirtyFiles,
        warning: `检测到目标目录存在 ${dirtyFiles.length} 项未提交修改 (Git Dirty Working Tree)`
      }
    } catch {
      return { isGit: false, isClean: true, dirtyFiles: [], warning: null }
    }
  }
}
