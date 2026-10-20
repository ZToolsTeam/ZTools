import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  PROTECTED_PROCESS_NAMES,
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
    const freeMemBefore = os.freemem()
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

      const freeMemAfter = os.freemem()
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
    const freeMem = os.freemem()
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
      const targetPath = String(
        params.uninstallString ?? params.installLocation ?? params.path ?? params.uninstallPath ?? ''
      ).trim()
      if (!targetPath) {
        return { ok: false, success: false, error: '未提供待清理的软件残余目录或卸载程序路径' }
      }
      const cleanCandidate = targetPath.replace(/^"([^"]+)".*$/, '$1').trim()
      const resolved = await this.#ctx.authorizeExistingPath(cleanCandidate, caller, 'write')
      if (isProtectedSystemPath(resolved)) {
        return { ok: false, success: false, error: '系统核心路径受保护，禁止移除' }
      }
      await fs.rm(resolved, { recursive: true, force: true })
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
              installLocation: path.dirname(full),
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
      if (
        this.#ctx.windowControl &&
        typeof (this.#ctx.windowControl as { getActiveWindow?: () => Promise<unknown> }).getActiveWindow === 'function'
      ) {
        const active = await (this.#ctx.windowControl as { getActiveWindow: () => Promise<unknown> }).getActiveWindow()
        return { ok: true, success: true, activeWindow: active, windows: active ? [active] : [] }
      }
      if (process.platform === 'win32') {
        const ps = `
          Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 30 | ForEach-Object {
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
          activeWindow: windows[0] ?? null,
          windows
        }
      }
      return { ok: true, success: true, windows: [] }
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
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
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
        [ZToolsWin32]::SetForegroundWindow($hwnd) | Out-Null
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
    if (lowerFn === 'settext' || lowerFn === 'writetext' || lowerFn === 'copy') {
      const text = String(params.text ?? params.content ?? '')
      if (this.#ctx.clipboard) {
        await this.#ctx.clipboard.setText(text)
      }
      return { ok: true, success: true, text }
    }
    const text = this.#ctx.clipboard ? await this.#ctx.clipboard.getText().catch(() => '') : ''
    return {
      ok: true,
      success: true,
      items: text ? [{ id: 'clip-latest', text, type: 'text', createdAt: new Date().toISOString() }] : []
    }
  }
}
