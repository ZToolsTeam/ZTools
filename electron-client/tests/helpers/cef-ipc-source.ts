import fs from 'node:fs'
import path from 'node:path'

const CEF_IPC_SRC_DIR = path.resolve(__dirname, '../../../../frontend/public/js/cef-ipc/src')

/**
 * 剥离 cef-ipc 源码中的 ESM import/export 语法，便于在 Node vm 沙箱中执行真实前端 SDK 源码。
 */
export function stripCefIpcModuleSyntax(source: string): string {
  // 先剥离多行或单行 import 语句
  const withoutImports = source.replace(
    /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"][^'"]+['"]\s*;?\s*$/gm,
    ''
  )
  return withoutImports
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (/^export\s+default\b/.test(trimmed) || /^export\s*\{/.test(trimmed)) {
        return ''
      }
      return line.replace(/^(\s*)export\s+/, '$1')
    })
    .join('\n')
}

/**
 * 读取前端 cef-ipc/src/core/environment.js 中的真实 i18n 辅助函数（resolveSdkText / SDK_ERROR_MESSAGES /
 * resolveSdkErrorText / createSdkError），不含 Environment 单例实例化，避免与自定义沙箱 environment 冲突。
 */
export function loadCefIpcI18nSource(): string {
  const envPath = path.join(CEF_IPC_SRC_DIR, 'core/environment.js')
  const raw = fs.readFileSync(envPath, 'utf8')
  const marker = raw.indexOf('class Environment')
  if (marker === -1) {
    throw new Error(`无法在 ${envPath} 中定位 class Environment 分界线`)
  }
  return stripCefIpcModuleSyntax(raw.slice(0, marker))
}

/**
 * 按顺序读取一组 cef-ipc 源码文件，自动前置真实 i18n 辅助定义并剥离 ESM 模块语法。
 * @param relativePaths 相对于 frontend/public/js/cef-ipc/src 的路径（可省略 .js 后缀）
 */
export function loadCefIpcSources(
  relativePaths: readonly string[],
  options: { readonly includeI18n?: boolean } = {}
): string {
  const parts: string[] = []
  if (options.includeI18n !== false) {
    parts.push(loadCefIpcI18nSource())
  }
  for (const rel of relativePaths) {
    const normalized = rel.endsWith('.js') ? rel : `${rel}.js`
    const fullPath = path.join(CEF_IPC_SRC_DIR, normalized)
    parts.push(stripCefIpcModuleSyntax(fs.readFileSync(fullPath, 'utf8')))
  }
  return parts.join('\n')
}
