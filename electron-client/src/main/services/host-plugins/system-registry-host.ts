import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readSystemAvailableMemoryBytes } from '../../platform/macos/memory.js'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  PROTECTED_PROCESS_NAMES,
  formatBytes,
  isForbiddenRegistryPath,
  isProtectedSystemPath,
  resolveHostSystemCommands,
  type HostPluginContext,
  type HostSystemCommands,
  escapePsSingleQuoted,
  PowerShellError
} from './shared-utils.js'

/** 系统与注册表处理器的系统依赖：生产用真实实现，测试经构造参数注入替身（插件调用参数无法切换） */
export interface SystemRegistryHostDeps extends HostSystemCommands {
  /** 向进程发送结束信号；失败时抛出带 code（EPERM / ESRCH 等）的错误，语义同 process.kill */
  killProcess: (pid: number) => void
  /** 启动常驻子进程（防休眠保持进程）；语义同 child_process.spawn，失败经返回进程的 error 事件报告 */
  spawnProcess: typeof spawn
}

export class SystemRegistryHostPluginHandler {
  readonly #ctx: HostPluginContext
  readonly #sys: HostSystemCommands
  readonly #killProcess: (pid: number) => void
  readonly #spawnProcess: typeof spawn

  constructor(ctx: HostPluginContext, deps: Partial<SystemRegistryHostDeps> = {}) {
    this.#ctx = ctx
    this.#sys = resolveHostSystemCommands(deps)
    this.#killProcess = deps.killProcess ?? ((pid) => { process.kill(pid) })
    this.#spawnProcess = deps.spawnProcess ?? spawn
  }

  /**
   * PowerShell 函数：判断捕获到的错误是否为拒绝访问（注册表写 HKLM、受保护文件等）。
   * 按异常类型判断（含内层异常），不依赖本地化的错误文本。
   */
  static readonly #PS_IS_ACCESS_DENIED = `function Test-ZToolsAccessDenied($record) {
          $x = $record.Exception
          while ($x) {
            if ($x -is [System.UnauthorizedAccessException] -or $x -is [System.Security.SecurityException]) { return $true }
            $x = $x.InnerException
          }
          return $false
        }`

  /** runPowerShell 抛出的错误转成结构化失败：超时为 *_TIMEOUT、取消为 CANCELLED，错误文本以错误码开头（插件桥接层失败时只转发 error 文本） */
  static #psFailure(err: unknown, errorCode: string, label: string): { ok: false; success: false; errorCode: string; error: string } {
    const exitCode = err instanceof PowerShellError ? err.exitCode : undefined
    const code = exitCode === 124
      ? (errorCode.endsWith('_FAILED') ? errorCode.replace(/_FAILED$/, '_TIMEOUT') : 'TIMEOUT')
      : exitCode === 130 ? 'CANCELLED' : errorCode
    return { ok: false, success: false, errorCode: code, error: `${code}: ${label}：${err instanceof Error ? err.message : String(err)}` }
  }

  /** 脚本以状态标记结尾：取最后一个非空行（前面可能有 Add-Type 等命令的输出） */
  static #lastStatusLine(out: string): string {
    const lines = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    return lines.at(-1) ?? ''
  }

  /**
   * 右键菜单项键路径：Software\Classes 下 *、Directory、Directory\Background、Drive 的 shell\<项>（只允许一层，不能是 . 或 ..）。
   * 删除只允许当前用户（HKCU）；启用 / 禁用还允许扫描列出的系统级（HKLM）项。
   */
  static #isContextMenuShellKey(normalizedPath: string, allowHklm: boolean): boolean {
    const hive = allowHklm ? '(?:HKEY_CURRENT_USER|HKEY_LOCAL_MACHINE)' : 'HKEY_CURRENT_USER'
    const m = new RegExp(`^${hive}\\\\Software\\\\Classes\\\\(?:\\*|Directory|Directory\\\\Background|Drive)\\\\shell\\\\([^\\\\]+)$`, 'i').exec(normalizedPath)
    return Boolean(m?.[1]) && !/^[.\s]+$/.test(m![1]!) && !/[\0\r\n]/.test(normalizedPath) && !isForbiddenRegistryPath(normalizedPath)
  }

  async handleContextMenu(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'list' ||
      lowerFn === 'scanentries' ||
      lowerFn === 'getitems' ||
      lowerFn === 'scan' ||
      lowerFn === 'getcontextmenuitems'
    ) {
      const items: Array<Record<string, unknown>> = []

      if (process.platform === 'win32') {
        // 「所有文件」的键名就是 *：一律用 -LiteralPath，否则 -Path 会把它当通配符，枚举出所有文件类型的 shell 子键
        const psScript = `
          $roots = @(
            @{ Scope = 'file'; ScopeLabel = '所有文件 (*)'; Path = 'HKCU:\\Software\\Classes\\*\\shell' },
            @{ Scope = 'directory'; ScopeLabel = '文件夹 (Directory)'; Path = 'HKCU:\\Software\\Classes\\Directory\\shell' },
            @{ Scope = 'background'; ScopeLabel = '桌面背景 (Background)'; Path = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell' },
            @{ Scope = 'file'; ScopeLabel = '所有文件 (*)'; Path = 'HKLM:\\Software\\Classes\\*\\shell' },
            @{ Scope = 'directory'; ScopeLabel = '文件夹 (Directory)'; Path = 'HKLM:\\Software\\Classes\\Directory\\shell' }
          )
          $results = @()
          foreach ($r in $roots) {
            if (Test-Path -LiteralPath $r.Path) {
              Get-ChildItem -LiteralPath $r.Path -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object {
                $keyPath = $_.PSPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', ''
                $muiverb = (Get-ItemProperty -LiteralPath $_.PSPath -Name 'MUIVerb' -ErrorAction SilentlyContinue).MUIVerb
                $defaultVal = (Get-ItemProperty -LiteralPath $_.PSPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
                $icon = (Get-ItemProperty -LiteralPath $_.PSPath -Name 'Icon' -ErrorAction SilentlyContinue).Icon
                $legacyDisable = $null -ne (Get-ItemProperty -LiteralPath $_.PSPath -Name 'LegacyDisable' -ErrorAction SilentlyContinue).LegacyDisable
                $cmdPath = "$($_.PSPath)\\command"
                $cmdVal = ''
                if (Test-Path -LiteralPath $cmdPath) {
                  $cmdVal = (Get-ItemProperty -LiteralPath $cmdPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
                }
                $results += [PSCustomObject]@{
                  id = $keyPath
                  name = if ($muiverb) { $muiverb } elseif ($defaultVal) { $defaultVal } else { $_.PSChildName }
                  keyName = $_.PSChildName
                  scope = $r.Scope
                  scopeLabel = $r.ScopeLabel
                  regPath = $keyPath
                  keyPath = $keyPath
                  command = if ($cmdVal) { $cmdVal } else { '' }
                  icon = if ($icon) { $icon } else { '' }
                  enabled = (-not $legacyDisable)
                }
              }
            }
          }
          $results | ConvertTo-Json -Compress
        `
        // 扫描失败或输出无法解析如实报错，不能当成“没有右键菜单项”
        let raw: string
        try {
          raw = await this.#sys.runPowerShell(psScript, 12_000, signal)
        } catch (err) {
          return SystemRegistryHostPluginHandler.#psFailure(err, 'SCAN_FAILED', '读取右键菜单失败')
        }
        if (raw.trim()) {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { ok: false, success: false, errorCode: 'SCAN_FAILED', error: 'SCAN_FAILED: 右键菜单扫描结果格式无效' }
          }
          const list = Array.isArray(parsed) ? parsed : [parsed]
          for (const entry of list) {
            if (entry && typeof entry === 'object') {
              const rec = entry as Record<string, unknown>
              const rawScope = String(rec.scope ?? 'file').toLowerCase()
              const normalizedScope: 'file' | 'directory' | 'background' =
                rawScope.includes('background') || rawScope.includes('背景')
                  ? 'background'
                  : rawScope.includes('directory') || rawScope.includes('文件夹')
                    ? 'directory'
                    : 'file'
              const scopeLabel =
                typeof rec.scopeLabel === 'string' && rec.scopeLabel
                  ? rec.scopeLabel
                  : normalizedScope === 'background'
                    ? '桌面背景 (Background)'
                    : normalizedScope === 'directory'
                      ? '文件夹 (Directory)'
                      : '所有文件 (*)'
              items.push({
                ...rec,
                scope: normalizedScope,
                scopeLabel,
                keyPath: rec.keyPath ?? rec.regPath
              })
            }
          }
        }
      }

      return { ok: true, success: true, items, entries: items }
    }

    if (
      lowerFn === 'toggleentry' ||
      lowerFn === 'toggle' ||
      lowerFn === 'setenabled' ||
      lowerFn === 'enable' ||
      lowerFn === 'disable'
    ) {
      const regPath = String(params.regPath ?? params.keyPath ?? params.id ?? '').trim()
      const enabled =
        lowerFn === 'enable' ? true : lowerFn === 'disable' ? false : Boolean(params.enabled)
      if (!regPath || process.platform !== 'win32') {
        return { ok: false, success: false, error: '无效的注册表路径或非 Windows 平台' }
      }
      if (isForbiddenRegistryPath(regPath)) {
        return { ok: false, success: false, error: '安全策略拦截：禁止修改系统敏感注册表路径' }
      }
      const normalizedRegPath = regPath
        .replace(/^HKCU:\\?/i, 'HKEY_CURRENT_USER\\')
        .replace(/^HKLM:\\?/i, 'HKEY_LOCAL_MACHINE\\')
      // 只允许扫描列出的右键菜单项（HKCU / HKLM 下 *、Directory、Directory\Background、Drive 的 shell\<项>），不能借此改任意注册表键
      if (!SystemRegistryHostPluginHandler.#isContextMenuShellKey(normalizedRegPath, true)) {
        return { ok: false, success: false, errorCode: 'INVALID_REG_PATH', error: 'INVALID_REG_PATH: 只能启用或禁用右键菜单 shell 下的菜单项' }
      }
      const psRegPath = `Registry::${escapePsSingleQuoted(normalizedRegPath)}`
      // 键名 * 必须用 -LiteralPath（否则会通配到其他文件类型的同名项）；先判断 LegacyDisable 是否存在，修改后读回确认，
      // 拒绝访问（HKLM 项需要管理员权限）单独报告，其他错误抛出由退出码如实反映
      const script = `
        $ErrorActionPreference = 'Stop'
        ${SystemRegistryHostPluginHandler.#PS_IS_ACCESS_DENIED}
        $p = '${psRegPath}'
        if (-not (Test-Path -LiteralPath $p)) { Write-Output 'KEY_NOT_FOUND'; exit 0 }
        $wantDisabled = ${enabled ? '$false' : '$true'}
        try {
          $has = $null -ne (Get-ItemProperty -LiteralPath $p -Name 'LegacyDisable' -ErrorAction SilentlyContinue)
          if ($wantDisabled -and -not $has) {
            Set-ItemProperty -LiteralPath $p -Name 'LegacyDisable' -Value '' -ErrorAction Stop
          } elseif (-not $wantDisabled -and $has) {
            Remove-ItemProperty -LiteralPath $p -Name 'LegacyDisable' -ErrorAction Stop
          }
        } catch {
          if (Test-ZToolsAccessDenied $_) { Write-Output 'ACCESS_DENIED'; exit 0 }
          throw
        }
        $now = $null -ne (Get-ItemProperty -LiteralPath $p -Name 'LegacyDisable' -ErrorAction SilentlyContinue)
        if ($now -eq $wantDisabled) { Write-Output 'OK' } else { Write-Output 'VERIFY_FAILED' }
        exit 0
      `
      const base = { regPath: normalizedRegPath, keyPath: normalizedRegPath, enabled }
      let out: string
      try {
        out = await this.#sys.runPowerShell(script, 8_000, signal)
      } catch (err) {
        return { ...base, ...SystemRegistryHostPluginHandler.#psFailure(err, 'TOGGLE_FAILED', '修改右键菜单启用状态失败') }
      }
      const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
      if (status === 'OK') return { ok: true, success: true, ...base }
      const failure: Record<string, { errorCode: string; error: string }> = {
        ACCESS_DENIED: { errorCode: 'ADMIN_REQUIRED', error: 'ADMIN_REQUIRED: 修改该右键菜单项需要管理员权限，请以管理员身份运行 ZTools 后重试' },
        KEY_NOT_FOUND: { errorCode: 'ITEM_NOT_FOUND', error: 'ITEM_NOT_FOUND: 右键菜单项不存在，可能已被删除' },
        VERIFY_FAILED: { errorCode: 'VERIFY_FAILED', error: 'VERIFY_FAILED: 已执行修改，但读回的启用状态与预期不符' }
      }
      return { ok: false, success: false, ...base, ...(failure[status] ?? { errorCode: 'TOGGLE_FAILED', error: `TOGGLE_FAILED: 修改右键菜单启用状态未得到确认（输出：${out.trim().slice(0, 200) || '空'}）` }) }
    }

    if (lowerFn === 'switchwin11classic' || lowerFn === 'togglewin11classic') {
      if (process.platform !== 'win32') {
        return { ok: false, success: false, error: '仅 Windows 平台支持切换 Win11 经典右键菜单' }
      }
      const clsidKey = 'HKCU\\Software\\Classes\\CLSID\\{86ca1aa0-34aa-4e8b-a509-50c905bae2a2}'
      const inprocKey = `${clsidKey}\\InprocServer32`
      let enableClassic: boolean
      if (typeof params.classic === 'boolean') {
        enableClassic = params.classic
      } else if (typeof params.enabled === 'boolean') {
        enableClassic = params.enabled
      } else {
        const queryRes = await this.#sys.runCommand('reg', ['query', inprocKey], 5_000, signal)
        enableClassic = queryRes.exitCode !== 0
      }

      if (enableClassic) {
        const res = await this.#sys.runCommand(
          'reg',
          ['add', inprocKey, '/ve', '/t', 'REG_SZ', '/d', '', '/f'],
          8_000,
          signal
        )
        const ok = res.exitCode === 0
        return {
          ok,
          success: ok,
          classic: true,
          output: res.stdout || res.stderr,
          ...(ok ? {} : { error: res.stderr || res.stdout || '写入经典右键菜单注册表项失败' })
        }
      } else {
        const queryRes = await this.#sys.runCommand('reg', ['query', clsidKey], 5_000, signal)
        if (queryRes.exitCode !== 0) {
          return { ok: true, success: true, classic: false, output: '当前已是 Win11 默认现代右键菜单' }
        }
        const res = await this.#sys.runCommand('reg', ['delete', clsidKey, '/f'], 8_000, signal)
        const ok = res.exitCode === 0
        return {
          ok,
          success: ok,
          classic: false,
          output: res.stdout || res.stderr,
          ...(ok ? {} : { error: res.stderr || res.stdout || '恢复 Win11 默认右键菜单失败' })
        }
      }
    }

    if (lowerFn === 'cleanorphans' || lowerFn === 'removeorphans') {
      if (process.platform !== 'win32') {
        return { ok: false, success: false, error: '仅 Windows 平台支持清理孤儿右键菜单注册表项' }
      }
      const rawTargets = Array.isArray(params.regPaths)
        ? params.regPaths.map(String)
        : Array.isArray(params.keyPaths)
          ? params.keyPaths.map(String)
          : Array.isArray(params.ids)
            ? params.ids.map(String)
            : typeof params.regPath === 'string'
              ? [params.regPath]
              : typeof params.id === 'string'
                ? [params.id]
                : []
      if (rawTargets.length === 0) {
        return { ok: false, success: false, error: '未提供待清理的孤儿注册表路径列表' }
      }
      const cleanedPaths: string[] = []
      const errors: Array<{ regPath: string; error: string }> = []

      for (const rawTarget of rawTargets) {
        const normalized = rawTarget
          .trim()
          .replace(/^HKCU:\\?/i, 'HKEY_CURRENT_USER\\')
          .replace(/^HKEY_CURRENT_USER:\\?/i, 'HKEY_CURRENT_USER\\')
        if (
          !normalized.toUpperCase().startsWith('HKEY_CURRENT_USER\\SOFTWARE\\CLASSES\\') ||
          isForbiddenRegistryPath(normalized)
        ) {
          errors.push({
            regPath: rawTarget,
            error: '安全策略拦截：仅允许清理 HKCU\\Software\\Classes\\ 下的菜单项'
          })
          continue
        }
        const regCliPath = normalized.replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\')
        const res = await this.#sys.runCommand('reg', ['delete', regCliPath, '/f'], 8_000, signal)
        if (res.exitCode === 0) {
          cleanedPaths.push(normalized)
        } else {
          errors.push({
            regPath: normalized,
            error: res.stderr || res.stdout || '删除注册表项失败'
          })
        }
      }

      return {
        ok: cleanedPaths.length > 0 && errors.length === 0,
        success: cleanedPaths.length > 0,
        cleanedCount: cleanedPaths.length,
        cleanedPaths,
        errors,
        ...(errors.length > 0 && cleanedPaths.length === 0 ? { error: errors[0]!.error } : {})
      }
    }

    if (lowerFn === 'add' || lowerFn === 'create' || lowerFn === 'additem') {
      const keyName = String(params.keyName ?? params.name ?? '').trim()
      const displayName = String(params.displayName ?? params.name ?? keyName).trim()
      const rawCommand = String(params.command ?? '').trim()
      if (!keyName || !rawCommand || process.platform !== 'win32') {
        return { ok: false, success: false, error: '名称和执行命令不能为空' }
      }
      // 键名白名单：只删 ASCII 单引号时弯引号仍能提前结束 PowerShell 字符串注入命令；. / .. 会被当成上级目录
      if (!/^[\w .()-]{1,64}$/.test(keyName) || /^[. ]+$/.test(keyName)) {
        return { ok: false, success: false, errorCode: 'INVALID_KEY_NAME', error: 'INVALID_KEY_NAME: 菜单键名只能包含字母、数字、下划线、空格、点、括号和连字符（1~64 个字符），显示名称可另行填写' }
      }
      const exeMatch = rawCommand.match(/^"([^"]+)"|^(\S+)/)
      const rawExePath = (exeMatch?.[1] ?? exeMatch?.[2] ?? '').trim()
      if (!rawExePath) {
        return { ok: false, success: false, error: '无法解析命令中的可执行文件路径' }
      }
      const authorizedExe = await this.#ctx.authorizeExistingPath(rawExePath, caller, 'read')
      const command = `"${authorizedExe}" "%1"`
      const targetScope = String(params.scope ?? '*')
      const baseClass =
        targetScope.toLowerCase().includes('background')
          ? 'Directory\\Background\\shell'
          : targetScope.toLowerCase().includes('directory')
            ? 'Directory\\shell'
            : '*\\shell'
      const subKey = `Software\\Classes\\${baseClass}\\${keyName}`
      const regKey = `HKCU:\\${subKey}`
      // 用 .NET 注册表接口按字面路径创建（键名 * 不会被当成通配符，也不会像 New-Item -Force 那样清空已有子键），写入后读回确认
      const script = `
        $ErrorActionPreference = 'Stop'
        ${SystemRegistryHostPluginHandler.#PS_IS_ACCESS_DENIED}
        $sub = '${escapePsSingleQuoted(subKey)}'
        $display = '${escapePsSingleQuoted(displayName)}'
        $command = '${escapePsSingleQuoted(command)}'
        $status = 'WRITE_FAILED'
        $key = $null
        $cmdKey = $null
        try {
          $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($sub)
          $key.SetValue('', $display)
          $cmdKey = $key.CreateSubKey('command')
          $cmdKey.SetValue('', $command)
          if ([string]$key.GetValue('') -ceq $display -and [string]$cmdKey.GetValue('') -ceq $command) { $status = 'OK' } else { $status = 'VERIFY_FAILED' }
        } catch {
          if (Test-ZToolsAccessDenied $_) { $status = 'ACCESS_DENIED' } else { throw }
        } finally {
          if ($cmdKey) { $cmdKey.Close() }
          if ($key) { $key.Close() }
        }
        Write-Output $status
      `
      const base = { regPath: regKey, keyPath: regKey }
      let out: string
      try {
        out = await this.#sys.runPowerShell(script, 8_000, signal)
      } catch (err) {
        return { ...base, ...SystemRegistryHostPluginHandler.#psFailure(err, 'WRITE_FAILED', '写入右键菜单失败') }
      }
      const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
      if (status === 'OK') return { ok: true, success: true, ...base }
      if (status === 'ACCESS_DENIED') return { ok: false, success: false, ...base, errorCode: 'ADMIN_REQUIRED', error: 'ADMIN_REQUIRED: 没有写入该右键菜单注册表项的权限' }
      if (status === 'VERIFY_FAILED') return { ok: false, success: false, ...base, errorCode: 'VERIFY_FAILED', error: 'VERIFY_FAILED: 已写入右键菜单，但读回的内容与预期不符' }
      return { ok: false, success: false, ...base, errorCode: 'WRITE_FAILED', error: `WRITE_FAILED: 写入右键菜单未得到确认（输出：${out.trim().slice(0, 200) || '空'}）` }
    }

    if (lowerFn === 'delete' || lowerFn === 'remove' || lowerFn === 'deleteitem') {
      const regPath = String(params.regPath ?? params.keyPath ?? params.id ?? '').trim()
      const normalized = regPath
        .replace(/^HKCU:\\?/i, 'HKEY_CURRENT_USER\\')
        .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
      // 删除带 -Recurse：路径必须严格是 HKCU 下某个右键菜单项本身，不能是 shell 根、上级类或任意注册表键
      if (!SystemRegistryHostPluginHandler.#isContextMenuShellKey(normalized, false)) {
        return { ok: false, success: false, errorCode: 'INVALID_REG_PATH', error: '出于安全保护，仅允许删除当前用户 (HKCU) 下的自定义右键菜单项' }
      }
      if (process.platform !== 'win32') {
        return { ok: false, success: false, errorCode: 'UNSUPPORTED_PLATFORM', error: '仅 Windows 平台支持删除右键菜单项' }
      }
      const psRegPath = `Registry::${escapePsSingleQuoted(normalized)}`
      // -LiteralPath：所有文件项路径里的 * 不能被当成通配符，否则会递归删除其他文件类型下的同名菜单项
      const script = `
        $ErrorActionPreference = 'Stop'
        ${SystemRegistryHostPluginHandler.#PS_IS_ACCESS_DENIED}
        $p = '${psRegPath}'
        if (-not (Test-Path -LiteralPath $p)) { Write-Output 'KEY_NOT_FOUND'; exit 0 }
        try {
          Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
        } catch {
          if (Test-ZToolsAccessDenied $_) { Write-Output 'ACCESS_DENIED'; exit 0 }
          throw
        }
        if (Test-Path -LiteralPath $p) { Write-Output 'VERIFY_FAILED' } else { Write-Output 'OK' }
        exit 0
      `
      const base = { regPath: normalized, keyPath: normalized }
      let out: string
      try {
        out = await this.#sys.runPowerShell(script, 8_000, signal)
      } catch (err) {
        return { ...base, ...SystemRegistryHostPluginHandler.#psFailure(err, 'DELETE_FAILED', '删除右键菜单项失败') }
      }
      const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
      if (status === 'OK') return { ok: true, success: true, ...base }
      if (status === 'ACCESS_DENIED') return { ok: false, success: false, ...base, errorCode: 'ADMIN_REQUIRED', error: 'ADMIN_REQUIRED: 没有删除该右键菜单项的权限' }
      if (status === 'KEY_NOT_FOUND') return { ok: false, success: false, ...base, errorCode: 'ITEM_NOT_FOUND', error: 'ITEM_NOT_FOUND: 右键菜单项不存在，可能已被删除' }
      if (status === 'VERIFY_FAILED') return { ok: false, success: false, ...base, errorCode: 'VERIFY_FAILED', error: 'VERIFY_FAILED: 已执行删除，但注册表项仍然存在' }
      return { ok: false, success: false, ...base, errorCode: 'DELETE_FAILED', error: `DELETE_FAILED: 删除右键菜单项未得到确认（输出：${out.trim().slice(0, 200) || '空'}）` }
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported ContextMenuPlugin function: ${fn}`
    }
  }

  async handleWeChatMulti(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const candidatePaths = [
      'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'D:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      'D:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'
    ]

    const rawParamPath = String(params.executablePath ?? params.wechatPath ?? params.path ?? '').trim()
    let detectedPath = rawParamPath
    if (!detectedPath || !fsSync.existsSync(detectedPath)) {
      detectedPath = candidatePaths.find((p) => fsSync.existsSync(p)) ?? ''
    }

    // 读取安装路径失败（超时等）不能当成“未安装”：记下原因，随结果如实返回
    let detectWarning = ''
    if (!detectedPath && process.platform === 'win32') {
      // 没装微信时注册表键不存在属于正常情况：取值存进变量后显式 exit 0，
      // 否则最后一条命令写过非终止错误会让 powershell.exe 退出码为 1，runPowerShell 随之抛错
      try {
        const regOut = await this.#sys.runPowerShell(
          `$v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Tencent\\WeChat' -Name 'InstallPath' -ErrorAction SilentlyContinue).InstallPath
          if ($v) { Write-Output $v }
          exit 0`,
          5_000,
          signal
        )
        if (regOut.trim()) {
          const exe = path.join(regOut.trim(), 'WeChat.exe')
          if (fsSync.existsSync(exe)) detectedPath = exe
        }
      } catch (err) {
        detectWarning = `读取微信安装路径失败：${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (
      lowerFn === 'getstatus' ||
      lowerFn === 'scaninstances' ||
      lowerFn === 'detect' ||
      lowerFn === 'listinstances'
    ) {
      const instances: Array<Record<string, unknown>> = []
      if (process.platform === 'win32') {
        // 只运行了其中一个进程名（或都没运行）时 Get-Process 会写非终止错误：结果先存变量，最后单独输出 JSON，
        // 退出码才只反映真正的失败（读取超时、脚本异常等）
        const ps = `
          $procs = @(Get-Process -Name 'WeChat','Weixin' -ErrorAction SilentlyContinue)
          $list = @($procs | ForEach-Object {
            $wsBytes = [int64]$_.WorkingSet64
            $memMB = [math]::Round($wsBytes / 1MB, 1)
            [PSCustomObject]@{
              pid = $_.Id
              name = $_.ProcessName
              memoryMB = $memMB
              memoryBytes = $wsBytes
              workingSetBytes = $wsBytes
              startTime = if ($_.StartTime) { $_.StartTime.ToString('HH:mm:ss') } else { '' }
            }
          })
          ConvertTo-Json -InputObject $list -Compress
        `
        let raw: string
        try {
          raw = await this.#sys.runPowerShell(ps, 6_000, signal)
        } catch (err) {
          return SystemRegistryHostPluginHandler.#psFailure(err, 'DETECT_FAILED', '读取微信进程失败，不能判断运行实例数')
        }
        if (raw.trim()) {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { ok: false, success: false, errorCode: 'DETECT_FAILED', error: 'DETECT_FAILED: 微信进程列表格式无效，不能判断运行实例数' }
          }
          const list = Array.isArray(parsed) ? parsed : [parsed]
          for (const item of list) {
            if (item && typeof item === 'object') {
              const rec = item as Record<string, unknown>
              const memoryMB = Number(rec.memoryMB ?? 0)
              const computedBytes =
                typeof rec.memoryBytes === 'number' && rec.memoryBytes > 0
                  ? rec.memoryBytes
                  : Math.round(memoryMB * 1024 * 1024)
              instances.push({
                ...rec,
                memoryMB,
                memoryBytes: computedBytes,
                workingSetBytes: computedBytes
              })
            }
          }
        }
      }
      return {
        ok: true,
        success: true,
        installed: Boolean(detectedPath),
        wechatPath: detectedPath,
        installPath: detectedPath,
        runningCount: instances.length,
        instances,
        ...(detectWarning ? { partial: true, warning: detectWarning } : {})
      }
    }

    if (
      lowerFn === 'launch' ||
      lowerFn === 'launchinstance' ||
      lowerFn === 'openmultiple' ||
      lowerFn === 'startinstances'
    ) {
      const count = Math.min(Math.max(Number(params.count) || 1, 1), 5)
      if (!detectedPath || !fsSync.existsSync(detectedPath)) {
        return {
          ok: false,
          success: false,
          errorCode: 'WECHAT_NOT_FOUND',
          error: `未检测到本地微信安装路径 (WeChat.exe)，请在设置或参数中指定路径${detectWarning ? `（${detectWarning}）` : ''}`
        }
      }
      const resolvedExe = rawParamPath
        ? await this.#ctx.authorizeExistingPath(rawParamPath, caller, 'read')
        : detectedPath
      const pids: number[] = []
      for (let i = 0; i < count; i++) {
        const child = spawn(resolvedExe, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false
        })
        if (child.pid) pids.push(child.pid)
        child.unref()
      }
      return {
        ok: true,
        success: true,
        launchedCount: pids.length,
        pids,
        wechatPath: resolvedExe,
        installPath: resolvedExe
      }
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported WeChatMultiPlugin function: ${fn}`
    }
  }

  async handleFlowGuard(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'getconnections' || lowerFn === 'scan' || lowerFn === 'listconnections' || lowerFn === 'getstatus') {
      const connections: Array<Record<string, unknown>> = []

      if (process.platform === 'win32') {
        const netstat = await this.#sys.runCommand('netstat', ['-ano', '-p', 'tcp'], 8_000, signal)
        const procMap = new Map<number, string>()
        const tasklist = await this.#sys.runCommand('tasklist', ['/FO', 'CSV', '/NH'], 8_000, signal)
        for (const line of tasklist.stdout.split(/\r?\n/)) {
          const m = line.match(/^"([^"]+)","(\d+)"/)
          if (m?.[1] && m[2]) {
            procMap.set(Number(m[2]), m[1])
          }
        }

        const lines = netstat.stdout.split(/\r?\n/)
        for (const line of lines) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 5 || (parts[0] ?? '').toUpperCase() !== 'TCP') continue
          const localAddr = parts[1] ?? ''
          const remoteAddr = parts[2] ?? ''
          const state = parts[3] ?? ''
          const pid = Number(parts[4] ?? 0)
          if (!pid) continue
          const processName = procMap.get(pid) || `PID:${pid}`
          connections.push({
            id: `${pid}-${localAddr}-${remoteAddr}`,
            pid,
            processName,
            localAddress: localAddr,
            remoteAddress: remoteAddr,
            state,
            isExternal: !remoteAddr.startsWith('127.') && !remoteAddr.startsWith('0.0.0.0') && !remoteAddr.startsWith('[::')
          })
          if (connections.length >= 120) break
        }
      }

      return {
        ok: true,
        success: true,
        totalConnections: connections.length,
        establishedCount: connections.filter((c) => c.state === 'ESTABLISHED').length,
        connections
      }
    }

    if (lowerFn === 'killprocess' || lowerFn === 'terminate') {
      const pid = Number(params.pid)
      if (!pid || pid <= 4 || pid === process.pid) {
        return { ok: false, success: false, error: '无效或受保护的系统进程 PID' }
      }
      if (process.platform === 'win32') {
        const tasklist = await this.#sys.runCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5_000, signal)
        const m = tasklist.stdout.match(/^"([^"]+)"/)
        const procName = (m?.[1] ?? '').toLowerCase()
        if (PROTECTED_PROCESS_NAMES.has(procName)) {
          return { ok: false, success: false, error: `安全拦截：禁止终止系统关键进程 (${procName})` }
        }
      }
      try {
        this.#killProcess(pid)
        return { ok: true, success: true, pid }
      } catch (err) {
        return { ok: false, success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return this.handleFlowGuard('getConnections', params, signal)
  }

  async handleBoost(
    fn: string,
    _params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const totalMem = os.totalmem()
    const freeMemBefore = await readSystemAvailableMemoryBytes(process.platform, { fresh: true })
    const usedPercentBefore = Math.round(((totalMem - freeMemBefore) / totalMem) * 100)

    if (lowerFn === 'getstatus' || lowerFn === 'inspect' || lowerFn === 'scan') {
      const topProcesses: Array<Record<string, unknown>> = []
      let topProcessesWarning = ''
      if (process.platform === 'win32') {
        // 个别进程读取失败只写非终止错误：结果存变量后最后单独输出，退出码才只反映真正的失败
        const ps = `
          $procs = @(Get-Process -ErrorAction SilentlyContinue)
          $list = @($procs | Sort-Object WorkingSet64 -Descending | Select-Object -First 25 | ForEach-Object {
            [PSCustomObject]@{
              pid = $_.Id
              name = $_.ProcessName
              memoryBytes = $_.WorkingSet64
              memoryText = "$([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
            }
          })
          ConvertTo-Json -InputObject $list -Compress
        `
        // 内存数字来自系统接口照常返回；进程排行读取失败时标记 partial 并说明，不能让空列表看起来像“没有进程”
        try {
          const raw = await this.#sys.runPowerShell(ps, 8_000, signal)
          if (raw.trim()) {
            const parsed: unknown = JSON.parse(raw)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (item && typeof item === 'object') {
                topProcesses.push(item as Record<string, unknown>)
              }
            }
          }
        } catch (err) {
          topProcessesWarning = `读取进程内存排行失败：${err instanceof Error ? err.message : String(err)}`
        }
      }

      return {
        ok: true,
        success: true,
        totalMemoryBytes: totalMem,
        totalMemoryText: formatBytes(totalMem),
        freeMemoryBytes: freeMemBefore,
        freeMemoryText: formatBytes(freeMemBefore),
        usedPercent: usedPercentBefore,
        cpuCount: os.cpus().length,
        uptimeSeconds: Math.floor(os.uptime()),
        topProcesses,
        ...(topProcessesWarning ? { partial: true, warning: topProcessesWarning } : {})
      }
    }

    // 开机启动项由启动管理（StartupManagerPlugin）统一处理，这里不再保留另一份有缺陷的实现

    if (lowerFn === 'optimize' || lowerFn === 'boost' || lowerFn === 'cleanmemory' || lowerFn === 'cleantemp') {
      let tempCleanedBytes = 0
      let tempCleanedCount = 0
      const tmpDir = os.tmpdir()
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      try {
        const entries = await fs.readdir(tmpDir, { withFileTypes: true })
        for (const entry of entries.slice(0, 150)) {
          if (!entry.isFile()) continue
          const fullPath = path.join(tmpDir, entry.name)
          try {
            const stat = await fs.stat(fullPath)
            if (stat.mtimeMs < cutoff) {
              await fs.unlink(fullPath)
              tempCleanedBytes += stat.size
              tempCleanedCount += 1
            }
          } catch {
            // ignore locked temp files
          }
        }
      } catch {
        // ignore
      }

      if (typeof global.gc === 'function') {
        try {
          global.gc()
        } catch {
          // ignore
        }
      }

      const freeMemAfter = await readSystemAvailableMemoryBytes(process.platform, { fresh: true })
      const freedMemoryBytes = Math.max(0, freeMemAfter - freeMemBefore)
      return {
        ok: true,
        success: true,
        freedMemoryBytes,
        freedMemoryText: formatBytes(freedMemoryBytes),
        tempCleanedBytes,
        tempCleanedText: formatBytes(tempCleanedBytes),
        tempCleanedCount,
        freeMemoryBytes: freeMemAfter,
        freeMemoryText: formatBytes(freeMemAfter),
        usedPercent: Math.round(((totalMem - freeMemAfter) / totalMem) * 100)
      }
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported BoostPlugin function: ${fn}`
    }
  }

  // 硬件信息 (HardwareInfoPlugin)：旧接口在 Windows 上只查 C/D/E 三个盘符且吞掉读取错误、CPU 负载取开机以来平均值并至少报 1%、
  // 把 ACPI 热区温度当 CPU 温度、读不到时填 'Unknown CPU' / 0 MHz。新版插件改用 system_get_hardware_summary、system_get_cpu_usage、
  // system_get_memory_usage、system_list_volumes、system_get_battery_status、screen_get_all_displays 等通用接口（逐项报告失败原因）。
  async handleHardwareInfo(_fn: string, _signal?: AbortSignal): Promise<unknown> {
    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: '请更新硬件信息插件，通过新版接口读取硬件信息'
    }
  }

  async handleSoftwareManager(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'uninstall' || lowerFn === 'uninstallsoftware' || lowerFn === 'removeapp') {
      const rawUninstallCmd = String(
        params.quietUninstallString ?? params.uninstallString ?? params.installLocation ?? params.path ?? params.uninstallPath ?? ''
      ).trim()
      if (!rawUninstallCmd) {
        return { ok: false, success: false, error: '未提供待清理的软件残余目录或卸载程序路径' }
      }
      if (/^msiexec(?:.exe)?\s+/i.test(rawUninstallCmd)) {
        if (params.dryRun !== true && process.platform === 'win32') {
          const msiArgs = rawUninstallCmd.replace(/^msiexec(?:.exe)?\s+/i, '').trim().split(/\s+/)
          const child = spawn('msiexec.exe', msiArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          })
          child.on('error', () => undefined)
          child.unref()
        }
        return { ok: true, success: true, launchedUninstaller: rawUninstallCmd, removedPath: rawUninstallCmd }
      }
      const quotedMatch = rawUninstallCmd.match(/^"([^"]+)"(?:\s+(.*))?$/)
      const cleanCandidate = quotedMatch ? quotedMatch[1]!.trim() : rawUninstallCmd.replace(/\s+\/[a-zA-Z0-9_-]+.*$/, '').trim()
      const extraArgs = quotedMatch && quotedMatch[2]
        ? quotedMatch[2].trim().split(/\s+/).filter(Boolean)
        : rawUninstallCmd.slice(cleanCandidate.length).trim().split(/\s+/).filter(Boolean)

      if (isProtectedSystemPath(path.resolve(cleanCandidate))) {
        return { ok: false, success: false, error: '系统核心路径或用户主目录受保护，禁止移除' }
      }
      const resolved = await this.#ctx.authorizeExistingPath(cleanCandidate, caller, 'write')
      if (isProtectedSystemPath(resolved)) {
        return { ok: false, success: false, error: '系统核心路径或用户主目录受保护，禁止移除' }
      }
      if (/\.(?:exe|msi)$/i.test(resolved)) {
        if (params.dryRun !== true) {
          const child = spawn(resolved, extraArgs, {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          })
          child.on('error', () => undefined)
          child.unref()
        }
        return { ok: true, success: true, launchedUninstaller: resolved, removedPath: resolved }
      }
      // 软件残余目录同样走回收站：没有回收站或超过容量时拒绝并保留目录，绝不永久删除
      const trashRes = await this.#moveTargetToTrash(resolved, signal)
      if (!trashRes.ok) {
        return { ok: false, success: false, errorCode: trashRes.errorCode ?? 'TRASH_FAILED', error: trashRes.error ?? '移入回收站失败' }
      }
      return { ok: true, success: true, removedPath: resolved }
    }

    if (lowerFn === 'cleanresiduals' || lowerFn === 'cleanresidual') {
      const rawPaths = Array.isArray(params.paths)
        ? params.paths.map(String)
        : Array.isArray(params.residualPaths)
          ? params.residualPaths.map(String)
          : typeof params.path === 'string'
            ? [params.path]
            : []
      if (rawPaths.length === 0) {
        return { ok: false, success: false, error: '未提供待清理的残留文件路径列表 (paths)' }
      }
      let freedBytes = 0
      const cleanedPaths: string[] = []
      const errors: Array<{ path: string; error: string }> = []

      for (const rawPath of rawPaths) {
        try {
          const resolved = await this.#ctx.authorizeExistingPath(rawPath.trim(), caller, 'write')
          if (isProtectedSystemPath(resolved)) {
            errors.push({ path: resolved, error: '系统核心路径受保护，禁止清理' })
            continue
          }
          const stat = await fs.lstat(resolved)
          let bytes = 0
          if (stat.isFile()) {
            bytes = stat.size
          } else if (stat.isDirectory()) {
            const entries = await fs.readdir(resolved, { withFileTypes: true }).catch(() => [])
            for (const entry of entries) {
              if (entry.isFile()) {
                const s = await fs.stat(path.join(resolved, entry.name)).catch(() => null)
                if (s) bytes += s.size
              }
            }
          }
          await fs.rm(resolved, { recursive: true, force: true })
          freedBytes += bytes
          cleanedPaths.push(resolved)
        } catch (err) {
          errors.push({ path: rawPath, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        ok: cleanedPaths.length > 0 && errors.length === 0,
        success: cleanedPaths.length > 0,
        cleanedCount: cleanedPaths.length,
        freedBytes,
        freedText: formatBytes(freedBytes),
        cleanedPaths,
        errors,
        ...(errors.length > 0 && cleanedPaths.length === 0 ? { error: errors[0]!.error } : {})
      }
    }

    if (
      lowerFn === 'list' ||
      lowerFn === 'getapps' ||
      lowerFn === 'scan' ||
      lowerFn === 'listinstalled' ||
      lowerFn === 'getinstalledapps' ||
      lowerFn === 'scaninstalledapps' ||
      lowerFn === 'getsoftwarelist'
    ) {
      const apps: Array<Record<string, unknown>> = []
      const seenNames = new Set<string>()

      if (process.platform === 'win32' && params.skipRegistryScan !== true) {
        // 这里的 * 是有意的通配（枚举所有卸载项）。个别卸载项损坏只写非终止错误：结果存变量后最后单独输出 JSON，
        // 否则最后一条管道带过错误会让 powershell.exe 退出码为 1，runPowerShell 抛错导致整个列表失败
        const ps = `
          $ErrorActionPreference = 'SilentlyContinue'
          $paths = @(
            'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
          )
          $list = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and ($_.UninstallString -or $_.InstallLocation) -and $_.SystemComponent -ne 1 } |
            Select-Object -First 150 DisplayName, DisplayVersion, Publisher, InstallDate, EstimatedSize, InstallLocation, UninstallString, QuietUninstallString, PSChildName)
          ConvertTo-Json -InputObject $list -Compress
        `
        let raw: string
        try {
          raw = await this.#sys.runPowerShell(ps, 8_000, signal)
        } catch (err) {
          return SystemRegistryHostPluginHandler.#psFailure(err, 'SCAN_FAILED', '读取已安装软件列表失败')
        }
        if (raw.trim()) {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { ok: false, success: false, errorCode: 'SCAN_FAILED', error: 'SCAN_FAILED: 已安装软件列表格式无效' }
          }
          const list = Array.isArray(parsed) ? parsed : [parsed]
          for (const item of list) {
            if (!item || typeof item !== 'object') continue
            const rec = item as Record<string, unknown>
            const name = String(rec.DisplayName ?? '').trim()
            if (!name) continue
            const dedupKey = name.toLowerCase()
            if (seenNames.has(dedupKey)) continue
            seenNames.add(dedupKey)
            const estKb = Number(rec.EstimatedSize ?? 0)
            const sizeBytes = Number.isFinite(estKb) && estKb > 0 ? Math.round(estKb * 1024) : 0
            const installLocation = String(rec.InstallLocation ?? '').trim()
            const uninstallString = String(rec.UninstallString ?? '').trim()
            const quietUninstallString = String(rec.QuietUninstallString ?? '').trim()
            const rawDate = String(rec.InstallDate ?? '').trim()
            const formattedDate =
              /^\d{8}$/.test(rawDate)
                ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
                : rawDate || undefined
            apps.push({
              id: crypto
                .createHash('md5')
                .update(String(rec.PSChildName || name))
                .digest('hex')
                .slice(0, 10),
              name,
              version: String(rec.DisplayVersion ?? '').trim() || '未知版本',
              publisher: String(rec.Publisher ?? '').trim() || '未知发布者',
              path: installLocation || uninstallString,
              installLocation,
              uninstallString,
              ...(quietUninstallString ? { quietUninstallString } : {}),
              sizeBytes,
              sizeText: formatBytes(sizeBytes),
              ...(formattedDate ? { installDate: formattedDate, installedAt: formattedDate } : {})
            })
          }
        }
      } else if (process.platform === 'darwin') {
        const appDirs = ['/Applications', path.join(os.homedir(), 'Applications')]
        for (const dir of appDirs) {
          if (!fsSync.existsSync(dir)) continue
          try {
            const entries = await fs.readdir(dir, { withFileTypes: true })
            for (const entry of entries.slice(0, 100)) {
              if (!entry.name.endsWith('.app')) continue
              const full = path.join(dir, entry.name)
              const st = await fs.stat(full).catch(() => null)
              const name = path.basename(entry.name, '.app')
              if (seenNames.has(name.toLowerCase())) continue
              seenNames.add(name.toLowerCase())
              apps.push({
                id: crypto.createHash('md5').update(full).digest('hex').slice(0, 10),
                name,
                version: '1.0',
                publisher: 'macOS Application',
                path: full,
                installLocation: full,
                uninstallString: full,
                sizeBytes: st?.size ?? 0,
                sizeText: formatBytes(st?.size ?? 0),
                installedAt: st ? st.mtime.toISOString() : new Date().toISOString()
              })
            }
          } catch {
            // ignore
          }
        }
      }

      if (apps.length === 0) {
        const desktopDir = path.join(os.homedir(), 'Desktop')
        if (fsSync.existsSync(desktopDir)) {
          try {
            const entries = await fs.readdir(desktopDir, { withFileTypes: true })
            for (const entry of entries.slice(0, 60)) {
              if (!entry.isFile()) continue
              const ext = path.extname(entry.name).toLowerCase()
              if (!['.lnk', '.exe', '.app', '.url'].includes(ext)) continue
              const full = path.join(desktopDir, entry.name)
              const st = await fs.stat(full)
              apps.push({
                id: crypto.createHash('md5').update(full).digest('hex').slice(0, 10),
                name: path.basename(entry.name, ext),
                path: full,
                installLocation: full,
                uninstallString: full,
                sizeBytes: st.size,
                sizeText: formatBytes(st.size),
                installedAt: st.mtime.toISOString()
              })
            }
          } catch {
            // ignore
          }
        }
      }

      void signal
      return {
        ok: true,
        success: true,
        count: apps.length,
        apps,
        items: apps
      }
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported SoftwareManagerPlugin function: ${fn}`
    }
  }

  async handleSystemActions(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'getsysteminfo' || lowerFn === 'listactions' || lowerFn === 'getstatus') {
      return {
        ok: true,
        success: true,
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: Math.floor(os.uptime()),
        actions: ['lockScreen', 'emptyTrash', 'toggleMute', 'sleep', 'toggleHiddenFiles', 'toggleFileExtensions', 'toggleDarkMode']
      }
    }

    const rawAction =
      lowerFn === 'execute' || lowerFn === 'runaction' || lowerFn === 'trigger' || lowerFn === 'executesystemaction'
        ? String(params.action ?? params.actionId ?? params.id ?? params.command ?? '')
        : fn
    const normalizedAction = rawAction.toLowerCase().replace(/[-_\s]/g, '')

    if (normalizedAction === 'lockscreen' || normalizedAction === 'lock' || normalizedAction === 'lockworkstation') {
      if (process.platform === 'win32') {
        const res = await this.#sys.runCommand('rundll32.exe', ['user32.dll,LockWorkStation'], 5_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          executedAt: new Date().toISOString()
        }
      }
      return { ok: false, success: false, error: '当前系统平台不支持 rundll32 锁屏' }
    }

    if (
      normalizedAction === 'emptytrash' ||
      normalizedAction === 'emptyrecyclebin' ||
      normalizedAction === 'clearrecyclebin'
    ) {
      if (process.platform === 'win32') {
        // 以前 -ErrorAction SilentlyContinue 后固定输出 OK：清空失败也报成功。现在先按回收站项目数判断是否本来就空
        // （不依赖本地化错误文本，空回收站上 Clear-RecycleBin 会报错），清空后重新计数确认；其余错误如实返回
        const ps = `
          $ErrorActionPreference = 'Stop'
          $before = (New-Object -ComObject Shell.Application).Namespace(10).Items().Count
          if ($before -eq 0) { Write-Output 'ALREADY_EMPTY'; exit 0 }
          $clearError = ''
          try { Clear-RecycleBin -Force -ErrorAction Stop } catch { $clearError = [string]$_.Exception.Message }
          $left = (New-Object -ComObject Shell.Application).Namespace(10).Items().Count
          if ($left -eq 0) { Write-Output 'OK' }
          elseif ($clearError) { Write-Output ('CLEAR_FAILED:' + ($clearError -replace '[\\r\\n]+', ' ')) }
          else { Write-Output ('REMAINING:' + $left) }
          exit 0
        `
        const base = { action: rawAction, executedAt: new Date().toISOString() }
        let out: string
        try {
          out = await this.#sys.runPowerShell(ps, 15_000, signal)
        } catch (err) {
          return { ...base, ...SystemRegistryHostPluginHandler.#psFailure(err, 'EMPTY_TRASH_FAILED', '清空回收站失败') }
        }
        const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
        if (status === 'OK') return { ok: true, success: true, ...base }
        if (status === 'ALREADY_EMPTY') return { ok: true, success: true, ...base, alreadyEmpty: true }
        if (status.startsWith('REMAINING:')) {
          return { ok: false, success: false, ...base, errorCode: 'EMPTY_TRASH_INCOMPLETE', error: `EMPTY_TRASH_INCOMPLETE: 回收站仍有 ${status.slice('REMAINING:'.length)} 个项目未清空` }
        }
        const detail = status.startsWith('CLEAR_FAILED:') ? status.slice('CLEAR_FAILED:'.length) : `输出：${out.trim().slice(0, 200) || '空'}`
        return { ok: false, success: false, ...base, errorCode: 'EMPTY_TRASH_FAILED', error: `EMPTY_TRASH_FAILED: 清空回收站失败：${detail}` }
      }
      return { ok: false, success: false, error: '当前平台不支持 Clear-RecycleBin' }
    }

    if (normalizedAction === 'sleep' || normalizedAction === 'suspend' || normalizedAction === 'hibernatesystem') {
      if (process.platform === 'win32') {
        const res = await this.#sys.runCommand('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], 5_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          executedAt: new Date().toISOString()
        }
      }
      return { ok: false, success: false, error: '当前平台不支持系统休眠指令' }
    }

    if (
      normalizedAction === 'togglemute' ||
      normalizedAction === 'mute' ||
      normalizedAction === 'volumeup' ||
      normalizedAction === 'volumedown'
    ) {
      if (process.platform === 'win32') {
        const keyChar =
          normalizedAction === 'volumeup' ? 175 : normalizedAction === 'volumedown' ? 174 : 173
        // $ErrorActionPreference = 'Stop'：创建 COM 对象或发送按键失败时不再继续输出 OK
        let out: string
        try {
          out = await this.#sys.runPowerShell(
            `$ErrorActionPreference = 'Stop'; $wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]${keyChar}); Write-Output 'OK'`,
            5_000,
            signal
          )
        } catch (err) {
          return { action: rawAction, ...SystemRegistryHostPluginHandler.#psFailure(err, 'ACTION_FAILED', '发送音量按键失败') }
        }
        const ok = SystemRegistryHostPluginHandler.#lastStatusLine(out) === 'OK'
        return {
          ok,
          success: ok,
          action: rawAction,
          executedAt: new Date().toISOString(),
          ...(ok ? {} : { errorCode: 'ACTION_FAILED', error: 'ACTION_FAILED: 发送音量按键未得到确认' })
        }
      }
      return { ok: false, success: false, error: '当前平台不支持音量快捷键注入' }
    }

    if (normalizedAction === 'togglehiddenfiles') {
      if (process.platform === 'win32') {
        const advKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
        const q = await this.#sys.runCommand('reg', ['query', advKey, '/v', 'Hidden'], 5_000, signal)
        const currentlyShown = /0x1\b/i.test(q.stdout)
        const nextVal = currentlyShown ? '2' : '1'
        const res = await this.#sys.runCommand('reg', ['add', advKey, '/v', 'Hidden', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          showHiddenFiles: nextVal === '1'
        }
      }
      return { ok: false, success: false, error: '仅 Windows 支持切换隐藏文件显示状态' }
    }

    if (normalizedAction === 'togglefileextensions') {
      if (process.platform === 'win32') {
        const advKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
        const q = await this.#sys.runCommand('reg', ['query', advKey, '/v', 'HideFileExt'], 5_000, signal)
        const currentlyHidden = /0x1\b/i.test(q.stdout)
        const nextVal = currentlyHidden ? '0' : '1'
        const res = await this.#sys.runCommand('reg', ['add', advKey, '/v', 'HideFileExt', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          showExtensions: nextVal === '0'
        }
      }
      return { ok: false, success: false, error: '仅 Windows 支持切换文件扩展名显示状态' }
    }

    if (normalizedAction === 'toggledarkmode' || normalizedAction === 'toggletheme') {
      if (process.platform === 'win32') {
        const themeKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
        const q = await this.#sys.runCommand('reg', ['query', themeKey, '/v', 'AppsUseLightTheme'], 5_000, signal)
        const isLight = /0x1\b/i.test(q.stdout)
        const nextVal = isLight ? '0' : '1'
        const res = await this.#sys.runCommand('reg', ['add', themeKey, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          darkMode: nextVal === '0'
        }
      }
      return { ok: false, success: false, error: '仅 Windows 支持切换系统深浅色模式' }
    }

    if (normalizedAction === 'flushdns') {
      if (process.platform === 'win32') {
        const res = await this.#sys.runCommand('ipconfig', ['/flushdns'], 8_000, signal)
        return {
          ok: res.exitCode === 0,
          success: res.exitCode === 0,
          action: rawAction,
          output: res.stdout || res.stderr
        }
      }
      return { ok: false, success: false, error: '仅 Windows 支持 ipconfig /flushdns' }
    }

    return {
      ok: false,
      success: false,
      error: `Unsupported SystemActionsPlugin action: ${rawAction || fn}`
    }
  }

  async handleWindowManagement(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'listwindows' ||
      lowerFn === 'getwindows' ||
      lowerFn === 'getactivewindow' ||
      lowerFn === 'scanwindows'
    ) {
      let activeWindow: unknown = null
      if (
        this.#ctx.windowControl &&
        typeof (this.#ctx.windowControl as { getActiveWindow?: () => Promise<unknown> }).getActiveWindow === 'function'
      ) {
        activeWindow = await (this.#ctx.windowControl as { getActiveWindow: () => Promise<unknown> })
          .getActiveWindow()
          .catch(() => null)
        if (lowerFn === 'getactivewindow' || process.platform !== 'win32') {
          return {
            ok: true,
            success: true,
            activeWindow,
            windows: activeWindow ? [activeWindow] : []
          }
        }
      }
      if (process.platform === 'win32') {
        // 结果存变量后最后单独输出：个别进程读取失败的非终止错误不能让退出码变成 1
        const ps = `
          $procs = @(Get-Process -ErrorAction SilentlyContinue)
          $list = @($procs | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 40 | ForEach-Object {
            [PSCustomObject]@{
              id = [string]$_.MainWindowHandle
              hwnd = [int64]$_.MainWindowHandle
              pid = $_.Id
              processName = $_.ProcessName
              title = $_.MainWindowTitle
            }
          })
          ConvertTo-Json -InputObject $list -Compress
        `
        let raw: string
        try {
          raw = await this.#sys.runPowerShell(ps, 6_000)
        } catch (err) {
          return SystemRegistryHostPluginHandler.#psFailure(err, 'LIST_FAILED', '读取窗口列表失败')
        }
        const windows: Array<Record<string, unknown>> = []
        if (raw.trim()) {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return { ok: false, success: false, errorCode: 'LIST_FAILED', error: 'LIST_FAILED: 窗口列表格式无效' }
          }
          const list = Array.isArray(parsed) ? parsed : [parsed]
          for (const w of list) {
            if (w && typeof w === 'object') windows.push(w as Record<string, unknown>)
          }
        }
        return {
          ok: true,
          success: true,
          activeWindow: activeWindow ?? windows[0] ?? null,
          windows: windows.length > 0 ? windows : activeWindow ? [activeWindow as Record<string, unknown>] : []
        }
      }
      return { ok: true, success: true, activeWindow, windows: activeWindow ? [activeWindow] : [] }
    }

    const rawAction =
      lowerFn === 'applylayout' || lowerFn === 'snapwindow' || lowerFn === 'controlwindow' || lowerFn === 'execute'
        ? String(params.layout ?? params.action ?? params.mode ?? fn)
        : fn
    const normalizedAction = rawAction.toLowerCase().replace(/[-_\s]/g, '')

    const supportedWindowActions = new Set([
      'maximize',
      'minimize',
      'restore',
      'center',
      'lefthalf',
      'snapleft',
      'righthalf',
      'snapright',
      'tophalf',
      'bottomhalf',
      'fullscreen',
      'activate',
      'focus',
      'bringtofront',
      'close',
      'closewindow'
    ])

    if (!supportedWindowActions.has(normalizedAction)) {
      return {
        ok: false,
        success: false,
        error: `Unsupported WindowManagementPlugin action: ${rawAction}`
      }
    }

    if (process.platform !== 'win32') {
      return {
        ok: false,
        success: false,
        error: '当前操作系统不支持 Win32 窗口管理操作'
      }
    }

    const targetHwnd = Number(params.hwnd ?? params.windowHandle ?? params.handle ?? 0)
    if (params.hwnd !== undefined && (!Number.isFinite(targetHwnd) || targetHwnd < 0)) {
      return {
        ok: false,
        success: false,
        error: '无效的窗口句柄 (hwnd)'
      }
    }

    // $ErrorActionPreference = 'Stop'：Add-Type 或 Win32 调用失败时不再继续输出 OK
    const psScript = `
      $ErrorActionPreference = 'Stop'
      Add-Type @"
      using System;
      using System.Runtime.InteropServices;
      public class ZToolsWin32 {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
      }
"@
      Add-Type -AssemblyName System.Windows.Forms
      $hwnd = if (${Math.trunc(targetHwnd)} -gt 0) { [IntPtr]${Math.trunc(targetHwnd)} } else { [ZToolsWin32]::GetForegroundWindow() }
      if ($hwnd -eq [IntPtr]::Zero) {
        Write-Output 'ERR_NO_WINDOW'
        exit 0
      }
      $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
      $act = '${normalizedAction}'
      if ($act -eq 'maximize' -or $act -eq 'fullscreen') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 3) | Out-Null
      } elseif ($act -eq 'minimize') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 6) | Out-Null
      } elseif ($act -eq 'restore') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
      } elseif ($act -eq 'lefthalf' -or $act -eq 'snapleft') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
        [ZToolsWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, $wa.X, $wa.Y, [int]($wa.Width / 2), $wa.Height, 0x0040) | Out-Null
      } elseif ($act -eq 'righthalf' -or $act -eq 'snapright') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
        [ZToolsWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, $wa.X + [int]($wa.Width / 2), $wa.Y, [int]($wa.Width / 2), $wa.Height, 0x0040) | Out-Null
      } elseif ($act -eq 'tophalf') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
        [ZToolsWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, $wa.X, $wa.Y, $wa.Width, [int]($wa.Height / 2), 0x0040) | Out-Null
      } elseif ($act -eq 'bottomhalf') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
        [ZToolsWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, $wa.X, $wa.Y + [int]($wa.Height / 2), $wa.Width, [int]($wa.Height / 2), 0x0040) | Out-Null
      } elseif ($act -eq 'center') {
        $w = [int]($wa.Width * 0.7)
        $h = [int]($wa.Height * 0.75)
        $x = $wa.X + [int](($wa.Width - $w) / 2)
        $y = $wa.Y + [int](($wa.Height - $h) / 2)
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
        [ZToolsWin32]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $w, $h, 0x0040) | Out-Null
      } elseif ($act -eq 'activate' -or $act -eq 'focus' -or $act -eq 'bringtofront') {
        [ZToolsWin32]::ShowWindowAsync($hwnd, 9) | Out-Null
      } elseif ($act -eq 'close' -or $act -eq 'closewindow') {
        [ZToolsWin32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      }
      Write-Output 'OK'
    `
    let out: string
    try {
      out = await this.#sys.runPowerShell(psScript, 8_000)
    } catch (err) {
      return { action: normalizedAction, ...SystemRegistryHostPluginHandler.#psFailure(err, 'WINDOW_ACTION_FAILED', '执行 Win32 窗口管理操作失败') }
    }
    const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
    const ok = status === 'OK'
    return {
      ok,
      success: ok,
      action: normalizedAction,
      ...(ok ? {} : status === 'ERR_NO_WINDOW'
        ? { errorCode: 'NO_WINDOW', error: 'NO_WINDOW: 没有找到要操作的窗口' }
        : { errorCode: 'WINDOW_ACTION_FAILED', error: '执行 Win32 窗口管理操作失败' })
    }
  }

  async handleClipboardHistory(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'gettext' || lowerFn === 'readtext' || lowerFn === 'getlatest') {
      const text = this.#ctx.clipboard ? await this.#ctx.clipboard.getText() : ''
      return { ok: true, success: true, text }
    }
    if (
      lowerFn === 'settext' ||
      lowerFn === 'setclipboardtext' ||
      lowerFn === 'writetext' ||
      lowerFn === 'copy' ||
      lowerFn === 'copytext'
    ) {
      const text = String(params.text ?? params.content ?? '')
      if (!this.#ctx.clipboard) {
        return { ok: false, success: false, copied: false, error: '宿主剪贴板服务未注入，无法写入剪贴板' }
      }
      await this.#ctx.clipboard.setText(text)
      return { ok: true, success: true, copied: true, text }
    }
    if (
      lowerFn === 'list' ||
      lowerFn === 'gethistory' ||
      lowerFn === 'getitems' ||
      lowerFn === 'load' ||
      lowerFn === 'scan'
    ) {
      const text = this.#ctx.clipboard ? await this.#ctx.clipboard.getText().catch(() => '') : ''
      return {
        ok: true,
        success: true,
        items: text ? [{ id: 'clip-latest', text, type: 'text', createdAt: new Date().toISOString() }] : []
      }
    }
    return {
      ok: false,
      success: false,
      error: `Unsupported ClipboardHistoryPlugin function: ${fn}`
    }
  }

  static readonly #KERNEL_PROTECTED_PROCESSES = new Set([
    'system',
    'idle',
    'registry',
    'smss',
    'smss.exe',
    'csrss',
    'csrss.exe',
    'wininit',
    'wininit.exe',
    'services',
    'services.exe',
    'lsass',
    'lsass.exe',
    'svchost',
    'svchost.exe',
    'winlogon',
    'winlogon.exe',
    'dwm',
    'dwm.exe',
    'fontdrvhost',
    'fontdrvhost.exe',
    'memory compression',
    'spoolsv',
    'spoolsv.exe',
    'launchd',
    'kernel_task',
    'windowserver',
    'loginwindow'
  ])

  static #normalizeProcessBaseName(name: string): string {
    return (name ?? '')
      .trim()
      .toLowerCase()
      .replace(/\.exe$/i, '')
  }

  static #isKernelProtectedProcess(pid: number, name: string): boolean {
    if (Number.isFinite(pid) && pid > 0 && pid <= 4) {
      return true
    }
    const lower = (name ?? '').trim().toLowerCase()
    if (!lower) return false
    const base = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(lower)
    return (
      SystemRegistryHostPluginHandler.#KERNEL_PROTECTED_PROCESSES.has(lower) ||
      SystemRegistryHostPluginHandler.#KERNEL_PROTECTED_PROCESSES.has(base) ||
      (PROTECTED_PROCESS_NAMES.has(lower) && base !== 'explorer')
    )
  }

  static #resolveServiceTypeLabel(
    pid: number,
    name: string,
    rawServiceType?: string
  ): '系统内核' | '资源管理器' | '后台服务' | '普通进程' {
    if (SystemRegistryHostPluginHandler.#isKernelProtectedProcess(pid, name)) {
      return '系统内核'
    }
    const base = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(name)
    if (base === 'explorer') {
      return '资源管理器'
    }
    const st = (rawServiceType ?? '').toLowerCase()
    if (st.includes('service') || st === '3' || st.includes('后台服务')) {
      return '后台服务'
    }
    return '普通进程'
  }

  static #validateUnlockTargetPath(rawTarget: string): { valid: true } | { valid: false; errorCode: string; error: string } {
    const trimmed = (rawTarget ?? '').trim()
    if (!trimmed) {
      return {
        valid: false,
        errorCode: 'INVALID_PATH',
        error: 'INVALID_PATH: 未提供待检测的文件或文件夹路径'
      }
    }
    if (trimmed.includes('\0')) {
      return {
        valid: false,
        errorCode: 'INVALID_PATH',
        error: 'INVALID_PATH: 路径包含非法空字节 (null byte)'
      }
    }
    if (/(^|[\\/])\.\.([\\/]|$)/.test(trimmed)) {
      return {
        valid: false,
        errorCode: 'INVALID_PATH',
        error: 'INVALID_PATH: 禁止使用包含 .. 的相对路径穿越'
      }
    }
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\[^\\]+\\[^\\]+/.test(trimmed)
    const isPosixAbs = trimmed.startsWith('/')
    if (!isWinAbs && !isPosixAbs) {
      return {
        valid: false,
        errorCode: 'INVALID_PATH',
        error: 'INVALID_PATH: 必须提供合法的绝对路径'
      }
    }
    return { valid: true }
  }

  /** 目录只抽查有限文件：同时返回是否截断与读取失败的目录数，抽查结果不能当成完整结论 */
  async #collectCandidateFilesForRestartManager(targetPath: string, isDirectory: boolean): Promise<{ files: string[]; truncated: boolean; unreadableDirs: number }> {
    if (!isDirectory) {
      return { files: [targetPath], truncated: false, unreadableDirs: 0 }
    }
    const collected: string[] = []
    const maxFiles = 32
    let truncated = false, unreadableDirs = 0
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (collected.length >= maxFiles) { truncated = true; return }
      let entries: fsSync.Dirent[] = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        unreadableDirs++
        return
      }
      for (const entry of entries) {
        if (collected.length >= maxFiles) { truncated = true; break }
        const full = path.join(dir, entry.name)
        if (entry.isFile()) {
          collected.push(full)
        } else if (entry.isDirectory()) {
          if (depth < 2) await walk(full, depth + 1)
          else truncated = true
        }
      }
    }
    await walk(targetPath, 0)
    return { files: collected, truncated, unreadableDirs }
  }

  /** queryFailed：系统查询本身失败（不能当成“进程不存在”） */
  async #queryLiveProcessName(pid: number, signal?: AbortSignal): Promise<{ exists: boolean; name: string; executablePath: string; queryFailed?: boolean; error?: string }> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { exists: false, name: '', executablePath: '' }
    }
    if (pid === 4 && process.platform === 'win32') {
      return { exists: true, name: 'System', executablePath: 'System' }
    }
    if (process.platform === 'win32') {
      const tasklist = await this.#sys.runCommand(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        5_000,
        signal
      )
      if (tasklist.exitCode !== 0) {
        return { exists: false, name: '', executablePath: '', queryFailed: true, error: tasklist.stderr || `tasklist 退出码 ${tasklist.exitCode}` }
      }
      for (const line of tasklist.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        const m = trimmed.match(/^"([^"]+)","(\d+)"/)
        if (m?.[1] && Number(m[2]) === pid) {
          return { exists: true, name: m[1], executablePath: m[1] }
        }
      }
      return { exists: false, name: '', executablePath: '' }
    }

    const psRes = await this.#sys.runCommand('ps', ['-p', String(pid), '-o', 'comm='], 5_000, signal)
    if (psRes.exitCode === 0 && psRes.stdout.trim()) {
      const fullComm = psRes.stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
      return {
        exists: Boolean(fullComm),
        name: path.basename(fullComm),
        executablePath: fullComm
      }
    }
    return { exists: false, name: '', executablePath: '' }
  }

  /**
   * 移入回收站，绝不静默永久删除：VB 的 DeleteFile / DeleteDirectory(…, OnlyErrorDialogs, SendToRecycleBin) 在没有回收站的位置
   * （可移动盘、网络共享、UNC）、回收站被关闭（NukeOnDelete / NoRecycleFiles 策略）或目标超过回收站容量时会直接永久删除且不提示。
   * 因此先在同一脚本里确认：本地固定卷、回收站未关闭、目标大小不超过该卷回收站上限（未设置时按系统默认上限的下界“卷容量 5%”估算），
   * 任何一项不满足或无法确认都返回 TRASH_UNSUPPORTED / TRASH_TOO_LARGE 并保留原文件。
   */
  async #moveTargetToTrash(resolvedTarget: string, signal?: AbortSignal): Promise<{ ok: boolean; errorCode?: string; error?: string }> {
    if (isProtectedSystemPath(resolvedTarget)) {
      return { ok: false, errorCode: 'PROTECTED_PATH', error: 'PROTECTED_PATH: 系统核心受保护路径禁止移入回收站' }
    }
    if (process.platform === 'win32') {
      if (/^[\\/]{2}/.test(resolvedTarget)) {
        return { ok: false, errorCode: 'TRASH_UNSUPPORTED', error: 'TRASH_UNSUPPORTED: 网络共享（UNC）路径没有回收站，移入回收站会被直接永久删除，已取消，原文件保留' }
      }
      const escaped = escapePsSingleQuoted(resolvedTarget)
      const isDir = fsSync.existsSync(resolvedTarget) && fsSync.statSync(resolvedTarget).isDirectory()
      const psTrash = `
        $ErrorActionPreference = 'Stop'
        $p = '${escaped}'
        if (-not (Test-Path -LiteralPath $p)) { Write-Output 'TRASH_NOT_FOUND'; exit 0 }
        $full = [System.IO.Path]::GetFullPath($p)
        $root = [System.IO.Path]::GetPathRoot($full)
        if (-not $root -or $root.StartsWith('\\\\') -or $root -notmatch '^[A-Za-z]:\\\\$') { Write-Output 'TRASH_UNSUPPORTED:UNC'; exit 0 }
        # 路径上有目录联接 / 卷挂载点 / 符号链接时，实际所在卷不是盘符根对应的卷，下面按盘符做的类型与容量检查不成立，保守拒绝
        $probe = $full
        while ($probe -and $probe.Length -gt $root.Length) {
          $linkType = (Get-Item -LiteralPath $probe -Force).LinkType
          if ($linkType -eq 'Junction' -or $linkType -eq 'SymbolicLink') { Write-Output 'TRASH_UNSUPPORTED:REPARSE'; exit 0 }
          $probe = [System.IO.Path]::GetDirectoryName($probe)
        }
        $drive = New-Object System.IO.DriveInfo($root)
        if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) { Write-Output ('TRASH_UNSUPPORTED:' + $drive.DriveType); exit 0 }
        foreach ($policyKey in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer')) {
          $policy = Get-ItemProperty -LiteralPath $policyKey -Name 'NoRecycleFiles' -ErrorAction SilentlyContinue
          if ($policy -and [int]$policy.NoRecycleFiles -eq 1) { Write-Output 'TRASH_UNSUPPORTED:POLICY'; exit 0 }
        }
        $letter = $root.Substring(0, 2)
        $volume = Get-CimInstance Win32_Volume -Filter "DriveLetter='$letter'"
        if (-not $volume -or -not ([string]$volume.DeviceID -match '\\{[0-9A-Fa-f-]+\\}')) { Write-Output 'TRASH_UNSUPPORTED:VOLUME_UNKNOWN'; exit 0 }
        $bitBucket = Get-ItemProperty -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\' + $Matches[0]) -ErrorAction SilentlyContinue
        if ($bitBucket -and $null -ne $bitBucket.NukeOnDelete -and [int]$bitBucket.NukeOnDelete -eq 1) { Write-Output 'TRASH_UNSUPPORTED:NUKE_ON_DELETE'; exit 0 }
        $limit = if ($bitBucket -and $null -ne $bitBucket.MaxCapacity -and [int64]$bitBucket.MaxCapacity -gt 0) { [int64]$bitBucket.MaxCapacity * 1MB } else { [int64]($drive.TotalSize * 0.05) }
        $size = if (${isDir ? '$true' : '$false'}) {
          [int64](Get-ChildItem -LiteralPath $p -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum
        } else {
          [int64](Get-Item -LiteralPath $p -Force).Length
        }
        if ($size -gt $limit) { Write-Output ('TRASH_TOO_LARGE:' + $size + ':' + $limit); exit 0 }
        Add-Type -AssemblyName Microsoft.VisualBasic
        if (${isDir ? '$true' : '$false'}) {
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
        } else {
          [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
        }
        Write-Output 'TRASH_OK'
      `
      let out: string
      try {
        out = await this.#sys.runPowerShell(psTrash, 30_000, signal)
      } catch (err) {
        return { ok: false, errorCode: 'TRASH_FAILED', error: `TRASH_FAILED: ${err instanceof Error ? err.message : String(err)}；原文件保留` }
      }
      const status = SystemRegistryHostPluginHandler.#lastStatusLine(out)
      if (status === 'TRASH_OK' && !fsSync.existsSync(resolvedTarget)) return { ok: true }
      if (status.startsWith('TRASH_UNSUPPORTED:')) {
        const reason = status.slice('TRASH_UNSUPPORTED:'.length)
        const reasonText: Record<string, string> = {
          UNC: '网络共享（UNC）路径',
          Removable: '可移动磁盘',
          Network: '网络驱动器',
          CDRom: '光盘',
          Ram: '内存盘',
          NoRootDirectory: '未挂载的卷',
          Unknown: '无法识别类型的磁盘',
          POLICY: '组策略已禁用回收站',
          NUKE_ON_DELETE: '该磁盘的回收站已设置为“不将文件移到回收站”',
          VOLUME_UNKNOWN: '无法确认所在卷的回收站设置',
          REPARSE: '路径经过目录联接、挂载的卷或符号链接，无法确认实际所在磁盘的回收站设置'
        }
        return { ok: false, errorCode: 'TRASH_UNSUPPORTED', error: `TRASH_UNSUPPORTED: 目标位置没有可用的回收站（${reasonText[reason] ?? reason}），移入回收站会被直接永久删除，已取消，原文件保留` }
      }
      if (status.startsWith('TRASH_TOO_LARGE:')) {
        const [, size, limit] = status.split(':')
        return { ok: false, errorCode: 'TRASH_TOO_LARGE', error: `TRASH_TOO_LARGE: 目标大小 ${formatBytes(Number(size))} 超过该磁盘回收站上限 ${formatBytes(Number(limit))}，移入回收站会被直接永久删除，已取消，原文件保留` }
      }
      if (status === 'TRASH_NOT_FOUND') return { ok: false, errorCode: 'TRASH_FAILED', error: 'TRASH_FAILED: 目标已不存在' }
      return { ok: false, errorCode: 'TRASH_FAILED', error: 'TRASH_FAILED: 系统未确认移入回收站，原文件保留' }
    }
    // 回收站失败绝不退化为永久删除：用户以为可以从回收站还原
    return { ok: false, errorCode: 'TRASH_UNSUPPORTED', error: 'TRASH_UNSUPPORTED: 当前平台的此入口不支持移入回收站，原文件保留' }
  }

  async handleFileUnlock(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase().replace(/[-_\s]/g, '')

    if (
      lowerFn === 'listremovabledrives' ||
      lowerFn === 'getremovabledrives' ||
      lowerFn === 'scanremovabledrives'
    ) {
      const drives: Array<{
        mount: string
        label: string
        totalBytes: number
        freeBytes: number
        totalText: string
        freeText: string
      }> = []

      if (process.platform === 'win32') {
        // 移动硬盘与 USB 固态硬盘通常报告为本地磁盘（DriveType=3），还要按磁盘总线（USB/SD/MMC）找出它们的分区
        const ps = `
          $ErrorActionPreference = 'Stop'
          $found = @{}
          Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | ForEach-Object { $found[$_.DeviceID] = $_ }
          $busWarning = ''
          try {
            Get-Disk | Where-Object { $_.BusType -in 'USB', 'SD', 'MMC' } | Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object {
              $id = "$($_.DriveLetter):"
              if (-not $found.ContainsKey($id)) {
                $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$id'"
                if ($disk) { $found[$id] = $disk }
              }
            }
          } catch { $busWarning = $_.Exception.Message }
          $drives = @($found.Values | ForEach-Object {
            [PSCustomObject]@{
              mount = "$($_.DeviceID)\\"
              label = if ($_.VolumeName) { $_.VolumeName } else { '外接磁盘' }
              totalBytes = [int64]($_.Size)
              freeBytes = [int64]($_.FreeSpace)
            }
          })
          @{ drives = $drives; warning = $busWarning } | ConvertTo-Json -Compress -Depth 4
        `
        let parsed: { drives?: unknown; warning?: unknown }
        try {
          parsed = JSON.parse(await this.#sys.runPowerShell(ps, 10_000, signal)) as { drives?: unknown; warning?: unknown }
        } catch (err) {
          return { ok: false, success: false, errorCode: 'DRIVE_LIST_FAILED', error: `DRIVE_LIST_FAILED: 读取外接磁盘失败：${err instanceof Error ? err.message : String(err)}` }
        }
        if (!parsed || !Array.isArray(parsed.drives)) {
          return { ok: false, success: false, errorCode: 'DRIVE_LIST_FAILED', error: 'DRIVE_LIST_FAILED: 外接磁盘列表格式无效' }
        }
        for (const item of parsed.drives as unknown[]) {
          if (!item || typeof item !== 'object') continue
          const rec = item as Record<string, unknown>
          const mount = String(rec.mount ?? '')
          const totalBytes = Number(rec.totalBytes ?? 0)
          const freeBytes = Number(rec.freeBytes ?? 0)
          if (!mount) continue
          drives.push({ mount, label: String(rec.label ?? '外接磁盘'), totalBytes, freeBytes, totalText: formatBytes(totalBytes), freeText: formatBytes(freeBytes) })
        }
        if (typeof parsed.warning === 'string' && parsed.warning) {
          return { ok: true, success: true, drives, partial: true, warning: `按磁盘总线识别移动硬盘失败，列表可能不完整：${parsed.warning}` }
        }
      } else if (process.platform === 'darwin' && fsSync.existsSync('/Volumes')) {
        try {
          const entries = await fs.readdir('/Volumes', { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === 'Macintosh HD') continue
            const mount = path.join('/Volumes', entry.name)
            let totalBytes = 0
            let freeBytes = 0
            try {
              const st = await fs.statfs(mount)
              totalBytes = Number(st.bsize) * Number(st.blocks)
              freeBytes = Number(st.bsize) * Number(st.bavail)
            } catch {
              // ignore statfs failure
            }
            drives.push({
              mount,
              label: entry.name,
              totalBytes,
              freeBytes,
              totalText: totalBytes > 0 ? formatBytes(totalBytes) : '-',
              freeText: freeBytes > 0 ? formatBytes(freeBytes) : '-'
            })
          }
        } catch {
          // ignore
        }
      }

      return {
        ok: true,
        success: true,
        drives
      }
    }

    if (
      lowerFn === 'inspectlocks' ||
      lowerFn === 'scanlocks' ||
      lowerFn === 'inspect' ||
      lowerFn === 'scan' ||
      lowerFn === 'getlocks'
    ) {
      const rawTarget = String(params.targetPath ?? params.path ?? params.filePath ?? '').trim()
      const validation = SystemRegistryHostPluginHandler.#validateUnlockTargetPath(rawTarget)
      if (!validation.valid) {
        return {
          ok: false,
          success: false,
          errorCode: validation.errorCode,
          error: validation.error
        }
      }

      let resolved: string
      try {
        resolved = await this.#ctx.authorizeExistingPath(rawTarget, caller, 'read')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          success: false,
          errorCode: 'ACCESS_DENIED',
          error: `ACCESS_DENIED: ${message}`
        }
      }

      let stat: fsSync.Stats
      try {
        stat = await fs.stat(resolved)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code === 'EACCES' || code === 'EPERM') {
          return {
            ok: false,
            success: false,
            errorCode: 'ACCESS_DENIED',
            error: `ACCESS_DENIED: 权限不足，无法访问目标路径 (${resolved})`
          }
        }
        return {
          ok: false,
          success: false,
          errorCode: 'TARGET_NOT_FOUND',
          error: `TARGET_NOT_FOUND: 目标文件或文件夹不存在 (${resolved})`
        }
      }

      const isDirectory = stat.isDirectory()
      const normalizedProcessList: Array<{
        id: string
        pid: number
        name: string
        executablePath: string
        lockedPath: string
        handleType: 'file' | 'directory' | 'dll' | 'unknown'
        serviceTypeLabel: '系统内核' | '资源管理器' | '后台服务' | '普通进程'
        isProtected: boolean
        user: string
      }> = []
      const seenPids = new Set<number>()
      let scanCoverage: { checkedFiles: number; truncated: boolean; unreadableDirs: number } | undefined

      const appendLockingProcess = (rawProc: {
        pid: number
        name: string
        executablePath?: string | undefined
        lockedPath?: string | undefined
        handleType?: string | undefined
        serviceType?: string | undefined
        user?: string | undefined
      }) => {
        const pid = Number(rawProc.pid)
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || seenPids.has(pid)) {
          return
        }
        seenPids.add(pid)
        const name = String(rawProc.name || `PID-${pid}`).trim()
        const executablePath = String(rawProc.executablePath || name).trim()
        const lockedPath = String(rawProc.lockedPath || resolved).trim()
        const isProtected = SystemRegistryHostPluginHandler.#isKernelProtectedProcess(pid, name)
        const serviceTypeLabel = SystemRegistryHostPluginHandler.#resolveServiceTypeLabel(
          pid,
          name,
          rawProc.serviceType
        )
        const rawHandle = String(rawProc.handleType ?? '').toLowerCase()
        const handleType: 'file' | 'directory' | 'dll' | 'unknown' =
          rawHandle === 'dll'
            ? 'dll'
            : rawHandle === 'directory' || isDirectory
              ? 'directory'
              : 'file'

        normalizedProcessList.push({
          id: `${pid}-${lockedPath}`,
          pid,
          name,
          executablePath,
          lockedPath,
          handleType,
          serviceTypeLabel,
          isProtected,
          user: String(rawProc.user || os.userInfo().username || 'User')
        })
      }

      if (process.platform === 'win32') {
        const candidates = await this.#collectCandidateFilesForRestartManager(resolved, isDirectory)
        scanCoverage = { checkedFiles: candidates.files.length, truncated: candidates.truncated, unreadableDirs: candidates.unreadableDirs }
        const escapedFilesArray = candidates.files
          .map((f) => `'${escapePsSingleQuoted(f)}'`)
          .join(',')
        const escapedTarget = escapePsSingleQuoted(resolved)
        const psScript = `
          $ErrorActionPreference = 'Stop'
          Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          using System.Collections.Generic;
          using System.Diagnostics;

          public static class ZToolsRmDetector {
            [StructLayout(LayoutKind.Sequential)]
            public struct RM_UNIQUE_PROCESS {
              public int dwProcessId;
              public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
            }
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct RM_PROCESS_INFO {
              public RM_UNIQUE_PROCESS Process;
              [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
              public string strAppName;
              [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
              public string strServiceShortName;
              public int ApplicationType;
              public uint AppStatus;
              public uint TSSessionId;
              [MarshalAs(UnmanagedType.Bool)]
              public bool bRestartable;
            }
            [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
            public static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);
            [DllImport("rstrtmgr.dll")]
            public static extern int RmEndSession(uint pSessionHandle);
            [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
            public static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, [In] RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
            [DllImport("rstrtmgr.dll")]
            public static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

            public static RM_PROCESS_INFO[] QueryLocked(string[] files) {
              if (files == null || files.Length == 0) return new RM_PROCESS_INFO[0];
              uint handle;
              string key = Guid.NewGuid().ToString();
              int started = RmStartSession(out handle, 0, key);
              if (started != 0) throw new InvalidOperationException("RmStartSession 失败：" + started);
              try {
                int registered = RmRegisterResources(handle, (uint)files.Length, files, 0, null, 0, null);
                if (registered != 0) throw new InvalidOperationException("RmRegisterResources 失败：" + registered);
                uint needed = 0, count = 0, reasons = 0;
                int res = RmGetList(handle, out needed, ref count, null, ref reasons);
                if (res == 0) return new RM_PROCESS_INFO[0];
                if (res != 234) throw new InvalidOperationException("RmGetList 失败：" + res);
                count = needed;
                RM_PROCESS_INFO[] infos = new RM_PROCESS_INFO[count];
                int listed = RmGetList(handle, out needed, ref count, infos, ref reasons);
                if (listed != 0) throw new InvalidOperationException("RmGetList 失败：" + listed);
                return infos;
              } finally {
                RmEndSession(handle);
              }
            }
          }
"@
          $results = @()
          $files = @(${escapedFilesArray})
          if ($files.Count -gt 0) {
            $rmList = [ZToolsRmDetector]::QueryLocked($files)
            foreach ($info in $rmList) {
              $procId = [int]$info.Process.dwProcessId
              if ($procId -gt 0 -and $procId -ne $PID) {
                $pObj = Get-Process -Id $procId -ErrorAction SilentlyContinue
                $procName = if ($pObj -and $pObj.ProcessName) { "$($pObj.ProcessName).exe" } elseif ($info.strAppName) { $info.strAppName } else { "PID-$procId" }
                $exePath = if ($pObj -and $pObj.Path) { $pObj.Path } else { $procName }
                $results += [PSCustomObject]@{
                  pid = $procId
                  name = $procName
                  executablePath = $exePath
                  serviceType = [string]$info.ApplicationType
                }
              }
            }
          }
          $targetPrefix = '${escapedTarget}'
          Get-CimInstance Win32_Process | ForEach-Object {
            $pId = [int]$_.ProcessId
            if ($pId -gt 0 -and $pId -ne $PID) {
              $cmd = [string]$_.CommandLine
              $exe = [string]$_.ExecutablePath
              if (($exe -and $exe.StartsWith($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) -or ($cmd -and $cmd.IndexOf($targetPrefix, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
                $results += [PSCustomObject]@{
                  pid = $pId
                  name = [string]$_.Name
                  executablePath = if ($exe) { $exe } else { [string]$_.Name }
                  serviceType = '0'
                }
              }
            }
          }
          @{ processes = @($results) } | ConvertTo-Json -Compress -Depth 4
        `
        // 检测失败、超时或输出无法解析都必须如实报告，不能当成“未被占用”
        let detection: { processes?: unknown }
        try {
          const rawOut = await this.#sys.runPowerShell(psScript, 20_000, signal)
          detection = JSON.parse(rawOut) as { processes?: unknown }
        } catch (err) {
          const timedOut = err instanceof PowerShellError && err.exitCode === 124
          return {
            ok: false, success: false, targetPath: resolved,
            errorCode: timedOut ? 'DETECT_TIMEOUT' : 'DETECT_FAILED',
            error: `${timedOut ? 'DETECT_TIMEOUT' : 'DETECT_FAILED'}: 占用检测未完成，不能判断是否被占用：${err instanceof Error ? err.message : String(err)}`
          }
        }
        if (!detection || !Array.isArray(detection.processes)) {
          return { ok: false, success: false, targetPath: resolved, errorCode: 'DETECT_FAILED', error: 'DETECT_FAILED: 占用检测结果格式无效，不能判断是否被占用' }
        }
        for (const entry of detection.processes as unknown[]) {
          if (entry && typeof entry === 'object') {
            const rec = entry as Record<string, unknown>
            appendLockingProcess({
              pid: Number(rec.pid ?? 0),
              name: String(rec.name ?? ''),
              executablePath: typeof rec.executablePath === 'string' ? rec.executablePath : undefined,
              lockedPath: resolved,
              serviceType: typeof rec.serviceType === 'string' ? rec.serviceType : undefined
            })
          }
        }
      } else {
        const lsofRes = await this.#sys.runCommand('lsof', ['-F', 'pcn', '--', resolved], 8_000, signal)
        if (lsofRes.stdout) {
          let currentPid = 0
          let currentCmd = ''
          let currentLockedPath = resolved
          for (const line of lsofRes.stdout.split(/\r?\n/)) {
            if (!line) continue
            const prefix = line[0]
            const val = line.slice(1).trim()
            if (prefix === 'p') {
              if (currentPid > 0) {
                appendLockingProcess({
                  pid: currentPid,
                  name: currentCmd,
                  executablePath: currentCmd,
                  lockedPath: currentLockedPath
                })
              }
              currentPid = Number(val)
              currentCmd = ''
              currentLockedPath = resolved
            } else if (prefix === 'c') {
              currentCmd = val
            } else if (prefix === 'n' && val) {
              currentLockedPath = val
            }
          }
          if (currentPid > 0) {
            appendLockingProcess({
              pid: currentPid,
              name: currentCmd,
              executablePath: currentCmd,
              lockedPath: currentLockedPath
            })
          }
        }
      }

      const partial = Boolean(scanCoverage && (scanCoverage.truncated || scanCoverage.unreadableDirs > 0))
      return {
        ok: true,
        success: true,
        targetPath: resolved,
        isDirectory,
        // 只抽查了部分文件时不能给出“未被占用”的结论
        isUnlocked: normalizedProcessList.length === 0 && !partial,
        processes: normalizedProcessList,
        lockingProcesses: normalizedProcessList,
        ...(scanCoverage ? { scanCoverage, partial } : {})
      }
    }

    if (
      lowerFn === 'unlockpath' ||
      lowerFn === 'unlock' ||
      lowerFn === 'terminatelockingprocess' ||
      lowerFn === 'killlockingprocess'
    ) {
      const pid = Number(params.pid ?? 0)
      const expectedName = String(params.expectedName ?? params.name ?? params.processName ?? '').trim()
      const rawTargetPath = String(params.targetPath ?? params.path ?? '').trim()
      const trashAfterUnlock = Boolean(params.trashAfterUnlock)
      const renameTo = String(params.renameTo ?? '').trim()

      if (!Number.isInteger(pid) || pid <= 0) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_PID',
          error: 'INVALID_PID: 无效的进程 PID'
        }
      }

      if (!expectedName) {
        return {
          ok: false,
          success: false,
          pid,
          errorCode: 'MISSING_EXPECTED_NAME',
          error: 'MISSING_EXPECTED_NAME: 缺少 expectedName 进程身份校验参数'
        }
      }

      if (SystemRegistryHostPluginHandler.#isKernelProtectedProcess(pid, expectedName)) {
        return {
          ok: false,
          success: false,
          pid,
          expectedName,
          errorCode: 'PROCESS_PROTECTED',
          error: `PROCESS_PROTECTED: 系统关键保护进程 (${expectedName}, PID ${pid}) 严禁强制终止`
        }
      }

      if (pid === process.pid) {
        return {
          ok: false,
          success: false,
          pid,
          expectedName,
          errorCode: 'PROCESS_PROTECTED',
          error: 'PROCESS_PROTECTED: 禁止终止 ZTools 宿主自身进程'
        }
      }

      // 进程名只由宿主查询，不接受调用方传入，避免绕过系统关键进程保护与身份核对
      const liveInfo = await this.#queryLiveProcessName(pid, signal)
      if (liveInfo.queryFailed) {
        return {
          ok: false, success: false, pid, expectedName, errorCode: 'PROCESS_QUERY_FAILED',
          error: `PROCESS_QUERY_FAILED: 无法确认进程状态，未执行终止：${liveInfo.error ?? '系统查询失败'}`
        }
      }
      if (!liveInfo.exists) {
        return {
          ok: false, success: false, pid, expectedName, errorCode: 'PROCESS_GONE',
          error: `PROCESS_GONE: 进程 ${expectedName} (PID ${pid}) 已不存在，请重新检测占用`
        }
      }

      if (liveInfo.exists && SystemRegistryHostPluginHandler.#isKernelProtectedProcess(pid, liveInfo.name)) {
        return {
          ok: false,
          success: false,
          pid,
          expectedName,
          actualName: liveInfo.name,
          errorCode: 'PROCESS_PROTECTED',
          error: `PROCESS_PROTECTED: 目标 PID (${pid}) 属于系统关键保护进程 (${liveInfo.name})，已拦截终止请求`
        }
      }

      if (liveInfo.exists) {
        const expectedBase = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(expectedName)
        const actualBase = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(liveInfo.name)
        if (expectedBase && actualBase && expectedBase !== actualBase) {
          return {
            ok: false,
            success: false,
            pid,
            expectedName,
            actualName: liveInfo.name,
            errorCode: 'PROCESS_IDENTITY_MISMATCH',
            error: `PROCESS_IDENTITY_MISMATCH: 目标 PID (${pid}) 当前进程为 ${liveInfo.name}，与预期进程 ${expectedName} 不一致，已取消终止操作以防误杀`
          }
        }
      }

      const expectedBase = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(expectedName)
      let explorerRestarted = false

      if (expectedBase === 'explorer') {
        if (process.platform === 'win32' && params.dryRun !== true) {
          // 只结束占用目标的那个资源管理器进程，不按进程名结束全部（包括独立进程的文件夹窗口）
          const killed = await this.#sys.runCommand('taskkill', ['/F', '/PID', String(pid)], 6_000, signal)
          if (killed.exitCode !== 0) {
            return {
              ok: false, success: false, pid, expectedName, errorCode: 'TERMINATE_FAILED',
              error: `TERMINATE_FAILED: 结束资源管理器失败：${killed.stderr || `退出码 ${killed.exitCode}`}`
            }
          }
          const started = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
            try {
              const child = spawn('explorer.exe', [], { detached: true, stdio: 'ignore', windowsHide: false })
              child.once('error', (err) => resolve({ ok: false, error: err.message }))
              child.once('spawn', () => { child.unref(); resolve({ ok: true }) })
            } catch (err) {
              resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
            }
          })
          if (!started.ok) {
            return {
              ok: false, success: false, pid, expectedName, errorCode: 'EXPLORER_RESTART_FAILED',
              error: `EXPLORER_RESTART_FAILED: 资源管理器已结束但未能重新启动（${started.error}），请按 Ctrl+Shift+Esc 打开任务管理器，运行 explorer.exe`
            }
          }
          explorerRestarted = true
        }
      } else if (liveInfo.exists && params.dryRun !== true) {
        try {
          this.#killProcess(pid)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'EPERM' || code === 'EACCES') {
            return {
              ok: false,
              success: false,
              pid,
              expectedName,
              errorCode: 'PROCESS_ACCESS_DENIED',
              error: `PROCESS_ACCESS_DENIED: 权限不足，无法终止高权限进程 ${expectedName} (PID ${pid})，请以管理员身份运行 ZTools 后重试`
            }
          }
          if (code !== 'ESRCH') {
            return {
              ok: false,
              success: false,
              pid,
              expectedName,
              errorCode: 'TERMINATE_FAILED',
              error: err instanceof Error ? err.message : String(err)
            }
          }
        }
      }

      // 结束后确认进程确实退出，未确认时不能报告“已解除占用”
      if (params.dryRun !== true && expectedBase !== 'explorer') {
        let exited = false
        for (let attempt = 0; attempt < 25; attempt++) {
          const probe = await this.#queryLiveProcessName(pid, signal)
          if (probe.queryFailed) break
          if (!probe.exists) { exited = true; break }
          await new Promise((r) => setTimeout(r, 80))
        }
        if (!exited) {
          return {
            ok: false, success: false, pid, expectedName, errorCode: 'TERMINATE_UNCONFIRMED',
            error: `TERMINATE_UNCONFIRMED: 已向进程 ${expectedName} (PID ${pid}) 发送结束请求，但未确认其退出，请重新检测占用`
          }
        }
      }

      let trashed = false
      let renamedPath: string | undefined

      // 预览（dryRun）只做目标路径校验：既不结束进程，也不能真的移入回收站或重命名
      if (trashAfterUnlock && rawTargetPath) {
        const validation = SystemRegistryHostPluginHandler.#validateUnlockTargetPath(rawTargetPath)
        if (!validation.valid) {
          return {
            ok: false,
            success: false,
            pid,
            errorCode: validation.errorCode,
            error: validation.error
          }
        }
        let resolvedTarget: string
        try {
          resolvedTarget = await this.#ctx.authorizeExistingPath(rawTargetPath, caller, 'write')
        } catch (err) {
          return {
            ok: false,
            success: false,
            pid,
            errorCode: 'ACCESS_DENIED',
            error: err instanceof Error ? err.message : String(err)
          }
        }
        if (isProtectedSystemPath(resolvedTarget)) {
          return {
            ok: false,
            success: false,
            pid,
            errorCode: 'PROTECTED_PATH',
            error: `PROTECTED_PATH: 系统核心受保护路径禁止移入回收站 (${resolvedTarget})`
          }
        }
        const trashRes = params.dryRun === true ? null : await this.#moveTargetToTrash(resolvedTarget, signal)
        if (trashRes && !trashRes.ok) {
          // 占用进程此时已结束并确认退出，只有移入回收站失败（原文件保留）：如实告知调用方占用已解除
          return {
            ok: false,
            success: false,
            pid,
            unlocked: true,
            explorerRestarted,
            errorCode: 'TRASH_FAILED',
            ...(trashRes.errorCode ? { trashErrorCode: trashRes.errorCode } : {}),
            error: trashRes.error ?? '移入回收站失败'
          }
        }
        trashed = trashRes !== null
      }

      if (renameTo && rawTargetPath) {
        if (/[\\/:*?"<>|\0]/.test(renameTo) || renameTo === '.' || renameTo === '..') {
          return {
            ok: false,
            success: false,
            pid,
            errorCode: 'INVALID_RENAME_TARGET',
            error: 'INVALID_RENAME_TARGET: 新文件名包含非法字符'
          }
        }
        if (params.dryRun !== true) {
          const resolvedTarget = await this.#ctx.authorizeExistingPath(rawTargetPath, caller, 'write')
          const nextPath = path.join(path.dirname(resolvedTarget), renameTo)
          await fs.rename(resolvedTarget, nextPath)
          renamedPath = nextPath
        }
      }

      return {
        ok: true,
        success: true,
        pid,
        expectedName,
        explorerRestarted,
        trashed,
        ...(renamedPath ? { renamedPath } : {}),
        ...(params.dryRun === true ? { dryRun: true } : {})
      }
    }

    if (lowerFn === 'eject' || lowerFn === 'ejectdrive' || lowerFn === 'ejectremovabledrive' || lowerFn === 'safeeject') {
      const drive = String(params.drive ?? params.path ?? params.targetPath ?? '').trim()
      if (!drive) {
        return { ok: false, success: false, errorCode: 'INVALID_DRIVE', error: '未提供待弹出的驱动器盘符或挂载点路径' }
      }
      if (params.dryRun === true) return { ok: true, success: true, drive, ejected: false, dryRun: true }
      if (process.platform === 'win32') {
        const driveRoot = drive.slice(0, 2).toUpperCase()
        if (!/^[A-Z]:$/.test(driveRoot)) {
          return { ok: false, success: false, errorCode: 'INVALID_DRIVE', error: 'INVALID_DRIVE: 盘符格式无效' }
        }
        // InvokeVerb('Eject') 是异步的且不返回结果：轮询确认盘符消失才算弹出成功
        const ps = `
          $ErrorActionPreference = 'Stop'
          $drive = '${driveRoot}'
          $sh = New-Object -ComObject Shell.Application
          $item = $sh.Namespace(17).ParseName($drive)
          if (-not $item) { Write-Output 'EJECT_NOT_FOUND'; exit 0 }
          $item.InvokeVerb('Eject')
          for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 250
            if (-not (Test-Path -LiteralPath ($drive + '\\'))) { Write-Output 'EJECT_OK'; exit 0 }
          }
          Write-Output 'EJECT_UNCONFIRMED'
        `
        let out = ''
        try { out = await this.#sys.runPowerShell(ps, 10_000, signal) }
        catch (err) {
          return { ok: false, success: false, drive, errorCode: 'EJECT_FAILED', error: `EJECT_FAILED: ${err instanceof Error ? err.message : String(err)}` }
        }
        if (out.includes('EJECT_OK')) return { ok: true, success: true, drive, ejected: true }
        if (out.includes('EJECT_NOT_FOUND')) return { ok: false, success: false, drive, errorCode: 'DRIVE_NOT_FOUND', error: `DRIVE_NOT_FOUND: 未找到驱动器 ${driveRoot}` }
        return { ok: false, success: false, drive, errorCode: 'EJECT_UNCONFIRMED', error: `EJECT_UNCONFIRMED: 已请求弹出 ${driveRoot}，但盘符仍在，可能仍有程序占用，请关闭相关程序后重试` }
      }
      if (process.platform === 'darwin') {
        const res = await this.#sys.runCommand('diskutil', ['eject', drive], 10_000, signal)
        if (res.exitCode !== 0) {
          return { ok: false, success: false, drive, errorCode: 'EJECT_FAILED', error: `EJECT_FAILED: ${res.stderr || res.stdout || `退出码 ${res.exitCode}`}` }
        }
        return { ok: true, success: true, drive, ejected: true }
      }
      return { ok: false, success: false, drive, errorCode: 'UNSUPPORTED_PLATFORM', error: '当前平台不支持弹出磁盘' }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported FileUnlockPlugin function: ${fn}`
    }
  }

  static readonly #WINDOWS_CORE_SERVICES = new Set([
    'rpcss',
    'dcomlaunch',
    'plugplay',
    'eventlog',
    'windefend',
    'wdnissvc',
    'mpssvc',
    'dhcp',
    'dnscache',
    'lanmanworkstation',
    'lanmanserver',
    'schedule',
    'spooler',
    'themes',
    'audiosrv',
    'audioendpointbuilder',
    'bfe',
    'cryptsvc',
    'profsvc',
    'samss',
    'lsm',
    'power',
    'systemeventsbroker',
    'timebrokersvc',
    'usermanager',
    'wcmsvc',
    'winmgmt',
    'wuauserv',
    'trustedinstaller',
    'gpsvc',
    'nsi',
    'keyiso',
    'vaultsvc'
  ])

  static #expandWindowsEnvVars(raw: string): string {
    return (raw ?? '').replace(/%([^%]+)%/g, (full, varName: string) => {
      const envVal = process.env[varName] ?? process.env[varName.toUpperCase()]
      return typeof envVal === 'string' && envVal ? envVal : full
    })
  }

  static #extractExecutableFromCommand(rawCommand: string): string {
    const expanded = SystemRegistryHostPluginHandler.#expandWindowsEnvVars((rawCommand ?? '').trim())
    if (!expanded) return ''

    const quotedMatch = expanded.match(/^"([^"]+)"/)
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim()
    }

    const exeIdxMatch = expanded.match(/^([a-zA-Z]:\\[^\r\n"]*?\.(?:exe|bat|cmd|com|ps1|vbs|lnk|msc))\b/i)
    if (exeIdxMatch?.[1]) {
      return exeIdxMatch[1].trim()
    }

    const posixMatch = expanded.match(/^(\/[^\s"']+)/)
    if (posixMatch?.[1]) {
      return posixMatch[1].trim()
    }

    const firstToken = expanded.split(/\s+/)[0] ?? ''
    return firstToken.replace(/^['"]+|['"]+$/g, '').trim()
  }

  /** 按扫描时的标识选择注册表键：reg:HKLM32 为 32 位视图（WOW6432Node），reg:HKLM 为 64 位系统级，其余为当前用户 */
  static #startupRegistryKeys(id: string, scope = ''): { runKey: string; disabledKey: string; isHklm: boolean } {
    const base = id.startsWith('reg:HKLM32:')
      ? 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion'
      : id.startsWith('reg:HKLM:') || (!id.startsWith('reg:HKCU:') && scope.toUpperCase() === 'HKLM')
        ? 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion'
        : 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion'
    return { runKey: `${base}\\Run`, disabledKey: `${base}\\RunDisabled`, isHklm: base.startsWith('HKLM') }
  }

  /** 只允许当前用户与所有用户「启动」目录下的直接文件（与扫描时 GetFolderPath('Startup' / 'CommonStartup') 一致） */
  static #isInsideStartupFolder(filePath: string): boolean {
    const win = path.win32
    const startupDirs = [
      process.env.APPDATA ? win.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : '',
      win.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp')
    ].filter(Boolean).map(dir => win.resolve(dir).toLowerCase())
    const parent = win.dirname(win.resolve(filePath)).toLowerCase()
    return startupDirs.includes(parent)
  }

  static #isMicrosoftCoreServiceOrTask(item: {
    source?: string
    name?: string
    serviceName?: string
    taskPath?: string
    publisher?: string
    exePath?: string
    command?: string
  }): boolean {
    const src = (item.source ?? '').toLowerCase()
    const svcName = (item.serviceName ?? item.name ?? '').trim().toLowerCase()
    const taskPath = (item.taskPath ?? item.name ?? '').trim()
    const publisher = (item.publisher ?? '').trim().toLowerCase()
    const exePath = (item.exePath ?? SystemRegistryHostPluginHandler.#extractExecutableFromCommand(item.command ?? '')).toLowerCase()

    if (src === 'service') {
      if (SystemRegistryHostPluginHandler.#WINDOWS_CORE_SERVICES.has(svcName)) {
        return true
      }
      if (publisher.includes('microsoft')) {
        return true
      }
      if (
        exePath.startsWith('c:\\windows\\system32\\') ||
        exePath.startsWith('c:\\windows\\syswow64\\') ||
        exePath.includes('\\svchost.exe')
      ) {
        return true
      }
    }

    if (src === 'task') {
      const normalizedTask = taskPath.replace(/\//g, '\\').toLowerCase()
      if (normalizedTask.startsWith('\\microsoft\\') || publisher.includes('microsoft')) {
        return true
      }
    }

    return false
  }

  static #hasDangerousShellTokens(val: string): boolean {
    if (!val) return false
    return /[\0\r\n;|`$]/.test(val)
  }

  /** 扫描 Windows 启动项：任何来源读取失败都写进 warnings；整体失败（退出码非零、超时、输出无法解析）抛错，不能当成“没有启动项” */
  async #scanWindowsStartupItems(signal?: AbortSignal): Promise<{ entries: Array<Record<string, unknown>>; warnings: string[] }> {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      $items = @()
      $warnings = @()

      # 值名可能含 * ? [ ]：-Name 会按通配符匹配，因此读出整个键再按名字精确取值
      function Get-StartupApprovedState($hivePath, $valName) {
        if (-not (Test-Path -LiteralPath $hivePath)) { return $true }
        $all = Get-ItemProperty -LiteralPath $hivePath -ErrorAction SilentlyContinue
        if ($null -eq $all) { return $true }
        $prop = $all.PSObject.Properties[$valName]
        if ($null -eq $prop) { return $true }
        $bytes = $prop.Value
        if ($bytes -is [byte[]] -and $bytes.Length -ge 1) {
          $b0 = $bytes[0]
          if ($b0 -eq 3 -or $b0 -eq 1 -or ($b0 % 2 -eq 1)) { return $false }
        }
        return $true
      }

      $regRoots = @(
        @{ Key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; Enabled = $true; Scope = 'HKCU'; IdScope = 'HKCU' },
        @{ Key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKCU'; IdScope = 'HKCU' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; Enabled = $true; Scope = 'HKLM'; IdScope = 'HKLM' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKLM'; IdScope = 'HKLM' },
        @{ Key = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; Approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32'; Enabled = $true; Scope = 'HKLM'; IdScope = 'HKLM32' },
        @{ Key = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKLM'; IdScope = 'HKLM32' }
      )

      foreach ($r in $regRoots) {
        try {
          if (Test-Path -LiteralPath $r.Key) {
            $props = Get-ItemProperty -LiteralPath $r.Key
            foreach ($p in $props.PSObject.Properties) {
              if ($p.Name -in @('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider')) { continue }
              $cmdStr = [string]$p.Value
              if (-not $cmdStr) { continue }
              $isEnabled = if ($r.Enabled -and $r.Approved) { Get-StartupApprovedState $r.Approved $p.Name } else { $r.Enabled }
              $items += [PSCustomObject]@{
                id = "reg:$($r.IdScope):$($p.Name)"
                name = [string]$p.Name
                command = $cmdStr
                source = 'registry'
                sourceLabel = '注册表'
                scope = $r.Scope
                regKey = ($r.Key -replace '^HKCU:\\\\', 'HKCU\\' -replace '^HKLM:\\\\', 'HKLM\\')
                enabled = [bool]$isEnabled
                publisher = ''
              }
            }
          }
        } catch { $warnings += "注册表 $($r.Key)：$($_.Exception.Message)" }
      }

      $shell = $null
      try { $shell = New-Object -ComObject WScript.Shell } catch { $warnings += "无法解析启动目录快捷方式：$($_.Exception.Message)" }
      $startupFolders = @(
        @{ Path = [Environment]::GetFolderPath('Startup'); Scope = 'User' },
        @{ Path = [Environment]::GetFolderPath('CommonStartup'); Scope = 'System' }
      )
      foreach ($sf in $startupFolders) {
        try {
          if ($sf.Path -and (Test-Path -LiteralPath $sf.Path)) {
            Get-ChildItem -LiteralPath $sf.Path -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
              $isDisabledExt = $_.Extension -eq '.disabled'
              $displayName = if ($isDisabledExt) { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) } else { $_.BaseName }
              # 快捷方式要检查它指向的程序是否存在，.lnk 文件本身永远存在
              $target = ''
              if ($shell -and ($_.Name -match '\\.lnk(\\.disabled)?$')) {
                try { $target = [string]$shell.CreateShortcut($_.FullName).TargetPath } catch { $target = '' }
              }
              $items += [PSCustomObject]@{
                id = "folder:$($_.FullName)"
                name = $displayName
                command = $_.FullName
                exePath = if ($target) { $target } else { $_.FullName }
                source = 'folder'
                sourceLabel = '启动目录'
                scope = $sf.Scope
                enabled = (-not $isDisabledExt)
                publisher = ''
              }
            }
          }
        } catch { $warnings += "启动目录 $($sf.Path)：$($_.Exception.Message)" }
      }

      try {
        Get-CimInstance Win32_Service | Where-Object {
          $_.PathName -and
          ($_.PathName -notmatch '(?i)^"?C:\\\\Windows\\\\') -and
          ($_.PathName -notmatch '(?i)svchost\\.exe')
        } | ForEach-Object {
          $items += [PSCustomObject]@{
            id = "service:$($_.Name)"
            name = if ($_.DisplayName) { [string]$_.DisplayName } else { [string]$_.Name }
            serviceName = [string]$_.Name
            command = [string]$_.PathName
            source = 'service'
            sourceLabel = '后台服务'
            scope = 'System'
            enabled = ($_.StartMode -eq 'Auto')
            publisher = ''
          }
        }
      } catch { $warnings += "后台服务：$($_.Exception.Message)" }

      try {
        Get-ScheduledTask | Where-Object {
          $_.TaskPath -notlike '\\Microsoft*' -and $_.TaskPath -notlike '\\Apple*'
        } | ForEach-Object {
          $act = $_.Actions | Select-Object -First 1
          $exe = if ($act -and $act.Execute) { [string]$act.Execute } else { '' }
          $arg = if ($act -and $act.Arguments) { [string]$act.Arguments } else { '' }
          $fullCmd = if ($arg) { "$exe $arg" } else { $exe }
          if ($fullCmd) {
            $fullTaskName = "$($_.TaskPath)$($_.TaskName)"
            $items += [PSCustomObject]@{
              id = "task:$fullTaskName"
              name = [string]$_.TaskName
              taskPath = $fullTaskName
              command = $fullCmd
              source = 'task'
              sourceLabel = '计划任务'
              scope = 'System'
              enabled = ($_.State -ne 'Disabled')
              publisher = if ($_.Author) { [string]$_.Author } else { '' }
            }
          }
        }
      } catch { $warnings += "计划任务：$($_.Exception.Message)" }

      @{ items = @($items); warnings = @($warnings) } | ConvertTo-Json -Compress -Depth 5
    `
    const parsed = JSON.parse(await this.#sys.runPowerShell(psScript, 30_000, signal)) as { items?: unknown; warnings?: unknown }
    if (!parsed || !Array.isArray(parsed.items)) throw new Error('启动项扫描结果格式无效')
    return {
      entries: (parsed.items as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object')),
      warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as unknown[]).map(String).filter(Boolean) : []
    }
  }

  #normalizeStartupEntries(rawList: Array<Record<string, unknown>>): Array<{
    id: string
    name: string
    publisher: string
    command: string
    exePath: string
    source: 'registry' | 'folder' | 'service' | 'task' | 'launchd'
    sourceLabel: '注册表' | '启动目录' | '后台服务' | '计划任务' | 'LaunchAgent'
    scope: string
    regKey?: string | undefined
    serviceName?: string | undefined
    taskPath?: string | undefined
    enabled: boolean
    fileMissing: boolean
  }> {
    const normalized: Array<{
      id: string
      name: string
      publisher: string
      command: string
      exePath: string
      source: 'registry' | 'folder' | 'service' | 'task' | 'launchd'
      sourceLabel: '注册表' | '启动目录' | '后台服务' | '计划任务' | 'LaunchAgent'
      scope: string
      regKey?: string | undefined
      serviceName?: string | undefined
      taskPath?: string | undefined
      enabled: boolean
      fileMissing: boolean
    }> = []

    const seenIds = new Set<string>()
    for (const raw of rawList) {
      const rawSource = String(raw.source ?? 'registry').toLowerCase()
      const source: 'registry' | 'folder' | 'service' | 'task' | 'launchd' =
        rawSource === 'folder' || rawSource === 'service' || rawSource === 'task' || rawSource === 'launchd'
          ? (rawSource as 'folder' | 'service' | 'task' | 'launchd')
          : 'registry'

      const name = String(raw.name ?? '').trim()
      const command = String(raw.command ?? raw.path ?? '').trim()
      if (!name || !command) continue

      const exePath =
        typeof raw.exePath === 'string' && raw.exePath.trim()
          ? SystemRegistryHostPluginHandler.#expandWindowsEnvVars(raw.exePath.trim())
          : SystemRegistryHostPluginHandler.#extractExecutableFromCommand(command)

      const publisher = String(raw.publisher ?? '').trim()
      const serviceName = typeof raw.serviceName === 'string' ? raw.serviceName.trim() : undefined
      const taskPath = typeof raw.taskPath === 'string' ? raw.taskPath.trim() : undefined
      const regKey = typeof raw.regKey === 'string' ? raw.regKey.trim() : undefined

      if (
        SystemRegistryHostPluginHandler.#isMicrosoftCoreServiceOrTask({
          source,
          name,
          ...(serviceName ? { serviceName } : {}),
          ...(taskPath ? { taskPath } : {}),
          publisher,
          exePath,
          command
        })
      ) {
        continue
      }

      const id = String(raw.id ?? `${source}:${serviceName ?? taskPath ?? name}`)
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const sourceLabel: '注册表' | '启动目录' | '后台服务' | '计划任务' | 'LaunchAgent' =
        source === 'folder'
          ? '启动目录'
          : source === 'service'
            ? '后台服务'
            : source === 'task'
              ? '计划任务'
              : source === 'launchd'
                ? 'LaunchAgent'
                : '注册表'

      let fileMissing = false
      if (typeof raw.fileMissing === 'boolean') {
        fileMissing = raw.fileMissing
      } else if (exePath && (path.isAbsolute(exePath) || /^[a-zA-Z]:[\\/]/.test(exePath))) {
        fileMissing = !fsSync.existsSync(exePath)
      }

      normalized.push({
        id,
        name,
        publisher,
        command,
        exePath,
        source,
        sourceLabel,
        scope: String(raw.scope ?? (source === 'service' || source === 'task' ? 'System' : 'User')),
        ...(regKey ? { regKey } : {}),
        ...(serviceName ? { serviceName } : {}),
        ...(taskPath ? { taskPath } : {}),
        enabled: Boolean(raw.enabled),
        fileMissing
      })
    }

    return normalized
  }

  static #isAccessDeniedText(text: string): boolean {
    return /拒绝访问|Access is denied/i.test(text)
  }

  /**
   * 查询启动项注册表值：reg query 退出码 0 为存在（解析字符串值），1 为不存在（输出含拒绝访问时除外），其余为查询失败。
   * 不依赖本地化的“找不到”文本（中文系统实际是“错误: 系统找不到指定的注册表项或值。”）。
   */
  async #queryStartupRegistryValue(key: string, name: string, signal?: AbortSignal): Promise<
    { state: 'absent' } | { state: 'present'; value: string } | { state: 'error'; errorCode: string; error: string }
  > {
    const res = await this.#sys.runCommand('reg', ['query', key, '/v', name], 5_000, signal)
    if (res.exitCode === 0) {
      const m = res.stdout.match(/(REG_(?:EXPAND_)?SZ)\s+(.+)$/im)
      return { state: 'present', value: m?.[2]?.trim() ?? '' }
    }
    const text = `${res.stderr} ${res.stdout}`.trim()
    const denied = SystemRegistryHostPluginHandler.#isAccessDeniedText(text)
    // reg query 对“不存在”和“拒绝访问”都返回 1，只靠中英文提示区分在其他语言系统上会把拒绝访问误判为不存在。
    // 因此再列出整个键（不存在时再看父键的子键列表），按值名 / 键名精确比对确认确实不存在
    if (res.exitCode === 1 && !denied && (await this.#confirmRegistryValueAbsent(key, name, signal))) return { state: 'absent' }
    return {
      state: 'error',
      errorCode: denied ? 'ADMIN_REQUIRED' : 'REGISTRY_QUERY_FAILED',
      error: `读取 ${key} 失败：${text || `退出码 ${res.exitCode}`}`
    }
  }

  /** 与系统语言无关地确认注册表值不存在：键可读且没有同名值，或父键可读且没有这个子键；无法确认时返回 false */
  async #confirmRegistryValueAbsent(key: string, name: string, signal?: AbortSignal): Promise<boolean> {
    const listing = await this.#sys.runCommand('reg', ['query', key], 5_000, signal)
    if (listing.exitCode === 0) {
      const lower = name.toLowerCase()
      return !listing.stdout.split(/\r?\n/).some(line => {
        const m = line.match(/^\s{2,}(.+?)\s{2,}REG_[A-Z_]+(?:\s|$)/)
        return m?.[1]?.toLowerCase() === lower
      })
    }
    const cut = key.lastIndexOf('\\')
    if (cut <= 0) return false
    const parent = await this.#sys.runCommand('reg', ['query', key.slice(0, cut)], 5_000, signal)
    if (parent.exitCode !== 0) return false
    const lowerKey = key.toLowerCase()
    return !parent.stdout.split(/\r?\n/).some(line => line.trim().toLowerCase() === lowerKey)
  }

  /** 确认启动项指向的程序确实不存在：返回 null 表示确认缺失；路径不完整、在网络位置、所在磁盘不可用或无法读取时都不能当成残留 */
  static async #confirmStartupTargetMissing(exePath: string): Promise<{ errorCode: string; error: string } | null> {
    const exe = SystemRegistryHostPluginHandler.#expandWindowsEnvVars((exePath ?? '').trim())
    const isDriveAbsolute = /^[a-zA-Z]:[\\/]/.test(exe)
    if (/^[\\/]{2}/.test(exe)) {
      return { errorCode: 'CANNOT_VERIFY', error: `目标程序在网络位置（${exe}），网络不可用时无法确认是否存在，不作为残留删除` }
    }
    if (!exe || (!isDriveAbsolute && !path.isAbsolute(exe))) {
      return { errorCode: 'CANNOT_VERIFY', error: '无法从启动命令解析出目标程序的完整路径，不能确认是残留' }
    }
    const root = isDriveAbsolute ? exe.slice(0, 3) : path.parse(exe).root
    if (!fsSync.existsSync(root)) {
      return { errorCode: 'CANNOT_VERIFY', error: `目标程序所在磁盘 ${root} 当前不可用（可能是未插入的移动磁盘），不作为残留删除` }
    }
    try {
      await fs.stat(exe)
      return { errorCode: 'ITEM_NOT_BROKEN', error: `目标程序仍存在，不是残留（${exe}），如需停止开机启动请使用禁用` }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return null
      return { errorCode: 'CANNOT_VERIFY', error: `无法确认目标程序是否存在（${exe}）：${err instanceof Error ? err.message : String(err)}` }
    }
  }

  /** 清理注册表残留启动项：Run 与 RunDisabled 两处逐一 reg query，存在的值都确认目标程序缺失后才 reg delete，删除退出码非零即失败 */
  async #removeBrokenRegistryStartup(id: string, name: string, scope: string, dryRun: boolean, signal?: AbortSignal): Promise<
    { status: 'removed' | 'gone' } | { status: 'failed'; errorCode: string; error: string }
  > {
    if (!name) return { status: 'failed', errorCode: 'INVALID_IDENTIFIER', error: '缺少注册表启动项名称' }
    const { runKey, disabledKey } = SystemRegistryHostPluginHandler.#startupRegistryKeys(id, scope)
    const present: Array<{ key: string; value: string }> = []
    for (const key of [runKey, disabledKey]) {
      const q = await this.#queryStartupRegistryValue(key, name, signal)
      if (q.state === 'error') return { status: 'failed', errorCode: q.errorCode, error: q.error }
      if (q.state === 'present') present.push({ key, value: q.value })
    }
    // 两处都已不存在：残留已不在（可能已被别处清理），不需要删除
    if (present.length === 0) return { status: 'gone' }
    for (const { key, value } of present) {
      const exe = value ? SystemRegistryHostPluginHandler.#extractExecutableFromCommand(value) : ''
      const problem = await SystemRegistryHostPluginHandler.#confirmStartupTargetMissing(exe)
      if (problem) return { status: 'failed', errorCode: problem.errorCode, error: `${key}：${problem.error}` }
    }
    if (dryRun) return { status: 'removed' }
    const errors: string[] = []
    for (const { key } of present) {
      const res = await this.#sys.runCommand('reg', ['delete', key, '/v', name, '/f'], 5_000, signal)
      if (res.exitCode !== 0) errors.push(`${key}：${(res.stderr || res.stdout).trim() || `退出码 ${res.exitCode}`}`)
    }
    if (errors.length) {
      const denied = errors.some(text => SystemRegistryHostPluginHandler.#isAccessDeniedText(text))
      return { status: 'failed', errorCode: denied ? 'ADMIN_REQUIRED' : 'REGISTRY_DELETE_FAILED', error: errors.join('；') }
    }
    return { status: 'removed' }
  }

  /** 清理启动目录残留：只处理目标程序已不存在的快捷方式（.lnk），目标由宿主解析；启动目录里的程序或脚本本身存在就不是残留 */
  async #removeBrokenStartupFile(filePath: string, dryRun: boolean, signal?: AbortSignal): Promise<
    { status: 'removed' | 'gone' } | { status: 'failed'; errorCode: string; error: string }
  > {
    if (!filePath || !path.isAbsolute(filePath) || !SystemRegistryHostPluginHandler.#isInsideStartupFolder(filePath)) {
      return { status: 'failed', errorCode: 'INVALID_PATH', error: '只能清理系统启动目录中的文件' }
    }
    try {
      await fs.lstat(filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return { status: 'gone' }
      return { status: 'failed', errorCode: 'CANNOT_VERIFY', error: `无法读取启动目录文件：${err instanceof Error ? err.message : String(err)}` }
    }
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.lnk.disabled')) {
      return { status: 'failed', errorCode: 'CANNOT_VERIFY', error: '已禁用的快捷方式无法解析目标程序，请先启用后重新检测' }
    }
    if (!lower.endsWith('.lnk')) {
      return { status: 'failed', errorCode: 'ITEM_NOT_BROKEN', error: '启动目录中的这个文件本身就是要运行的程序或脚本，它仍然存在，不是残留' }
    }
    let target: string
    try {
      const out = await this.#sys.runPowerShell(
        `$ErrorActionPreference = 'Stop'
        $target = [string](New-Object -ComObject WScript.Shell).CreateShortcut('${escapePsSingleQuoted(filePath)}').TargetPath
        Write-Output ('TARGET:' + $target)`,
        8_000,
        signal
      )
      const line = SystemRegistryHostPluginHandler.#lastStatusLine(out)
      if (!line.startsWith('TARGET:')) {
        return { status: 'failed', errorCode: 'CANNOT_VERIFY', error: '解析快捷方式目标未得到结果，不能确认是残留' }
      }
      target = line.slice('TARGET:'.length).trim()
    } catch (err) {
      return { status: 'failed', errorCode: 'CANNOT_VERIFY', error: `解析快捷方式目标失败，不能确认是残留：${err instanceof Error ? err.message : String(err)}` }
    }
    // 目标为空（如 Windows Installer 发布的快捷方式）同样无法确认，交给 #confirmStartupTargetMissing 拒绝
    const problem = await SystemRegistryHostPluginHandler.#confirmStartupTargetMissing(target)
    if (problem) return { status: 'failed', ...problem }
    if (dryRun) return { status: 'removed' }
    try {
      await fs.rm(filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') return { status: 'gone' }
      const denied = code === 'EPERM' || code === 'EACCES'
      return {
        status: 'failed',
        errorCode: denied ? 'ADMIN_REQUIRED' : 'FOLDER_DELETE_FAILED',
        error: denied ? '删除所有用户启动目录中的文件需要管理员权限' : err instanceof Error ? err.message : String(err)
      }
    }
    return { status: 'removed' }
  }

  async handleStartupManager(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    void caller
    const lowerFn = fn.toLowerCase().replace(/[-_\s]/g, '')

    if (
      lowerFn === 'listall' ||
      lowerFn === 'scan' ||
      lowerFn === 'list' ||
      lowerFn === 'getstartupitems' ||
      lowerFn === 'liststartupitems'
    ) {
      let rawEntries: Array<Record<string, unknown>> = []
      let scanWarnings: string[] = []
      if (process.platform === 'win32') {
        try {
          const scanned = await this.#scanWindowsStartupItems(signal)
          rawEntries = scanned.entries
          scanWarnings = scanned.warnings
        } catch (err) {
          const timedOut = err instanceof PowerShellError && err.exitCode === 124
          return {
            ok: false, success: false, errorCode: timedOut ? 'SCAN_TIMEOUT' : 'SCAN_FAILED',
            error: `${timedOut ? 'SCAN_TIMEOUT' : 'SCAN_FAILED'}: 读取启动项失败，不能当作没有启动项：${err instanceof Error ? err.message : String(err)}`
          }
        }
      } else if (process.platform === 'darwin') {
        const agentDirs = [
          path.join(os.homedir(), 'Library', 'LaunchAgents'),
          '/Library/LaunchAgents'
        ]
        for (const dir of agentDirs) {
          if (!fsSync.existsSync(dir)) continue
          try {
            const files = await fs.readdir(dir)
            for (const f of files) {
              if (!f.endsWith('.plist') && !f.endsWith('.plist.disabled')) continue
              const full = path.join(dir, f)
              const enabled = !f.endsWith('.disabled')
              rawEntries.push({
                id: `launchd:${full}`,
                name: f.replace(/\.plist(\.disabled)?$/, ''),
                command: full,
                exePath: full,
                source: 'launchd',
                sourceLabel: 'LaunchAgent',
                scope: dir.startsWith('/Library') ? 'System' : 'User',
                enabled,
                fileMissing: false
              })
            }
          } catch {
            // ignore
          }
        }
      }

      const items = this.#normalizeStartupEntries(rawEntries)
      const enabledCount = items.filter((i) => i.enabled).length
      const serviceCount = items.filter((i) => i.source === 'service').length
      const taskCount = items.filter((i) => i.source === 'task').length
      const brokenCount = items.filter((i) => i.fileMissing).length

      return {
        ok: true,
        success: true,
        items,
        startupItems: items,
        totalCount: items.length,
        enabledCount,
        serviceCount,
        taskCount,
        brokenCount,
        ...(scanWarnings.length ? { warnings: scanWarnings, partial: true } : {})
      }
    }

    if (
      lowerFn === 'setenabled' ||
      lowerFn === 'toggle' ||
      lowerFn === 'togglestartupitem' ||
      lowerFn === 'setstartupitemstate'
    ) {
      const id = String(params.id ?? '').trim()
      const name = String(params.name ?? '').trim()
      const source = String(params.source ?? 'registry').trim().toLowerCase()
      const targetEnabled = Boolean(params.enabled)
      const commandVal = String(params.command ?? '').trim()
      const serviceName = String(params.serviceName ?? name).trim()
      const taskPath = String(params.taskPath ?? name).trim()
      const scope = String(params.scope ?? 'User').trim()

      if (!name && !id) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_IDENTIFIER',
          error: 'INVALID_IDENTIFIER: 缺少启动项名称或标识 (id/name)'
        }
      }

      if (
        SystemRegistryHostPluginHandler.#hasDangerousShellTokens(id) ||
        SystemRegistryHostPluginHandler.#hasDangerousShellTokens(name) ||
        SystemRegistryHostPluginHandler.#hasDangerousShellTokens(serviceName) ||
        SystemRegistryHostPluginHandler.#hasDangerousShellTokens(taskPath)
      ) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_IDENTIFIER',
          error: 'INVALID_IDENTIFIER: 启动项标识包含非法控制字符或注入风险片段，已安全拦截'
        }
      }

      if (
        SystemRegistryHostPluginHandler.#isMicrosoftCoreServiceOrTask({
          source,
          name,
          serviceName,
          taskPath,
          publisher: String(params.publisher ?? ''),
          exePath: String(params.exePath ?? ''),
          command: commandVal
        })
      ) {
        return {
          ok: false,
          success: false,
          errorCode: 'PROTECTED_SYSTEM_ITEM',
          error: 'PROTECTED_SYSTEM_ITEM: 微软系统核心服务或系统计划任务受保护，禁止修改或禁用'
        }
      }

      if (params.dryRun === true) {
        return {
          ok: true,
          success: true,
          id: id || `${source}:${name}`,
          name,
          source,
          enabled: targetEnabled
        }
      }

      if (source === 'registry' && process.platform === 'win32') {
        const { runKey, disabledKey, isHklm } = SystemRegistryHostPluginHandler.#startupRegistryKeys(id, scope)
        const srcKey = targetEnabled ? disabledKey : runKey
        const dstKey = targetEnabled ? runKey : disabledKey

        // 启动命令只从注册表原位置读取，不接受调用方传入，避免写入任意开机启动命令；写回时保留原值类型（REG_EXPAND_SZ 中的 %VAR% 才会展开）
        let resolvedCmd = ''
        let valueType = 'REG_SZ'
        const q = await this.#sys.runCommand('reg', ['query', srcKey, '/v', name], 5_000, signal)
        if (q.exitCode === 0) {
          const m = q.stdout.match(/(REG_(?:EXPAND_)?SZ)\s+(.+)$/im)
          if (m?.[2]) { valueType = m[1]!.toUpperCase(); resolvedCmd = m[2].trim() }
        }
        if (!resolvedCmd) {
          return {
            ok: false,
            success: false,
            errorCode: 'ITEM_NOT_FOUND',
            error: `ITEM_NOT_FOUND: 未找到注册表自启项 "${name}"`
          }
        }

        const addRes = await this.#sys.runCommand(
          'reg',
          ['add', dstKey, '/v', name, '/t', valueType, '/d', resolvedCmd, '/f'],
          8_000,
          signal
        )
        if (addRes.exitCode !== 0) {
          const outErr = `${addRes.stderr} ${addRes.stdout}`
          const isDenied = /拒绝访问|Access is denied/i.test(outErr)
          return {
            ok: false,
            success: false,
            errorCode: isDenied ? 'ADMIN_REQUIRED' : 'REGISTRY_WRITE_FAILED',
            error: isDenied
              ? `ADMIN_REQUIRED: 修改${isHklm ? '系统级' : ''}注册表自启项需要管理员权限`
              : outErr.trim() || '修改注册表自启状态失败'
          }
        }
        // 原位置删除失败时同一项会同时留在两处，开机照样启动：回滚刚写入的值并如实报错
        const delRes = await this.#sys.runCommand('reg', ['delete', srcKey, '/v', name, '/f'], 5_000, signal)
        if (delRes.exitCode !== 0) {
          const rollback = await this.#sys.runCommand('reg', ['delete', dstKey, '/v', name, '/f'], 5_000, signal)
          return {
            ok: false, success: false, errorCode: 'REGISTRY_WRITE_FAILED',
            error: `REGISTRY_WRITE_FAILED: 移除原启动项失败（${delRes.stderr || `退出码 ${delRes.exitCode}`}）${rollback.exitCode === 0 ? '，已撤销本次修改' : '，撤销也未完成，请检查 Run 与 RunDisabled 两处'}`
          }
        }
        return {
          ok: true,
          success: true,
          id: id || `reg:${isHklm ? 'HKLM' : 'HKCU'}:${name}`,
          name,
          source,
          enabled: targetEnabled
        }
      }

      if (source === 'service' && process.platform === 'win32') {
        if (!/^[A-Za-z0-9_.\- ()]+$/.test(serviceName)) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_IDENTIFIER',
            error: 'INVALID_IDENTIFIER: 非法的服务名格式'
          }
        }
        const startMode = targetEnabled ? 'auto' : 'demand'
        const cfgRes = await this.#sys.runCommand('sc.exe', ['config', serviceName, `start=`, startMode], 8_000, signal)
        if (cfgRes.exitCode !== 0) {
          const outErr = `${cfgRes.stderr} ${cfgRes.stdout}`
          const isDenied = cfgRes.exitCode === 5 || /拒绝访问|Access is denied|FAILED 5\b/i.test(outErr)
          return {
            ok: false,
            success: false,
            errorCode: isDenied ? 'ADMIN_REQUIRED' : 'SERVICE_UPDATE_FAILED',
            error: isDenied
              ? `ADMIN_REQUIRED: 修改后台服务 "${serviceName}" 启动类型需要管理员权限`
              : outErr.trim() || '修改后台服务启动模式失败'
          }
        }
        return {
          ok: true,
          success: true,
          id: id || `service:${serviceName}`,
          name,
          source,
          enabled: targetEnabled
        }
      }

      if (source === 'task' && process.platform === 'win32') {
        const flag = targetEnabled ? '/ENABLE' : '/DISABLE'
        const taskRes = await this.#sys.runCommand('schtasks', ['/Change', '/TN', taskPath, flag], 8_000, signal)
        if (taskRes.exitCode !== 0) {
          const outErr = `${taskRes.stderr} ${taskRes.stdout}`
          const isDenied = /拒绝访问|Access is denied/i.test(outErr)
          return {
            ok: false,
            success: false,
            errorCode: isDenied ? 'ADMIN_REQUIRED' : 'TASK_UPDATE_FAILED',
            error: isDenied
              ? `ADMIN_REQUIRED: 修改计划任务 "${taskPath}" 状态需要管理员权限`
              : outErr.trim() || '修改计划任务状态失败'
          }
        }
        return {
          ok: true,
          success: true,
          id: id || `task:${taskPath}`,
          name,
          source,
          enabled: targetEnabled
        }
      }

      if (source === 'folder' || source === 'launchd') {
        const filePath = commandVal
        if (!filePath || !path.isAbsolute(filePath)) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_PATH',
            error: 'INVALID_PATH: 启动目录项缺少合法文件路径'
          }
        }
        if (source === 'folder' && !SystemRegistryHostPluginHandler.#isInsideStartupFolder(filePath)) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_PATH',
            error: 'INVALID_PATH: 只能启用或禁用系统启动目录中的文件'
          }
        }
        const nextPath = targetEnabled
          ? filePath.replace(/\.disabled$/i, '')
          : filePath.endsWith('.disabled')
            ? filePath
            : `${filePath}.disabled`
        if (!fsSync.existsSync(filePath)) {
          return { ok: false, success: false, errorCode: 'ITEM_NOT_FOUND', error: `ITEM_NOT_FOUND: 启动项文件不存在：${filePath}` }
        }
        try {
          if (filePath !== nextPath) {
            await fs.rename(filePath, nextPath)
          }
          return {
            ok: true,
            success: true,
            id: id || `${source}:${nextPath}`,
            name,
            source,
            enabled: targetEnabled,
            command: nextPath
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          const isDenied = code === 'EACCES' || code === 'EPERM'
          return {
            ok: false,
            success: false,
            errorCode: isDenied ? 'ADMIN_REQUIRED' : 'FOLDER_TOGGLE_FAILED',
            error: isDenied
              ? 'ADMIN_REQUIRED: 修改系统级启动目录文件需要管理员权限'
              : err instanceof Error
                ? err.message
                : String(err)
          }
        }
      }

      return {
        ok: false,
        success: false,
        id: id || `${source}:${name}`,
        errorCode: 'UNSUPPORTED_SOURCE',
        error: `UNSUPPORTED_SOURCE: 当前平台不支持修改此类启动项（${source}）`
      }
    }

    if (
      lowerFn === 'removebroken' ||
      lowerFn === 'cleanbroken' ||
      lowerFn === 'deletebroken'
    ) {
      const rawItems: Array<Record<string, unknown>> = Array.isArray(params.items)
        ? params.items.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
        : params.item && typeof params.item === 'object'
          ? [params.item as Record<string, unknown>]
          : [params]

      if (rawItems.length === 0) {
        return {
          ok: false,
          success: false,
          errorCode: 'EMPTY_ITEMS',
          error: 'EMPTY_ITEMS: 未提供待清理的残留启动项'
        }
      }

      // 先校验全部条目再动手：避免删掉前几项后才因后面的条目非法整体报错、丢掉已删除的结果
      for (const rawItem of rawItems) {
        if (
          SystemRegistryHostPluginHandler.#hasDangerousShellTokens(String(rawItem.id ?? '')) ||
          SystemRegistryHostPluginHandler.#hasDangerousShellTokens(String(rawItem.name ?? ''))
        ) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_IDENTIFIER',
            error: 'INVALID_IDENTIFIER: 启动项标识包含非法字符，拒绝执行清理'
          }
        }
      }

      const dryRun = params.dryRun === true
      // 预览只做只读核验（reg query、解析快捷方式），列出可清理的条目，不删除
      const removedIds: string[] = []
      const alreadyGoneIds: string[] = []
      const failed: Array<{ id: string; errorCode: string; error: string }> = []
      for (const rawItem of rawItems) {
        const id = String(rawItem.id ?? '').trim()
        const name = String(rawItem.name ?? '').trim()
        const source = String(rawItem.source ?? 'registry').trim().toLowerCase()
        const itemId = id || `${source}:${name}`
        // 调用方传来的 fileMissing / exePath 一律不采信：由宿主读取注册表值或快捷方式目标，确认目标程序确实不存在才删除
        if (source !== 'registry' && source !== 'folder') {
          // 服务与计划任务不做删除：误删会破坏已安装软件；请在系统工具里卸载对应程序
          failed.push({ id: itemId, errorCode: 'UNSUPPORTED_SOURCE', error: `${source === 'service' ? '后台服务' : source === 'task' ? '计划任务' : source}不支持作为残留项删除，请在系统中卸载对应程序` })
          continue
        }
        if (process.platform !== 'win32') {
          failed.push({ id: itemId, errorCode: 'UNSUPPORTED_PLATFORM', error: '当前平台不支持清理此类启动项' })
          continue
        }
        const result = source === 'registry'
          ? await this.#removeBrokenRegistryStartup(id, name, String(rawItem.scope ?? ''), dryRun, signal)
          : await this.#removeBrokenStartupFile(String(rawItem.command ?? '').trim(), dryRun, signal)
        if (result.status === 'failed') failed.push({ id: itemId, errorCode: result.errorCode, error: result.error })
        else {
          removedIds.push(itemId)
          if (result.status === 'gone') alreadyGoneIds.push(itemId)
        }
      }

      const details = failed.map(item => `${item.id}：${item.error}`).join('；')
      const doneLabel = dryRun ? '可清理' : '已清理'
      const base = {
        ...(dryRun ? { dryRun: true, removedCount: 0, removedIds: [] as string[], removableIds: removedIds } : { removedCount: removedIds.length, removedIds }),
        ...(alreadyGoneIds.length ? { alreadyGoneIds } : {}),
        failed
      }
      if (failed.length === 0) return { ok: true, success: true, ...base }
      // 部分成功仍是成功（ok:true）：插件传输层在失败时会丢弃 data，已清理的条目必须随成功结果带回
      if (removedIds.length > 0) {
        return {
          ok: true,
          success: true,
          partial: true,
          ...base,
          errorCode: 'PARTIAL_FAILED',
          error: `${doneLabel} ${removedIds.length} 个，${failed.length} 个未清理：${details}`
        }
      }
      // 全部失败：错误文本以错误码开头（插件桥接层在失败时只转发 error 文本，靠前缀识别错误码，如 ADMIN_REQUIRED 提示以管理员身份运行）
      const errorCode = failed[0]!.errorCode
      return { ok: false, success: false, ...base, errorCode, error: `${errorCode}: ${details}` }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported StartupManagerPlugin function: ${fn}`
    }
  }

  // ==================== 04. 外接显示器亮度与控制 (MonitorControlPlugin) ====================
  static #hasUnsafeMonitorToken(value: string): boolean {
    return /[`$;|&<>'"\r\n\0]/.test(value)
  }

  async handleMonitorControl(
    fn: string,
    params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    // 旧接口在 Windows 上编造亮度与分辨率、只调主屏且不读回；真实操作改由 monitor_control 接口（逐屏读回核验）完成
    const monitorPluginOutdated = () => ({
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: '请更新屏幕亮度插件，通过新版接口读取和调节显示器'
    })

    if (
      lowerFn === 'listdisplays' ||
      lowerFn === 'getdisplays' ||
      lowerFn === 'list' ||
      lowerFn === 'scan'
    ) {
      return monitorPluginOutdated()
    }

    if (
      lowerFn === 'setbrightness' ||
      lowerFn === 'adjustbrightness' ||
      lowerFn === 'setallbrightness'
    ) {
      const id = String(params.id ?? params.displayId ?? 'all').trim()
      if (SystemRegistryHostPluginHandler.#hasUnsafeMonitorToken(id)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_DISPLAY_ID',
          error: 'INVALID_DISPLAY_ID: 显示器标识包含非法字符'
        }
      }

      const protocol = String(params.protocol ?? '').trim().toLowerCase()
      if (protocol === 'unsupported') {
        return {
          ok: false,
          success: false,
          errorCode: 'DDC_UNSUPPORTED',
          error: 'DDC_UNSUPPORTED: 该显示器未开启 DDC/CI 硬件控制或使用了不支持 DDC 的转接线'
        }
      }

      const rawBrightness = Number(params.brightness ?? params.level ?? params.value)
      if (!Number.isFinite(rawBrightness)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_BRIGHTNESS',
          error: 'INVALID_BRIGHTNESS: 亮度值必须为有效的数字 (0-100)'
        }
      }
      const clampedBrightness = Math.max(0, Math.min(100, Math.round(rawBrightness)))

      // 只做参数校验与预览，不改任何状态
      if (params.dryRun !== true) return monitorPluginOutdated()

      return {
        ok: true,
        success: true,
        id,
        brightness: clampedBrightness
      }
    }

    if (lowerFn === 'setcontrast') {
      const id = String(params.id ?? params.displayId ?? '').trim()
      if (!id || SystemRegistryHostPluginHandler.#hasUnsafeMonitorToken(id)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_DISPLAY_ID',
          error: 'INVALID_DISPLAY_ID: 显示器标识无效'
        }
      }
      const protocol = String(params.protocol ?? '').trim().toLowerCase()
      if (protocol === 'unsupported' || protocol === 'wmi') {
        return {
          ok: false,
          success: false,
          errorCode: 'CONTRAST_UNSUPPORTED',
          error: 'CONTRAST_UNSUPPORTED: 该显示器不支持硬件对比度调节'
        }
      }
      const rawContrast = Number(params.contrast ?? params.value)
      if (!Number.isFinite(rawContrast)) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_CONTRAST',
          error: 'INVALID_CONTRAST: 对比度值必须为有效的数字 (0-100)'
        }
      }
      const clampedContrast = Math.max(0, Math.min(100, Math.round(rawContrast)))
      if (params.dryRun !== true) return monitorPluginOutdated()
      return {
        ok: true,
        success: true,
        id,
        contrast: clampedContrast
      }
    }

    if (lowerFn === 'sleepmonitors' || lowerFn === 'turnoffmonitors' || lowerFn === 'sleep') {
      if (params.dryRun !== true) return monitorPluginOutdated()
      return {
        ok: true,
        success: true,
        action: 'sleepMonitors',
        message: '已发送关闭显示器电源信号'
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported MonitorControlPlugin function: ${fn}`
    }
  }

  // ==================== 05. 防休眠常亮助手 (CaffeinePlugin) ====================
  #caffeineSession: {
    active: boolean
    mode: 'display' | 'system'
    durationMinutes: number
    startedAtMs: number | null
    expiresAtMs: number | null
    timer: ReturnType<typeof setTimeout> | null
    keepAliveProc: ReturnType<typeof spawn> | null
    sessionId: number
  } = {
    active: false,
    mode: 'display',
    durationMinutes: 0,
    startedAtMs: null,
    expiresAtMs: null,
    timer: null,
    keepAliveProc: null,
    sessionId: 0
  }

  #caffeineStartSeq = 0

  /**
   * 启动防休眠保持进程，并确认它真正生效后才返回：
   * Windows 等 PowerShell 首次调用 SetThreadExecutionState 成功并输出就绪标记；macOS 等 caffeinate 进程成功创建。
   * 进程无法创建（error 事件）、就绪前退出、超时或被取消都如实返回失败，不能报告已激活。
   */
  #startKeepAliveProcess(
    mode: 'display' | 'system',
    signal?: AbortSignal
  ): Promise<{ ok: true; child: ReturnType<typeof spawn> } | { ok: false; errorCode: string; error: string }> {
    const isWindows = process.platform === 'win32'
    const readyMarker = 'ZTOOLS_KEEP_AWAKE_READY'
    let child: ReturnType<typeof spawn>
    try {
      if (isWindows) {
        // PowerShell 会把 0x80000000 以上的十六进制字面量解析成负的 Int32，传给 uint 参数会报错，所以用十进制并显式转换
        // ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED = 0x80000003，ES_CONTINUOUS|ES_SYSTEM_REQUIRED = 0x80000001
        const flags = mode === 'display' ? '[uint32]2147483651' : '[uint32]2147483649'
        // SetThreadExecutionState 返回 0 表示调用失败；Add-Type 失败在 Stop 模式下直接以非零码退出
        const ps = `
          $ErrorActionPreference = 'Stop'
          Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ZKernelPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags); }'
          if ([ZKernelPower]::SetThreadExecutionState(${flags}) -eq 0) { [Console]::Error.WriteLine('SetThreadExecutionState 调用失败'); exit 2 }
          [Console]::Out.WriteLine('${readyMarker}')
          [Console]::Out.Flush()
          while ($true) { Start-Sleep -Seconds 30; if ([ZKernelPower]::SetThreadExecutionState(${flags}) -eq 0) { exit 2 } }
        `
        const encoded = Buffer.from(ps, 'utf16le').toString('base64')
        child = this.#spawnProcess(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
      } else {
        child = this.#spawnProcess('caffeinate', mode === 'display' ? ['-d', '-i'] : ['-i'], { stdio: 'ignore' })
      }
    } catch (err) {
      return Promise.resolve({
        ok: false,
        errorCode: 'KEEP_AWAKE_START_FAILED',
        error: `无法启动防休眠进程：${err instanceof Error ? err.message : String(err)}`
      })
    }

    return new Promise((resolve) => {
      let settled = false
      let stdoutText = ''
      let stderrText = ''
      const timer = setTimeout(() => {
        finish({ ok: false, errorCode: 'KEEP_AWAKE_START_TIMEOUT', error: '防休眠进程启动超时，未确认生效' }, true)
      }, 20_000)
      const onAbort = (): void => {
        finish({ ok: false, errorCode: 'CANCELLED', error: '防休眠启动已取消' }, true)
      }
      const finish = (
        result: { ok: true; child: ReturnType<typeof spawn> } | { ok: false; errorCode: string; error: string },
        killChild = false
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('spawn', onSpawn)
        if (killChild) {
          try { child.kill() } catch { /* 进程可能已退出 */ }
        }
        if (result.ok) child.unref()
        resolve(result)
      }
      const onError = (err: Error): void => {
        finish({ ok: false, errorCode: 'KEEP_AWAKE_START_FAILED', error: `无法启动防休眠进程：${err.message}` })
      }
      const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
        const detail = stderrText.trim() || (sig ? `信号 ${sig}` : `退出码 ${code ?? '未知'}`)
        finish({ ok: false, errorCode: 'KEEP_AWAKE_START_FAILED', error: `防休眠进程启动后立即退出：${detail}` })
      }
      const onSpawn = (): void => {
        // macOS：caffeinate 创建成功即生效；Windows 还要等就绪标记
        if (!isWindows) finish({ ok: true, child })
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.once('spawn', onSpawn)
      // 管道持续读取（不读满会阻塞子进程写入），只在就绪前收集内容
      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        stdoutText += chunk.toString()
        if (stdoutText.includes(readyMarker)) finish({ ok: true, child })
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (!settled && stderrText.length < 4096) stderrText += chunk.toString()
      })
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  #clearCaffeineSession(): void {
    if (this.#caffeineSession.timer !== null) {
      clearTimeout(this.#caffeineSession.timer)
      this.#caffeineSession.timer = null
    }
    if (this.#caffeineSession.keepAliveProc !== null) {
      try {
        this.#caffeineSession.keepAliveProc.kill()
      } catch {
        // ignore
      }
      this.#caffeineSession.keepAliveProc = null
    }
    this.#caffeineSession.active = false
    this.#caffeineSession.startedAtMs = null
    this.#caffeineSession.expiresAtMs = null
  }

  #buildCaffeineStatusPayload() {
    if (
      this.#caffeineSession.active &&
      this.#caffeineSession.expiresAtMs !== null &&
      Date.now() >= this.#caffeineSession.expiresAtMs
    ) {
      this.#clearCaffeineSession()
    }
    const now = Date.now()
    const remainingMs =
      this.#caffeineSession.active && this.#caffeineSession.expiresAtMs !== null
        ? Math.max(0, this.#caffeineSession.expiresAtMs - now)
        : null
    return {
      ok: true,
      success: true,
      active: this.#caffeineSession.active,
      mode: this.#caffeineSession.mode,
      durationMinutes: this.#caffeineSession.durationMinutes,
      startedAtMs: this.#caffeineSession.startedAtMs,
      expiresAtMs: this.#caffeineSession.expiresAtMs,
      remainingMs,
      sessionId: this.#caffeineSession.sessionId
    }
  }

  async handleCaffeine(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'getstatus' || lowerFn === 'status') {
      return this.#buildCaffeineStatusPayload()
    }

    if (lowerFn === 'stop' || lowerFn === 'deactivate' || lowerFn === 'disable') {
      this.#caffeineStartSeq += 1
      this.#clearCaffeineSession()
      // 防休眠由常驻保持进程的线程状态维持，#clearCaffeineSession 结束该进程即恢复。以前这里另起一个 PowerShell 调
      // SetThreadExecutionState(ES_CONTINUOUS) 只影响那个临时进程自己的线程，对保持进程无效，失败时还会让停止整体抛错，已去掉
      void signal
      return this.#buildCaffeineStatusPayload()
    }

    if (lowerFn === 'start' || lowerFn === 'activate' || lowerFn === 'enable') {
      const rawDuration = params.durationMinutes ?? params.minutes ?? 0
      const durationMinutes = Number(rawDuration)
      if (!Number.isFinite(durationMinutes) || durationMinutes < 0 || durationMinutes > 10080) {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_DURATION',
          error: 'INVALID_DURATION: 持续时长必须为 0（无限期）或 1~10080 分钟之间的有效数值'
        }
      }

      const rawMode = String(params.mode ?? 'display').trim().toLowerCase()
      if (rawMode !== 'display' && rawMode !== 'system') {
        return {
          ok: false,
          success: false,
          errorCode: 'INVALID_MODE',
          error: 'INVALID_MODE: 防休眠模式仅支持 display（保持屏幕常亮）或 system（仅保持系统后台运行）'
        }
      }

      // 单例收敛：先清理旧定时器/会话，严禁泄漏；启动序号用于识别等待期间被新的启动或停止取代
      this.#clearCaffeineSession()
      const startSeq = ++this.#caffeineStartSeq

      let keepAliveProc: ReturnType<typeof spawn> | null = null
      if (params.dryRun !== true) {
        if (process.platform !== 'win32' && process.platform !== 'darwin') {
          return {
            ok: false,
            success: false,
            errorCode: 'UNSUPPORTED_PLATFORM',
            error: '当前系统不支持防休眠'
          }
        }
        const started = await this.#startKeepAliveProcess(rawMode, signal)
        if (!started.ok) {
          return { ok: false, success: false, errorCode: started.errorCode, error: started.error }
        }
        if (startSeq !== this.#caffeineStartSeq) {
          // 等待期间已有新的启动或停止请求：本次进程作废，不能覆盖新会话
          try { started.child.kill() } catch { /* 进程可能已退出 */ }
          return {
            ok: false,
            success: false,
            errorCode: 'KEEP_AWAKE_SUPERSEDED',
            error: '防休眠启动期间收到了新的操作，本次启动已取消'
          }
        }
        keepAliveProc = started.child
      }

      const now = Date.now()
      const customDurationMs =
        typeof params.durationMs === 'number' && Number.isFinite(params.durationMs) && params.durationMs > 0
          ? Math.round(params.durationMs)
          : Math.round(durationMinutes * 60_000)

      this.#caffeineSession.active = true
      this.#caffeineSession.mode = rawMode
      this.#caffeineSession.durationMinutes = durationMinutes
      this.#caffeineSession.startedAtMs = now
      this.#caffeineSession.expiresAtMs = customDurationMs > 0 ? now + customDurationMs : null
      this.#caffeineSession.sessionId += 1
      this.#caffeineSession.keepAliveProc = keepAliveProc

      if (keepAliveProc) {
        // 保持进程意外退出（被结束、PowerShell 报错）后会话即失效，状态不能继续显示已激活
        const sessionId = this.#caffeineSession.sessionId
        keepAliveProc.once('exit', () => {
          if (this.#caffeineSession.sessionId === sessionId && this.#caffeineSession.keepAliveProc === keepAliveProc) {
            this.#caffeineSession.keepAliveProc = null
            this.#clearCaffeineSession()
          }
        })
      }

      if (customDurationMs > 0) {
        this.#caffeineSession.timer = setTimeout(() => {
          this.#clearCaffeineSession()
        }, customDurationMs)
        if (typeof this.#caffeineSession.timer?.unref === 'function') {
          this.#caffeineSession.timer.unref()
        }
      }

      return this.#buildCaffeineStatusPayload()
    }

    if (lowerFn === 'toggle') {
      const current = this.#buildCaffeineStatusPayload()
      if (current.active) {
        return this.handleCaffeine('stop', params, signal)
      }
      return this.handleCaffeine(
        'start',
        {
          durationMinutes: params.durationMinutes ?? 0,
          mode: params.mode ?? 'display',
          dryRun: params.dryRun
        },
        signal
      )
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported CaffeinePlugin function: ${fn}`
    }
  }

  // ==================== 08. 键盘清洁防误触锁 (CleanKeyboardPlugin) ====================
  #cleanKeyboardSession: {
    locked: boolean
    durationSeconds: number | null
    startedAtMs: number | null
    expiresAtMs: number | null
    blockedKeystrokes: number
    lastBlockedKey: string | null
    timer: ReturnType<typeof setTimeout> | null
  } = {
    locked: false,
    durationSeconds: null,
    startedAtMs: null,
    expiresAtMs: null,
    blockedKeystrokes: 0,
    lastBlockedKey: null,
    timer: null
  }

  #clearCleanKeyboardSession(): void {
    if (this.#cleanKeyboardSession.timer !== null) {
      clearTimeout(this.#cleanKeyboardSession.timer)
      this.#cleanKeyboardSession.timer = null
    }
    this.#cleanKeyboardSession.locked = false
    this.#cleanKeyboardSession.startedAtMs = null
    this.#cleanKeyboardSession.expiresAtMs = null
    ;(this.#ctx.windowControl as { setAlwaysOnTop?: (flag: boolean) => void } | null)?.setAlwaysOnTop?.(false)
  }

  #buildCleanKeyboardStatusPayload() {
    if (
      this.#cleanKeyboardSession.locked &&
      this.#cleanKeyboardSession.expiresAtMs !== null &&
      Date.now() >= this.#cleanKeyboardSession.expiresAtMs
    ) {
      this.#clearCleanKeyboardSession()
    }
    const now = Date.now()
    const remainingSeconds =
      this.#cleanKeyboardSession.locked && this.#cleanKeyboardSession.expiresAtMs !== null
        ? Math.max(0, Math.ceil((this.#cleanKeyboardSession.expiresAtMs - now) / 1000))
        : null
    return {
      ok: true,
      success: true,
      locked: this.#cleanKeyboardSession.locked,
      durationSeconds: this.#cleanKeyboardSession.durationSeconds,
      startedAtMs: this.#cleanKeyboardSession.startedAtMs,
      expiresAtMs: this.#cleanKeyboardSession.expiresAtMs,
      remainingSeconds,
      blockedKeystrokes: this.#cleanKeyboardSession.blockedKeystrokes,
      lastBlockedKey: this.#cleanKeyboardSession.lastBlockedKey
    }
  }

  async handleCleanKeyboard(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'getstatus' || lowerFn === 'status') {
      return this.#buildCleanKeyboardStatusPayload()
    }

    if (lowerFn === 'startcleanlock' || lowerFn === 'lock' || lowerFn === 'start') {
      const rawSec = params.durationSeconds ?? params.seconds
      let durationSeconds: number | null = null
      if (rawSec !== null && rawSec !== undefined && rawSec !== '') {
        const num = Number(rawSec)
        if (!Number.isFinite(num) || num <= 0 || num > 604800) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_DURATION',
            error: 'INVALID_DURATION: 锁定时长必须为正数（1~604800 秒）或 null（无限期）'
          }
        }
        durationSeconds = Math.round(num)
      }

      this.#clearCleanKeyboardSession()
      const now = Date.now()
      this.#cleanKeyboardSession.locked = true
      this.#cleanKeyboardSession.durationSeconds = durationSeconds
      this.#cleanKeyboardSession.startedAtMs = now
      this.#cleanKeyboardSession.expiresAtMs =
        durationSeconds !== null ? now + durationSeconds * 1000 : null
      this.#cleanKeyboardSession.blockedKeystrokes = 0
      this.#cleanKeyboardSession.lastBlockedKey = null
      ;(this.#ctx.windowControl as { setAlwaysOnTop?: (flag: boolean) => void } | null)?.setAlwaysOnTop?.(true)

      if (durationSeconds !== null) {
        this.#cleanKeyboardSession.timer = setTimeout(() => {
          this.#clearCleanKeyboardSession()
        }, durationSeconds * 1000)
        if (typeof this.#cleanKeyboardSession.timer?.unref === 'function') {
          this.#cleanKeyboardSession.timer.unref()
        }
      }

      return this.#buildCleanKeyboardStatusPayload()
    }

    if (lowerFn === 'stopcleanlock' || lowerFn === 'unlock' || lowerFn === 'stop') {
      this.#clearCleanKeyboardSession()
      return this.#buildCleanKeyboardStatusPayload()
    }

    if (lowerFn === 'recordblockedkey' || lowerFn === 'interceptkey') {
      if (this.#cleanKeyboardSession.locked) {
        this.#cleanKeyboardSession.blockedKeystrokes += 1
        this.#cleanKeyboardSession.lastBlockedKey = String(params.key ?? 'Key')
      }
      return this.#buildCleanKeyboardStatusPayload()
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported CleanKeyboardPlugin function: ${fn}`
    }
  }

  // ==================== 10. 全局热键冲突侦测 (HotkeyRadarPlugin) ====================
  static readonly #SYSTEM_RESERVED_HOTKEYS = new Set([
    'WIN+L',
    'CTRL+ALT+DEL',
    'CTRL+ALT+DELETE',
    'ALT+TAB',
    'WIN+D',
    'WIN+E',
    'WIN+R',
    'WIN+TAB',
    'WIN+X'
  ])

  static readonly #KNOWN_HOTKEY_SUSPECTS: ReadonlyArray<{
    comboUpper: string
    processNames: string[]
    appName: string
    modifyGuide: string
  }> = [
    {
      comboUpper: 'CTRL+ALT+A',
      processNames: ['wechat.exe', 'weixin.exe', 'qq.exe', 'tim.exe', 'dingtalk.exe'],
      appName: '微信 / QQ / 钉钉截图',
      modifyGuide: '打开微信/QQ -> 设置 -> 快捷键 -> 截取屏幕，修改或清空热键'
    },
    {
      comboUpper: 'CTRL+ALT+S',
      processNames: ['qq.exe', 'cloudmusic.exe'],
      appName: 'QQ 录屏 / 网易云音乐',
      modifyGuide: '打开 QQ 或网易云音乐设置 -> 快捷键 -> 取消全局快捷键勾选'
    },
    {
      comboUpper: 'CTRL+ALT+P',
      processNames: ['cloudmusic.exe', 'qqmusic.exe'],
      appName: '网易云音乐 / QQ音乐播放控制',
      modifyGuide: '打开音乐软件设置 -> 快捷键 -> 禁用启用全局快捷键'
    },
    {
      comboUpper: 'CTRL+ALT+D',
      processNames: ['cloudmusic.exe', 'eudic.exe', 'youdaodict.exe'],
      appName: '网易云桌面歌词 / 欧路/有道词典',
      modifyGuide: '在软件设置中关闭全局桌面歌词或取词快捷键'
    },
    {
      comboUpper: 'ALT+Z',
      processNames: ['nvcontainer.exe', 'nvidia share.exe', 'nvidia overlay.exe'],
      appName: 'NVIDIA GeForce Experience 游戏内覆盖',
      modifyGuide: '打开 NVIDIA App / GeForce Experience -> 设置 -> 关闭游戏内覆盖 (In-Game Overlay)'
    },
    {
      comboUpper: 'ALT+R',
      processNames: ['nvcontainer.exe', 'radeonsoftware.exe', 'amddvr.exe'],
      appName: 'NVIDIA 性能图层 / AMD Radeon Adrenalin',
      modifyGuide: '打开显卡控制面板 -> 热键设置 -> 修改性能监控或驱动面板快捷键'
    },
    {
      comboUpper: 'CTRL+SHIFT+F',
      processNames: ['sogoucloud.exe', 'imeutil.exe', 'wechatime.exe', 'ctfmon.exe'],
      appName: '微软拼音 / 搜狗输入法繁简切换',
      modifyGuide: '打开系统设置 -> 时间和语言 -> 输入 -> 高级键盘设置 / 输入法按键设置 -> 关闭 Ctrl+Shift+F 简繁切换'
    },
    {
      comboUpper: 'CTRL+SPACE',
      processNames: ['ctfmon.exe', 'sogoucloud.exe'],
      appName: '系统输入法中英文切换',
      modifyGuide: '系统输入法设置 -> 按键 -> 更改输入法切换热键'
    },
    {
      comboUpper: 'CTRL+ALT+W',
      processNames: ['wechat.exe', 'weixin.exe'],
      appName: '微信主窗口呼出',
      modifyGuide: '微信设置 -> 快捷键 -> 打开微信'
    },
    {
      comboUpper: 'CTRL+ALT+Z',
      processNames: ['qq.exe', 'tim.exe'],
      appName: 'QQ 提取消息',
      modifyGuide: 'QQ 设置 -> 热键 -> 提取消息'
    },
    {
      comboUpper: 'F1',
      processNames: ['snipaste.exe', 'pixpin.exe'],
      appName: 'Snipaste / PixPin 贴图截图',
      modifyGuide: '任务栏托盘右键 Snipaste/PixPin -> 首选项 -> 热键控制'
    }
  ]

  async handleHotkeyRadar(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (process.platform === 'darwin') return { ok: false, success: false, error: '请更新热键侦测插件，通过 Mac 热键探测接口重新检测；旧接口不支持 Mac 探测或结束进程' }
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'probehotkeys' || lowerFn === 'scanhotkeys' || lowerFn === 'probe') {
      const rawCombos = Array.isArray(params.combos)
        ? params.combos.map(String)
        : typeof params.combo === 'string'
          ? [params.combo]
          : []

      // 读取一次正在运行的进程，只用于提示占用热键的“可能来源”
      const runningProcs: Array<{ name: string; pid: number }> = []
      if (process.platform === 'win32' && params.skipSystemScan !== true) {
        const res = await this.#sys.runCommand('tasklist', ['/FO', 'CSV', '/NH'], 4_000, signal)
        if (res.stdout) {
          for (const line of res.stdout.split(/\r?\n/)) {
            const m = line.match(/^"([^"]+)",\s*"(\d+)"/)
            if (m?.[1] && m?.[2]) {
              runningProcs.push({
                name: m[1].toLowerCase(),
                pid: Number(m[2]) || 0
              })
            }
          }
        }
      }

      // 只有系统注册探测失败的组合才算“占用”；正在运行的常见软件只作为可能来源的提示，不能据此判定占用
      const probeStatus = new Map<string, 'occupied' | 'free' | 'unsupported'>()
      // 组合键白名单：只删 ASCII 单引号时弯引号（‘ ’ ‚ ‛）仍能提前结束 PowerShell 字符串注入命令。
      // 不符合的组合键不进入脚本，结果标为无法检测并说明原因
      const isProbeableCombo = (upper: string) => /^[A-Z0-9+]{1,64}$/.test(upper)
      if (params.skipSystemProbe !== true && process.platform === 'win32' && rawCombos.length > 0) {
        const comboListLiteral = rawCombos
          .map((c) => String(c ?? '').toUpperCase().replace(/\s+/g, ''))
          .filter(isProbeableCombo)
          .map((c) => `'${escapePsSingleQuoted(c)}'`)
          .join(',')
        if (comboListLiteral) {
          const ps = `
            $ErrorActionPreference = 'Stop'
            Add-Type -TypeDefinition '
              using System;
              using System.Runtime.InteropServices;
              public class ZHotkeyProbe {
                [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
                [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
              }
            '
            $combos = @(${comboListLiteral})
            $results = @()
            $id = 9100
            foreach ($c in $combos) {
              $id++
              $parts = $c -split '\\+'
              [uint32]$mods = 0x4000
              [uint32]$vk = 0
              $unknown = $false
              foreach ($p in $parts) {
                if ($p -eq 'CTRL' -or $p -eq 'CONTROL') { $mods = $mods -bor 2 }
                elseif ($p -eq 'ALT') { $mods = $mods -bor 1 }
                elseif ($p -eq 'SHIFT') { $mods = $mods -bor 4 }
                elseif ($p -eq 'WIN' -or $p -eq 'META' -or $p -eq 'CMD') { $mods = $mods -bor 8 }
                elseif ($p -eq 'SPACE') { $vk = 0x20 }
                elseif ($p -eq 'TAB') { $vk = 0x09 }
                elseif ($p -eq 'ESC') { $vk = 0x1B }
                elseif ($p -match '^[A-Z0-9]$') { $vk = [uint32][char]$p[0] }
                elseif ($p -match '^F(\\d+)$' -and [uint32]$Matches[1] -ge 1 -and [uint32]$Matches[1] -le 24) { $vk = 0x6F + [uint32]$Matches[1] }
                else { $unknown = $true }
              }
              if ($unknown -or $vk -eq 0) { $results += @{ combo = $c; status = 'unsupported' }; continue }
              $ok = [ZHotkeyProbe]::RegisterHotKey([IntPtr]::Zero, $id, $mods, $vk)
              if ($ok) { [ZHotkeyProbe]::UnregisterHotKey([IntPtr]::Zero, $id) | Out-Null; $results += @{ combo = $c; status = 'free' } }
              else { $results += @{ combo = $c; status = 'occupied' } }
            }
            @{ results = @($results) } | ConvertTo-Json -Compress -Depth 4
          `
          let parsed: { results?: unknown }
          try {
            parsed = JSON.parse(await this.#sys.runPowerShell(ps, 15_000, signal)) as { results?: unknown }
          } catch (err) {
            return { ok: false, success: false, errorCode: 'PROBE_FAILED', error: `PROBE_FAILED: 热键探测未完成，不能判断是否空闲：${err instanceof Error ? err.message : String(err)}` }
          }
          if (!parsed || !Array.isArray(parsed.results)) {
            return { ok: false, success: false, errorCode: 'PROBE_FAILED', error: 'PROBE_FAILED: 热键探测结果格式无效' }
          }
          for (const item of parsed.results as Array<Record<string, unknown>>) {
            const status = String(item?.status ?? '')
            if (status === 'occupied' || status === 'free' || status === 'unsupported') probeStatus.set(String(item.combo ?? '').toUpperCase(), status)
          }
        }
      }

      const results = rawCombos.map((rawCombo) => {
        const cleanCombo = String(rawCombo ?? '').trim()
        const upper = cleanCombo.toUpperCase().replace(/\s+/g, '')
        const isSystemReserved = SystemRegistryHostPluginHandler.#SYSTEM_RESERVED_HOTKEYS.has(upper)
        const invalidCombo = !isSystemReserved && !isProbeableCombo(upper)
        const status = isSystemReserved ? 'reserved' : (probeStatus.get(upper) ?? 'unsupported')
        const isOccupied = status === 'reserved' || status === 'occupied'

        const suspectRule = SystemRegistryHostPluginHandler.#KNOWN_HOTKEY_SUSPECTS.find(
          (r) => r.comboUpper === upper
        )
        const matchedProc = isOccupied && suspectRule
          ? runningProcs.find((p) => suspectRule.processNames.includes(p.name))
          : undefined

        return {
          keyCombo: cleanCombo,
          probeStatus: status,
          isOccupied,
          isSystemReserved,
          // 系统不提供占用者信息：以下只是按常见软件推测的“可能来源”，不能作为结束进程的依据
          suspectApp: isSystemReserved
            ? 'Windows 系统保留'
            : status === 'occupied'
              ? (matchedProc && suspectRule ? `可能是 ${suspectRule.appName}` : '未知程序（系统不提供占用者）')
              : null,
          suspectProcess: matchedProc?.name ?? null,
          suspectPid: null,
          ...(invalidCombo ? { probeNote: '组合键只能由字母、数字和 + 组成（如 Ctrl+Shift+F12），包含其他字符的无法检测' } : {}),
          modifyGuide: isSystemReserved
            ? '操作系统内核级保留热键，不支持第三方软件覆盖'
            : suspectRule?.modifyGuide ?? '请检查当前后台运行的聊天、输入法、音乐或显卡驱动软件设置'
        }
      })

      return {
        ok: true,
        success: true,
        results
      }
    }

    if (lowerFn === 'killsuspectprocess' || lowerFn === 'terminateprocess') {
      // 系统不提供热键占用者，“嫌疑进程”只是按进程名推测，不能据此强制结束进程
      return { ok: false, success: false, errorCode: 'UNSUPPORTED_ACTION', error: 'UNSUPPORTED_ACTION: 系统无法确认热键占用者，已不再提供按推测结束进程；请在对应软件的设置中修改快捷键' }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported HotkeyRadarPlugin function: ${fn}`
    }
  }

  // ==================== 26. IDE 最近项目聚合 (VscodeProjectsPlugin) ====================
  async handleVscodeProjects(
    fn: string,
    _params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'scan' || lowerFn === 'scanallrecentprojects' || lowerFn === 'launch' || lowerFn === 'launchproject') {
      // 旧入口原样采用调用方传入的项目列表、按扫描顺序编造打开时间、解析失败仍报成功，打开项目还经 cmd 拼接未加引号的路径，已停用；
      // 最近项目插件 1.0.3 起改走 recent_projects 接口（macOS 与 Windows 都由主进程读取编辑器历史并直接启动编辑器）
      return {
        ok: false,
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: '请更新最近项目插件，通过新版接口读取和打开最近项目'
      }
    }

    return { ok: false, success: false, errorCode: 'UNSUPPORTED_ACTION', error: `Unsupported VscodeProjectsPlugin function: ${fn}` }
  }

  // ==================== 28. 系统与用户环境变量管理 (EnvManagerPlugin) ====================
  async handleEnvManager(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()
    // 旧接口的问题：读取时直接采用调用方给的 customEnv / rawPath（或主进程自身的环境），清理只改内存却报告已清理，
    // 写入在 persistRegistry:false / customEnv 时不写注册表也报成功；环境变量插件已改走 environment_manager 接口（备份、授权、写后读回）
    const unsupported = {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: '请更新环境变量插件，通过新版接口读取和修改环境变量'
    }

    if (lowerFn === 'load' || lowerFn === 'loadallenvvariables') return unsupported
    if (lowerFn === 'cleaninvalid' || lowerFn === 'cleaninvalidpathentries') return unsupported

    if (lowerFn === 'write' || lowerFn === 'writeenvvariable') {
      const scope = (String(params.scope ?? 'user') === 'system' ? 'system' : 'user') as 'user' | 'system'
      const key = String(params.key ?? '').trim()
      const value = String(params.value ?? '')
      if (!key) {
        return { ok: false, success: false, errorCode: 'INVALID_ENV_KEY', error: '变量名不能为空' }
      }
      if (key.toUpperCase() === 'PATH' && value.length > 2048) {
        return {
          ok: false,
          success: false,
          errorCode: 'PATH_TOO_LONG',
          error: 'PATH_TOO_LONG: PATH 长度超过 Windows 2048 字符安全阈值，已拦截写入防止截断'
        }
      }
      // 预览只校验参数、不写入（结果带 dryRun 标记，不能当作已保存）；真实写入一律要求新版接口
      if (params.dryRun === true) {
        return { ok: true, success: true, dryRun: true, key, value, scope }
      }
      return unsupported
    }

    return { ok: false, success: false, errorCode: 'UNSUPPORTED_ACTION', error: `Unsupported EnvManagerPlugin function: ${fn}` }
  }

  async stop(): Promise<void> {
    this.#clearCaffeineSession()
    this.#clearCleanKeyboardSession()
  }
}
