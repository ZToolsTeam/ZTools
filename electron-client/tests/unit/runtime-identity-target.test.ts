import assert from 'node:assert/strict'
import fs, { symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { RuntimeCapabilityTarget } from '../../src/contracts/runtime-capability.js'
import {
  readMacRuntimeTargetManifest,
  resolveRuntimeIdentityTarget,
  RUNTIME_TARGET_MANIFEST_FILE
} from '../../src/main/platform/runtime-identity-target.js'

function expectNotSupported(callback: () => unknown): void {
  assert.throws(
    callback,
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
}

function writeManifest(resourcesPath: string, manifest: unknown): void {
  fs.writeFileSync(
    path.join(resourcesPath, RUNTIME_TARGET_MANIFEST_FILE),
    JSON.stringify(manifest),
    'utf8'
  )
}

function macTarget(arch: 'x64' | 'arm64' = 'arm64'): RuntimeCapabilityTarget {
  return { platform: 'macos', runtime: 'electron', arch }
}

test('packaged macOS identity uses the strict universal marker while process target stays a slice', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-runtime-target-'))
  const resourcesPath = path.join(temporaryRoot, 'Contents', 'Resources')
  fs.mkdirSync(resourcesPath, { recursive: true })
  writeManifest(resourcesPath, {
    manifestVersion: 1,
    target: { platform: 'macos', runtime: 'electron', arch: 'universal' }
  })

  try {
    assert.deepEqual(resolveRuntimeIdentityTarget({
      target: macTarget('x64'),
      platform: 'darwin',
      processArch: 'x64',
      isPackaged: true,
      resourcesPath
    }), { platform: 'macos', runtime: 'electron', arch: 'universal' })
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('development uses the active macOS process slice and does not depend on a packaged marker', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-runtime-target-'))
  try {
    assert.deepEqual(resolveRuntimeIdentityTarget({
      target: macTarget('arm64'),
      platform: 'darwin',
      processArch: 'arm64',
      isPackaged: false,
      resourcesPath: path.join(temporaryRoot, 'missing-resources')
    }), { platform: 'macos', runtime: 'electron', arch: 'arm64' })
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('packaged macOS target resolution fails closed for missing, malformed, or mismatched markers', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-runtime-target-'))
  const resourcesPath = path.join(temporaryRoot, 'Resources')
  fs.mkdirSync(resourcesPath)
  const input = {
    target: macTarget('arm64'),
    platform: 'darwin' as const,
    processArch: 'arm64',
    isPackaged: true,
    resourcesPath
  }

  try {
    expectNotSupported(() => resolveRuntimeIdentityTarget(input))
    for (const manifest of [
      { manifestVersion: 2, target: { platform: 'macos', runtime: 'electron', arch: 'universal' } },
      { manifestVersion: 1, target: { platform: 'macos', runtime: 'electron', arch: 'universal', id: 'wrong' } },
      { manifestVersion: 1, target: { platform: 'windows', runtime: 'electron', arch: 'universal' } },
      { manifestVersion: 1, target: { platform: 'macos', runtime: 'legacy-delphi', arch: 'universal' } },
      { manifestVersion: 1, target: { platform: 'macos', runtime: 'electron', arch: 'x64' } }
    ]) {
      writeManifest(resourcesPath, manifest)
      expectNotSupported(() => resolveRuntimeIdentityTarget(input))
      fs.rmSync(path.join(resourcesPath, RUNTIME_TARGET_MANIFEST_FILE), { force: true })
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('runtime target manifest reader requires an absolute Resources directory', () => {
  expectNotSupported(() => readMacRuntimeTargetManifest('relative/Resources'))
})

test('runtime target manifest reader accepts a parent directory alias while enforcing canonical containment', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-runtime-target-'))
  const physicalBundleRoot = path.join(temporaryRoot, 'physical')
  const aliasBundleRoot = path.join(temporaryRoot, 'alias')
  const physicalResourcesPath = path.join(physicalBundleRoot, 'Contents', 'Resources')
  const aliasedResourcesPath = path.join(aliasBundleRoot, 'Contents', 'Resources')
  fs.mkdirSync(physicalResourcesPath, { recursive: true })
  writeManifest(physicalResourcesPath, {
    manifestVersion: 1,
    target: { platform: 'macos', runtime: 'electron', arch: 'universal' }
  })

  try {
    try {
      symlinkSync(physicalBundleRoot, aliasBundleRoot, 'junction')
    } catch {
      t.skip('directory aliases cannot be created in this test environment')
      return
    }

    assert.deepEqual(resolveRuntimeIdentityTarget({
      target: macTarget('arm64'),
      platform: 'darwin',
      processArch: 'arm64',
      isPackaged: true,
      resourcesPath: aliasedResourcesPath
    }), { platform: 'macos', runtime: 'electron', arch: 'universal' })
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('Windows target identity remains based on its runtime target and does not require a Mac marker', () => {
  assert.deepEqual(resolveRuntimeIdentityTarget({
    target: { platform: 'windows', runtime: 'electron', arch: 'ia32' },
    platform: 'win32',
    processArch: 'ia32',
    isPackaged: true,
    resourcesPath: ''
  }), {
    id: 'windows-electron-ia32',
    platform: 'windows',
    runtime: 'electron',
    arch: 'ia32'
  })
})
