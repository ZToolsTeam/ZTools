import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BUILD_API_BASE_ENV,
  normalizeApiBase,
  officialApiBase,
  readBuildConfig,
  readDotenvValue,
  resolveBuildApiBase,
  serializeBuildConfig
} from '../../src/main/runtime/build-config.js'

// 官方后台地址由构建期注入：没有注入时是单机离线构建。开源版任何情况下都不使用这个地址。
// 这里覆盖地址解析、校验与配置文件读取（读取失败一律降级为离线）。

const OFFICIAL_LIKE = 'https://api.example'

async function tempRoot(t: { after(fn: () => Promise<void>): void }, name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ztools-build-config-${name}-`))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('normalizeApiBase accepts https bases and loopback http, strips trailing slashes', () => {
  assert.equal(normalizeApiBase(''), '')
  assert.equal(normalizeApiBase('   '), '')
  assert.equal(normalizeApiBase('https://api.example'), 'https://api.example')
  assert.equal(normalizeApiBase(' https://api.example/// '), 'https://api.example')
  assert.equal(normalizeApiBase('https://api.example/base/'), 'https://api.example/base')
  assert.equal(normalizeApiBase('HTTPS://API.EXAMPLE:8443'), 'https://api.example:8443')
  assert.equal(normalizeApiBase('http://localhost:8001'), 'http://localhost:8001')
  assert.equal(normalizeApiBase('http://127.0.0.1:8001/'), 'http://127.0.0.1:8001')
  assert.equal(normalizeApiBase('http://[::1]:8001'), 'http://[::1]:8001')
})

test('normalizeApiBase rejects insecure, malformed and credential-bearing bases', () => {
  for (const bad of [
    'http://api.example',
    'http://localhost.evil.example',
    'ftp://api.example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'api.example',
    '/api',
    'https://user:pass@api.example',
    'https://api.example/?redirect=evil',
    'https://api.example/#fragment',
    `https://api.example/${'a'.repeat(4096)}`
  ]) {
    assert.throws(() => normalizeApiBase(bad), Error, bad.slice(0, 60))
  }
  for (const bad of [undefined, null, 42, {}, ['https://api.example']]) {
    assert.throws(() => normalizeApiBase(bad), TypeError)
  }
})

test('readDotenvValue handles spaces, quotes, comments, BOM, CRLF and last-wins', () => {
  assert.equal(readDotenvValue('VITE_API_BASE_URL = https://api.example\n', 'VITE_API_BASE_URL'), 'https://api.example')
  assert.equal(readDotenvValue('﻿VITE_API_BASE_URL="https://a.example"\r\nOTHER=1\r\n', 'VITE_API_BASE_URL'), 'https://a.example')
  assert.equal(readDotenvValue("VITE_API_BASE_URL='https://a.example'", 'VITE_API_BASE_URL'), 'https://a.example')
  assert.equal(readDotenvValue('# VITE_API_BASE_URL=https://commented.example\n', 'VITE_API_BASE_URL'), undefined)
  assert.equal(readDotenvValue('VITE_API_BASE_URL_EXTRA=https://x.example\n', 'VITE_API_BASE_URL'), undefined)
  assert.equal(readDotenvValue('VITE_API_BASE_URL=https://a.example\nVITE_API_BASE_URL=https://b.example', 'VITE_API_BASE_URL'), 'https://b.example')
  assert.equal(readDotenvValue('garbage line without separator\n=value', 'VITE_API_BASE_URL'), undefined)
})

test('resolveBuildApiBase: env wins (empty means forced offline), then frontend .env.production, else offline', () => {
  const production = 'VITE_API_BASE_URL = https://api.example\n'
  assert.deepEqual(resolveBuildApiBase({ env: {}, frontendEnvProduction: production }),
    { apiBase: OFFICIAL_LIKE, source: 'frontend-env-production' })
  assert.deepEqual(resolveBuildApiBase({ env: { [BUILD_API_BASE_ENV]: 'https://other.example/' }, frontendEnvProduction: production }),
    { apiBase: 'https://other.example', source: 'env' })
  assert.deepEqual(resolveBuildApiBase({ env: { [BUILD_API_BASE_ENV]: '' }, frontendEnvProduction: production }),
    { apiBase: '', source: 'env' }, '显式空值强制离线，不回落到界面层配置')
  // 公开源码：没有 .env.production
  assert.deepEqual(resolveBuildApiBase({ env: {} }), { apiBase: '', source: 'none' })
  // 只给开发代理用的相对前缀不当作后台地址
  assert.deepEqual(resolveBuildApiBase({ env: {}, frontendEnvProduction: 'VITE_API_BASE_URL = /api\n' }),
    { apiBase: '', source: 'none' })
  assert.deepEqual(resolveBuildApiBase({ env: {}, frontendEnvProduction: '' }), { apiBase: '', source: 'none' })
})

test('resolveBuildApiBase fails the build on an explicitly configured but invalid base', () => {
  assert.throws(() => resolveBuildApiBase({ env: { [BUILD_API_BASE_ENV]: 'http://api.example' } }), /https/)
  assert.throws(() => resolveBuildApiBase({ env: { [BUILD_API_BASE_ENV]: 'not a url' } }), /有效/)
  assert.throws(() => resolveBuildApiBase({ env: {}, frontendEnvProduction: 'VITE_API_BASE_URL=http://api.example' }), /https/)
  assert.throws(() => resolveBuildApiBase({ env: {}, frontendEnvProduction: 'VITE_API_BASE_URL=https://u:p@api.example' }), /账号/)
})

test('readBuildConfig degrades to offline on missing, corrupt, wrong-version or tampered config', async (t) => {
  const root = await tempRoot(t, 'read')
  const file = path.join(root, 'build-config.json')
  const warnings: unknown[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  t.after(() => { console.warn = originalWarn })

  assert.deepEqual(readBuildConfig(file), { apiBase: '' }, '文件缺失：离线，不告警')
  assert.equal(warnings.length, 0)

  await fs.writeFile(file, serializeBuildConfig({ apiBase: 'https://api.example/' }), 'utf8')
  assert.deepEqual(readBuildConfig(file), { apiBase: OFFICIAL_LIKE })
  await fs.writeFile(file, `﻿${serializeBuildConfig({ apiBase: OFFICIAL_LIKE })}`, 'utf8')
  assert.deepEqual(readBuildConfig(file), { apiBase: OFFICIAL_LIKE }, 'BOM 不影响读取')
  await fs.writeFile(file, serializeBuildConfig({ apiBase: '' }), 'utf8')
  assert.deepEqual(readBuildConfig(file), { apiBase: '' })

  for (const corrupt of [
    '{"schemaVersion":1,"apiBase":"https://api.example"',
    '[1,2,3]',
    'null',
    JSON.stringify({ schemaVersion: 2, apiBase: OFFICIAL_LIKE }),
    JSON.stringify({ apiBase: OFFICIAL_LIKE }),
    JSON.stringify({ schemaVersion: 1, apiBase: 'http://evil.example' }),
    JSON.stringify({ schemaVersion: 1, apiBase: 42 })
  ]) {
    await fs.writeFile(file, corrupt, 'utf8')
    assert.deepEqual(readBuildConfig(file), { apiBase: '' }, corrupt)
  }
  assert.equal(warnings.length, 7, '每种损坏都告警一次')
  assert.throws(() => serializeBuildConfig({ apiBase: 'http://evil.example' }), /https/)
})

test('production layout: out/main/runtime/build-config.js reads out/main/build-config.json', async (t) => {
  const root = await tempRoot(t, 'layout')
  const runtimeDir = path.join(root, 'main', 'runtime')
  await fs.mkdir(runtimeDir, { recursive: true })
  // 拷一份编译后的模块到独立目录，得到独立的模块实例与缓存，不影响本进程其他用例
  const compiled = createRequire(__filename).resolve('../../src/main/runtime/build-config.js')
  await fs.copyFile(compiled, path.join(runtimeDir, 'build-config.js'))
  await fs.writeFile(path.join(root, 'main', 'build-config.json'), serializeBuildConfig({ apiBase: OFFICIAL_LIKE }), 'utf8')
  const injected = createRequire(__filename)(path.join(runtimeDir, 'build-config.js')) as { officialApiBase(): string }
  assert.equal(injected.officialApiBase(), OFFICIAL_LIKE)
  // 进程内缓存：运行中改文件不会让地址漂移
  await fs.writeFile(path.join(root, 'main', 'build-config.json'), serializeBuildConfig({ apiBase: '' }), 'utf8')
  assert.equal(injected.officialApiBase(), OFFICIAL_LIKE)
})

test('test build has no injected config: official base is empty (offline)', () => {
  assert.equal(officialApiBase(), '')
})
