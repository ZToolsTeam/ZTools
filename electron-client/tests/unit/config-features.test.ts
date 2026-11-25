import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ConfigService, DEFAULT_FEATURE_FLAGS, type FeatureFlagKey } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'

async function createTestRoot(t: test.TestContext, name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ztools-test-config-features-${name}-`))
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  return root
}

test('ConfigService.getFeatures() returns all 7 flags with default false when file is empty or missing', async (t) => {
  const root = await createTestRoot(t, 'missing')
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  const features = await config.getFeatures()
  assert.deepEqual(features, {
    unifiedKeymap: false,
    commandPalette: false,
    dashboardStage: false,
    silentInstall: false,
    extensionHost: false,
    scriptCommands: false,
    extensionTools: false
  })

  // All individual features default to readable and false
  for (const key of Object.keys(DEFAULT_FEATURE_FLAGS) as FeatureFlagKey[]) {
    assert.equal(await config.getFeature(key), false)
  }
})

test('ConfigService gracefully falls back to default feature flags when user_settings.json is corrupted', async (t) => {
  const root = await createTestRoot(t, 'corrupt')
  const settingsFile = path.join(root, 'user_settings.json')
  await fs.writeFile(settingsFile, '{corrupted-json-content', 'utf8')

  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  // Corrupted file must NEVER crash getFeatures() or getFeature()
  const features = await config.getFeatures()
  assert.deepEqual(features, DEFAULT_FEATURE_FLAGS)
  assert.equal(await config.getFeature('unifiedKeymap'), false)

  // getSetting('features') and getSetting('features.unifiedKeymap') must also gracefully fall back
  const serialized = await config.getSetting('features')
  assert.deepEqual(JSON.parse(serialized), DEFAULT_FEATURE_FLAGS)
  assert.equal(await config.getSetting('features.unifiedKeymap'), 'false')

  // Normal setting keys still report corruption as expected by existing integrity contract
  await assert.rejects(
    config.get('user_settings.json', 'ui.theme', 'light'),
    (err) => err instanceof ZToolsError && err.code === errorCodes.dataCorrupt
  )
})

test('ConfigService gracefully handles missing or malformed feature fields', async (t) => {
  const root = await createTestRoot(t, 'malformed-fields')
  const settingsFile = path.join(root, 'user_settings.json')
  await fs.writeFile(
    settingsFile,
    JSON.stringify({
      features: {
        unifiedKeymap: true,
        commandPalette: 'not-a-boolean',
        dashboardStage: null,
        silentInstall: 12345,
        // extensionHost, scriptCommands, extensionTools are completely missing
      }
    }),
    'utf8'
  )

  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  const features = await config.getFeatures()
  assert.equal(features.unifiedKeymap, true)
  assert.equal(features.commandPalette, false) // Malformed string fallback
  assert.equal(features.dashboardStage, false) // null fallback
  assert.equal(features.silentInstall, false) // number fallback
  assert.equal(features.extensionHost, false) // missing fallback
  assert.equal(features.scriptCommands, false) // missing fallback
  assert.equal(features.extensionTools, false) // missing fallback
})

test('ConfigService supports setFeature and persists updates to user_settings.json', async (t) => {
  const root = await createTestRoot(t, 'set-feature')
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  assert.equal(await config.getFeature('unifiedKeymap'), false)
  const updated = await config.setFeature('unifiedKeymap', true)
  assert.equal(updated, true)
  assert.equal(await config.getFeature('unifiedKeymap'), true)

  // Verify file on disk
  const raw = await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')
  const content = JSON.parse(raw.replace(/^\uFEFF/, ''))
  assert.equal(content.features.unifiedKeymap, true)

  // Reject unknown feature flag keys
  await assert.rejects(
    config.setFeature('nonExistentFeature' as unknown as FeatureFlagKey, true),
    (err) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
})

test('ConfigService.setFeatures batch updates multiple flags in a single store update', async (t) => {
  const root = await createTestRoot(t, 'batch-set')
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  let updateCalls = 0
  const originalUpdate = store.update.bind(store)
  store.update = async (fileName, mutate) => {
    updateCalls += 1
    return originalUpdate(fileName, mutate)
  }

  const result = await config.setFeatures({
    commandPalette: true,
    scriptCommands: true,
    extensionTools: true
  })

  assert.equal(updateCalls, 1, '批量设置多个特性开关应合并为单次写盘')
  assert.equal(result.commandPalette, true)
  assert.equal(result.scriptCommands, true)
  assert.equal(result.extensionTools, true)
  assert.equal(result.unifiedKeymap, false)

  // 无有效布尔更新时不得触发无意义写盘
  await config.setFeatures({})
  assert.equal(updateCalls, 1)

  const reread = await config.getFeatures()
  assert.equal(reread.commandPalette, true)
  assert.equal(reread.scriptCommands, true)
  assert.equal(reread.extensionTools, true)
  assert.equal(reread.unifiedKeymap, false)
})
