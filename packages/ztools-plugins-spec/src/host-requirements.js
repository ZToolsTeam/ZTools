import fs from 'node:fs'
import path from 'node:path'

/**
 * 插件依赖的宿主接口 → 首个提供该接口的客户端版本。
 *
 * 插件目录里的 minAppVersion 由发布脚本按这张表自动算出：客户端低于这个版本时，
 * 插件市场不提供更新、安装前会提示先升级客户端，避免旧客户端装上后功能直接失败。
 * 新增宿主接口并且有插件离不开它时，在这里登记；插件自带退路（旧客户端也能用）的接口不要登记。
 * 版本号以实际发布的安装包为准：v1.1.8.4 的宿主接口与 v1.1.8.3 相同，下面标 1.1.8.5 的接口从 1.1.8.5 起才有。
 */
export const HOST_API_REQUIREMENTS = Object.freeze([
  { api: 'system_list_volumes', minAppVersion: '1.1.8.3', pattern: /\bsystem_list_volumes\b/ },
  { api: 'clipboard_history_restore', minAppVersion: '1.1.8.3', pattern: /\bclipboard_history_restore\b/ },
  { api: 'filesystem_move_file_no_replace', minAppVersion: '1.1.8.3', pattern: /\bfilesystem_move_file_no_replace\b/ },
  { api: 'browser_bookmarks_scan', minAppVersion: '1.1.8.5', pattern: /\bbrowser_bookmarks_(?:scan|cancel)\b/ },
  { api: 'system_power_session', minAppVersion: '1.1.8.5', pattern: /\bsystem_power_session\b/ },
  { api: 'keyboard_lock', minAppVersion: '1.1.8.5', pattern: /\bkeyboard_lock\b/ },
  { api: 'dns_benchmark', minAppVersion: '1.1.8.5', pattern: /\bdns_benchmark\b/ },
  { api: 'docker_manager', minAppVersion: '1.1.8.5', pattern: /\bdocker_manager\b/ },
  { api: 'downloads_manager', minAppVersion: '1.1.8.5', pattern: /\bdownloads_manager\b/ },
  { api: 'environment_manager', minAppVersion: '1.1.8.5', pattern: /\benvironment_manager\b/ },
  { api: 'file_unlock', minAppVersion: '1.1.8.5', pattern: /\bfile_unlock\b/ },
  { api: 'folder_sync', minAppVersion: '1.1.8.5', pattern: /\bfolder_sync(?:_cancel)?\b/ },
  { api: 'font_manager', minAppVersion: '1.1.8.5', pattern: /\bfont_manager(?:_cancel)?\b/ },
  { api: 'hosts_manager', minAppVersion: '1.1.8.5', pattern: /\bhosts_manager\b/ },
  { api: 'hotkey_probe', minAppVersion: '1.1.8.5', pattern: /\bhotkey_probe\b/ },
  { api: 'lan_network', minAppVersion: '1.1.8.5', pattern: /\blan_network\b/ },
  { api: 'markdown_document', minAppVersion: '1.1.8.5', pattern: /\bmarkdown_document\b/ },
  { api: 'media_metadata', minAppVersion: '1.1.8.5', pattern: /\bmedia_metadata(?:_cancel)?\b/ },
  { api: 'monitor_control', minAppVersion: '1.1.8.5', pattern: /\bmonitor_control\b/ },
  { api: 'network_speedtest', minAppVersion: '1.1.8.5', pattern: /\bnetwork_speedtest\b/ },
  { api: 'office_document', minAppVersion: '1.1.8.5', pattern: /\boffice_(?:document|cancel)\b/ },
  { api: 'recent_projects', minAppVersion: '1.1.8.5', pattern: /\brecent_projects\b/ },
  { api: 'ssh_proxy', minAppVersion: '1.1.8.5', pattern: /\bssh_proxy\b/ },
  { api: 'startup_manager', minAppVersion: '1.1.8.5', pattern: /\bstartup_manager\b/ },
  { api: 'tls_inspect', minAppVersion: '1.1.8.5', pattern: /\btls_inspect\b/ }
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
