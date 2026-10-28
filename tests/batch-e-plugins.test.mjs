import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BuiltinPluginHostService } from '../electron-client/out/main/services/builtin-plugin-host-service.js'
import { NetworkHostPluginHandler } from '../electron-client/out/main/services/host-plugins/network-host.js'
import {
  normalizeFileUriToPath,
  parseVscRecentlyOpenedJson,
  parseJetBrainsRecentProjectsXml,
  parseGitHeadContent,
  mergeAndSortProjects,
  scanAllRecentProjects,
  launchProjectInEditor
} from '../packages/declarative-ui/dist/examples/vscode-projects/project-service.js'
import {
  isValidIpAddress,
  isValidDomainName,
  parseHostsContent,
  buildCombinedHostsContent,
  applyCombinedHosts,
  flushDnsCache
} from '../packages/declarative-ui/dist/examples/hosts-switcher/hosts-service.js'
import {
  expandEnvVariablesInString,
  loadAllEnvVariables,
  cleanInvalidPathEntries,
  writeEnvVariable,
  exportEnvSnapshot
} from '../packages/declarative-ui/dist/examples/env-manager/env-service.js'
import {
  cleanContainerLogText,
  parseDockerPortMappings,
  normalizeDockerContainerRecord,
  listContainers,
  controlContainer,
  getContainerTailLogs
} from '../packages/declarative-ui/dist/examples/docker-manager/docker-service.js'
import {
  normalizeMacAddress,
  lookupOuiVendor,
  buildWolMagicPacketBytes,
  parseArpTableOutput,
  detectActiveInterfaces,
  scanSubnet,
  sendWakeOnLan
} from '../packages/declarative-ui/dist/examples/lan-scanner/lan-service.js'
import {
  parseSshConfigText,
  parseSshConfigFile,
  getProxyStatus,
  setDevToolsProxy,
  unsetDevToolsProxy
} from '../packages/declarative-ui/dist/examples/ssh-proxy-helper/ssh-proxy-service.js'

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * 直接调用旧内置处理器的桥：宿主已不接受 mock、simulate、raw 前缀的模拟参数，Windows 命令输出改由构造参数注入的
 * 命令执行器提供（测试替身只在测试里，插件参数无法切换）。
 */
function createHandlerBridge(call) {
  return {
    __isRealHost: true,
    dllplugin_call: async (payload) => call(payload.func, payload.params || {}),
    dllplugin: { call: async (_plugin, func, params) => call(func, params || {}) }
  }
}

/** 按命令名返回预设结果（数组依次取用）并记录调用 */
function fakeRunCommand(commands, calls = []) {
  return async (command, args) => {
    calls.push([command, ...args].join(' '))
    const preset = commands[command]
    if (!preset) return { stdout: '', stderr: `未预设命令: ${command}`, exitCode: 1 }
    return Array.isArray(preset) ? (preset.shift() ?? { stdout: '', stderr: '预设结果已用完', exitCode: 1 }) : preset
  }
}

/** 旧处理器只在 Windows 走真实分支：临时把 process.platform 视作 win32 */
async function asWindows(work) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
  try { return await work() } finally { Object.defineProperty(process, 'platform', original) }
}

function createHostBridge(hostService) {
  return {
    __isRealHost: true,
    dllplugin_call: async (payload) =>
      hostService.handlePluginCall(payload.plugin, payload.func, payload.params || {}),
    dllplugin: {
      call: async (plugin, func, params) => hostService.handlePluginCall(plugin, func, params)
    }
  }
}

test('26-vscode-projects: URI 解码、VSCode/JetBrains 解析、Git HEAD 分支探测与异常容错', async () => {
  const tmpDir = createTempDir('ztools-test-vscode-')
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

  try {
    // 1. URI 解码（含中文与空格）
    const decoded = normalizeFileUriToPath('file:///D%3A/work/%E4%B8%AD%E6%96%87%20Project')
    assert.equal(decoded, 'D:\\work\\中文 Project')

    // 2. VS Code JSON 解析与去重合并
    const vscodeJson = JSON.stringify({
      entries: [
        { folderUri: 'file:///e%3A/code/ztools-core' },
        { folderUri: 'file:///E%3A/code/ztools-core' },
        { fileUri: 'file:///e%3A/code/demo.code-workspace', label: 'Demo WS' }
      ]
    })
    const vscodeList = parseVscRecentlyOpenedJson(vscodeJson, 'vscode')
    const merged = mergeAndSortProjects([vscodeList])
    assert.equal(merged.length, 2)
    assert.equal(merged[0].name, 'ztools-core')

    // 3. 损坏 JSON / SQLite 防御（返回空数组不崩溃）
    const corrupted = parseVscRecentlyOpenedJson('{broken_json_sqlite_header', 'cursor')
    assert.deepEqual(corrupted, [])

    // 4. JetBrains recentProjects.xml 解析
    const jbXml = `
      <application>
        <component name="RecentProjectsManager">
          <option name="additionalInfo">
            <map>
              <entry key="$USER_HOME$/IdeaProjects/payment-gateway">
                <value>
                  <RecentProjectMetaInfo>
                    <option name="projectOpenTimestamp" value="1730000000000" />
                  </RecentProjectMetaInfo>
                </value>
              </entry>
            </map>
          </option>
        </component>
      </application>
    `
    const jbList = parseJetBrainsRecentProjectsXml(jbXml, 'idea', 'C:\\Users\\Alice')
    assert.equal(jbList.length, 1)
    assert.equal(jbList[0].path, 'C:\\Users\\Alice\\IdeaProjects\\payment-gateway')

    // 5. Git HEAD 解析 + 宿主真实目录扫描
    const repoDir = path.join(tmpDir, 'my-git-app')
    fs.mkdirSync(path.join(repoDir, '.git', 'refs', 'heads'), { recursive: true })
    fs.writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/feat/plugin-suite\n')

    const branchName = parseGitHeadContent(fs.readFileSync(path.join(repoDir, '.git', 'HEAD'), 'utf8'))
    assert.equal(branchName, 'feat/plugin-suite')

    // 宿主旧接口已停用：调用方传入的项目列表不再被原样当作扫描结果返回（插件改走 recent_projects 新接口）
    const missingDir = path.join(tmpDir, 'deleted-repo')
    const legacyScan = await hostService.handlePluginCall('vscode-projects', 'scanAllRecentProjects', {
      rawEntries: [{ name: 'my-git-app', path: repoDir, editorType: 'vscode', lastOpenedMs: Date.now() }]
    })
    assert.equal(legacyScan.ok, false)
    assert.equal(legacyScan.errorCode, 'UNSUPPORTED_ACTION')
    assert.match(legacyScan.error, /请更新最近项目插件/)
    assert.equal(legacyScan.projects, undefined)
    assert.deepEqual(await scanAllRecentProjects([{ name: 'fake', path: repoDir, editorType: 'vscode', lastOpenedMs: 1 }], bridge), [])

    // 6. 异常：打开已删除目录在插件侧拦截并返回 PROJECT_PATH_MISSING，不进入宿主
    const launchRes = await launchProjectInEditor({ name: 'deleted-repo', path: missingDir, isMissing: true }, bridge)
    assert.equal(launchRes.ok, false)
    assert.match(launchRes.error, /PROJECT_PATH_MISSING/)
    const legacyLaunch = await hostService.handlePluginCall('vscode-projects', 'launchProject', { path: repoDir })
    assert.equal(legacyLaunch.ok, false)
    assert.match(legacyLaunch.error, /请更新最近项目插件/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('27-hosts-switcher: Hosts 语法校验、非法规则过滤合并；旧宿主拒绝写入系统 hosts、读取与刷新 DNS 如实返回', async () => {
  const tmpDir = createTempDir('ztools-test-hosts-')

  try {
    // 1. 语法解析与校验
    assert.equal(isValidIpAddress('127.0.0.1'), true)
    assert.equal(isValidIpAddress('::1'), true)
    assert.equal(isValidIpAddress('999.888.777.666'), false)
    assert.equal(isValidDomainName('api.ztools.local'), true)
    assert.equal(isValidDomainName('evil.local;rm'), false)

    const rawContent = '# 开发环境\n127.0.0.1 dev.ztools.local api.ztools.local\n999.999.1.1 invalid.domain'
    const rules = parseHostsContent(rawContent)
    assert.equal(rules.length, 3)
    assert.equal(rules.filter((r) => r.isValid).length, 2)
    assert.equal(rules.filter((r) => !r.isValid).length, 1)

    // 2. 多方案合并（自动跳过非法行）
    const combined = buildCombinedHostsContent([
      {
        id: 'p1',
        name: '本地微服务',
        isEnabled: true,
        isSystem: false,
        rawContent: '127.0.0.1 gateway.ztools.local\n999.999.999.999 bad.host',
        rulesCount: 2,
        invalidCount: 1,
        updatedAt: Date.now(),
        updatedAtFormatted: '2026-10-25'
      }
    ])
    assert.equal(combined.activeRulesCount, 1)
    assert.equal(combined.skippedInvalidCount, 1)
    assert.match(combined.combinedContent, /gateway\.ztools\.local/)

    // 3. 旧宿主（Windows 分支）不再写入 hosts：已安装的旧版插件带完整内容整体覆盖时一律拒绝，系统 hosts 保持原样；
    //    调用方传的 customHostsPath 被忽略，测试经构造参数把系统 hosts 换成临时文件
    const targetHostsFile = path.join(tmpDir, 'hosts')
    fs.writeFileSync(targetHostsFile, '127.0.0.1 localhost\n', 'utf8')
    const calls = []
    const ipconfig = [{ stdout: '', stderr: '命令执行超时（3000 ms）', exitCode: 124 }]
    const handler = new NetworkHostPluginHandler({}, { hostsPath: targetHostsFile, runCommand: fakeRunCommand({ ipconfig }, calls) })
    const bridge = createHandlerBridge((func, params) => handler.handleHostsSwitcher(func, params))

    await asWindows(async () => {
      for (const options of [{ customHostsPath: path.join(tmpDir, 'other-hosts'), skipFlushDns: true }, {}]) {
        // 插件端解包时丢掉了宿主的 errorCode（缺省填 EACCES），这里只断言失败与原因文字；错误码直接查宿主结果
        const applyRes = await applyCombinedHosts(combined.combinedContent, options, bridge)
        assert.equal(applyRes.success, false)
        assert.match(applyRes.error, /Windows 版域名映射正在重做，暂不支持写入系统 hosts/)
        const hostRes = await bridge.dllplugin_call({ plugin: 'HostsSwitcherPlugin', func: 'applyCombinedHosts', params: { content: combined.combinedContent, ...options } })
        assert.equal(hostRes.success, false)
        assert.equal(hostRes.errorCode, 'UNSUPPORTED_ACTION')
      }
      assert.equal(fs.readFileSync(targetHostsFile, 'utf8'), '127.0.0.1 localhost\n', '系统 hosts 不能被改动')
      assert.deepEqual(fs.readdirSync(tmpDir), ['hosts'], '不能写到调用方指定的路径，也不产生备份')
      assert.deepEqual(calls, [], '拒绝写入时不刷新 DNS')

      // 4. 读取保留；ipconfig 超时如实失败
      const readRes = await bridge.dllplugin_call({ plugin: 'HostsSwitcherPlugin', func: 'readSystemHosts', params: {} })
      assert.equal(readRes.success, true)
      assert.equal(readRes.content, '127.0.0.1 localhost\n')

      const dnsTimeout = await flushDnsCache(undefined, bridge)
      assert.equal(dnsTimeout.success, false)
      assert.match(dnsTimeout.error, /TIMEOUT/)
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('28-env-manager: PATH 拆分与失效目录标红、一键清理失效项及无管理员权限拦截', async () => {
  const tmpDir = createTempDir('ztools-test-env-')
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

  try {
    const validBin = path.join(tmpDir, 'valid-bin')
    const deadBin = path.join(tmpDir, 'uninstalled-node-v12')
    fs.mkdirSync(validBin, { recursive: true })

    // 1. %VAR% 展开验证
    const expanded = expandEnvVariablesInString('%JAVA_HOME%\\bin', { JAVA_HOME: 'C:\\Program Files\\Java\\jdk-21' })
    assert.equal(expanded, 'C:\\Program Files\\Java\\jdk-21\\bin')

    // 2. 宿主旧接口已停用：不再采用调用方给的 customEnv / rawPath，也不再只改内存却报告清理成功（插件改走 environment_manager 新接口）
    const customEnv = {
      JAVA_HOME: validBin,
      Path: `${validBin};${deadBin}`
    }
    const legacyLoad = await hostService.handlePluginCall('env-manager', 'loadAllEnvVariables', { customEnv })
    assert.equal(legacyLoad.ok, false)
    assert.match(legacyLoad.error, /请更新环境变量插件/)
    assert.deepEqual(await loadAllEnvVariables(customEnv, bridge), [])

    // 3. 一键清理失效 PATH：旧接口拒绝，不返回伪造的 removedCount
    const legacyClean = await hostService.handlePluginCall('env-manager', 'cleanInvalidPathEntries', { rawPath: `${validBin};${deadBin}`, customEnv })
    assert.equal(legacyClean.ok, false)
    assert.match(legacyClean.error, /请更新环境变量插件/)
    const cleaned = await cleanInvalidPathEntries({ rawPath: `${validBin};${deadBin}`, customEnv }, bridge)
    assert.equal(cleaned.removedCount, 0)

    // 4. 异常：旧接口写系统级变量从不落盘，一律拒绝并要求新版接口（不再依赖 simulateNoAdmin 模拟）
    const noAdminRes = await writeEnvVariable('SYSTEM_TEST_VAR', '123', 'system', undefined, bridge)
    assert.equal(noAdminRes.ok, false)
    assert.match(noAdminRes.error, /请更新环境变量插件/)

    const items = [{ key: 'JAVA_HOME', value: validBin, scope: 'user', isPathItem: false, isInvalid: false }]
    const snapshotJson = exportEnvSnapshot(items)
    assert.match(snapshotJson, /JAVA_HOME/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('29-docker-manager: 容器列表归一化、ANSI 日志清洗、启停控制与引擎未启动拦截', async () => {

  // 1. ANSI 控制符剥离与端口解析
  const cleanLog = cleanContainerLogText('\u001b[32mINFO\u001b[0m Server listening on 0.0.0.0:6379')
  assert.equal(cleanLog, 'INFO Server listening on 0.0.0.0:6379')

  const parsedPorts = parseDockerPortMappings('0.0.0.0:8080->80/tcp, :::8080->80/tcp')
  assert.equal(parsedPorts.primaryPort, '8080->80')
  assert.equal(parsedPorts.webUrl, 'http://localhost:8080')

  // 2. 容器列表与状态控制
  const rawContainers = [
    {
      Id: 'a1b2c3d4e5f60001',
      Names: ['/ztools-postgres'],
      Image: 'postgres:16-alpine',
      State: 'running',
      Status: 'Up 3 hours',
      Ports: [{ PublicPort: 5432, PrivatePort: 5432, Type: 'tcp' }]
    },
    {
      Id: 'f6e5d4c3b2a10002',
      Names: ['/ztools-redis-cache'],
      Image: 'redis:7-alpine',
      State: 'exited',
      Status: 'Exited (137) 10 minutes ago',
      Ports: []
    }
  ]

  // docker 命令输出由注入的命令执行器提供（宿主不再原样返回调用方传入的 rawContainers / rawLogs）
  const dockerCalls = []
  const docker = [
    { stdout: rawContainers.map((c) => JSON.stringify(c)).join('\n'), stderr: '', exitCode: 0 },
    { stdout: '\u001b[36m2026-10-25 Ready to accept connections\u001b[0m', stderr: '', exitCode: 0 },
    { stdout: '', stderr: 'Cannot connect to the Docker daemon', exitCode: 1 }
  ]
  const handler = new NetworkHostPluginHandler({}, { runCommand: fakeRunCommand({ docker }, dockerCalls) })
  const bridge = createHandlerBridge((func, params) => handler.handleDockerManager(func, params))

  const list = await listContainers({ rawContainers: [{ Id: 'forged' }] }, bridge)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, 'ztools-postgres')
  assert.equal(list[0].primaryPort, '5432->5432')
  assert.equal(list[1].isRunning, false)

  const ctrl = await controlContainer('a1b2c3d4e5f6', 'restart', { dryRun: true }, bridge)
  assert.equal(ctrl.ok, true)

  const logs = await getContainerTailLogs('a1b2c3d4e5f6', 50, 'forged', bridge)
  assert.equal(logs, '2026-10-25 Ready to accept connections')

  // 3. 异常：Docker 守护进程未启动（docker 命令非零退出）& 非法容器 ID 注入拦截
  await assert.rejects(() => listContainers(undefined, bridge), /DAEMON_OFFLINE/)
  assert.deepEqual(dockerCalls, ['docker ps -a --format {{json .}}', 'docker logs --tail 50 a1b2c3d4e5f6', 'docker ps -a --format {{json .}}'])

  const badCtrl = await controlContainer('bad;rm -rf', 'stop', { dryRun: true }, bridge)
  assert.equal(badCtrl.ok, false)
})

test('30-lan-scanner: 102 字节 WOL 魔术包构造、OUI 厂商识别、ARP 解析与断网/畸形 MAC 拦截', async () => {
  const handler = new NetworkHostPluginHandler({}, { runCommand: fakeRunCommand({}) })
  const bridge = createHandlerBridge((func, params) => asWindows(() => handler.handleLanScanner(func, params)))

  // 1. MAC 规范化与 102 字节 WOL 魔术包验证（6 个 0xFF + 16 组重复 MAC）
  const normMac = normalizeMacAddress('00-11-32-ab-cd-ef')
  assert.equal(normMac, '00:11:32:AB:CD:EF')
  assert.equal(lookupOuiVendor(normMac), '群晖 (Synology)')

  const packet = buildWolMagicPacketBytes(normMac)
  assert.equal(packet.byteLength, 102)
  for (let i = 0; i < 6; i++) {
    assert.equal(packet[i], 0xff)
  }
  assert.equal(packet[6], 0x00)
  assert.equal(packet[7], 0x11)
  assert.equal(packet[8], 0x32)
  assert.equal(packet[101], 0xef)

  // 2. ARP 表解析（自动过滤广播与多播地址）
  const sampleArp = `
接口: 192.168.1.100 --- 0xb
  Internet 地址         物理地址              类型
  192.168.1.1           00-e0-fc-11-22-33     动态
  192.168.1.50          00-11-32-aa-bb-cc     动态
  192.168.1.255         ff-ff-ff-ff-ff-ff     静态
  224.0.0.22            01-00-5e-00-00-16     静态
  `
  const devices = parseArpTableOutput(sampleArp)
  assert.equal(devices.length, 2)
  assert.equal(devices[0].vendor, '华为 (Huawei)')
  assert.equal(devices[1].vendor, '群晖 (Synology)')

  // 3. 真实宿主 WOL 发送（dryRun）
  const wolRes = await sendWakeOnLan('00:11:32:AA:BB:CC', '255.255.255.255', { dryRun: true }, bridge)
  assert.equal(wolRes.success, true)
  assert.equal(wolRes.byteLength, 102)

  // 4. 异常：畸形 MAC 地址拦截；旧扫描入口已停用（真实扫描走 lan_network 新接口），模拟断网参数不再生效
  assert.throws(() => normalizeMacAddress('00:11:22:GG:HH:II'), /INVALID_MAC_ADDRESS/)
  await assert.rejects(
    () => sendWakeOnLan('invalid-mac', '255.255.255.255', { dryRun: true }, bridge),
    /INVALID_MAC_ADDRESS/
  )
  await assert.rejects(() => scanSubnet(undefined, { simulateOffline: true }, bridge), /请更新局域网扫描插件/)
})

test('31-ssh-proxy-helper: ~/.ssh/config 解析、通配符过滤、代理端口存活探测与未监听拦截', async () => {
  const tmpDir = createTempDir('ztools-test-ssh-')
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

  try {
    const sshConfigContent = `
# 全局默认配置
Host *
  ServerAliveInterval 60

Host prod-api-01
  HostName 203.0.113.15
  User ubuntu
  Port 22022
  IdentityFile ~/.ssh/id_ed25519
  ProxyJump bastion-host

Host internal-gpu
  HostName 10.16.0.88
  User root
  LocalForward 8888 127.0.0.1:8888
    `
    const cfgFile = path.join(tmpDir, 'config')
    fs.writeFileSync(cfgFile, sshConfigContent, 'utf8')

    // 1. 解析 ~/.ssh/config 并过滤 Host *（纯解析，不经宿主）
    const hosts = parseSshConfigText(sshConfigContent)
    assert.equal(hosts.length, 2)
    assert.equal(hosts[0].host, 'prod-api-01')
    assert.equal(hosts[0].port, 22022)
    assert.equal(hosts[0].identityFileShort, 'id_ed25519')
    assert.equal(hosts[0].proxyJump, 'bastion-host')
    assert.equal(hosts[1].host, 'internal-gpu')
    assert.deepEqual(hosts[1].localForwards, ['8888 127.0.0.1:8888'])

    // 2. 旧宿主入口已停用（可读任意路径、假装代理已启用）：读取文件一律得到空列表，不读调用方给的路径
    assert.deepEqual(await parseSshConfigFile(cfgFile, bridge), [])
    assert.deepEqual(await parseSshConfigFile(path.join(tmpDir, 'non-existent-config'), bridge), [])

    // 3. 代理开关：原“端口存活 / 未监听拦截”用例只验证宿主按 mockListeningPorts 返回的模拟结果，已删除；
    //    现在即使传入模拟端口，旧入口也拒绝并要求更新插件，不会假装代理已开启
    await assert.rejects(
      () => setDevToolsProxy(7890, { requireListening: true, mockListeningPorts: [7890], applySystemGit: false }, bridge),
      /请更新主机与代理插件/
    )
    const status = await getProxyStatus({ mockListeningPorts: [7890] }, bridge)
    assert.equal(status.isEnabled, false)
    assert.deepEqual(status.detectedPorts, [])
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
