import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LaunchIntentDeduplicator,
  parseLaunchIntent
} from '../../src/main/runtime/launch-intent.js'

test('launch intent parser accepts shortcut arguments and preserves paths with spaces', () => {
  const environment: NodeJS.ProcessEnv = {
    ZTOOLS_SOURCE: 'legacy-installer',
    ZTOOLS_LAUNCH_ID: 'env-launch'
  }
  const intent = parseLaunchIntent([
    'ZTools.exe',
    '--plugin',
    'plugin.with spaces',
    '--source=desktop-shortcut',
    '--launch-id=shortcut-1'
  ], environment)

  assert.deepEqual(intent, {
    source: 'desktop-shortcut',
    launchId: 'shortcut-1'
  })
  assert.equal(environment.ZTOOLS_SOURCE, undefined)
  assert.equal(environment.ZTOOLS_LAUNCH_ID, undefined)
})

test('launch intent parser validates plugin identifiers and adds safe source defaults', () => {
  assert.deepEqual(parseLaunchIntent(['ZTools.exe', '--plugin', 'plugin.test']), {
    pluginId: 'plugin.test',
    source: 'plugin-shortcut'
  })
  assert.equal(parseLaunchIntent(['ZTools.exe', '--plugin', '../outside']), undefined)
  assert.equal(parseLaunchIntent(['ZTools.exe', '--plugin', 'con']), undefined)
  assert.deepEqual(parseLaunchIntent(['ZTools.exe', '--autostart', '--updated']), {
    autostart: true,
    updated: true,
    source: 'autostart'
  })
})

test('launch intent context environment is one-shot and command line wins', () => {
  const environment: NodeJS.ProcessEnv = {
    ZTOOLS_PLUGIN_ID: 'from-env',
    ZTOOLS_SOURCE: 'env-source',
    ZTOOLS_AUTOSTART: '1',
    ZTOOLS_UPDATED: 'true'
  }
  const first = parseLaunchIntent(['--plugin=from-args', '--autostart=false'], environment)
  assert.deepEqual(first, {
    pluginId: 'from-args',
    source: 'env-source',
    autostart: false,
    updated: true
  })
  assert.equal(parseLaunchIntent([], environment), undefined)
})

test('launch intent preserves the startup attribution fields used by the legacy host', () => {
  const environment: NodeJS.ProcessEnv = {
    ZTOOLS_LAUNCH_REQUEST_ID: 'request-1',
    ZTOOLS_LAUNCH_TYPE: 'installer',
    ZTOOLS_LAUNCH_ATTEMPT_NO: '2',
    ZTOOLS_LAUNCH_METHOD: 'shortcut',
    ZTOOLS_INSTALL_SESSION_ID: 'session-1',
    ZTOOLS_INSTALLER_MODE: 'silent',
    ZTOOLS_REG_SOURCE: 'registry-source'
  }
  assert.deepEqual(parseLaunchIntent([
    '--launch-id=launch-1',
    '--source=installer',
    '--launch-method=command-line'
  ], environment), {
    source: 'installer',
    launchId: 'launch-1',
    launchRequestId: 'request-1',
    launchType: 'installer',
    launchAttemptNo: '2',
    launchMethod: 'command-line',
    installSessionId: 'session-1',
    installerMode: 'silent',
    registrySource: 'registry-source'
  })
  assert.equal(environment.ZTOOLS_INSTALL_SESSION_ID, undefined)
})

test('launch intent deduplicator only suppresses explicit launch ids', () => {
  const deduplicator = new LaunchIntentDeduplicator()
  assert.equal(deduplicator.accept({ pluginId: 'a' }), true)
  assert.equal(deduplicator.accept({ pluginId: 'a' }), true)
  assert.equal(deduplicator.accept({ launchId: 'launch-1' }), true)
  assert.equal(deduplicator.accept({ launchId: 'launch-1' }), false)
})
