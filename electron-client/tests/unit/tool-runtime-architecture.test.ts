import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  TOOL_RUNTIME_ADMIN_IPC_METHODS,
  TOOL_RUNTIME_CORE_IPC_METHODS,
  TOOL_RUNTIME_DOMAIN_IDS,
  TOOL_RUNTIME_DOMAIN_IPC_METHODS,
  TOOL_RUNTIME_IPC_METHODS,
  TOOL_RUNTIME_PRIMITIVES
} from '../../src/contracts/tool-runtime/registry.js'
import {
  BUILTIN_COMMONLIBS_PUBLIC_KEYS,
  COMMONLIBS_PUBLIC_KEYS_FILE,
  loadCommonLibsTrustBundle
} from '../../src/main/tool-runtime/core/commonlibs-trust.js'
import { ToolRuntimeRegistry } from '../../src/main/tool-runtime/registry.js'
import type { ToolDomainRegistration } from '../../src/main/tool-runtime/core/domain-types.js'

/**
 * 宿主薄原语防重架构、目录强聚合、去工具名化与信任根一致性静态结构自检测试
 */

// 兼容编译后位于 out-test/tests/unit/ 与源码位于 tests/unit/ 两种路径解析
const clientRoot = path.basename(path.resolve(__dirname, '..', '..')) === 'out-test'
  ? path.resolve(__dirname, '..', '..', '..')
  : path.resolve(__dirname, '..', '..')

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full)
    }
  }
  return results
}

test('架构自检：contracts/tool-runtime/domains 与 main/tool-runtime/domains 严格一一对应且去工具名化', () => {
  const contractDomainsDir = path.join(clientRoot, 'src', 'contracts', 'tool-runtime', 'domains')
  const mainDomainsDir = path.join(clientRoot, 'src', 'main', 'tool-runtime', 'domains')

  const contractDomainFiles = fs
    .readdirSync(contractDomainsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort()

  const mainDomainDirs = fs
    .readdirSync(mainDomainsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  const registeredDomains = [...TOOL_RUNTIME_DOMAIN_IDS].sort()

  assert.deepEqual(contractDomainFiles, registeredDomains, '契约层域文件必须与单一事实总表完全一致')
  assert.deepEqual(mainDomainDirs, registeredDomains, '宿主执行层域目录必须与单一事实总表完全一致')

  for (const domain of registeredDomains) {
    const domainDir = path.join(mainDomainsDir, domain)
    for (const requiredFile of ['index.ts', 'driver.ts', 'policy.ts', 'ipc.ts']) {
      assert.equal(
        fs.existsSync(path.join(domainDir, requiredFile)),
        true,
        `域 ${domain} 必须包含标准文件 ${requiredFile}`
      )
    }
    assert.equal(
      fs.existsSync(path.join(domainDir, 'drivers')),
      true,
      `域 ${domain} 必须包含平台异构隔离目录 drivers/`
    )
  }

  // 契约层基础原语 ID 与 IPC 方法严禁泄漏具体第三方工具名
  const forbiddenEngineNames = ['ffmpeg', 'ffprobe', 'yt-dlp', 'ytdlp', 'aria2', 'mediainfo']
  const contractRoot = path.join(clientRoot, 'src', 'contracts', 'tool-runtime')
  for (const file of collectTsFiles(contractRoot)) {
    const content = fs.readFileSync(file, 'utf8').toLowerCase()
    for (const engineName of forbiddenEngineNames) {
      assert.equal(
        content.includes(engineName),
        false,
        `平台无关契约 ${path.relative(clientRoot, file)} 严禁出现具体引擎名 "${engineName}"`
      )
    }
  }
})

test('架构自检：所有 tool_* IPC 方法名无重复且严格遵守所属域前缀', () => {
  const uniqueIpc = new Set(TOOL_RUNTIME_IPC_METHODS)
  assert.equal(uniqueIpc.size, TOOL_RUNTIME_IPC_METHODS.length, 'TOOL_RUNTIME_IPC_METHODS 不允许存在重复项')

  const seenPrimitives = new Set<string>()
  const coveredDomainMethods = new Set<string>()

  for (const entry of TOOL_RUNTIME_PRIMITIVES) {
    assert.equal(seenPrimitives.has(entry.primitiveId), false, `重复原语 ID: ${entry.primitiveId}`)
    seenPrimitives.add(entry.primitiveId)
    assert.ok(entry.primitiveId.startsWith(`${entry.domain}.`), `原语 ID ${entry.primitiveId} 必须以域前缀开头`)
    for (const method of entry.ipcMethods) {
      assert.ok(
        method.startsWith(`tool_${entry.domain}_`),
        `域 ${entry.domain} 的 IPC 方法 ${method} 必须使用 tool_${entry.domain}_ 前缀`
      )
      assert.equal(coveredDomainMethods.has(method), false, `域 IPC 方法重复登记: ${method}`)
      coveredDomainMethods.add(method)
    }
  }

  assert.deepEqual(
    Array.from(coveredDomainMethods).sort(),
    [...TOOL_RUNTIME_DOMAIN_IPC_METHODS].sort(),
    '所有域 IPC 方法必须精确对应单一事实总表'
  )

  for (const coreMethod of TOOL_RUNTIME_CORE_IPC_METHODS) {
    assert.ok(coreMethod.startsWith('tool_'), `核心方法 ${coreMethod} 必须以 tool_ 开头`)
  }
  for (const adminMethod of TOOL_RUNTIME_ADMIN_IPC_METHODS) {
    assert.ok(adminMethod.startsWith('tool_commonlibs_'), `管理方法 ${adminMethod} 必须以 tool_commonlibs_ 开头`)
  }
})

test('架构自检：严禁在 main/tool-runtime/domains/ 下直接引用 node:child_process 旁路共享底座', () => {
  const mainDomainsDir = path.join(clientRoot, 'src', 'main', 'tool-runtime', 'domains')
  const childProcessImportPattern = /(?:from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\))/
  for (const file of collectTsFiles(mainDomainsDir)) {
    const content = fs.readFileSync(file, 'utf8')
    assert.equal(
      childProcessImportPattern.test(content),
      false,
      `${path.relative(clientRoot, file)} 严禁直接导入 child_process，必须统一通过 core/guarded-process.ts`
    )
  }
})

test('架构自检：ToolRuntimeRegistry 启动期对重复域、重复 IPC 与跨域前缀越权 Fail-Fast', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-tr-arch-'))
  try {
    const dummyHandler = async () => ({ ok: true })
    const badPrefixDomain: ToolDomainRegistration = {
      domain: 'media',
      primitiveIds: ['media.probe'],
      getCapabilityStatus: async () => 'ready',
      ensureCapability: async () => ({ status: 'ready', provisioned: false }),
      getStaticToolIds: () => [],
      handlers: {
        // 故意用 download 前缀注册到 media 域，必须 Fail-Fast 拦截
        tool_download_stream_probe: dummyHandler
      }
    }

    assert.throws(
      () => new ToolRuntimeRegistry({ dataRoot: tempRoot, domains: [badPrefixDomain] }),
      /prefix|domain|invalid|mismatch|reserved|unsupported/i,
      '非所属域前缀的 IPC 注册必须启动期 Fail-Fast'
    )

    const duplicateDomainA: ToolDomainRegistration = {
      domain: 'media',
      primitiveIds: ['media.probe'],
      getCapabilityStatus: async () => 'ready',
      ensureCapability: async () => ({ status: 'ready', provisioned: false }),
      getStaticToolIds: () => [],
      handlers: { tool_media_probe: dummyHandler }
    }
    const duplicateDomainB: ToolDomainRegistration = {
      domain: 'media',
      primitiveIds: ['media.transcode'],
      getCapabilityStatus: async () => 'ready',
      ensureCapability: async () => ({ status: 'ready', provisioned: false }),
      getStaticToolIds: () => [],
      handlers: { tool_media_transcode_run: dummyHandler }
    }

    assert.throws(
      () => new ToolRuntimeRegistry({ dataRoot: tempRoot, domains: [duplicateDomainA, duplicateDomainB] }),
      /duplicate/i,
      '重复注册同一能力域必须启动期 Fail-Fast'
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('信任根一致性：BUILTIN_COMMONLIBS_PUBLIC_KEYS 与公开资源文件完全一致且严守 commonlibs 用途隔离', () => {
  const resourcesDir = path.join(clientRoot, 'resources', 'commonlibs')
  const pubJsonPath = path.join(resourcesDir, COMMONLIBS_PUBLIC_KEYS_FILE)
  assert.equal(fs.existsSync(pubJsonPath), true, '公开仓库必须存在 resources/commonlibs/commonlibs-public-keys.json')

  const fileEntries = JSON.parse(fs.readFileSync(pubJsonPath, 'utf8')) as Array<{
    keyId: string
    publicKeyHex: string
    usages: string[]
  }>

  assert.equal(fileEntries.length, BUILTIN_COMMONLIBS_PUBLIC_KEYS.length)
  for (let i = 0; i < BUILTIN_COMMONLIBS_PUBLIC_KEYS.length; i += 1) {
    const builtin = BUILTIN_COMMONLIBS_PUBLIC_KEYS[i]!
    const fromFile = fileEntries[i]!
    assert.equal(builtin.keyId, fromFile.keyId)
    assert.equal(builtin.publicKeyHex, fromFile.publicKeyHex)
    assert.deepEqual([...builtin.usages], fromFile.usages)
    assert.deepEqual([...builtin.usages], ['commonlibs'], 'CommonLibs 公开公钥仅允许声明 commonlibs 用途')
  }

  const bundle = loadCommonLibsTrustBundle(resourcesDir)
  assert.ok(bundle.publicKeys.some((k) => k.keyId === 'ztools-commonlibs-prod-2026a'))
})
