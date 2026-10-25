import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BuiltinPluginHostService } from '../electron-client/out/main/services/builtin-plugin-host-service.js'
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

    const missingDir = path.join(tmpDir, 'deleted-repo')
    const scanned = await scanAllRecentProjects(
      [
        { name: 'my-git-app', path: repoDir, editorType: 'vscode', lastOpenedMs: Date.now() },
        { name: 'deleted-repo', path: missingDir, editorType: 'cursor', lastOpenedMs: Date.now() - 1000 }
      ],
      bridge
    )
    const foundValid = scanned.find((p) => p.path === repoDir)
    const foundMissing = scanned.find((p) => p.path === missingDir)
    assert.ok(foundValid)
    assert.equal(foundValid.isMissing, false)
    assert.equal(foundValid.gitBranch, 'feat/plugin-suite')
    assert.ok(foundMissing)
    assert.equal(foundMissing.isMissing, true)

    // 6. 异常：打开已删除目录拦截并返回 PROJECT_PATH_MISSING
    const launchRes = await launchProjectInEditor(foundMissing, bridge)
    assert.equal(launchRes.ok, false)
    assert.match(launchRes.error, /PROJECT_PATH_MISSING/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('27-hosts-switcher: Hosts 语法校验、非法规则过滤合并、原子写盘与只读权限拒绝拦截', async () => {
  const tmpDir = createTempDir('ztools-test-hosts-')
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

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

    // 3. 真实宿主原子写入自定义 hosts 文件
    const targetHostsFile = path.join(tmpDir, 'hosts')
    fs.writeFileSync(targetHostsFile, '127.0.0.1 localhost\n', 'utf8')

    const applyRes = await applyCombinedHosts(
      combined.combinedContent,
      { customHostsPath: targetHostsFile, skipFlushDns: true },
      bridge
    )
    assert.equal(applyRes.success, true)
    const written = fs.readFileSync(targetHostsFile, 'utf8')
    assert.match(written, /gateway\.ztools\.local/)

    // 4. 异常：权限拒绝模拟拦截与 DNS 超时拦截
    const deniedRes = await applyCombinedHosts(
      combined.combinedContent,
      { customHostsPath: targetHostsFile, simulateAccessDenied: true },
      bridge
    )
    assert.equal(deniedRes.success, false)
    assert.equal(deniedRes.errorCode, 'EACCES')

    const dnsTimeout = await flushDnsCache({ simulateTimeout: true }, bridge)
    assert.equal(dnsTimeout.success, false)
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

    // 2. 宿主加载环境变量并检测失效 PATH
    const customEnv = {
      JAVA_HOME: validBin,
      Path: `${validBin};${deadBin}`
    }
    const items = await loadAllEnvVariables(customEnv, bridge)
    assert.ok(items.length >= 2)
    const deadItem = items.find((i) => i.isPathItem && i.value === deadBin)
    const validItem = items.find((i) => i.isPathItem && i.value === validBin)
    assert.ok(deadItem)
    assert.equal(deadItem.isInvalid, true)
    assert.ok(validItem)
    assert.equal(validItem.isInvalid, false)

    // 3. 一键清理失效 PATH 条目
    const cleaned = await cleanInvalidPathEntries(
      { rawPath: `${validBin};${deadBin}`, customEnv },
      bridge
    )
    assert.equal(cleaned.removedCount, 1)
    assert.equal(cleaned.cleanedPath, validBin)

    // 4. 异常：修改系统级变量无管理员权限时拦截
    const noAdminRes = await writeEnvVariable(
      'SYSTEM_TEST_VAR',
      '123',
      'system',
      { simulateNoAdmin: true },
      bridge
    )
    assert.equal(noAdminRes.ok, false)
    assert.equal(noAdminRes.errorCode, 'ADMIN_REQUIRED')

    const snapshotJson = exportEnvSnapshot(items)
    assert.match(snapshotJson, /JAVA_HOME/)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('29-docker-manager: 容器列表归一化、ANSI 日志清洗、启停控制与引擎未启动拦截', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

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

  const list = await listContainers({ rawContainers }, bridge)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, 'ztools-postgres')
  assert.equal(list[0].primaryPort, '5432->5432')
  assert.equal(list[1].isRunning, false)

  const ctrl = await controlContainer('a1b2c3d4e5f6', 'restart', { dryRun: true }, bridge)
  assert.equal(ctrl.ok, true)

  const logs = await getContainerTailLogs(
    'a1b2c3d4e5f6',
    50,
    '\u001b[36m2026-10-25 Ready to accept connections\u001b[0m',
    bridge
  )
  assert.equal(logs, '2026-10-25 Ready to accept connections')

  // 3. 异常：Docker 守护进程未启动 & 非法容器 ID 注入拦截
  await assert.rejects(
    () => listContainers({ simulateDaemonOffline: true }, bridge),
    /DAEMON_OFFLINE/
  )

  const badCtrl = await controlContainer('bad;rm -rf', 'stop', { dryRun: true }, bridge)
  assert.equal(badCtrl.ok, false)
})

test('30-lan-scanner: 102 字节 WOL 魔术包构造、OUI 厂商识别、ARP 解析与断网/畸形 MAC 拦截', async () => {
  const hostService = new BuiltinPluginHostService()
  const bridge = createHostBridge(hostService)

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

  // 4. 异常：畸形 MAC 地址与未连接局域网拦截
  assert.throws(() => normalizeMacAddress('00:11:22:GG:HH:II'), /INVALID_MAC_ADDRESS/)
  await assert.rejects(
    () => sendWakeOnLan('invalid-mac', '255.255.255.255', { dryRun: true }, bridge),
    /INVALID_MAC_ADDRESS/
  )
  await assert.rejects(
    () => scanSubnet(undefined, { simulateOffline: true }, bridge),
    /NETWORK_OFFLINE/
  )
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
  HostName 47.96.120.15
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

    // 1. 解析 ~/.ssh/config 并过滤 Host *
    const hosts = await parseSshConfigFile(cfgFile, bridge)
    assert.equal(hosts.length, 2)
    assert.equal(hosts[0].host, 'prod-api-01')
    assert.equal(hosts[0].port, 22022)
    assert.equal(hosts[0].identityFileShort, 'id_ed25519')
    assert.equal(hosts[0].proxyJump, 'bastion-host')
    assert.equal(hosts[1].host, 'internal-gpu')
    assert.deepEqual(hosts[1].localForwards, ['8888 127.0.0.1:8888'])

    // 2. 配置文件不存在时优雅返回空数组
    const emptyHosts = await parseSshConfigFile(path.join(tmpDir, 'non-existent-config'), bridge)
    assert.deepEqual(emptyHosts, [])

    // 3. 代理状态读取与开启/关闭（端口存活）
    const statusAfterOn = await setDevToolsProxy(
      7890,
      { requireListening: true, mockListeningPorts: [7890], applySystemGit: false },
      bridge
    )
    assert.equal(statusAfterOn.isEnabled, true)
    assert.equal(statusAfterOn.port, 7890)

    const statusAfterOff = await unsetDevToolsProxy({ applySystemGit: false }, bridge)
    assert.equal(statusAfterOff.isEnabled, false)

    // 4. 异常：代理端口未处于监听状态时阻断写入
    await assert.rejects(
      () =>
        setDevToolsProxy(
          10809,
          { requireListening: true, mockListeningPorts: [], applySystemGit: false },
          bridge
        ),
      /未处于监听状态/
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
