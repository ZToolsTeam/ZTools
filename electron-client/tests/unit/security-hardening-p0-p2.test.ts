import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ChildProcess, spawn } from 'node:child_process'
import {
  isPrivilegedMethod,
  type CallerIdentity
} from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { ZToolsRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { requirePluginPermission } from '../../src/main/ipc/plugin-principal.js'
import { authorizeIpcRequest } from '../../src/main/ipc/router.js'
import {
  WEB_CONTENT_SECURITY_POLICY,
  withWebSecurityHeaders
} from '../../src/main/protocol/ztools-protocol.js'
import type { CredentialProtection, CredentialProtectionStatus } from '../../src/main/services/credential-protection.js'
import {
  MCP_ENCRYPTED_VALUE_PREFIX,
  MCP_REDACTED_VALUE,
  McpService
} from '../../src/main/services/mcp-service.js'
import { ScriptCommandsService } from '../../src/main/services/script-commands-service.js'
import {
  ADMIN_ELEVATION_PS_SCRIPT,
  buildAdminElevationSpawnSpec,
  createDefaultRunProcessLauncher,
  POWERSHELL_LAUNCH_SCRIPT,
  WindowsRunService
} from '../../src/main/services/windows-run-service.js'

class InMemoryCredentialProtection implements CredentialProtection {
  readonly #key = randomBytes(32)
  statusValue: CredentialProtectionStatus = { status: 'available' }
  shouldReEncrypt = false

  async status(): Promise<CredentialProtectionStatus> {
    return this.statusValue
  }

  async encrypt(plaintext: string): Promise<Buffer> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }

  async decrypt(ciphertext: Buffer): Promise<{ readonly plaintext: string; readonly shouldReEncrypt: boolean }> {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, ciphertext.subarray(0, 12))
    decipher.setAuthTag(ciphertext.subarray(12, 28))
    return {
      plaintext: Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8'),
      shouldReEncrypt: this.shouldReEncrypt
    }
  }
}

// ===========================================================================
// P0-1: windows-run-service.ts launchAsAdmin & PowerShell 命令注入防护
// ===========================================================================
test('P0-1: launchAsAdmin 与 PowerShell 启动绝不将注入载荷拼入 -Command，并拒绝空字节', async () => {
  const payloads = [
    { file: 'notepad.exe"; whoami; #', args: '$(calc)' },
    { file: 'C:\\Tools\\$(calc).exe', args: '`calc` | whoami' },
    { file: 'cmd.exe', args: '"; Start-Process calc.exe; "' }
  ]

  for (const payload of payloads) {
    const spec = buildAdminElevationSpawnSpec(payload.file, payload.args, { PATH: 'C:\\Windows' })
    assert.equal(spec.executable, 'powershell.exe')
    const cmdIndex = spec.args.indexOf('-Command')
    assert.ok(cmdIndex >= 0)
    const commandScript = spec.args[cmdIndex + 1]
    assert.equal(commandScript, ADMIN_ELEVATION_PS_SCRIPT)
    // 注入载荷绝对不能出现在 -Command 脚本中
    assert.equal(commandScript?.includes(payload.file), false)
    assert.equal(commandScript?.includes(payload.args), false)
    assert.equal(commandScript?.includes('$(calc)'), false)
    assert.equal(commandScript?.includes('whoami'), false)
    assert.equal(commandScript?.includes('`'), false)
    // 通过环境变量原样安全传递
    assert.equal(spec.env.ZTOOLS_RUN_FILE, payload.file)
    assert.equal(spec.env.ZTOOLS_RUN_ARGS, payload.args)
  }

  // 注入 spawnImpl 验证 launchAsAdmin 完整执行路径与 env 传递
  const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv | undefined }> = []
  const fakeSpawn = ((command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options?.env })
    const child = new EventEmitter() as ChildProcess
    setImmediate(() => child.emit('exit', 0))
    return child
  }) as unknown as typeof spawn

  const launcher = createDefaultRunProcessLauncher(fakeSpawn)
  const adminRes = await launcher.launchAsAdmin('C:\\app\\$(calc).exe', '"; whoami')
  assert.equal(adminRes.success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, 'powershell.exe')
  assert.equal(calls[0]?.args[calls[0].args.indexOf('-Command') + 1], ADMIN_ELEVATION_PS_SCRIPT)
  assert.equal(calls[0]?.env?.ZTOOLS_RUN_FILE, 'C:\\app\\$(calc).exe')
  assert.equal(calls[0]?.env?.ZTOOLS_RUN_ARGS, '"; whoami')

  // 空字节必须被拒绝
  assert.throws(() => buildAdminElevationSpawnSpec('notepad\0.exe', ''), /空字节|null byte/i)
  assert.throws(() => buildAdminElevationSpawnSpec('notepad.exe', 'arg\0bad'), /空字节|null byte/i)
  const nullAdminRes = await launcher.launchAsAdmin('notepad\0.exe', '')
  assert.equal(nullAdminRes.success, false)

  // shell === 'powershell' 同样采用固定脚本 + 环境变量传参，不拼入 -Command
  calls.length = 0
  const service = new WindowsRunService(launcher)
  await service.execute('C:\\app\\$(calc).exe', { shell: 'powershell', arguments: '"; whoami' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, 'powershell.exe')
  assert.equal(calls[0]?.args[calls[0].args.indexOf('-Command') + 1], POWERSHELL_LAUNCH_SCRIPT)
  assert.equal(calls[0]?.env?.ZTOOLS_RUN_FILE, 'C:\\app\\$(calc).exe')
  assert.deepEqual(JSON.parse(calls[0]?.env?.ZTOOLS_RUN_ARGS_JSON ?? '[]'), ['";', 'whoami'])

  // shell === 'cmd' 拒绝换行符注入；execute 拒绝空字节
  await assert.rejects(service.execute('echo ok\ncalc', { shell: 'cmd' }), /换行符|newline/i)
  await assert.rejects(service.execute('notepad\0.exe'), /空字节|null byte/i)
})

// ===========================================================================
// P0-2: 高危系统方法权限收口、声明式会话拦截、script-commands 路径归属与 mcp_install_server 校验
// ===========================================================================
test('P0-2: PRIVILEGED_METHODS 与 authorizeIpcRequest 严格拦截第三方声明式插件与失效会话', async () => {
  const newlyPrivileged = [
    'windows_run_execute',
    'script_commands_execute',
    'script_commands_create',
    'brew_exec'
  ] as const
  for (const method of newlyPrivileged) {
    assert.equal(isPrivilegedMethod(method), true, `${method} 必须纳入 PRIVILEGED_METHODS`)
  }
  // 官方声明式插件（software-manager / wifi-password-reveal）使用 system 权限校验，不进 PRIVILEGED_METHODS
  assert.equal(isPrivilegedMethod('applications_uninstall'), false)
  assert.equal(isPrivilegedMethod('wifi_get_password'), false)

  const mainSender = { getURL: () => 'ztools://web/index.html' }
  const hostCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
  const thirdPartyDeclarativeCaller: CallerIdentity = {
    type: 'main',
    webContentsId: 1,
    attributedPlugin: {
      pluginId: 'third-party-declarative',
      sessionId: 'ds_1234567890abcdef',
      permissions: new Set(['system', 'shell', 'fs']),
      source: 'installed'
    }
  }
  const staleSessionCaller: CallerIdentity = {
    type: 'main',
    webContentsId: 1,
    stalePluginSession: true
  }
  const thirdPartyWindowCaller: CallerIdentity = {
    type: 'plugin',
    webContentsId: 2,
    pluginId: 'third-party-window',
    pluginInstanceId: 'inst-1'
  }
  const windowSender = { getURL: () => 'ztools://plugins/third-party-window/index.html' }
  const req = (method: string): ZToolsRequest => ({ messageId: 'm1', method, params: {} })

  // 宿主自身可调用所有高危方法
  for (const method of [...newlyPrivileged, 'config_set', 'settings_set', 'plugin_install', 'privileged_execute']) {
    assert.doesNotThrow(() => authorizeIpcRequest(hostCaller, req(method), mainSender))
  }

  // 第三方声明式插件、失效会话与独立插件窗口调用高危特权方法一律拦截
  for (const method of [...newlyPrivileged, 'config_set', 'settings_set', 'plugin_install', 'privileged_execute', 'system_get_native_id']) {
    assert.throws(
      () => authorizeIpcRequest(thirdPartyDeclarativeCaller, req(method), mainSender),
      (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.permissionDenied,
      `第三方声明式插件调用 ${method} 必须被拦截`
    )
    assert.throws(
      () => authorizeIpcRequest(staleSessionCaller, req(method), mainSender),
      (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.permissionDenied,
      `失效插件会话调用 ${method} 必须被拦截`
    )
    assert.throws(
      () => authorizeIpcRequest(thirdPartyWindowCaller, req(method), windowSender),
      (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.permissionDenied,
      `第三方插件窗口调用 ${method} 必须被拦截`
    )
  }

  // 只读硬件/卷监控方法：有效声明式插件会话放行，但失效插件会话与第三方插件窗口仍拦截
  for (const readonlyMethod of ['system_list_volumes', 'system_get_hardware_summary', 'system_get_memory_usage']) {
    assert.doesNotThrow(() => authorizeIpcRequest(thirdPartyDeclarativeCaller, req(readonlyMethod), mainSender))
    assert.throws(
      () => authorizeIpcRequest(staleSessionCaller, req(readonlyMethod), mainSender),
      (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.permissionDenied
    )
    assert.throws(
      () => authorizeIpcRequest(thirdPartyWindowCaller, req(readonlyMethod), windowSender),
      (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.permissionDenied
    )
  }

  // applications_uninstall 走 requirePluginPermission('system')：无 system 权限被拒绝，有 system 权限放行
  const noSystemPlugin: CallerIdentity = {
    type: 'main',
    webContentsId: 1,
    attributedPlugin: {
      pluginId: 'no-sys-plugin',
      sessionId: 'ds_abcdef1234567890',
      permissions: new Set(['clipboard']),
      source: 'installed'
    }
  }
  const manifests = {
    withPluginManifest: async <T,>(_id: string, action: (m: Record<string, unknown>) => Promise<T>) => action({ permissions: [] })
  }
  await assert.rejects(
    requirePluginPermission(noSystemPlugin, 'system', manifests),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.pluginPermissionRequired
  )
  const allowedPrincipal = await requirePluginPermission(thirdPartyDeclarativeCaller, 'system', manifests)
  assert.equal(allowedPrincipal.pluginId, 'third-party-declarative')
})

test('P0-2: script-commands 路径归属拒绝同前缀兄弟目录碰撞，mcp_install_server 严格校验参数', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-script-path-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))

  const scriptsDir = path.join(root, 'scripts')
  const siblingEvilDir = path.join(root, 'scripts-evil')
  await fs.mkdir(scriptsDir, { recursive: true })
  await fs.mkdir(siblingEvilDir, { recursive: true })

  const evilScript = path.join(siblingEvilDir, 'pwn.js')
  await fs.writeFile(
    evilScript,
    '// @raycast.schemaVersion 1\n// @raycast.title Evil Script\n// @raycast.mode fullOutput\nconsole.log("pwned")\n',
    'utf8'
  )

  const service = new ScriptCommandsService({ dataRoot: root, scriptsDir })
  // 注册一个解析指向同前缀兄弟目录 scripts-evil 的命令
  const result = await service.executeCommand(evilScript)
  assert.equal(result.success, false)
  assert.equal(result.cancelled, true, '同前缀目录 scripts-evil 中的未信任脚本不得被自动确认执行')

  // 正向验证：真实位于 scriptsDir 内的脚本在无 confirmHandler 时允许自动确认
  const safeScript = path.join(scriptsDir, 'safe.js')
  await fs.writeFile(
    safeScript,
    '// @raycast.schemaVersion 1\n// @raycast.title Safe Script\n// @raycast.mode fullOutput\nconsole.log("safe-ok")\n',
    'utf8'
  )
  const safeResult = await service.executeCommand(safeScript)
  assert.equal(safeResult.success, true)
  assert.ok(safeResult.stdout.includes('safe-ok'))
  await service.stop()

  // mcp_install_server 参数校验
  assert.doesNotThrow(() => validateMethodParams('mcp_install_server', {
    name: 'GitHub',
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'secret' }
  }))
  assert.doesNotThrow(() => validateMethodParams('mcp_install_server', {
    name: 'Memory SSE',
    transportType: 'sse',
    url: 'https://mcp.example.com/sse',
    headers: { Authorization: 'Bearer abc' },
    apiKey: 'k-123'
  }))
  assert.throws(
    () => validateMethodParams('mcp_install_server', { name: 'Bad', unknownField: 1 }),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
  assert.throws(
    () => validateMethodParams('mcp_install_server', { name: 'Bad', transportType: 'websocket' }),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
  assert.throws(
    () => validateMethodParams('mcp_install_server', { name: 'Bad', url: 'file:///etc/passwd' }),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
  assert.throws(
    () => validateMethodParams('mcp_install_server', { name: 'Bad', env: { BAD: 123 } }),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
})

// ===========================================================================
// P1-2 & P1-3: ztools://web/ CSP 安全响应头、无内联脚本与窗口三件套防护检查
// ===========================================================================
test('P1-2 & P1-3: ztools://web/ 注入严格 CSP 安全头，index.html 消除内联脚本，剩余窗口具备三件套防护', async () => {
  const baseResponse = new Response('<html></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  })
  const headers = withWebSecurityHeaders(baseResponse)
  const csp = headers.get('Content-Security-Policy') ?? ''
  assert.equal(csp, WEB_CONTENT_SECURITY_POLICY)
  assert.ok(csp.includes("script-src 'self' 'unsafe-eval'"))
  const scriptSrcDirective = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) ?? ''
  assert.equal(scriptSrcDirective.includes("'unsafe-inline'"), false, 'script-src 严禁包含 unsafe-inline')
  assert.ok(csp.includes("object-src 'none'"))
  assert.ok(csp.includes("frame-ancestors 'none'"))
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer')

  // 校验 frontend/index.html 不含内联 <script> 并引用 ./theme-init.js
  const repoRoot = path.resolve(process.cwd(), '..')
  const indexHtmlPath = path.join(repoRoot, 'frontend', 'index.html')
  const themeInitPath = path.join(repoRoot, 'frontend', 'public', 'theme-init.js')
  const indexHtml = await fs.readFile(indexHtmlPath, 'utf8')
  const themeInitJs = await fs.readFile(themeInitPath, 'utf8')
  assert.ok(indexHtml.includes('<script src="./theme-init.js"></script>'))
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(indexHtml), false, 'index.html 不得再包含内联 <script>')
  assert.ok(themeInitJs.includes('ztools_theme'))

  // 校验 P1-3 四个窗口文件全部具备 will-navigate / setWindowOpenHandler / will-attach-webview
  const hardenedWindowFiles = [
    path.join(process.cwd(), 'src', 'main', 'windows', 'launcher-controller.ts'),
    path.join(process.cwd(), 'src', 'main', 'services', 'window-service.ts'),
    path.join(process.cwd(), 'src', 'main', 'platform', 'macos', 'region-selection.ts'),
    path.join(process.cwd(), 'src', 'main', 'platform', 'electron-reference-pdf-renderer.ts')
  ]
  for (const filePath of hardenedWindowFiles) {
    const source = await fs.readFile(filePath, 'utf8')
    assert.ok(source.includes("on('will-navigate'"), `${path.basename(filePath)} 必须注册 will-navigate`)
    assert.ok(source.includes('setWindowOpenHandler'), `${path.basename(filePath)} 必须注册 setWindowOpenHandler`)
    assert.ok(source.includes("on('will-attach-webview'"), `${path.basename(filePath)} 必须注册 will-attach-webview`)
  }
})

// ===========================================================================
// P2-MCP: mcp-service.ts safeStorage 加密落盘、脱敏返回、旧明文迁移与 Fail-Fast
// ===========================================================================
test('P2-MCP: McpService 加密敏感字段原子落盘、脱敏返回、支持旧明文迁移与 Fail-Fast', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-mcp-secure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const configPath = path.join(root, 'mcp_servers.json')
  const protection = new InMemoryCredentialProtection()

  const service = new McpService({
    dataRoot: root,
    configFilePath: configPath,
    credentialProtection: protection
  })

  // 1. 安装含 env / headers / apiKey 的服务器：返回结果脱敏，磁盘全密文，非敏感字段可读
  const installed = await service.installServer({
    name: 'GitHub MCP',
    title: 'GitHub 代码检索',
    mentionName: 'github',
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_secret_123456', EMPTY_VAR: '' },
    headers: { Authorization: 'Bearer hdr_secret_789' },
    apiKey: 'api_secret_000'
  })

  assert.equal(installed.env?.GITHUB_TOKEN, MCP_REDACTED_VALUE)
  assert.equal(installed.env?.EMPTY_VAR, '')
  assert.equal(installed.headers?.Authorization, MCP_REDACTED_VALUE)
  assert.equal(installed.apiKey, MCP_REDACTED_VALUE)
  assert.equal(service.getServer('mcp.github')?.env?.GITHUB_TOKEN, MCP_REDACTED_VALUE)

  // 磁盘明文零泄露，密文均为 enc:v1: 前缀
  const rawDisk = await fs.readFile(configPath, 'utf8')
  assert.equal(rawDisk.includes('ghp_secret_123456'), false)
  assert.equal(rawDisk.includes('hdr_secret_789'), false)
  assert.equal(rawDisk.includes('api_secret_000'), false)
  const parsedDisk = JSON.parse(rawDisk) as Array<Record<string, unknown>>
  const diskEntry = parsedDisk[0] as {
    name: string
    env: Record<string, string>
    headers: Record<string, string>
    apiKey: string
  }
  assert.equal(diskEntry.name, 'GitHub MCP')
  assert.ok(diskEntry.env.GITHUB_TOKEN?.startsWith(MCP_ENCRYPTED_VALUE_PREFIX))
  assert.equal(diskEntry.env.EMPTY_VAR, '')
  assert.ok(diskEntry.headers.Authorization?.startsWith(MCP_ENCRYPTED_VALUE_PREFIX))
  assert.ok(diskEntry.apiKey.startsWith(MCP_ENCRYPTED_VALUE_PREFIX))

  // 同步 manageServers 搜索兼容
  assert.equal(service.manageServers('代码检索').length, 1)

  // 异步 getDecryptedServer 正确解密
  const decrypted = await service.getDecryptedServer('mcp.github')
  assert.equal(decrypted?.env?.GITHUB_TOKEN, 'ghp_secret_123456')
  assert.equal(decrypted?.headers?.Authorization, 'Bearer hdr_secret_789')
  assert.equal(decrypted?.apiKey, 'api_secret_000')

  // 2. 加密不可用时写入敏感字段必须 Fail-Fast，不污染内存与磁盘
  protection.statusValue = { status: 'unavailable', reason: 'encryption-unavailable' }
  await assert.rejects(
    service.installServer({
      name: 'Blocked Server',
      mentionName: 'blocked',
      transportType: 'stdio',
      command: 'node',
      env: { SECRET: 'must_not_persist' }
    }),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.notSupported
  )
  assert.equal(service.getServer('mcp.blocked'), undefined)
  assert.equal((await fs.readFile(configPath, 'utf8')).includes('must_not_persist'), false)

  // 加密不可用时读取已加密服务器也必须 Fail-Fast
  await assert.rejects(
    service.getDecryptedServer('mcp.github'),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.notSupported
  )
  await service.stop()

  // 3. 旧版明文 mcp_servers.json 自动迁移回写密文 + shouldReEncrypt 重加密
  protection.statusValue = { status: 'available' }
  await fs.writeFile(configPath, JSON.stringify([
    {
      id: 'mcp.legacy',
      name: 'Legacy MCP',
      title: 'Legacy MCP',
      mentionName: 'legacy',
      transportType: 'stdio',
      command: 'npx',
      args: [],
      env: { API_TOKEN: 'legacy_plain_token' },
      enabled: true,
      pinyin: 'legacymcp',
      createdAt: 1,
      updatedAt: 1
    }
  ], null, 2), 'utf8')

  const migratedService = new McpService({
    dataRoot: root,
    configFilePath: configPath,
    credentialProtection: protection
  })
  const migrateReport = await migratedService.ensureMigrated()
  assert.equal(migrateReport.migrated, true)
  const migratedDisk = await fs.readFile(configPath, 'utf8')
  assert.equal(migratedDisk.includes('legacy_plain_token'), false)
  assert.ok(migratedDisk.includes(MCP_ENCRYPTED_VALUE_PREFIX))
  const decryptedLegacy = await migratedService.getDecryptedServer('mcp.legacy')
  assert.equal(decryptedLegacy?.env?.API_TOKEN, 'legacy_plain_token')

  // 损坏密文 Fail-Closed 抛 DATA_CORRUPT
  await fs.writeFile(configPath, JSON.stringify([
    {
      id: 'mcp.corrupt',
      name: 'Corrupt MCP',
      title: 'Corrupt MCP',
      mentionName: 'corrupt',
      transportType: 'stdio',
      command: 'npx',
      args: [],
      env: { API_TOKEN: `${MCP_ENCRYPTED_VALUE_PREFIX}***invalid-base64***` },
      enabled: true,
      pinyin: 'corruptmcp',
      createdAt: 1,
      updatedAt: 1
    }
  ], null, 2), 'utf8')
  const corruptService = new McpService({
    dataRoot: root,
    configFilePath: configPath,
    credentialProtection: protection
  })
  await assert.rejects(
    corruptService.getDecryptedServer('mcp.corrupt'),
    (err: unknown) => err instanceof ZToolsError && err.code === errorCodes.dataCorrupt
  )
  await migratedService.stop()
  await corruptService.stop()
})
