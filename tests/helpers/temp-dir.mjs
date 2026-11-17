import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 递归清除目录树内所有子目录与普通文件的只读属性（严格跳过符号链接，防止越界修改外部文件权限）。
 * Windows 下 Git 创建的 .git/objects/xx/* 默认带只读属性，直接 rmSync 可能触发 EPERM / EACCES。
 */
export function makeWritableSync(targetPath) {
  let stat
  try {
    stat = fs.lstatSync(targetPath, { throwIfNoEntry: false })
  } catch {
    return
  }
  if (!stat || stat.isSymbolicLink()) return

  if (stat.isDirectory()) {
    try {
      fs.chmodSync(targetPath, 0o700)
    } catch {
      // 忽略单目录权限调整失败，继续处理子项
    }
    let entries = []
    try {
      entries = fs.readdirSync(targetPath)
    } catch {
      return
    }
    for (const name of entries) {
      makeWritableSync(path.join(targetPath, name))
    }
    return
  }

  try {
    fs.chmodSync(targetPath, 0o666)
  } catch {
    // 忽略单文件权限调整失败，交由后续 rmSync 重试处理
  }
}

/**
 * 稳健删除单个临时目录：Windows 下预先解除只读属性并启用重试，首次异常后再做一次权限修复重试。
 */
export function removeTempDirSync(dir) {
  if (!dir || typeof dir !== 'string') return
  if (!fs.existsSync(dir)) return
  if (process.platform === 'win32') {
    makeWritableSync(dir)
  }
  const rmOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }
  try {
    fs.rmSync(dir, rmOptions)
  } catch {
    makeWritableSync(dir)
    fs.rmSync(dir, rmOptions)
  }
}

/**
 * 创建临时目录追踪器：支持自动记录 mkdtemp 创建的目录，清理时对每个目录独立隔离异常，并注册进程退出兜底回收。
 */
export function createTempDirTracker({ registerExitHook = true } = {}) {
  const dirs = new Set()

  const remove = (dir) => {
    if (!dir) return
    dirs.delete(dir)
    try {
      removeTempDirSync(dir)
    } catch {
      // 单个临时目录释放异常不阻断其他目录或主断言
    }
  }

  const cleanupAll = () => {
    const snapshot = [...dirs]
    dirs.clear()
    for (const dir of snapshot) {
      try {
        removeTempDirSync(dir)
      } catch {
        // 独立保护每个目录清理，绝不因单个目录异常中断后续回收
      }
    }
  }

  if (registerExitHook) {
    process.once('exit', cleanupAll)
  }

  return {
    dirs,
    track(dir) {
      if (dir) dirs.add(dir)
      return dir
    },
    mkdtemp(prefix, { realpath = false, baseDir = os.tmpdir() } = {}) {
      const raw = fs.mkdtempSync(path.join(baseDir, prefix))
      const resolved = realpath ? fs.realpathSync(raw) : raw
      dirs.add(resolved)
      return resolved
    },
    remove,
    cleanupAll
  }
}
