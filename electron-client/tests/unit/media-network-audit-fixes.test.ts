import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NetworkHostPluginHandler } from '../../src/main/services/host-plugins/network-host.js'
import { MediaOcrHostPluginHandler } from '../../src/main/services/host-plugins/media-ocr-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
const ctx: HostPluginContext = { clipboard: null, processService: null, windowControl: null,
  authorizeExistingPath: async value => value, authorizeOutputPath: async value => value }

test('Windows网络诊断读取真实NLA状态，防火墙配置可读不冒充连通性正常', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-network-unit-'))
  const hosts = path.join(tmp, 'hosts')
  await fs.writeFile(hosts, '127.0.0.1 localhost')
  const scripts: string[] = []
  let fail = false
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const handler = new NetworkHostPluginHandler(ctx, {
      hostsPath: hosts, lookupDns: async () => { throw new Error('DNS unavailable') },
      probeTcp: async () => ({ ok: false, latencyMs: 3 }),
      runCommand: async () => { throw new Error('不得执行修复命令') },
      runPowerShell: async script => {
        scripts.push(script)
        if (fail) throw new Error('ACCESS_DENIED')
        return JSON.stringify({ nlaStatus: 'Stopped', firewallProfiles: [{ Name: 'Public', Enabled: true }], proxyEnabled: false })
      }
    })
    const result = await handler.handleNetworkRescue('diagnose', {}) as { checks: Array<{ id: string; status: string; detail: string }> }
    const byId = (id: string) => result.checks.find(item => item.id === id)!
    assert.equal(byId('restart-nla').status, 'warning')
    assert.match(byId('restart-nla').detail, /Stopped/)
    assert.equal(byId('reset-winsock').status, 'unknown')
    assert.equal(byId('reset-firewall').status, 'unknown')
    assert.match(scripts[0]!, /HKCU:\\Software\\Microsoft/)
    assert.match(scripts[0]!, /Get-Service -Name NlaSvc/)
    assert.match(scripts[0]!, /Get-NetFirewallProfile/)
    fail = true
    const unavailable = await handler.handleNetworkRescue('diagnose', {}) as typeof result
    assert.equal(unavailable.checks.find(item => item.id === 'restart-nla')?.status, 'unknown')
    assert.match(unavailable.checks.find(item => item.id === 'restart-nla')?.detail || '', /ACCESS_DENIED/)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('OCR日语韩语严格映射，Windows缺包不偷换默认语言，Tesseract缺包如实反馈', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-ocr-unit-'))
  const image = path.join(tmp, 'image.png')
  await fs.writeFile(image, 'fixture')
  const langs: string[] = [], scripts: string[] = []
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const handler = new MediaOcrHostPluginHandler(ctx, {
      runPowerShell: async script => { scripts.push(script); throw new Error('所选Windows语言包未安装') },
      runCommand: async (_command, args) => { langs.push(args.at(-1)!); return { exitCode: 1, stdout: '', stderr: `Failed loading language '${args.at(-1)}'` } }
    })
    for (const lang of ['ja-JP', 'ko-KR', 'en-US', 'zh-Hans-CN']) {
      const result = await handler.handleOcr('recognizeImage', { path: image, lang }) as { ok: boolean; error: string }
      assert.equal(result.ok, false)
      assert.match(result.error, /Failed loading language/)
      assert.match(result.error, /所选Windows语言包未安装/)
    }
    assert.deepEqual(langs, ['jpn', 'kor', 'eng', 'chi_sim+eng'])
    assert.equal(scripts.some(script => script.includes('TryCreateFromUserProfileLanguages')), false)
    const unsupported = await handler.handleOcr('recognizeImage', { path: image, lang: 'invalid' }) as { ok: boolean }
    assert.equal(unsupported.ok, false)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
