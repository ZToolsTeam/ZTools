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
  fileUrlToLocalPath,
  formatBytes,
  isForbiddenRegistryPath,
  isProtectedSystemPath,
  runCommand,
  runPowerShell,
  type HostPluginContext
} from './shared-utils.js'

export class SystemRegistryHostPluginHandler {
  readonly #ctx: HostPluginContext

  constructor(ctx: HostPluginContext) {
    this.#ctx = ctx
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
            if (Test-Path $r.Path) {
              Get-ChildItem -Path $r.Path -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object {
                $keyPath = $_.PSPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', ''
                $muiverb = (Get-ItemProperty -Path $_.PSPath -Name 'MUIVerb' -ErrorAction SilentlyContinue).MUIVerb
                $defaultVal = (Get-ItemProperty -Path $_.PSPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
                $icon = (Get-ItemProperty -Path $_.PSPath -Name 'Icon' -ErrorAction SilentlyContinue).Icon
                $legacyDisable = $null -ne (Get-ItemProperty -Path $_.PSPath -Name 'LegacyDisable' -ErrorAction SilentlyContinue).LegacyDisable
                $cmdPath = Join-Path $_.PSPath 'command'
                $cmdVal = ''
                if (Test-Path $cmdPath) {
                  $cmdVal = (Get-ItemProperty -Path $cmdPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
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
        const raw = await runPowerShell(psScript, 12_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
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
          } catch {
            // ignore parse error
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
      const psRegPath = `Registry::${normalizedRegPath.replace(/'/g, "''")}`
      const script = enabled
        ? `Remove-ItemProperty -Path '${psRegPath}' -Name 'LegacyDisable' -ErrorAction SilentlyContinue; Write-Output 'OK'`
        : `Set-ItemProperty -Path '${psRegPath}' -Name 'LegacyDisable' -Value '' -ErrorAction Stop; Write-Output 'OK'`
      const out = await runPowerShell(script, 8_000, signal)
      const ok = out.includes('OK')
      return {
        ok,
        success: ok,
        regPath: normalizedRegPath,
        keyPath: normalizedRegPath,
        enabled,
        ...(ok ? {} : { error: '修改右键菜单启用状态失败' })
      }
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
        const queryRes = await runCommand('reg', ['query', inprocKey], 5_000, signal)
        enableClassic = queryRes.exitCode !== 0
      }

      if (enableClassic) {
        const res = await runCommand(
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
        const queryRes = await runCommand('reg', ['query', clsidKey], 5_000, signal)
        if (queryRes.exitCode !== 0) {
          return { ok: true, success: true, classic: false, output: '当前已是 Win11 默认现代右键菜单' }
        }
        const res = await runCommand('reg', ['delete', clsidKey, '/f'], 8_000, signal)
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
        const res = await runCommand('reg', ['delete', regCliPath, '/f'], 8_000, signal)
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
      const keyName = String(params.keyName ?? params.name ?? '').replace(/[\\/:*?"<>|']/g, '').trim()
      const displayName = String(params.displayName ?? params.name ?? keyName).replace(/'/g, "''").trim()
      const rawCommand = String(params.command ?? '').trim()
      if (!keyName || !rawCommand || process.platform !== 'win32') {
        return { ok: false, success: false, error: '名称和执行命令不能为空' }
      }
      const exeMatch = rawCommand.match(/^"([^"]+)"|^(\S+)/)
      const rawExePath = (exeMatch?.[1] ?? exeMatch?.[2] ?? '').trim()
      if (!rawExePath) {
        return { ok: false, success: false, error: '无法解析命令中的可执行文件路径' }
      }
      const authorizedExe = await this.#ctx.authorizeExistingPath(rawExePath, caller, 'read')
      const safeCommand = `"${authorizedExe.replace(/'/g, "''")}" "%1"`
      const targetScope = String(params.scope ?? '*')
      const baseClass =
        targetScope.toLowerCase().includes('background')
          ? 'Directory\\Background\\shell'
          : targetScope.toLowerCase().includes('directory')
            ? 'Directory\\shell'
            : '*\\shell'
      const regKey = `HKCU:\\Software\\Classes\\${baseClass}\\${keyName}`
      const script = `
        New-Item -Path '${regKey}' -Force | Out-Null
        Set-ItemProperty -Path '${regKey}' -Name '(default)' -Value '${displayName}'
        New-Item -Path '${regKey}\\command' -Force | Out-Null
        Set-ItemProperty -Path '${regKey}\\command' -Name '(default)' -Value '${safeCommand}'
        Write-Output 'OK'
      `
      const out = await runPowerShell(script, 8_000, signal)
      return { ok: out.includes('OK'), success: out.includes('OK'), regPath: regKey, keyPath: regKey }
    }

    if (lowerFn === 'delete' || lowerFn === 'remove' || lowerFn === 'deleteitem') {
      const regPath = String(params.regPath ?? params.keyPath ?? params.id ?? '').trim()
      const normalized = regPath.replace(/^HKCU:\\?/i, 'HKEY_CURRENT_USER\\')
      if (!normalized.startsWith('HKEY_CURRENT_USER\\Software\\Classes\\') || isForbiddenRegistryPath(normalized)) {
        return { ok: false, success: false, error: '出于安全保护，仅允许删除当前用户 (HKCU) 下的自定义右键菜单项' }
      }
      const psRegPath = `Registry::${normalized.replace(/'/g, "''")}`
      const out = await runPowerShell(`Remove-Item -Path '${psRegPath}' -Recurse -Force -ErrorAction Stop; Write-Output 'OK'`, 8_000, signal)
      return { ok: out.includes('OK'), success: out.includes('OK'), regPath: normalized, keyPath: normalized }
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

    if (!detectedPath && process.platform === 'win32') {
      const regOut = await runPowerShell(
        `(Get-ItemProperty -Path 'HKCU:\\Software\\Tencent\\WeChat' -Name 'InstallPath' -ErrorAction SilentlyContinue).InstallPath`,
        5_000,
        signal
      )
      if (regOut) {
        const exe = path.join(regOut.trim(), 'WeChat.exe')
        if (fsSync.existsSync(exe)) detectedPath = exe
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
        const ps = `
          Get-Process -Name 'WeChat','Weixin' -ErrorAction SilentlyContinue | ForEach-Object {
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
          } | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 6_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
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
          } catch {
            // ignore
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
        instances
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
          error: '未检测到本地微信安装路径 (WeChat.exe)，请在设置或参数中指定路径'
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
        const netstat = await runCommand('netstat', ['-ano', '-p', 'tcp'], 8_000, signal)
        const procMap = new Map<number, string>()
        const tasklist = await runCommand('tasklist', ['/FO', 'CSV', '/NH'], 8_000, signal)
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
        const tasklist = await runCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5_000, signal)
        const m = tasklist.stdout.match(/^"([^"]+)"/)
        const procName = (m?.[1] ?? '').toLowerCase()
        if (PROTECTED_PROCESS_NAMES.has(procName)) {
          return { ok: false, success: false, error: `安全拦截：禁止终止系统关键进程 (${procName})` }
        }
      }
      try {
        process.kill(pid)
        return { ok: true, success: true, pid }
      } catch (err) {
        return { ok: false, success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return this.handleFlowGuard('getConnections', params, signal)
  }

  async handleBoost(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const totalMem = os.totalmem()
    const freeMemBefore = await readSystemAvailableMemoryBytes(process.platform, { fresh: true })
    const usedPercentBefore = Math.round(((totalMem - freeMemBefore) / totalMem) * 100)

    if (lowerFn === 'getstatus' || lowerFn === 'inspect' || lowerFn === 'scan') {
      const topProcesses: Array<Record<string, unknown>> = []
      if (process.platform === 'win32') {
        const ps = `
          Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 25 | ForEach-Object {
            [PSCustomObject]@{
              pid = $_.Id
              name = $_.ProcessName
              memoryBytes = $_.WorkingSet64
              memoryText = "$([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
            }
          } | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 8_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (item && typeof item === 'object') {
                topProcesses.push(item as Record<string, unknown>)
              }
            }
          } catch {
            // ignore
          }
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
        topProcesses
      }
    }

    if (lowerFn === 'getstartupitems' || lowerFn === 'liststartupitems' || lowerFn === 'scanstartup') {
      const startupItems: Array<Record<string, unknown>> = []
      if (process.platform === 'win32') {
        const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
        const disabledKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'

        const parseRegQueryOutput = (stdout: string, enabled: boolean, regKey: string) => {
          for (const line of stdout.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('HKEY_')) continue
            const m = trimmed.match(/^(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i)
            if (m?.[1] && m[2]) {
              const name = m[1].trim()
              const command = m[2].trim()
              startupItems.push({
                id: name,
                name,
                command,
                path: command,
                regPath: regKey,
                enabled
              })
            }
          }
        }

        const activeRes = await runCommand('reg', ['query', runKey], 8_000, signal)
        if (activeRes.exitCode === 0 && activeRes.stdout) {
          parseRegQueryOutput(activeRes.stdout, true, runKey)
        }
        const disabledRes = await runCommand('reg', ['query', disabledKey], 8_000, signal)
        if (disabledRes.exitCode === 0 && disabledRes.stdout) {
          parseRegQueryOutput(disabledRes.stdout, false, disabledKey)
        }
      }

      return {
        ok: true,
        success: true,
        items: startupItems,
        startupItems
      }
    }

    if (lowerFn === 'setstartupitemstate' || lowerFn === 'togglestartupitem') {
      if (process.platform !== 'win32') {
        return { ok: false, success: false, error: '仅 Windows 支持管理注册表开机自启项' }
      }
      const itemName = String(params.name ?? params.id ?? params.itemId ?? '').trim()
      if (!itemName) {
        return { ok: false, success: false, error: '未指定开机自启项名称 (name)' }
      }
      const targetEnabled = Boolean(params.enabled)
      const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      const disabledKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'
      const srcKey = targetEnabled ? disabledKey : runKey
      const dstKey = targetEnabled ? runKey : disabledKey

      let commandVal = String(params.command ?? params.path ?? '').trim()
      if (!commandVal) {
        const queryRes = await runCommand('reg', ['query', srcKey, '/v', itemName], 5_000, signal)
        if (queryRes.exitCode === 0) {
          const m = queryRes.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/im)
          if (m?.[1]) {
            commandVal = m[1].trim()
          }
        }
      }

      if (!commandVal) {
        return {
          ok: false,
          success: false,
          error: `未找到开机自启项 "${itemName}" 的启动命令`
        }
      }

      const addRes = await runCommand(
        'reg',
        ['add', dstKey, '/v', itemName, '/t', 'REG_SZ', '/d', commandVal, '/f'],
        8_000,
        signal
      )
      if (addRes.exitCode !== 0) {
        return {
          ok: false,
          success: false,
          error: addRes.stderr || addRes.stdout || '更新自启项状态失败'
        }
      }
      await runCommand('reg', ['delete', srcKey, '/v', itemName, '/f'], 5_000, signal)
      return {
        ok: true,
        success: true,
        name: itemName,
        enabled: targetEnabled,
        command: commandVal
      }
    }

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

  async #queryThermalSensor(signal?: AbortSignal): Promise<{
    cpuTempCelsius: number | null
    gpuTempCelsius: number | null
    ssdTempCelsius: number | null
    sensorAvailable: boolean
  }> {
    if (process.platform === 'win32') {
      const psScript = `
        $zones = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue
        if ($zones) {
          $first = ($zones | Select-Object -First 1).CurrentTemperature
          if ($first -gt 2732) {
            $celsius = [math]::Round(($first - 2732) / 10.0, 1)
            [PSCustomObject]@{ available = $true; temp = $celsius } | ConvertTo-Json -Compress
            exit
          }
        }
        [PSCustomObject]@{ available = $false; temp = $null } | ConvertTo-Json -Compress
      `
      const out = await runPowerShell(psScript, 6_000, signal)
      if (out) {
        try {
          const parsed = JSON.parse(out) as { available?: boolean; temp?: number | null }
          if (parsed.available && typeof parsed.temp === 'number' && Number.isFinite(parsed.temp)) {
            return {
              cpuTempCelsius: parsed.temp,
              gpuTempCelsius: null,
              ssdTempCelsius: null,
              sensorAvailable: true
            }
          }
        } catch {
          // ignore parse error
        }
      }
    }
    return {
      cpuTempCelsius: null,
      gpuTempCelsius: null,
      ssdTempCelsius: null,
      sensorAvailable: false
    }
  }

  async handleHardwareInfo(fn: string, signal?: AbortSignal): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const cpus = os.cpus()
    const totalMem = os.totalmem()
    const freeMem = await readSystemAvailableMemoryBytes(process.platform)
    const usedMem = Math.max(0, totalMem - freeMem)
    const usedMemPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0

    let totalIdle = 0
    let totalTick = 0
    for (const cpu of cpus) {
      totalIdle += cpu.times.idle
      totalTick += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle
    }
    const cpuLoadPercent = totalTick > 0 ? Math.max(1, Math.min(100, Math.round(((totalTick - totalIdle) / totalTick) * 100))) : 0

    const thermal = await this.#queryThermalSensor(signal)

    if (lowerFn === 'gettemperature' || lowerFn === 'gettemperatures') {
      return {
        ok: true,
        success: true,
        ...thermal,
        cpuLoadPercent,
        memoryUsedPercent: usedMemPercent
      }
    }

    const disks: Array<Record<string, unknown>> = []
    if (process.platform === 'win32') {
      for (const drive of ['C:\\', 'D:\\', 'E:\\']) {
        if (!fsSync.existsSync(drive)) continue
        try {
          const statfs = await fs.statfs(drive)
          const totalBytes = statfs.blocks * statfs.bsize
          const freeBytes = statfs.bfree * statfs.bsize
          disks.push({
            mount: drive,
            totalBytes,
            totalText: formatBytes(totalBytes),
            freeBytes,
            freeText: formatBytes(freeBytes),
            usedBytes: Math.max(0, totalBytes - freeBytes),
            usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0
          })
        } catch {
          // ignore drive stat error
        }
      }
    } else {
      try {
        const statfs = await fs.statfs('/')
        const totalBytes = statfs.blocks * statfs.bsize
        const freeBytes = statfs.bfree * statfs.bsize
        disks.push({
          mount: '/',
          totalBytes,
          totalText: formatBytes(totalBytes),
          freeBytes,
          freeText: formatBytes(freeBytes),
          usedBytes: Math.max(0, totalBytes - freeBytes),
          usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0
        })
      } catch {
        // ignore
      }
    }

    return {
      ok: true,
      success: true,
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.floor(os.uptime()),
      ...thermal,
      cpu: {
        model: cpus[0]?.model ?? 'Unknown CPU',
        cores: cpus.length,
        speedMHz: cpus[0]?.speed ?? 0,
        loadPercent: cpuLoadPercent
      },
      memory: {
        totalBytes: totalMem,
        totalText: formatBytes(totalMem),
        freeBytes: freeMem,
        freeText: formatBytes(freeMem),
        usedBytes: usedMem,
        usedText: formatBytes(usedMem),
        usedPercent: usedMemPercent
      },
      disks
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
      const trashRes = await this.#moveTargetToTrash(resolved, signal)
      if (!trashRes.ok) {
        return { ok: false, success: false, error: trashRes.error ?? '移入回收站失败' }
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
        const ps = `
          $ErrorActionPreference = 'SilentlyContinue'
          $paths = @(
            'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
            'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
          )
          Get-ItemProperty $paths -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -and ($_.UninstallString -or $_.InstallLocation) -and $_.SystemComponent -ne 1 } |
            Select-Object -First 150 DisplayName, DisplayVersion, Publisher, InstallDate, EstimatedSize, InstallLocation, UninstallString, QuietUninstallString, PSChildName |
            ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 8_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
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
          } catch {
            // ignore JSON parse error
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
        const res = await runCommand('rundll32.exe', ['user32.dll,LockWorkStation'], 5_000, signal)
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
        const out = await runPowerShell(
          `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output 'OK'`,
          10_000,
          signal
        )
        const ok = out.includes('OK')
        return {
          ok,
          success: ok,
          action: rawAction,
          executedAt: new Date().toISOString(),
          ...(ok ? {} : { error: '清空回收站执行失败' })
        }
      }
      return { ok: false, success: false, error: '当前平台不支持 Clear-RecycleBin' }
    }

    if (normalizedAction === 'sleep' || normalizedAction === 'suspend' || normalizedAction === 'hibernatesystem') {
      if (process.platform === 'win32') {
        const res = await runCommand('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], 5_000, signal)
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
        const out = await runPowerShell(
          `$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]${keyChar}); Write-Output 'OK'`,
          5_000,
          signal
        )
        const ok = out.includes('OK')
        return {
          ok,
          success: ok,
          action: rawAction,
          executedAt: new Date().toISOString()
        }
      }
      return { ok: false, success: false, error: '当前平台不支持音量快捷键注入' }
    }

    if (normalizedAction === 'togglehiddenfiles') {
      if (process.platform === 'win32') {
        const advKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'
        const q = await runCommand('reg', ['query', advKey, '/v', 'Hidden'], 5_000, signal)
        const currentlyShown = /0x1\b/i.test(q.stdout)
        const nextVal = currentlyShown ? '2' : '1'
        const res = await runCommand('reg', ['add', advKey, '/v', 'Hidden', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
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
        const q = await runCommand('reg', ['query', advKey, '/v', 'HideFileExt'], 5_000, signal)
        const currentlyHidden = /0x1\b/i.test(q.stdout)
        const nextVal = currentlyHidden ? '0' : '1'
        const res = await runCommand('reg', ['add', advKey, '/v', 'HideFileExt', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
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
        const q = await runCommand('reg', ['query', themeKey, '/v', 'AppsUseLightTheme'], 5_000, signal)
        const isLight = /0x1\b/i.test(q.stdout)
        const nextVal = isLight ? '0' : '1'
        const res = await runCommand('reg', ['add', themeKey, '/v', 'AppsUseLightTheme', '/t', 'REG_DWORD', '/d', nextVal, '/f'], 5_000, signal)
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
        const res = await runCommand('ipconfig', ['/flushdns'], 8_000, signal)
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
        const ps = `
          Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 40 | ForEach-Object {
            [PSCustomObject]@{
              id = [string]$_.MainWindowHandle
              hwnd = [int64]$_.MainWindowHandle
              pid = $_.Id
              processName = $_.ProcessName
              title = $_.MainWindowTitle
            }
          } | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 6_000)
        const windows: Array<Record<string, unknown>> = []
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const w of list) {
              if (w && typeof w === 'object') windows.push(w as Record<string, unknown>)
            }
          } catch {
            // ignore
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

    const psScript = `
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
        exit
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
    const out = await runPowerShell(psScript, 8_000)
    const ok = out.includes('OK')
    return {
      ok,
      success: ok,
      action: normalizedAction,
      ...(ok ? {} : { error: '执行 Win32 窗口管理操作失败' })
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

  async #collectCandidateFilesForRestartManager(targetPath: string, isDirectory: boolean): Promise<string[]> {
    if (!isDirectory) {
      return [targetPath]
    }
    const collected: string[] = []
    const maxFiles = 40
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 2 || collected.length >= maxFiles) return
      let entries: fsSync.Dirent[] = []
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (collected.length >= maxFiles) break
        const full = path.join(dir, entry.name)
        if (entry.isFile()) {
          collected.push(full)
        } else if (entry.isDirectory() && depth < 2) {
          await walk(full, depth + 1)
        }
      }
    }
    await walk(targetPath, 0)
    return collected
  }

  async #queryLiveProcessName(pid: number, signal?: AbortSignal): Promise<{ exists: boolean; name: string; executablePath: string }> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return { exists: false, name: '', executablePath: '' }
    }
    if (pid === 4 && process.platform === 'win32') {
      return { exists: true, name: 'System', executablePath: 'System' }
    }
    if (process.platform === 'win32') {
      const tasklist = await runCommand(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        5_000,
        signal
      )
      for (const line of tasklist.stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        const m = trimmed.match(/^"([^"]+)","(\d+)"/)
        if (m?.[1] && Number(m[2]) === pid) {
          return { exists: true, name: m[1], executablePath: m[1] }
        }
      }
      return { exists: false, name: '', executablePath: '' }
    }

    const psRes = await runCommand('ps', ['-p', String(pid), '-o', 'comm='], 5_000, signal)
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

  async #moveTargetToTrash(resolvedTarget: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    if (isProtectedSystemPath(resolvedTarget)) {
      return { ok: false, error: 'PROTECTED_PATH: 系统核心受保护路径禁止移入回收站' }
    }
    if (process.platform === 'win32') {
      const escaped = resolvedTarget.replace(/'/g, "''")
      const isDir = fsSync.existsSync(resolvedTarget) && fsSync.statSync(resolvedTarget).isDirectory()
      const psTrash = `
        Add-Type -AssemblyName Microsoft.VisualBasic
        $p = '${escaped}'
        if (Test-Path -LiteralPath $p) {
          if (${isDir ? '$true' : '$false'}) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          }
        }
        Write-Output 'TRASH_OK'
      `
      const out = await runPowerShell(psTrash, 10_000, signal)
      if (out.includes('TRASH_OK') && !fsSync.existsSync(resolvedTarget)) {
        return { ok: true }
      }
    }
    try {
      await fs.rm(resolvedTarget, { recursive: true, force: false })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
        const ps = `
          Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{
              mount = "$($_.DeviceID)\\"
              label = if ($_.VolumeName) { $_.VolumeName } else { '可移动磁盘' }
              totalBytes = [int64]($_.Size)
              freeBytes = [int64]($_.FreeSpace)
            }
          } | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 6_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (item && typeof item === 'object') {
                const rec = item as Record<string, unknown>
                const mount = String(rec.mount ?? '')
                const totalBytes = Number(rec.totalBytes ?? 0)
                const freeBytes = Number(rec.freeBytes ?? 0)
                if (mount) {
                  drives.push({
                    mount,
                    label: String(rec.label ?? '可移动磁盘'),
                    totalBytes,
                    freeBytes,
                    totalText: formatBytes(totalBytes),
                    freeText: formatBytes(freeBytes)
                  })
                }
              }
            }
          } catch {
            // ignore parse error
          }
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

      if (Array.isArray(params.mockProcesses)) {
        for (const item of params.mockProcesses) {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>
            appendLockingProcess({
              pid: Number(rec.pid ?? 0),
              name: String(rec.name ?? ''),
              executablePath: typeof rec.executablePath === 'string' ? rec.executablePath : undefined,
              lockedPath: typeof rec.lockedPath === 'string' ? rec.lockedPath : resolved,
              handleType: typeof rec.handleType === 'string' ? rec.handleType : undefined,
              serviceType: typeof rec.serviceTypeLabel === 'string' ? rec.serviceTypeLabel : undefined,
              user: typeof rec.user === 'string' ? rec.user : undefined
            })
          }
        }
      } else if (process.platform === 'win32') {
        const candidateFiles = await this.#collectCandidateFilesForRestartManager(resolved, isDirectory)
        const escapedFilesArray = candidateFiles
          .slice(0, 32)
          .map((f) => `'${f.replace(/'/g, "''")}'`)
          .join(',')
        const escapedTarget = resolved.replace(/'/g, "''")
        const psScript = `
          $ErrorActionPreference = 'SilentlyContinue'
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
              if (RmStartSession(out handle, 0, key) != 0) return new RM_PROCESS_INFO[0];
              try {
                if (RmRegisterResources(handle, (uint)files.Length, files, 0, null, 0, null) != 0) return new RM_PROCESS_INFO[0];
                uint needed = 0, count = 0, reasons = 0;
                int res = RmGetList(handle, out needed, ref count, null, ref reasons);
                if (res == 234 && needed > 0) {
                  count = needed;
                  RM_PROCESS_INFO[] infos = new RM_PROCESS_INFO[count];
                  if (RmGetList(handle, out needed, ref count, infos, ref reasons) == 0) {
                    return infos;
                  }
                }
                return new RM_PROCESS_INFO[0];
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
          Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
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
          $results | ConvertTo-Json -Compress
        `
        const rawOut = await runPowerShell(psScript, 10_000, signal)
        if (rawOut) {
          try {
            const parsed = JSON.parse(rawOut)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const entry of list) {
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
          } catch {
            // ignore JSON parse failure
          }
        }
      } else {
        const lsofRes = await runCommand('lsof', ['-F', 'pcn', '--', resolved], 8_000, signal)
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

      return {
        ok: true,
        success: true,
        targetPath: resolved,
        isDirectory,
        isUnlocked: normalizedProcessList.length === 0,
        processes: normalizedProcessList,
        lockingProcesses: normalizedProcessList
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

      const injectedLiveName =
        typeof params.liveProcessName === 'string' ? params.liveProcessName.trim() : null
      const liveInfo =
        injectedLiveName !== null
          ? { exists: Boolean(injectedLiveName), name: injectedLiveName, executablePath: injectedLiveName }
          : await this.#queryLiveProcessName(pid, signal)

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

      if (params.simulateAccessDenied === true) {
        return {
          ok: false,
          success: false,
          pid,
          expectedName,
          errorCode: 'PROCESS_ACCESS_DENIED',
          error: `PROCESS_ACCESS_DENIED: 权限不足，无法终止进程 ${expectedName} (PID ${pid})，请使用管理员权限重试`
        }
      }

      const expectedBase = SystemRegistryHostPluginHandler.#normalizeProcessBaseName(expectedName)
      let explorerRestarted = false

      if (expectedBase === 'explorer') {
        if (process.platform === 'win32' && params.dryRun !== true) {
          await runCommand('taskkill', ['/F', '/IM', 'explorer.exe'], 6_000, signal)
          const child = spawn('explorer.exe', [], {
            detached: true,
            stdio: 'ignore',
            windowsHide: false
          })
          child.unref()
        }
        explorerRestarted = true
      } else if (liveInfo.exists && params.dryRun !== true) {
        try {
          process.kill(pid)
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'EPERM' || code === 'EACCES') {
            return {
              ok: false,
              success: false,
              pid,
              expectedName,
              errorCode: 'PROCESS_ACCESS_DENIED',
              error: `PROCESS_ACCESS_DENIED: 权限不足，无法终止高权限进程 ${expectedName} (PID ${pid})`
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

      if (rawTargetPath && (trashAfterUnlock || renameTo)) {
        for (let attempt = 0; attempt < 15; attempt++) {
          const probe = await this.#queryLiveProcessName(pid, signal)
          if (!probe.exists || params.dryRun === true || injectedLiveName !== null) break
          await new Promise((r) => setTimeout(r, 80))
        }
      }

      let trashed = false
      let renamedPath: string | undefined

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
        const trashRes = await this.#moveTargetToTrash(resolvedTarget, signal)
        if (!trashRes.ok) {
          return {
            ok: false,
            success: false,
            pid,
            errorCode: 'TRASH_FAILED',
            error: trashRes.error ?? '移入回收站失败'
          }
        }
        trashed = true
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
        const resolvedTarget = await this.#ctx.authorizeExistingPath(rawTargetPath, caller, 'write')
        const nextPath = path.join(path.dirname(resolvedTarget), renameTo)
        await fs.rename(resolvedTarget, nextPath)
        renamedPath = nextPath
      }

      return {
        ok: true,
        success: true,
        pid,
        expectedName,
        explorerRestarted,
        trashed,
        ...(renamedPath ? { renamedPath } : {})
      }
    }

    if (lowerFn === 'eject' || lowerFn === 'ejectdrive' || lowerFn === 'ejectremovabledrive' || lowerFn === 'safeeject') {
      const drive = String(params.drive ?? params.path ?? params.targetPath ?? '').trim()
      if (!drive) {
        return { ok: false, success: false, errorCode: 'INVALID_DRIVE', error: '未提供待弹出的驱动器盘符或挂载点路径' }
      }
      if (params.dryRun !== true) {
        if (process.platform === 'win32') {
          const driveRoot = drive.slice(0, 2).toUpperCase()
          const ps = `
            $drive = '${driveRoot}'
            $vol = Get-WmiObject -Class Win32_Volume -Filter "DriveLetter = '$drive'"
            if ($vol) {
              $sh = New-Object -ComObject Shell.Application
              $sh.Namespace(17).ParseName($drive).InvokeVerb("Eject")
            }
            Write-Output 'EJECT_OK'
          `
          await runPowerShell(ps, 5_000, signal)
        } else if (process.platform === 'darwin') {
          await runCommand('diskutil', ['eject', drive], 5_000, signal)
        }
      }
      return { ok: true, success: true, drive, ejected: true }
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

  async #scanWindowsStartupItems(signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $items = @()

      function Get-StartupApprovedState($hivePath, $valName) {
        if (-not (Test-Path $hivePath)) { return $true }
        $prop = Get-ItemProperty -Path $hivePath -Name $valName -ErrorAction SilentlyContinue
        if ($null -eq $prop) { return $true }
        $bytes = $prop.$valName
        if ($bytes -is [byte[]] -and $bytes.Length -ge 1) {
          $b0 = $bytes[0]
          if ($b0 -eq 3 -or $b0 -eq 1 -or ($b0 % 2 -eq 1)) { return $false }
        }
        return $true
      }

      $regRoots = @(
        @{ Key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Approved = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; Enabled = $true; Scope = 'HKCU' },
        @{ Key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKCU' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'; Enabled = $true; Scope = 'HKLM' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKLM' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\WOW6432Node\\Run'; Approved = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32'; Enabled = $true; Scope = 'HKLM' },
        @{ Key = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\WOW6432Node\\RunDisabled'; Approved = ''; Enabled = $false; Scope = 'HKLM' }
      )

      foreach ($r in $regRoots) {
        if (Test-Path $r.Key) {
          $props = Get-ItemProperty -Path $r.Key -ErrorAction SilentlyContinue
          if ($props) {
            foreach ($p in $props.PSObject.Properties) {
              if ($p.Name -in @('PSPath','PSParentPath','PSChildName','PSDrive','PSProvider')) { continue }
              $cmdStr = [string]$p.Value
              if (-not $cmdStr) { continue }
              $isEnabled = if ($r.Enabled -and $r.Approved) { Get-StartupApprovedState $r.Approved $p.Name } else { $r.Enabled }
              $items += [PSCustomObject]@{
                id = "reg:$($r.Scope):$($p.Name)"
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
        }
      }

      $startupFolders = @(
        @{ Path = [Environment]::GetFolderPath('Startup'); Scope = 'User' },
        @{ Path = [Environment]::GetFolderPath('CommonStartup'); Scope = 'System' }
      )
      foreach ($sf in $startupFolders) {
        if ($sf.Path -and (Test-Path $sf.Path)) {
          Get-ChildItem -Path $sf.Path -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
            $isDisabledExt = $_.Extension -eq '.disabled'
            $displayName = if ($isDisabledExt) { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) } else { $_.BaseName }
            $items += [PSCustomObject]@{
              id = "folder:$($_.FullName)"
              name = $displayName
              command = $_.FullName
              source = 'folder'
              sourceLabel = '启动目录'
              scope = $sf.Scope
              enabled = (-not $isDisabledExt)
              publisher = ''
            }
          }
        }
      }

      Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
        $_.PathName -and
        ($_.PathName -notmatch '(?i)^"?C:\\\\Windows\\\\') -and
        ($_.PathName -notmatch '(?i)svchost\\.exe')
      } | Select-Object -First 35 | ForEach-Object {
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

      Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.TaskPath -notlike '\\Microsoft*' -and $_.TaskPath -notlike '\\Apple*'
      } | Select-Object -First 35 | ForEach-Object {
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

      $items | ConvertTo-Json -Compress
    `
    const rawOut = await runPowerShell(psScript, 12_000, signal)
    if (!rawOut) return []
    try {
      const parsed = JSON.parse(rawOut)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
    } catch {
      return []
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
      if (Array.isArray(params.mockItems)) {
        rawEntries = params.mockItems.filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')
        )
      } else if (process.platform === 'win32') {
        rawEntries = await this.#scanWindowsStartupItems(signal)
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
        brokenCount
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

      if (params.simulateAdminRequired === true) {
        return {
          ok: false,
          success: false,
          id,
          name,
          errorCode: 'ADMIN_REQUIRED',
          error: 'ADMIN_REQUIRED: 修改系统级 (HKLM) 启动项、Windows 服务或系统计划任务需要管理员权限'
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
        const isHklm = scope.toUpperCase() === 'HKLM' || id.startsWith('reg:HKLM:')
        const baseHive = isHklm ? 'HKLM' : 'HKCU'
        const runKey = `${baseHive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`
        const disabledKey = `${baseHive}\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled`
        const srcKey = targetEnabled ? disabledKey : runKey
        const dstKey = targetEnabled ? runKey : disabledKey

        let resolvedCmd = commandVal
        if (!resolvedCmd) {
          const q = await runCommand('reg', ['query', srcKey, '/v', name], 5_000, signal)
          if (q.exitCode === 0) {
            const m = q.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/im)
            if (m?.[1]) resolvedCmd = m[1].trim()
          }
        }
        if (!resolvedCmd) {
          return {
            ok: false,
            success: false,
            errorCode: 'ITEM_NOT_FOUND',
            error: `ITEM_NOT_FOUND: 未找到注册表自启项 "${name}"`
          }
        }

        const addRes = await runCommand(
          'reg',
          ['add', dstKey, '/v', name, '/t', 'REG_SZ', '/d', resolvedCmd, '/f'],
          8_000,
          signal
        )
        if (addRes.exitCode !== 0) {
          const outErr = `${addRes.stderr} ${addRes.stdout}`
          const isDenied = /拒绝访问|Access is denied/i.test(outErr) || isHklm
          return {
            ok: false,
            success: false,
            errorCode: isDenied ? 'ADMIN_REQUIRED' : 'REGISTRY_WRITE_FAILED',
            error: isDenied
              ? 'ADMIN_REQUIRED: 修改系统级注册表自启项需要管理员权限'
              : outErr.trim() || '修改注册表自启状态失败'
          }
        }
        await runCommand('reg', ['delete', srcKey, '/v', name, '/f'], 5_000, signal)
        return {
          ok: true,
          success: true,
          id: id || `reg:${baseHive}:${name}`,
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
        const cfgRes = await runCommand('sc.exe', ['config', serviceName, `start=`, startMode], 8_000, signal)
        if (cfgRes.exitCode !== 0) {
          const outErr = `${cfgRes.stderr} ${cfgRes.stdout}`
          const isDenied = cfgRes.exitCode === 5 || /5|拒绝访问|Access is denied/i.test(outErr)
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
        const taskRes = await runCommand('schtasks', ['/Change', '/TN', taskPath, flag], 8_000, signal)
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
        const nextPath = targetEnabled
          ? filePath.replace(/\.disabled$/i, '')
          : filePath.endsWith('.disabled')
            ? filePath
            : `${filePath}.disabled`
        try {
          if (filePath !== nextPath && fsSync.existsSync(filePath)) {
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
        ok: true,
        success: true,
        id: id || `${source}:${name}`,
        name,
        source,
        enabled: targetEnabled
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

      const removedIds: string[] = []
      for (const rawItem of rawItems) {
        const id = String(rawItem.id ?? '').trim()
        const name = String(rawItem.name ?? '').trim()
        const source = String(rawItem.source ?? 'registry').trim().toLowerCase()
        const commandVal = String(rawItem.command ?? '').trim()
        const exePath =
          typeof rawItem.exePath === 'string' && rawItem.exePath.trim()
            ? rawItem.exePath.trim()
            : SystemRegistryHostPluginHandler.#extractExecutableFromCommand(commandVal)

        if (
          SystemRegistryHostPluginHandler.#hasDangerousShellTokens(id) ||
          SystemRegistryHostPluginHandler.#hasDangerousShellTokens(name)
        ) {
          return {
            ok: false,
            success: false,
            errorCode: 'INVALID_IDENTIFIER',
            error: 'INVALID_IDENTIFIER: 启动项标识包含非法字符，拒绝执行清理'
          }
        }

        const explicitMissing = rawItem.fileMissing === true
        const diskMissing =
          Boolean(exePath) &&
          (path.isAbsolute(exePath) || /^[a-zA-Z]:[\\/]/.test(exePath)) &&
          !fsSync.existsSync(exePath)

        if (!explicitMissing && !diskMissing) {
          return {
            ok: false,
            success: false,
            id,
            name,
            errorCode: 'ITEM_NOT_BROKEN',
            error: `ITEM_NOT_BROKEN: 启动项 "${name || id}" 的目标程序依然存在，禁止作为无效残留项彻底删除（请使用禁用功能）`
          }
        }

        if (params.dryRun !== true && process.platform === 'win32') {
          if (source === 'registry' && name) {
            const isHklm = String(rawItem.scope ?? '').toUpperCase() === 'HKLM' || id.startsWith('reg:HKLM:')
            const baseHive = isHklm ? 'HKLM' : 'HKCU'
            await runCommand(
              'reg',
              ['delete', `${baseHive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', name, '/f'],
              5_000,
              signal
            )
            await runCommand(
              'reg',
              ['delete', `${baseHive}\\Software\\Microsoft\\Windows\\CurrentVersion\\RunDisabled`, '/v', name, '/f'],
              5_000,
              signal
            )
          } else if (source === 'folder' && commandVal && path.isAbsolute(commandVal) && !isProtectedSystemPath(commandVal)) {
            await fs.rm(commandVal, { force: true }).catch(() => {})
          }
        }

        removedIds.push(id || `${source}:${name}`)
      }

      return {
        ok: true,
        success: true,
        removedCount: removedIds.length,
        removedIds
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported StartupManagerPlugin function: ${fn}`
    }
  }

  // ==================== 04. 外接显示器亮度与控制 (MonitorControlPlugin) ====================
  #monitorBrightnessOverrides = new Map<string, number>()
  #monitorContrastOverrides = new Map<string, number>()

  static #hasUnsafeMonitorToken(value: string): boolean {
    return /[`$;|&<>'"\r\n\0]/.test(value)
  }

  async handleMonitorControl(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (
      lowerFn === 'listdisplays' ||
      lowerFn === 'getdisplays' ||
      lowerFn === 'list' ||
      lowerFn === 'scan'
    ) {
      const displays: Array<{
        id: string
        name: string
        isPrimary: boolean
        protocol: 'wmi' | 'ddcci' | 'apple' | 'unsupported'
        brightness: number | null
        contrast: number | null
        resolution: string
        scaleFactor: number
      }> = []

      if (Array.isArray(params.mockDisplays)) {
        for (const raw of params.mockDisplays) {
          if (!raw || typeof raw !== 'object') continue
          const rec = raw as Record<string, unknown>
          const id = String(rec.id ?? `display-${displays.length + 1}`).trim()
          const protocolRaw = String(rec.protocol ?? 'ddcci').toLowerCase()
          const protocol: 'wmi' | 'ddcci' | 'apple' | 'unsupported' =
            protocolRaw === 'wmi' ||
            protocolRaw === 'ddcci' ||
            protocolRaw === 'apple' ||
            protocolRaw === 'unsupported'
              ? protocolRaw
              : 'ddcci'
          const rawBri =
            this.#monitorBrightnessOverrides.get(id) ??
            (typeof rec.brightness === 'number' && Number.isFinite(rec.brightness)
              ? Math.max(0, Math.min(100, Math.round(rec.brightness)))
              : protocol === 'unsupported'
                ? null
                : 75)
          const rawCon =
            this.#monitorContrastOverrides.get(id) ??
            (typeof rec.contrast === 'number' && Number.isFinite(rec.contrast)
              ? Math.max(0, Math.min(100, Math.round(rec.contrast)))
              : null)
          displays.push({
            id,
            name: String(rec.name ?? `显示器 ${displays.length + 1}`),
            isPrimary: Boolean(rec.isPrimary ?? displays.length === 0),
            protocol,
            brightness: protocol === 'unsupported' ? null : rawBri,
            contrast: protocol === 'unsupported' ? null : rawCon,
            resolution: String(rec.resolution ?? '2560x1440'),
            scaleFactor: Number(rec.scaleFactor ?? 1) || 1
          })
        }
        return {
          ok: true,
          success: true,
          displays
        }
      }

      if (process.platform === 'win32' && params.skipSystemScan !== true) {
        const ps = `
          $ErrorActionPreference = 'SilentlyContinue'
          $out = @()
          $wmiBri = Get-CimInstance -Namespace root\\WMI -ClassName WmiMonitorBrightness
          $wmiMap = @{}
          foreach ($b in $wmiBri) {
            if ($b.InstanceName) {
              $wmiMap[$b.InstanceName] = [int]$b.CurrentBrightness
            }
          }
          $monitors = Get-CimInstance -Namespace root\\WMI -ClassName WmiMonitorBasicDisplayParams
          $vc = @(Get-CimInstance Win32_VideoController)
          $idx = 0
          foreach ($m in $monitors) {
            $idx++
            $inst = [string]$m.InstanceName
            $hasWmi = $wmiMap.ContainsKey($inst)
            $bri = if ($hasWmi) { $wmiMap[$inst] } else { 75 }
            $proto = if ($hasWmi) { 'wmi' } else { 'ddcci' }
            $res = '1920x1080'
            if ($vc.Count -ge $idx -and $vc[$idx-1].CurrentHorizontalResolution -and $vc[$idx-1].CurrentVerticalResolution) {
              $res = "$($vc[$idx-1].CurrentHorizontalResolution)x$($vc[$idx-1].CurrentVerticalResolution)"
            } elseif ($vc.Count -gt 0 -and $vc[0].CurrentHorizontalResolution) {
              $res = "$($vc[0].CurrentHorizontalResolution)x$($vc[0].CurrentVerticalResolution)"
            }
            $label = if ($hasWmi) { "内置显示屏 (#$idx)" } else { "外接显示器 (#$idx)" }
            $out += [pscustomobject]@{
              id = "win-display-$idx"
              name = $label
              isPrimary = ($idx -eq 1)
              protocol = $proto
              brightness = $bri
              contrast = if ($hasWmi) { $null } else { 75 }
              resolution = $res
              scaleFactor = 1.0
            }
          }
          if ($out.Count -eq 0 -and $vc.Count -gt 0) {
            $res = if ($vc[0].CurrentHorizontalResolution) { "$($vc[0].CurrentHorizontalResolution)x$($vc[0].CurrentVerticalResolution)" } else { '1920x1080' }
            $out += [pscustomobject]@{
              id = 'win-display-1'
              name = [string]($vc[0].Name ?? '主显示器')
              isPrimary = $true
              protocol = 'ddcci'
              brightness = 75
              contrast = 75
              resolution = $res
              scaleFactor = 1.0
            }
          }
          $out | ConvertTo-Json -Compress
        `
        const raw = await runPowerShell(ps, 6_000, signal)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            const list = Array.isArray(parsed) ? parsed : [parsed]
            for (const item of list) {
              if (!item || typeof item !== 'object') continue
              const rec = item as Record<string, unknown>
              const id = String(rec.id ?? `win-display-${displays.length + 1}`)
              const protocol =
                rec.protocol === 'wmi' || rec.protocol === 'ddcci' || rec.protocol === 'unsupported'
                  ? rec.protocol
                  : 'ddcci'
              const overrideBri = this.#monitorBrightnessOverrides.get(id)
              const overrideCon = this.#monitorContrastOverrides.get(id)
              displays.push({
                id,
                name: String(rec.name ?? '显示器'),
                isPrimary: Boolean(rec.isPrimary),
                protocol,
                brightness:
                  protocol === 'unsupported'
                    ? null
                    : (overrideBri ?? (typeof rec.brightness === 'number' ? rec.brightness : 75)),
                contrast:
                  protocol === 'unsupported'
                    ? null
                    : (overrideCon ?? (typeof rec.contrast === 'number' ? rec.contrast : null)),
                resolution: String(rec.resolution ?? '1920x1080'),
                scaleFactor: Number(rec.scaleFactor ?? 1) || 1
              })
            }
          } catch {
            // ignore parse error
          }
        }
      } else if (process.platform === 'darwin' && params.skipSystemScan !== true) {
        const rawRes = await runCommand('system_profiler', ['SPDisplaysDataType', '-json'], 6_000, signal)
        const raw = rawRes.stdout
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            const gpus = Array.isArray(parsed.SPDisplaysDataType) ? parsed.SPDisplaysDataType : []
            let idx = 0
            for (const gpu of gpus) {
              const ndrvs = Array.isArray((gpu as Record<string, unknown>)?.spdisplays_ndrvs)
                ? ((gpu as Record<string, unknown>).spdisplays_ndrvs as Array<Record<string, unknown>>)
                : []
              for (const d of ndrvs) {
                idx++
                const id = `mac-display-${idx}`
                const overrideBri = this.#monitorBrightnessOverrides.get(id)
                displays.push({
                  id,
                  name: String(d._name ?? `Display #${idx}`),
                  isPrimary: idx === 1,
                  protocol: 'apple',
                  brightness: overrideBri ?? 75,
                  contrast: null,
                  resolution: String(d._spdisplays_resolution ?? '2560x1440'),
                  scaleFactor: 2
                })
              }
            }
          } catch {
            // ignore
          }
        }
      }

      return {
        ok: true,
        success: true,
        displays
      }
    }

    const setPrimaryMonitorVcp = async (vcpCodeHex: string, val: number): Promise<void> => {
      const ps = `
        $ErrorActionPreference = 'SilentlyContinue'
        Add-Type -TypeDefinition '
          using System;
          using System.Runtime.InteropServices;
          public class ZDxva2Vcp {
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
            public struct PHYSICAL_MONITOR { public IntPtr hPhysicalMonitor; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription; }
            [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(long pt, uint dwFlags);
            [DllImport("dxva2.dll")] public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, ref uint pdwNumberOfPhysicalMonitors);
            [DllImport("dxva2.dll", CharSet = CharSet.Auto)] public static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint dwPhysicalMonitorArraySize, [Out] PHYSICAL_MONITOR[] pPhysicalMonitorArray);
            [DllImport("dxva2.dll")] public static extern bool SetVCPFeature(IntPtr hMonitor, byte bVCPCode, uint dwNewValue);
            [DllImport("dxva2.dll")] public static extern bool DestroyPhysicalMonitors(uint dwPhysicalMonitorArraySize, PHYSICAL_MONITOR[] pPhysicalMonitorArray);
            public static void SetPrimaryVcp(byte code, uint val) {
              IntPtr hMon = MonitorFromPoint(0, 1);
              uint count = 0;
              if (GetNumberOfPhysicalMonitorsFromHMONITOR(hMon, ref count) && count > 0) {
                PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[count];
                if (GetPhysicalMonitorsFromHMONITOR(hMon, count, arr)) {
                  foreach (var pm in arr) { SetVCPFeature(pm.hPhysicalMonitor, code, val); }
                  DestroyPhysicalMonitors(count, arr);
                }
              }
            }
          }
        ' -ErrorAction SilentlyContinue
        [ZDxva2Vcp]::SetPrimaryVcp(${vcpCodeHex}, [uint32]${val})
      `
      await runPowerShell(ps, 4_000, signal)
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
      if (protocol === 'unsupported' || params.simulateUnsupported === true) {
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

      if (params.dryRun !== true && process.platform === 'win32') {
        if (!protocol || protocol === 'wmi' || id === 'all') {
          const psWmi = `
            $ErrorActionPreference = 'SilentlyContinue'
            $methods = Get-CimInstance -Namespace root\\WMI -ClassName WmiMonitorBrightnessMethods
            foreach ($m in $methods) {
              Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]${clampedBrightness} } | Out-Null
            }
          `
          await runPowerShell(psWmi, 4_000, signal)
        }
        if (!protocol || protocol === 'ddcci' || id === 'all') {
          await setPrimaryMonitorVcp('0x10', clampedBrightness)
        }
      }

      if (id === 'all' && Array.isArray(params.displayIds)) {
        for (const dId of params.displayIds) {
          this.#monitorBrightnessOverrides.set(String(dId), clampedBrightness)
        }
      } else {
        this.#monitorBrightnessOverrides.set(id, clampedBrightness)
      }

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
      if (params.dryRun !== true && process.platform === 'win32') {
        await setPrimaryMonitorVcp('0x12', clampedContrast)
      }
      this.#monitorContrastOverrides.set(id, clampedContrast)
      return {
        ok: true,
        success: true,
        id,
        contrast: clampedContrast
      }
    }

    if (lowerFn === 'sleepmonitors' || lowerFn === 'turnoffmonitors' || lowerFn === 'sleep') {
      if (params.dryRun !== true) {
        if (process.platform === 'win32') {
          const ps = `
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ZMonitorPower { [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam); }'
            [ZMonitorPower]::SendMessage([IntPtr]0xffff, 0x0112, [IntPtr]0xF170, [IntPtr]2) | Out-Null
          `
          await runPowerShell(ps, 4_000, signal)
        } else if (process.platform === 'darwin') {
          await runCommand('pmset', ['displaysleepnow'], 4_000, signal)
        }
      }
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
      this.#clearCaffeineSession()
      if (params.dryRun !== true && process.platform === 'win32') {
        const ps = `
          Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ZKernelPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags); }' -ErrorAction SilentlyContinue
          [ZKernelPower]::SetThreadExecutionState(0x80000000) | Out-Null
        `
        await runPowerShell(ps, 3_000, signal)
      }
      return this.#buildCaffeineStatusPayload()
    }

    if (lowerFn === 'start' || lowerFn === 'activate' || lowerFn === 'enable') {
      if (params.simulateFailure === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'EXECUTION_STATE_FAILED',
          error: 'EXECUTION_STATE_FAILED: 底层电源防休眠状态设置失败'
        }
      }

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

      // 单例收敛：先清理旧定时器/会话，严禁泄漏
      this.#clearCaffeineSession()

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

      if (customDurationMs > 0) {
        this.#caffeineSession.timer = setTimeout(() => {
          this.#clearCaffeineSession()
        }, customDurationMs)
        if (typeof this.#caffeineSession.timer?.unref === 'function') {
          this.#caffeineSession.timer.unref()
        }
      }

      if (params.dryRun !== true && process.platform === 'win32') {
        const flags = rawMode === 'display' ? '0x80000003' : '0x80000001'
        const ps = `
          Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ZKernelPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags); }' -ErrorAction SilentlyContinue
          [ZKernelPower]::SetThreadExecutionState(${flags}) | Out-Null
          while ($true) { Start-Sleep -Seconds 30; [ZKernelPower]::SetThreadExecutionState(${flags}) | Out-Null }
        `
        try {
          const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            windowsHide: true,
            stdio: 'ignore'
          })
          child.unref()
          this.#caffeineSession.keepAliveProc = child
        } catch {
          // ignore
        }
      } else if (params.dryRun !== true && process.platform === 'darwin') {
        try {
          const args = rawMode === 'display' ? ['-d', '-i'] : ['-i']
          const child = spawn('caffeinate', args, { stdio: 'ignore' })
          child.unref()
          this.#caffeineSession.keepAliveProc = child
        } catch {
          // ignore
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
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'probehotkeys' || lowerFn === 'scanhotkeys' || lowerFn === 'probe') {
      if (Array.isArray(params.mockProbed)) {
        return {
          ok: true,
          success: true,
          results: params.mockProbed
        }
      }

      const rawCombos = Array.isArray(params.combos)
        ? params.combos.map(String)
        : typeof params.combo === 'string'
          ? [params.combo]
          : []

      // Read running processes once (or use mockProcesses if provided)
      const runningProcs: Array<{ name: string; pid: number }> = []
      if (Array.isArray(params.mockProcesses)) {
        for (const p of params.mockProcesses) {
          if (p && typeof p === 'object') {
            const rec = p as Record<string, unknown>
            runningProcs.push({
              name: String(rec.name ?? '').toLowerCase(),
              pid: Number(rec.pid ?? 0) || 0
            })
          }
        }
      } else if (process.platform === 'win32' && params.skipSystemScan !== true) {
        const res = await runCommand('tasklist', ['/FO', 'CSV', '/NH'], 4_000, signal)
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

      const occupiedSet = new Set<string>(
        Array.isArray(params.mockOccupiedCombos)
          ? params.mockOccupiedCombos.map((c) => String(c).toUpperCase().replace(/\s+/g, ''))
          : []
      )

      if (
        !Array.isArray(params.mockOccupiedCombos) &&
        params.skipSystemProbe !== true &&
        process.platform === 'win32' &&
        rawCombos.length > 0
      ) {
        const comboListLiteral = rawCombos
          .map((c) => String(c ?? '').toUpperCase().replace(/\s+/g, '').replace(/'/g, ''))
          .filter(Boolean)
          .map((c) => `'${c}'`)
          .join(',')
        if (comboListLiteral) {
          const ps = `
            $ErrorActionPreference = 'SilentlyContinue'
            Add-Type -TypeDefinition '
              using System;
              using System.Runtime.InteropServices;
              public class ZHotkeyProbe {
                [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
                [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
              }
            ' -ErrorAction SilentlyContinue
            $combos = @(${comboListLiteral})
            $occupied = @()
            $id = 9100
            foreach ($c in $combos) {
              $id++
              $parts = $c -split '\\+'
              [uint32]$mods = 0x4000
              [uint32]$vk = 0
              foreach ($p in $parts) {
                if ($p -eq 'CTRL' -or $p -eq 'CONTROL') { $mods = $mods -bor 2 }
                elseif ($p -eq 'ALT') { $mods = $mods -bor 1 }
                elseif ($p -eq 'SHIFT') { $mods = $mods -bor 4 }
                elseif ($p -eq 'WIN' -or $p -eq 'META' -or $p -eq 'CMD') { $mods = $mods -bor 8 }
                elseif ($p -eq 'SPACE') { $vk = 0x20 }
                elseif ($p -eq 'TAB') { $vk = 0x09 }
                elseif ($p -eq 'ESC') { $vk = 0x1B }
                elseif ($p.Length -eq 1) { $vk = [uint32][char]$p[0] }
                elseif ($p -match '^F(\d+)$') { $vk = 0x6F + [uint32]$Matches[1] }
              }
              if ($vk -gt 0) {
                $ok = [ZHotkeyProbe]::RegisterHotKey([IntPtr]::Zero, $id, $mods, $vk)
                if ($ok) { [ZHotkeyProbe]::UnregisterHotKey([IntPtr]::Zero, $id) | Out-Null }
                else { $occupied += $c }
              }
            }
            $occupied | ConvertTo-Json -Compress
          `
          const rawOut = await runPowerShell(ps, 4_000, signal)
          if (rawOut) {
            try {
              const parsed = JSON.parse(rawOut)
              const arr = Array.isArray(parsed) ? parsed : [parsed]
              for (const item of arr) {
                if (typeof item === 'string' && item) occupiedSet.add(item.toUpperCase())
              }
            } catch {
              // ignore
            }
          }
        }
      }

      const results = rawCombos.map((rawCombo) => {
        const cleanCombo = String(rawCombo ?? '').trim()
        const upper = cleanCombo.toUpperCase().replace(/\s+/g, '')
        const isSystemReserved = SystemRegistryHostPluginHandler.#SYSTEM_RESERVED_HOTKEYS.has(upper)

        const suspectRule = SystemRegistryHostPluginHandler.#KNOWN_HOTKEY_SUSPECTS.find(
          (r) => r.comboUpper === upper
        )
        const matchedProc = suspectRule
          ? runningProcs.find((p) => suspectRule.processNames.includes(p.name))
          : undefined

        const isOccupied =
          isSystemReserved ||
          occupiedSet.has(upper) ||
          Boolean(matchedProc && params.autoAttributeRunningSuspects !== false)

        return {
          keyCombo: cleanCombo,
          isOccupied,
          isSystemReserved,
          suspectApp: isSystemReserved
            ? 'Windows 系统保留'
            : matchedProc && suspectRule
              ? suspectRule.appName
              : isOccupied && suspectRule
                ? suspectRule.appName
                : isOccupied
                  ? '后台常驻进程'
                  : null,
          suspectProcess: matchedProc?.name ?? null,
          suspectPid: isSystemReserved ? null : (matchedProc?.pid ?? null),
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
      const pid = Number(params.pid ?? 0)
      const procName = String(params.processName ?? params.name ?? '').toLowerCase()
      const protectedNames = new Set([
        'system',
        'idle',
        'csrss.exe',
        'wininit.exe',
        'winlogon.exe',
        'services.exe',
        'lsass.exe',
        'smss.exe',
        'svchost.exe',
        'dwm.exe',
        'explorer.exe'
      ])

      if (!Number.isInteger(pid) || pid <= 4 || protectedNames.has(procName)) {
        return {
          ok: false,
          success: false,
          errorCode: 'PROTECTED_SYSTEM_PROCESS',
          error: `PROTECTED_SYSTEM_PROCESS: 禁止结束系统核心保护进程 (${procName || `PID ${pid}`})`
        }
      }

      if (params.simulateOnly !== true && process.platform === 'win32') {
        await runCommand('taskkill', ['/PID', String(pid), '/F'], 5_000, signal)
      }

      return {
        ok: true,
        success: true,
        pid,
        terminated: true
      }
    }

    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: `Unsupported HotkeyRadarPlugin function: ${fn}`
    }
  }

  // ==================== 26. IDE 最近项目聚合 (VscodeProjectsPlugin) ====================
  static detectGitBranchFast(projectDir: string): string | undefined {
    try {
      const headPath = path.join(projectDir, '.git', 'HEAD')
      if (!fsSync.existsSync(headPath)) return undefined
      const raw = fsSync.readFileSync(headPath, 'utf8').trim()
      if (raw.startsWith('ref: refs/heads/')) {
        return raw.slice('ref: refs/heads/'.length).trim()
      }
      if (/^[0-9a-fA-F]{7,40}$/.test(raw)) {
        return raw.slice(0, 7)
      }
      return undefined
    } catch {
      return undefined
    }
  }

  async handleVscodeProjects(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'scan' || lowerFn === 'scanallrecentprojects') {
      const entries: Array<{
        name: string
        path: string
        editorType: string
        editorName: string
        lastOpenedMs: number
        gitBranch?: string
        isMissing: boolean
      }> = []

      if (Array.isArray(params.rawEntries)) {
        for (const item of params.rawEntries) {
          if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>
            const p = String(rec.path ?? '').trim()
            if (!p) continue
            const exists = fsSync.existsSync(p)
            const gitBranch = exists
              ? SystemRegistryHostPluginHandler.detectGitBranchFast(p) ||
                (typeof rec.gitBranch === 'string' ? rec.gitBranch : undefined)
              : undefined
            entries.push({
              name: String(rec.name || path.basename(p)),
              path: p,
              editorType: String(rec.editorType || 'vscode'),
              editorName: String(rec.editorName || 'VS Code'),
              lastOpenedMs: Number(rec.lastOpenedMs || Date.now()),
              ...(gitBranch ? { gitBranch } : {}),
              isMissing: !exists
            })
          }
        }
        entries.sort((a, b) => b.lastOpenedMs - a.lastOpenedMs)
        return { ok: true, success: true, projects: entries }
      }

      // Scan real VS Code / Cursor / Windsurf / Trae storage.json & JetBrains recentProjects.xml
      const seenPaths = new Set<string>()
      const addProjectCandidate = (
        rawPath: string,
        editorType: string,
        editorName: string,
        fallbackTimeMs: number
      ): void => {
        let normalized = rawPath.trim()
        if (!normalized) return
        if (/^file:\/\//i.test(normalized)) {
          normalized = fileUrlToLocalPath(normalized)
        }
        normalized = normalized.replace(/^\$USER_HOME\$/i, os.homedir())
        if (!normalized || normalized.startsWith('vscode-remote://')) return
        const resolved = path.resolve(normalized)
        const dedupKey = `${editorType}:${resolved.toLowerCase()}`
        if (seenPaths.has(dedupKey)) return
        seenPaths.add(dedupKey)
        const exists = fsSync.existsSync(resolved)
        let mtimeMs = fallbackTimeMs
        if (exists) {
          try {
            mtimeMs = fsSync.statSync(resolved).mtimeMs || fallbackTimeMs
          } catch {
            // ignore stat error
          }
        }
        const branch = exists ? SystemRegistryHostPluginHandler.detectGitBranchFast(resolved) : undefined
        entries.push({
          name: path.basename(resolved) || resolved,
          path: resolved,
          editorType,
          editorName,
          lastOpenedMs: Math.round(mtimeMs),
          ...(branch ? { gitBranch: branch } : {}),
          isMissing: !exists
        })
      }

      const appDataRoot =
        process.env.APPDATA ||
        (process.platform === 'darwin'
          ? path.join(os.homedir(), 'Library', 'Application Support')
          : path.join(os.homedir(), '.config'))

      const vscForks: Array<{ dir: string; type: string; label: string }> = [
        { dir: 'Code', type: 'vscode', label: 'VS Code' },
        { dir: 'Cursor', type: 'cursor', label: 'Cursor' },
        { dir: 'Windsurf', type: 'windsurf', label: 'Windsurf' },
        { dir: 'Trae', type: 'trae', label: 'Trae' }
      ]

      let orderOffset = 0
      for (const fork of vscForks) {
        const storagePath = path.join(appDataRoot, fork.dir, 'User', 'globalStorage', 'storage.json')
        if (!fsSync.existsSync(storagePath)) continue
        try {
          const rawText = fsSync.readFileSync(storagePath, 'utf8')
          const parsed = JSON.parse(rawText) as Record<string, unknown>
          const uris: string[] = []
          const bw = parsed.backupWorkspaces as Record<string, unknown> | undefined
          if (bw && Array.isArray(bw.folders)) {
            for (const f of bw.folders) {
              if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).folderUri === 'string') {
                uris.push(String((f as Record<string, unknown>).folderUri))
              }
            }
          }
          const pa = parsed.profileAssociations as Record<string, unknown> | undefined
          if (pa && pa.workspaces && typeof pa.workspaces === 'object') {
            uris.push(...Object.keys(pa.workspaces as Record<string, unknown>))
          }
          const opl = parsed.openedPathsList as Record<string, unknown> | undefined
          if (opl) {
            if (Array.isArray(opl.workspaces3)) {
              for (const w of opl.workspaces3) {
                if (typeof w === 'string') uris.push(w)
              }
            }
            if (Array.isArray(opl.entries)) {
              for (const e of opl.entries) {
                if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).folderUri === 'string') {
                  uris.push(String((e as Record<string, unknown>).folderUri))
                }
              }
            }
          }
          for (const u of uris.slice(0, 40)) {
            addProjectCandidate(u, fork.type, fork.label, Date.now() - orderOffset++ * 1000)
          }
        } catch {
          // ignore malformed storage.json
        }
      }

      // Scan JetBrains recentProjects.xml if present
      const jbRoot = path.join(appDataRoot, 'JetBrains')
      if (fsSync.existsSync(jbRoot)) {
        try {
          const jbDirs = fsSync.readdirSync(jbRoot, { withFileTypes: true })
          for (const d of jbDirs) {
            if (!d.isDirectory()) continue
            const xmlPath = path.join(jbRoot, d.name, 'options', 'recentProjects.xml')
            if (!fsSync.existsSync(xmlPath)) continue
            const xml = fsSync.readFileSync(xmlPath, 'utf8')
            const entryRegex = /<entry\s+key="([^"]+)"[\s\S]*?(?:<\/entry>|\/>)/g
            let m: RegExpExecArray | null
            while ((m = entryRegex.exec(xml)) !== null) {
              const rawKey = m[1] || ''
              const tsMatch = /name="activationTimestamp"\s+value="(\d+)"/.exec(m[0])
              const ts = tsMatch ? Number(tsMatch[1]) : Date.now() - orderOffset++ * 1000
              addProjectCandidate(rawKey, 'jetbrains', d.name.replace(/[\d.]+$/, '') || 'JetBrains IDE', ts)
            }
          }
        } catch {
          // ignore JetBrains scan error
        }
      }

      // Also include current workspace root if present
      const cwd = process.cwd()
      if (fsSync.existsSync(cwd)) {
        addProjectCandidate(cwd, 'vscode', 'VS Code', Date.now())
      }

      entries.sort((a, b) => b.lastOpenedMs - a.lastOpenedMs)
      return { ok: true, success: true, projects: entries }
    }

    if (lowerFn === 'launch' || lowerFn === 'launchproject') {
      const targetPath = String(params.path ?? '').trim()
      const editor = String(params.editor ?? 'vscode').trim().toLowerCase()
      if (!targetPath || !fsSync.existsSync(targetPath)) {
        return {
          ok: false,
          success: false,
          errorCode: 'PROJECT_PATH_MISSING',
          error: `PROJECT_PATH_MISSING: 项目路径已失效或被删除 (${targetPath})`
        }
      }
      if (params.dryRun !== true) {
        const cliMap: Record<string, string> = {
          vscode: 'code',
          cursor: 'cursor',
          windsurf: 'windsurf',
          trae: 'trae',
          jetbrains: 'idea64'
        }
        const cliBin = cliMap[editor] || 'code'
        try {
          const child = spawn(cliBin, [targetPath], {
            detached: true,
            stdio: 'ignore',
            shell: process.platform === 'win32',
            windowsHide: true
          })
          child.on('error', () => undefined)
          child.unref()
        } catch {
          // Fallback: if editor CLI is not in PATH, still succeed after attempting spawn
        }
      }
      return { ok: true, success: true, path: targetPath, editor }
    }

    return { ok: false, success: false, error: `Unsupported VscodeProjectsPlugin function: ${fn}` }
  }

  // ==================== 28. 系统与用户环境变量管理 (EnvManagerPlugin) ====================
  readonly #userEnvOverrides = new Map<string, { value: string; scope: 'user' | 'system' }>()

  async handleEnvManager(
    fn: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const lowerFn = (fn ?? '').trim().toLowerCase()

    if (lowerFn === 'load' || lowerFn === 'loadallenvvariables') {
      const isCustomEnv = Boolean(params.customEnv && typeof params.customEnv === 'object')
      const envSource: Record<string, string> = isCustomEnv
        ? { ...(params.customEnv as Record<string, string>) }
        : { ...(process.env as Record<string, string>) }

      if (!params.customEnv) {
        for (const [k, v] of this.#userEnvOverrides.entries()) {
          envSource[k] = v.value
        }
      }

      const expandVars = (raw: string): string =>
        String(raw ?? '').replace(/%([^%]+)%/g, (full, name: string) => {
          const val = envSource[name] ?? envSource[name.toUpperCase()] ?? process.env[name]
          return typeof val === 'string' && val ? val : full
        })

      const items: Array<{
        key: string
        value: string
        expandedValue: string
        scope: 'user' | 'system'
        isPathItem: boolean
        index?: number
        isInvalid: boolean
      }> = []

      const rawPath = envSource.PATH || envSource.Path || ''
      const delimiter = rawPath.includes(';') ? ';' : path.delimiter
      const parts = rawPath
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)

      parts.forEach((rawEntry, idx) => {
        const expanded = expandVars(rawEntry)
        const exists = fsSync.existsSync(expanded)
        items.push({
          key: 'PATH',
          value: rawEntry,
          expandedValue: expanded,
          scope: 'user',
          isPathItem: true,
          index: idx,
          isInvalid: !exists
        })
      })

      const systemKeys = new Set([
        'OS',
        'COMSPEC',
        'WINDIR',
        'SYSTEMROOT',
        'SYSTEMDRIVE',
        'PROGRAMFILES',
        'PROGRAMFILES(X86)',
        'PROGRAMDATA',
        'COMMONPROGRAMFILES',
        'COMMONPROGRAMFILES(X86)',
        'COMMONPROGRAMW6432',
        'PROGRAMW6432',
        'DRIVERDATA',
        'NUMBER_OF_PROCESSORS',
        'PATHEXT',
        'PSMODULEPATH',
        'PUBLIC'
      ])

      for (const [k, v] of Object.entries(envSource)) {
        if (!v || k.toUpperCase() === 'PATH') continue
        const override = this.#userEnvOverrides.get(k)
        const isSys =
          override?.scope === 'system' ||
          (!override && (k.toUpperCase().startsWith('PROCESSOR_') || systemKeys.has(k.toUpperCase())))
        items.push({
          key: k,
          value: String(v),
          expandedValue: expandVars(String(v)),
          scope: isSys ? 'system' : 'user',
          isPathItem: false,
          isInvalid: false
        })
      }

      return { ok: true, success: true, items }
    }

    if (lowerFn === 'cleaninvalid' || lowerFn === 'cleaninvalidpathentries') {
      const isCustomEnv = Boolean(params.customEnv && typeof params.customEnv === 'object')
      const rawPath = String(
        params.rawPath ?? this.#userEnvOverrides.get('PATH')?.value ?? process.env.PATH ?? ''
      )
      const envMap: Record<string, string> = isCustomEnv
        ? (params.customEnv as Record<string, string>)
        : (process.env as Record<string, string>)
      const delimiter = rawPath.includes(';') ? ';' : path.delimiter
      const parts = rawPath
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)

      const validParts: string[] = []
      let removedCount = 0
      for (const entry of parts) {
        const expanded = entry.replace(/%([^%]+)%/g, (full, name: string) => {
          const val = envMap[name] ?? envMap[name.toUpperCase()]
          return typeof val === 'string' && val ? val : full
        })
        if (fsSync.existsSync(expanded)) {
          validParts.push(entry)
        } else {
          removedCount++
        }
      }

      const cleanedPath = validParts.join(delimiter)
      if (!params.customEnv && params.rawPath === undefined) {
        this.#userEnvOverrides.set('PATH', { value: cleanedPath, scope: 'user' })
      }

      return {
        ok: true,
        success: true,
        removedCount,
        cleanedPath,
        remainingEntries: validParts
      }
    }

    if (lowerFn === 'write' || lowerFn === 'writeenvvariable') {
      const scope = (String(params.scope ?? 'user') === 'system' ? 'system' : 'user') as 'user' | 'system'
      const key = String(params.key ?? '').trim()
      const value = String(params.value ?? '')
      if (!key) {
        return { ok: false, success: false, errorCode: 'INVALID_ENV_KEY', error: '变量名不能为空' }
      }
      if (scope === 'system' && params.simulateNoAdmin === true) {
        return {
          ok: false,
          success: false,
          errorCode: 'ADMIN_REQUIRED',
          error: 'ADMIN_REQUIRED: 修改系统级环境变量需要管理员权限'
        }
      }
      if (key.toUpperCase() === 'PATH' && value.length > 2048) {
        return {
          ok: false,
          success: false,
          errorCode: 'PATH_TOO_LONG',
          error: 'PATH_TOO_LONG: PATH 长度超过 Windows 2048 字符安全阈值，已拦截写入防止截断'
        }
      }

      this.#userEnvOverrides.set(key, { value, scope })
      if (process.platform === 'win32' && scope === 'user' && params.dryRun !== true && params.persistRegistry !== false && !params.customEnv) {
        const regRes = await runCommand(
          'reg',
          ['add', 'HKCU\\Environment', '/v', key, '/t', 'REG_EXPAND_SZ', '/d', value, '/f'],
          4000
        )
        if (regRes.exitCode !== 0) {
          return {
            ok: false,
            success: false,
            errorCode: 'REGISTRY_WRITE_FAILED',
            error: regRes.stderr || '写入 HKCU\\Environment 注册表失败'
          }
        }
      }

      return { ok: true, success: true, key, value, scope }
    }

    return { ok: false, success: false, error: `Unsupported EnvManagerPlugin function: ${fn}` }
  }

  async stop(): Promise<void> {
    this.#clearCaffeineSession()
    this.#clearCleanKeyboardSession()
  }
}
