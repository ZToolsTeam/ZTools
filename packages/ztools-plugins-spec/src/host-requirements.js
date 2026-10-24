import fs from 'node:fs'
import path from 'node:path'

/**
 * 插件依赖的宿主接口 → 首个提供该接口的客户端版本。
 *
 * 插件目录里的 minAppVersion 由发布脚本按这张表自动算出：客户端低于这个版本时，
 * 插件市场不提供更新、安装前会提示先升级客户端，避免旧客户端装上后功能直接失败。
 * 新增宿主接口并且有插件离不开它时，在这里登记；插件自带退路（旧客户端也能用）的接口不要登记。
 */
export const HOST_API_REQUIREMENTS = Object.freeze([
  { api: 'system_list_volumes', minAppVersion: '1.1.8.3', pattern: /\bsystem_list_volumes\b/ },
  { api: 'clipboard_history_restore', minAppVersion: '1.1.8.3', pattern: /\bclipboard_history_restore\b/ },
  { api: 'filesystem_move_file_no_replace', minAppVersion: '1.1.8.3', pattern: /\bfilesystem_move_file_no_replace\b/ }
])

export const APP_VERSION_REGEX = /^\d+(?:\.\d+){1,3}$/

/** 比较客户端版本号（2～4 段数字，缺的段按 0）；格式不对返回 null */
export function compareAppVersion(a, b) {
  if (!APP_VERSION_REGEX.test(String(a)) || !APP_VERSION_REGEX.test(String(b))) return null
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const diff = (x[i] || 0) - (y[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

const RUNTIME_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', '__tests__', 'src'])

function collectRuntimeFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectRuntimeFiles(path.join(dir, entry.name), out)
    } else if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.[cm]?js$/.test(entry.name)) {
      out.push(path.join(dir, entry.name))
    }
  }
  return out
}

/**
 * 计算插件要求的最低客户端版本：plugin.json 里手写的 minAppVersion 与运行代码（不含 src/、测试）
 * 用到的登记接口取最高者。没有任何要求时返回 { minAppVersion: undefined }。
 * @param {string} pluginDir
 * @param {object} manifest
 * @returns {{ minAppVersion?: string, apis: string[] }}
 */
export function resolvePluginMinAppVersion(pluginDir, manifest = {}) {
  let minAppVersion = typeof manifest.minAppVersion === 'string' && APP_VERSION_REGEX.test(manifest.minAppVersion)
    ? manifest.minAppVersion
    : undefined
  const apis = []
  const sources = collectRuntimeFiles(pluginDir).map((file) => fs.readFileSync(file, 'utf8'))
  for (const requirement of HOST_API_REQUIREMENTS) {
    if (!sources.some((source) => requirement.pattern.test(source))) continue
    apis.push(requirement.api)
    if (!minAppVersion || compareAppVersion(requirement.minAppVersion, minAppVersion) > 0) {
      minAppVersion = requirement.minAppVersion
    }
  }
  return { minAppVersion, apis }
}
