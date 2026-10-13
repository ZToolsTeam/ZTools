/**
 * scanner.ts
 * Static scan analyzer for uTools plugins
 * Analyzes manifest, JS/TS code, uTools API coverage, Node modules, sync calls, readiness score and risks.
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  CompatTier,
  CompatTierCode,
  RiskItem,
  ScanResult,
  ApiUsageItem,
  NodeUsageItem,
  NativeModuleItem
} from './types.ts'

export const COMPAT_TIERS: Record<CompatTierCode, CompatTier> = {
  TIER_1_PURE_FRONTEND: {
    code: 'TIER_1_PURE_FRONTEND',
    title: '纯前端无需改动',
    color: 'green',
    level: 1,
    description: '无 Node.js 依赖，无特殊 preload，仅使用纯 Web 技术栈，直接支持运行'
  },
  TIER_2_MANIFEST_ONLY: {
    code: 'TIER_2_MANIFEST_ONLY',
    title: '仅需 manifest 转换',
    color: 'cyan',
    level: 2,
    description: '使用基础 utools API，已有对等 1:1 接口，无阻塞同步调用，仅需转换配置'
  },
  TIER_3_SYNC_ADAPT: {
    code: 'TIER_3_SYNC_ADAPT',
    title: '需要同步 API 适配',
    color: 'yellow',
    level: 3,
    description: '调用了同步 utools.db.* 或同步系统对话框，需内存缓存或改造为 async/await'
  },
  TIER_4_NODE_BRIDGE: {
    code: 'TIER_4_NODE_BRIDGE',
    title: '需要 Node 桥接改造',
    color: 'magenta',
    level: 4,
    description: '使用了 Node.js 原生模块或自定义 window.services，需配置 Node 宿主桥接'
  },
  TIER_5_NATIVE_BLOCKED: {
    code: 'TIER_5_NATIVE_BLOCKED',
    title: '存在重度原生依赖暂不支持',
    color: 'red',
    level: 5,
    description: '包含 .node 二进制模块、特定 C++ 原生库或未适配的 Windows 独占底层能力'
  }
}

export const NODE_BUILTIN_MODULES = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib', 'electron'
])

export const HEAVY_NATIVE_PACKAGES = new Set([
  'sharp', 'sqlite3', 'better-sqlite3', 'canvas', 'node-pty', 'robotjs',
  'iohook', 'ffi', 'ffi-napi', 'ref', 'ref-napi', 'ref-struct-napi',
  'serialport', 'node-sass', 'tree-sitter', 'koffi', 'couchbase',
  'leveldown', 'rocksdb', 'snappy', 'bcrypt', 'microtime', 'uiohook-napi',
  'desktop-screenshot', 'screenshot-desktop'
])

export interface ApiDef {
  category: string
  isSync: boolean
  ztools: string
  supported: boolean
}

export const UTOOLS_API_KNOWLEDGE: Record<string, ApiDef> = {
  // 生命周期
  'utools.onPluginReady': { category: 'lifecycle', isSync: false, ztools: 'ztoolsPlugin.onReady', supported: true },
  'utools.onPluginEnter': { category: 'lifecycle', isSync: false, ztools: 'ztoolsPlugin.onEnter', supported: true },
  'utools.onPluginOut': { category: 'lifecycle', isSync: false, ztools: 'ztoolsPlugin.onOut', supported: true },
  'utools.onPluginDetach': { category: 'lifecycle', isSync: false, ztools: 'ztoolsPlugin.onDetach', supported: true },
  'utools.onDbPull': { category: 'lifecycle', isSync: false, ztools: 'event_subscribe', supported: false },
  'utools.onScheduleTrigger': { category: 'lifecycle', isSync: false, ztools: 'trigger_register', supported: false },
  'utools.onMainPush': { category: 'search', isSync: false, ztools: 'ztoolsPlugin.onMainPush', supported: true },

  // 窗口与交互
  'utools.hideMainWindow': { category: 'window', isSync: false, ztools: 'ztools.window.hide', supported: true },
  'utools.showMainWindow': { category: 'window', isSync: false, ztools: 'ztools.window.show', supported: true },
  'utools.setExpandHeight': { category: 'window', isSync: false, ztools: 'ztools.window.setHeight', supported: true },
  'utools.setExpendHeight': { category: 'window', isSync: false, ztools: 'ztools.window.setHeight', supported: true },
  'utools.createBrowserWindow': { category: 'window', isSync: false, ztools: 'ztools.window.open', supported: true },
  'utools.sendToParent': { category: 'window', isSync: false, ztools: 'ztools.event.publish', supported: true },
  'utools.getWindowType': { category: 'window', isSync: true, ztools: 'system_get_runtime_identity', supported: true },
  'utools.outPlugin': { category: 'window', isSync: false, ztools: 'ztools.plugin.close', supported: true },

  // 子输入框
  'utools.setSubInput': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.set', supported: true },
  'utools.removeSubInput': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.remove', supported: true },
  'utools.setSubInputValue': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.setValue', supported: true },
  'utools.subInputFocus': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.focus', supported: true },
  'utools.subInputSelect': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.select', supported: true },
  'utools.subInputBlur': { category: 'subInput', isSync: false, ztools: 'ztools.subInput.blur', supported: true },

  // 剪贴板
  'utools.copyText': { category: 'clipboard', isSync: false, ztools: 'ztools.clipboard.writeText', supported: true },
  'utools.copyImage': { category: 'clipboard', isSync: false, ztools: 'ztools.clipboard.writeImage', supported: true },
  'utools.copyFile': { category: 'clipboard', isSync: false, ztools: 'ztools.clipboard.writeFile', supported: true },
  'utools.readCurrentBrowserUrl': { category: 'clipboard', isSync: false, ztools: 'ztools.system.getBrowserUrl', supported: false },

  // 通知与消息
  'utools.showNotification': { category: 'notification', isSync: false, ztools: 'ztools.notification.show', supported: true },
  'utools.shellOpenExternal': { category: 'shell', isSync: false, ztools: 'ztools.shell.openExternal', supported: true },
  'utools.shellOpenPath': { category: 'shell', isSync: false, ztools: 'ztools.shell.openPath', supported: true },
  'utools.shellShowItemInFolder': { category: 'shell', isSync: false, ztools: 'ztools.shell.showItemInFolder', supported: true },
  'utools.shellBeep': { category: 'shell', isSync: false, ztools: 'ztools.shell.beep', supported: true },

  // 数据库 (同步)
  'utools.db.get': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.get', supported: true },
  'utools.db.put': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.put', supported: true },
  'utools.db.remove': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.remove', supported: true },
  'utools.db.bulkDocs': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.bulkDocs', supported: true },
  'utools.db.allDocs': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.allDocs', supported: true },
  'utools.db.postAttachment': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.postAttachment', supported: true },
  'utools.db.getAttachment': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.getAttachment', supported: true },
  'utools.db.getAttachmentType': { category: 'database', isSync: true, ztools: 'utools-db-sync-shim.db.getAttachmentType', supported: true },

  // 键值存储 (同步)
  'utools.dbStorage.setItem': { category: 'storage', isSync: true, ztools: 'utools-db-sync-shim.dbStorage.setItem', supported: true },
  'utools.dbStorage.getItem': { category: 'storage', isSync: true, ztools: 'utools-db-sync-shim.dbStorage.getItem', supported: true },
  'utools.dbStorage.removeItem': { category: 'storage', isSync: true, ztools: 'utools-db-sync-shim.dbStorage.removeItem', supported: true },

  // 对话框 (同步)
  'utools.showOpenDialog': { category: 'dialog', isSync: true, ztools: 'ztools.dialog.open (异步化或替身)', supported: true },
  'utools.showSaveDialog': { category: 'dialog', isSync: true, ztools: 'ztools.dialog.save (异步化或替身)', supported: true },
  'utools.showMessageBox': { category: 'dialog', isSync: true, ztools: 'ztools.dialog.messageBox', supported: true },
  'utools.showErrorBox': { category: 'dialog', isSync: true, ztools: 'ztools.dialog.errorBox', supported: true },

  // 系统与设备
  'utools.isWindows': { category: 'environment', isSync: true, ztools: 'services-adapter.isWindows', supported: true },
  'utools.isMacOS': { category: 'environment', isSync: true, ztools: 'services-adapter.isMacOS', supported: true },
  'utools.isLinux': { category: 'environment', isSync: true, ztools: 'services-adapter.isLinux', supported: true },
  'utools.isDev': { category: 'environment', isSync: true, ztools: 'services-adapter.isDev', supported: true },
  'utools.getAppVersion': { category: 'environment', isSync: true, ztools: 'ztools.app.getVersion', supported: true },
  'utools.getNativeId': { category: 'environment', isSync: true, ztools: 'ztools.app.getId', supported: true }
}

export class StaticScanAnalyzer {
  static scan(pluginDir: string): ScanResult {
    const absDir = path.resolve(pluginDir)
    if (!fs.existsSync(absDir)) {
      throw new Error(`插件目录不存在: ${absDir}`)
    }

    const manifestResult = this.scanManifest(absDir)
    const codeFiles = this.findCodeFiles(absDir)

    const apiLocationsMap = new Map<string, Array<{ file: string; line: number }>>()
    const nodeLocationsMap = new Map<string, Array<{ file: string; line: number }>>()
    const nativeModulesMap = new Map<string, { type: 'binary_node' | 'c_cpp_package'; locations: Array<{ file: string; line?: number }> }>()

    let hasSyncDb = false
    let hasSyncNode = false
    let hasSyncDialog = false
    let totalSyncCount = 0

    const servicesMethods = new Set<string>()
    const rendererCalls = new Set<string>()
    let hasWindowExports = false

    // 扫描源码文件
    for (const filePath of codeFiles) {
      const relPath = path.relative(absDir, filePath).replace(/\\/g, '/')
      const ext = path.extname(filePath).toLowerCase()

      // 检测 .node 二进制模块文件
      if (ext === '.node') {
        const pkgName = path.basename(filePath)
        if (!nativeModulesMap.has(pkgName)) {
          nativeModulesMap.set(pkgName, { type: 'binary_node', locations: [] })
        }
        nativeModulesMap.get(pkgName)!.locations.push({ file: relPath })
        continue
      }

      if (['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.html', '.vue'].includes(ext)) {
        const content = fs.readFileSync(filePath, 'utf8')
        const lines = content.split('\n')

        // 1. 扫描 utools API
        this.scanUtoolsApis(content, lines, relPath, apiLocationsMap)

        // 2. 扫描 Node.js 模块使用
        this.scanNodeModules(content, lines, relPath, nodeLocationsMap)

        // 3. 扫描同步调用特征
        if (/utools\.db\.(get|put|remove|allDocs|bulkDocs|postAttachment|getAttachment)/.test(content)) {
          hasSyncDb = true
          totalSyncCount++
        }
        if (/utools\.dbStorage\.(setItem|getItem|removeItem)/.test(content)) {
          hasSyncDb = true
          totalSyncCount++
        }
        if (/utools\.(showOpenDialog|showSaveDialog|showMessageBox|showErrorBox)/.test(content)) {
          hasSyncDialog = true
          totalSyncCount++
        }
        if (/(?:readFileSync|writeFileSync|execSync|spawnSync)/.test(content)) {
          hasSyncNode = true
          totalSyncCount++
        }

        // 4. 扫描 window.services / window.exports
        this.scanServicesAndExports(content, servicesMethods, rendererCalls)
        if (/window\.exports\s*=|exports\s*\[/.test(content)) {
          hasWindowExports = true
        }
      }
    }

    // 扫描 package.json 依赖中的 heavy native packages
    const pkgPath = path.join(absDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
        for (const dep of Object.keys(allDeps)) {
          if (HEAVY_NATIVE_PACKAGES.has(dep.toLowerCase())) {
            if (!nativeModulesMap.has(dep)) {
              nativeModulesMap.set(dep, { type: 'c_cpp_package', locations: [] })
            }
            nativeModulesMap.get(dep)!.locations.push({ file: 'package.json' })
          }
        }
      } catch {}
    }

    // 汇总 API 调用信息
    const apiUsageDetails: ApiUsageItem[] = []
    let totalCalls = 0
    let coveredApisCount = 0
    let uncoveredApisCount = 0

    for (const [api, locs] of apiLocationsMap.entries()) {
      const def = UTOOLS_API_KNOWLEDGE[api] || {
        category: 'other',
        isSync: false,
        ztools: '未实现',
        supported: false
      }
      const count = locs.length
      totalCalls += count
      if (def.supported) {
        coveredApisCount++
      } else {
        uncoveredApisCount++
      }
      apiUsageDetails.push({
        api,
        category: def.category,
        isSync: def.isSync,
        ztoolsCounterpart: def.ztools,
        count,
        locations: locs
      })
    }

    const uniqueApisCount = apiUsageDetails.length
    const coveragePercent = uniqueApisCount > 0 ? Math.round((coveredApisCount / uniqueApisCount) * 100) : 100

    // 汇总 Node 使用信息
    const nodeUsageModules: NodeUsageItem[] = []
    let totalNodeCalls = 0
    for (const [mod, locs] of nodeLocationsMap.entries()) {
      totalNodeCalls += locs.length
      nodeUsageModules.push({
        module: mod,
        count: locs.length,
        locations: locs
      })
    }

    // 汇总 Native 使用信息
    const nativeModuleItems: NativeModuleItem[] = []
    for (const [mod, info] of nativeModulesMap.entries()) {
      nativeModuleItems.push({
        package: mod,
        type: info.type,
        locations: info.locations
      })
    }

    // 计算风险和兼容性 Tier 与得分
    const risks: RiskItem[] = []
    let score = 100

    if (nativeModuleItems.length > 0) {
      score -= 50
      risks.push({
        level: 'CRITICAL',
        message: `检测到重度原生 C++ / .node 二进制模块依赖 (${nativeModuleItems.map(m => m.package).join(', ')})`,
        remedy: '跨平台运行时无法直接承载平台专属二进制，需重构为纯 JS 或使用 ZTools NativeHost32 服务桥接'
      })
    }

    if (hasSyncDb) {
      score -= 10
      risks.push({
        level: 'MEDIUM',
        message: '检测到同步数据库调用 (utools.db.* 或 utools.dbStorage.*)',
        remedy: '需植入 UtoolsDbSyncShim 同步内存缓存垫片提供乐观 MVCC 读写支持'
      })
    }

    if (hasSyncDialog) {
      score -= 15
      risks.push({
        level: 'HIGH',
        message: '检测到同步原生系统对话框 (如 utools.showOpenDialog)',
        remedy: 'Electron 环境下系统对话框建议重构为异步调用或受控测试替身'
      })
    }

    if (totalNodeCalls > 0) {
      score -= 15
      risks.push({
        level: 'MEDIUM',
        message: `检测到 Node.js 原生内置模块依赖 (${nodeUsageModules.map(m => m.module).join(', ')})`,
        remedy: '需配置 Preload 桥接或 window.services 暴露受控 API'
      })
    }

    if (uncoveredApisCount > 0) {
      score -= uncoveredApisCount * 5
      risks.push({
        level: 'HIGH',
        message: `存在 ${uncoveredApisCount} 个尚未对等支持的 uTools API`,
        remedy: '需在适配层补充对应 polyfill 或调整业务逻辑'
      })
    }

    score = Math.max(0, Math.min(100, score))

    // 判定兼容性 Tier
    let tier: CompatTier
    if (nativeModuleItems.length > 0) {
      tier = COMPAT_TIERS.TIER_5_NATIVE_BLOCKED
    } else if (totalNodeCalls > 0 || servicesMethods.size > 0) {
      tier = COMPAT_TIERS.TIER_4_NODE_BRIDGE
    } else if (hasSyncDb || hasSyncDialog) {
      tier = COMPAT_TIERS.TIER_3_SYNC_ADAPT
    } else if (totalCalls > 0) {
      tier = COMPAT_TIERS.TIER_2_MANIFEST_ONLY
    } else {
      tier = COMPAT_TIERS.TIER_1_PURE_FRONTEND
    }

    return {
      manifest: manifestResult,
      apiUsage: {
        totalCalls,
        uniqueApisCount,
        coveredApisCount,
        uncoveredApisCount,
        coveragePercent,
        details: apiUsageDetails
      },
      nodeUsage: {
        totalCount: totalNodeCalls,
        modules: nodeUsageModules
      },
      nativeUsage: {
        hasHeavyNative: nativeModuleItems.length > 0,
        modules: nativeModuleItems
      },
      syncCalls: {
        hasSyncDb,
        hasSyncNode,
        hasSyncDialog,
        totalSyncCount
      },
      servicesScan: {
        hasCustomServices: servicesMethods.size > 0,
        hasWindowExports,
        servicesMethods: Array.from(servicesMethods),
        rendererCalls: Array.from(rendererCalls)
      },
      readinessScore: score,
      tier,
      risks
    }
  }

  private static scanManifest(absDir: string): ScanResult['manifest'] {
    const manifestPath = path.join(absDir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) {
      return {
        valid: false,
        errors: [`未找到 plugin.json: ${manifestPath}`],
        warnings: [],
        raw: null,
        mode: 'unknown',
        featuresCount: 0,
        cmdsCount: 0
      }
    }

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const errors: string[] = []
      const warnings: string[] = []

      if (!raw.name && !raw.pluginName) {
        errors.push('缺少 name 或 pluginName')
      }

      let mode: ScanResult['manifest']['mode'] = 'standard-web'
      if (!raw.main && raw.preload) {
        mode = 'template-list'
      }

      const features = Array.isArray(raw.features) ? raw.features : []
      let cmdsCount = 0
      for (const f of features) {
        if (Array.isArray(f.cmds)) {
          cmdsCount += f.cmds.length
        }
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        raw,
        name: raw.pluginName || raw.name,
        version: raw.version,
        main: raw.main,
        preload: raw.preload,
        mode,
        featuresCount: features.length,
        cmdsCount
      }
    } catch (e: any) {
      return {
        valid: false,
        errors: [`plugin.json 解析失败: ${e.message}`],
        warnings: [],
        raw: null,
        mode: 'unknown',
        featuresCount: 0,
        cmdsCount: 0
      }
    }
  }

  private static scanUtoolsApis(
    content: string,
    lines: string[],
    relPath: string,
    map: Map<string, Array<{ file: string; line: number }>>
  ) {
    const regex = /\butools\.([a-zA-Z0-9_$.]+)/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(content)) !== null) {
      const fullCall = `utools.${match[1]}`
      // 提取前两段 (例如 utools.db.get 或 utools.hideMainWindow)
      let matchedApi = fullCall
      for (const knownApi of Object.keys(UTOOLS_API_KNOWLEDGE)) {
        if (fullCall.startsWith(knownApi)) {
          matchedApi = knownApi
          break
        }
      }

      // 计算行号
      const offset = match.index
      let currentLen = 0
      let lineNum = 1
      for (let i = 0; i < lines.length; i++) {
        currentLen += lines[i].length + 1
        if (currentLen > offset) {
          lineNum = i + 1
          break
        }
      }

      if (!map.has(matchedApi)) {
        map.set(matchedApi, [])
      }
      map.get(matchedApi)!.push({ file: relPath, line: lineNum })
    }
  }

  private static scanNodeModules(
    content: string,
    lines: string[],
    relPath: string,
    map: Map<string, Array<{ file: string; line: number }>>
  ) {
    const requireRegex = /require\s*\(\s*['"]([a-zA-Z0-9_\-\/]+)['"]\s*\)/g
    const importRegex = /import\s+.*?from\s+['"]([a-zA-Z0-9_\-\/]+)['"]/g

    const scanMatches = (regex: RegExp) => {
      let m: RegExpExecArray | null
      while ((m = regex.exec(content)) !== null) {
        const modName = m[1].replace(/^node:/, '')
        if (NODE_BUILTIN_MODULES.has(modName)) {
          const offset = m.index
          let currentLen = 0
          let lineNum = 1
          for (let i = 0; i < lines.length; i++) {
            currentLen += lines[i].length + 1
            if (currentLen > offset) {
              lineNum = i + 1
              break
            }
          }

          if (!map.has(modName)) {
            map.set(modName, [])
          }
          map.get(modName)!.push({ file: relPath, line: lineNum })
        }
      }
    }

    scanMatches(requireRegex)
    scanMatches(importRegex)
  }

  private static scanServicesAndExports(
    content: string,
    servicesMethods: Set<string>,
    rendererCalls: Set<string>
  ) {
    // 挂载点: window.services.xxx = ...
    const serviceDefRegex = /window\.services\.([a-zA-Z0-9_]+)\s*=/g
    let m: RegExpExecArray | null
    while ((m = serviceDefRegex.exec(content)) !== null) {
      servicesMethods.add(m[1])
    }

    // 调用点: window.services.xxx(...)
    const serviceCallRegex = /window\.services\.([a-zA-Z0-9_]+)\s*\(/g
    while ((m = serviceCallRegex.exec(content)) !== null) {
      rendererCalls.add(m[1])
    }
  }

  private static findCodeFiles(dir: string, baseDir: string = dir): string[] {
    const results: string[] = []
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.ztools-backups') {
        continue
      }
      const fullPath = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        results.push(...this.findCodeFiles(fullPath, baseDir))
      } else if (ent.isFile()) {
        results.push(fullPath)
      }
    }

    return results
  }
}
