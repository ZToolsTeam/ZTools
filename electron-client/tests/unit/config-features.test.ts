import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ConfigService, DEFAULT_FEATURE_FLAGS, type FeatureFlagKey } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'

function testRoot(name: string): string {
  return path.join(os.tmpdir(), `ztools-test-config-features-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

test('ConfigService.getFeatures() returns all 7 flags with default false when file is empty or missing', async () => {
  const root = testRoot('missing')
  await fs.mkdir(root, { recursive: true })
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

test('ConfigService gracefully falls back to default feature flags when user_settings.json is corrupted', async () => {
  const root = testRoot('corrupt')
  await fs.mkdir(root, { recursive: true })
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

test('ConfigService gracefully handles missing or malformed feature fields', async () => {
  const root = testRoot('malformed-fields')
  await fs.mkdir(root, { recursive: true })
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

test('ConfigService supports setFeature and persists updates to user_settings.json', async () => {
  const root = testRoot('set-feature')
  await fs.mkdir(root, { recursive: true })
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
    config.setFeature('nonExistentFeature' as any, true),
    (err) => err instanceof ZToolsError && err.code === errorCodes.invalidRequest
  )
})

test('ConfigService.setFeatures batch updates multiple flags', async () => {
  const root = testRoot('batch-set')
  await fs.mkdir(root, { recursive: true })
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)

  const result = await config.setFeatures({
    commandPalette: true,
    scriptCommands: true
  })

  assert.equal(result.commandPalette, true)
  assert.equal(result.scriptCommands, true)
  assert.equal(result.unifiedKeymap, false)

  const reread = await config.getFeatures()
  assert.equal(reread.commandPalette, true)
  assert.equal(reread.scriptCommands, true)
  assert.equal(reread.unifiedKeymap, false)
})
