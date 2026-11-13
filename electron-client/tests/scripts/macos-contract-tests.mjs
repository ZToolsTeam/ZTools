import fs from 'node:fs'
import path from 'node:path'

export const macContractScripts = Object.freeze([
  'tests/scripts/test-sandbox-preload-bundle.mjs',
  'tests/scripts/test-build-macos-vision.mjs',
  'tests/scripts/test-build-macos-native-host.mjs',
  'tests/scripts/test-macos-native-worker-key-source.mjs',
  'tests/scripts/test-reference-image-functions.mjs',
  'tests/scripts/test-build-macos-clipboard.mjs',
  'tests/scripts/test-build-macos-path-access.mjs',
  'tests/scripts/test-build-windows-path-access.mjs',
  'tests/scripts/test-macos-apfs-fixtures.mjs',
  'tests/scripts/test-macos-path-names-apfs.mjs',
  'tests/scripts/test-macos-bundle-version.mjs',
  'tests/scripts/test-macos-plugin-baseline.mjs',
  'tests/scripts/test-macos-app-integration.mjs',
  'tests/scripts/test-normal-app-preboot-isolation.test.mjs',
  'tests/scripts/lib/windows-normal-app-harness.contract.test.mjs',
  'tests/scripts/lib/normal-app-plugin-install.contract.test.mjs',
  'tests/scripts/lib/windows-clipboard-metadata.contract.test.mjs',
  'tests/scripts/test-macos-fixtures.mjs',
  'tests/scripts/test-macos-data-fixtures.mjs',
  'tests/scripts/test-macos-loopback-fixtures.mjs',
  'tests/scripts/test-macos-lifecycle-baseline.mjs',
  'tests/scripts/test-macos-owned-cleanup.mjs',
  'tests/scripts/test-macos-minimum-os.mjs',
  'tests/scripts/test-macos-preflight.mjs',
  'tests/scripts/test-macos-readonly-cases.mjs',
  'tests/scripts/test-package-macos-universal.mjs',
  'tests/scripts/test-sign-macos.mjs',
  'tests/scripts/test-start-macos.mjs',
  'tests/scripts/test-test-run-options.mjs',
  'tests/scripts/test-verify-macos-universal.mjs'
])

// Entries outside electron-client belong to internal-only sibling projects.
// A public checkout does not contain them, so they are reported as NOT_RUN
// instead of failing. When the sibling project exists, every entry runs exactly as before.
export function externalProjectRoot(clientRoot, script) {
  const segments = script.split('/')
  if (segments[0] !== '..' || segments.length < 4) return null
  return path.resolve(clientRoot, ...segments.slice(0, 3))
}

export function partitionMacContractScripts(clientRoot, scripts = macContractScripts, exists = fs.existsSync) {
  const runnable = []
  const notRun = []
  for (const script of scripts) {
    const projectRoot = externalProjectRoot(clientRoot, script)
    if (projectRoot !== null && !exists(projectRoot)) notRun.push({ script, reason: `missing ${projectRoot}` })
    else runnable.push(script)
  }
  return { runnable, notRun }
}
