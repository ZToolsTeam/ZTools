import assert from 'node:assert/strict'
import { constants as fsConstants } from 'node:fs'
import test from 'node:test'
import {
  createMacApplicationInspector,
  type MacApplicationInspectorDependencies,
  type MacApplicationStat
} from '../../src/main/platform/macos/local-application.js'

interface FixtureEntry {
  kind: 'directory' | 'file'
  size: number
  executable?: boolean
  symbolicLink?: boolean
  realPath?: string
}

function createFixture(overrides: {
  metadata?: unknown
  infoSize?: number
  executableKind?: 'directory' | 'file'
  executableBit?: boolean
  selectedRealPath?: string
  infoRealPath?: string
  executableRealPath?: string
} = {}): {
  inspect: (selectedPath: string, signal?: AbortSignal) => Promise<{ appPath: string; bundleIdentifier: string; executableName: string }>
  readInfoPlistCalls: () => number
} {
  const appPath = '/Applications/CaseSensitive.app'
  const contentsPath = `${appPath}/Contents`
  const macOSPath = `${contentsPath}/MacOS`
  const infoPath = `${contentsPath}/Info.plist`
  const executablePath = `${macOSPath}/CaseSensitive`
  const entries = new Map<string, FixtureEntry>([
    [appPath, {
      kind: 'directory',
      size: 0,
      ...(overrides.selectedRealPath === undefined ? {} : { realPath: overrides.selectedRealPath })
    }],
    [contentsPath, { kind: 'directory', size: 0 }],
    [macOSPath, { kind: 'directory', size: 0 }],
    [infoPath, {
      kind: 'file',
      size: overrides.infoSize ?? 128,
      ...(overrides.infoRealPath === undefined ? {} : { realPath: overrides.infoRealPath })
    }],
    [executablePath, {
      kind: overrides.executableKind ?? 'file',
      size: 1024,
      executable: overrides.executableBit ?? true,
      ...(overrides.executableRealPath === undefined ? {} : { realPath: overrides.executableRealPath })
    }]
  ])
  let readInfoPlistCalls = 0
  const dependencies: MacApplicationInspectorDependencies = {
    lstat: async (filePath): Promise<MacApplicationStat> => {
      const entry = entries.get(filePath)
      if (!entry) throw new Error('missing')
      return {
        size: entry.size,
        isDirectory: () => entry.kind === 'directory',
        isFile: () => entry.kind === 'file',
        isSymbolicLink: () => entry.symbolicLink === true
      }
    },
    realpath: async (filePath) => {
      const entry = entries.get(filePath)
      if (!entry) throw new Error('missing')
      return entry.realPath ?? filePath
    },
    access: async (filePath, mode) => {
      const entry = entries.get(filePath)
      if (mode !== fsConstants.X_OK || entry?.executable !== true) throw new Error('not executable')
    },
    readInfoPlist: async () => {
      readInfoPlistCalls += 1
      return overrides.metadata ?? {
        CFBundlePackageType: 'APPL',
        CFBundleIdentifier: 'com.example.CaseSensitive',
        CFBundleExecutable: 'CaseSensitive'
      }
    }
  }

  return {
    inspect: createMacApplicationInspector(dependencies),
    readInfoPlistCalls: () => readInfoPlistCalls
  }
}

test('validates a selected canonical app bundle and its Info.plist executable identity', async () => {
  const fixture = createFixture()
  assert.deepEqual(await fixture.inspect('/Applications/CaseSensitive.app'), {
    appPath: '/Applications/CaseSensitive.app',
    bundleIdentifier: 'com.example.CaseSensitive',
    executableName: 'CaseSensitive'
  })
})

test('rejects noncanonical app paths and symlinked bundle members', async () => {
  const alias = createFixture({ selectedRealPath: '/Applications/Target.app' })
  await assert.rejects(alias.inspect('/Applications/CaseSensitive.app'), /符号链接/)

  const linkedInfo = createFixture({ infoRealPath: '/Applications/Elsewhere/Info.plist' })
  await assert.rejects(linkedInfo.inspect('/Applications/CaseSensitive.app'), /符号链接/)

  const linkedExecutable = createFixture({ executableRealPath: '/Applications/Other/Executable' })
  await assert.rejects(linkedExecutable.inspect('/Applications/CaseSensitive.app'), /符号链接/)
})

test('requires a bounded plist, valid identity, ordinary executable file, and execute permission', async () => {
  const oversizedInfo = createFixture({ infoSize: 1024 * 1024 + 1 })
  await assert.rejects(oversizedInfo.inspect('/Applications/CaseSensitive.app'))

  const invalidBundleId = createFixture({ metadata: {
    CFBundlePackageType: 'APPL',
    CFBundleIdentifier: '../invalid',
    CFBundleExecutable: 'CaseSensitive'
  } })
  await assert.rejects(invalidBundleId.inspect('/Applications/CaseSensitive.app'), /身份/)

  const invalidExecutableName = createFixture({ metadata: {
    CFBundlePackageType: 'APPL',
    CFBundleIdentifier: 'com.example.CaseSensitive',
    CFBundleExecutable: '../CaseSensitive'
  } })
  await assert.rejects(invalidExecutableName.inspect('/Applications/CaseSensitive.app'), /身份/)

  const nonApplicationPackage = createFixture({ metadata: {
    CFBundlePackageType: 'BNDL',
    CFBundleIdentifier: 'com.example.CaseSensitive',
    CFBundleExecutable: 'CaseSensitive'
  } })
  await assert.rejects(nonApplicationPackage.inspect('/Applications/CaseSensitive.app'), /身份/)

  const nonFileExecutable = createFixture({ executableKind: 'directory' })
  await assert.rejects(nonFileExecutable.inspect('/Applications/CaseSensitive.app'))

  const nonExecutable = createFixture({ executableBit: false })
  await assert.rejects(nonExecutable.inspect('/Applications/CaseSensitive.app'), /executable/)
})

test('rejects relative, NUL-containing, and oversized paths before filesystem access', async () => {
  const fixture = createFixture()
  await assert.rejects(fixture.inspect('Applications/CaseSensitive.app'), /路径无效/)
  await assert.rejects(fixture.inspect('/Applications/CaseSensitive.app\0'), /路径无效/)
  await assert.rejects(fixture.inspect(`/${'a'.repeat(32 * 1024)}.app`), /路径无效/)
})

test('does not invoke the plist reader when inspection is pre-cancelled', async () => {
  const fixture = createFixture()
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(fixture.inspect('/Applications/CaseSensitive.app', controller.signal))
  assert.equal(fixture.readInfoPlistCalls(), 0)
})
