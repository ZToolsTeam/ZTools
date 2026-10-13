import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { inspectMacosFile, main, verifyMacosUniversalBundle } from './verify-macos-universal.mjs'

function stats(kind) {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  }
}

function createVirtualFs() {
  const nodes = new Map()
  const normalize = (value) => path.resolve(value)

  function resolveCanonical(value, seen = new Set()) {
    const absolute = normalize(value)
    const root = path.parse(absolute).root
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
    let current = root
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index])
      const node = nodes.get(current)
      if (!node) {
        const error = new Error(`ENOENT: ${current}`)
        error.code = 'ENOENT'
        throw error
      }
      if (node.kind === 'symlink') {
        if (seen.has(current)) throw new Error(`ELOOP: ${current}`)
        seen.add(current)
        const target = path.resolve(path.dirname(current), node.target)
        const remaining = parts.slice(index + 1)
        return resolveCanonical(path.join(target, ...remaining), seen)
      }
    }
    return current
  }

  function lstatPath(value) {
    const absolute = normalize(value)
    const parent = path.dirname(absolute)
    const canonicalParent = resolveCanonical(parent)
    const target = path.join(canonicalParent, path.basename(absolute))
    const node = nodes.get(target)
    if (!node) {
      const error = new Error(`ENOENT: ${target}`)
      error.code = 'ENOENT'
      throw error
    }
    return { node, path: target }
  }

  const fsApi = {
    lstatSync(value) {
      return stats(lstatPath(value).node.kind)
    },
    realpathSync(value) {
      return resolveCanonical(value)
    },
    statSync(value) {
      const canonical = resolveCanonical(value)
      return stats(nodes.get(canonical).kind)
    },
    readFileSync(value, encoding) {
      const canonical = resolveCanonical(value)
      const node = nodes.get(canonical)
      if (node?.kind !== 'file') throw new Error(`EISDIR: ${canonical}`)
      return encoding === 'utf8' ? node.content : Buffer.from(node.content)
    },
    readdirSync(value) {
      const directory = resolveCanonical(value)
      const node = nodes.get(directory)
      if (node?.kind !== 'directory') throw new Error(`ENOTDIR: ${directory}`)
      const entries = []
      for (const [candidate, child] of nodes) {
        if (path.dirname(candidate) === directory) {
          entries.push({
            name: path.basename(candidate),
            isDirectory: () => child.kind === 'directory',
            isFile: () => child.kind === 'file',
            isSymbolicLink: () => child.kind === 'symlink',
          })
        }
      }
      return entries
    },
  }

  function addDirectory(value) {
    const directory = normalize(value)
    const ancestors = []
    let parent = path.dirname(directory)
    while (parent !== path.parse(parent).root && !nodes.has(parent)) {
      ancestors.push(parent)
      parent = path.dirname(parent)
    }
    for (const ancestor of ancestors.reverse()) nodes.set(ancestor, { kind: 'directory' })
    nodes.set(directory, { kind: 'directory' })
  }
  function addFile(value, content = '') {
    nodes.set(normalize(value), { kind: 'file', content })
  }
  function addSymlink(value, target) {
    nodes.set(normalize(value), { kind: 'symlink', target })
  }

  return { fsApi, addDirectory, addFile, addSymlink }
}

function makeApp({ framework = false } = {}) {
  const virtual = createVirtualFs()
  const root = path.resolve(process.cwd(), '__UniversalAuditFixture__.app')
  const contents = path.join(root, 'Contents')
  const macos = path.join(contents, 'MacOS')
  const executable = path.join(macos, 'ZTools')
  virtual.addDirectory(root)
  virtual.addDirectory(contents)
  virtual.addDirectory(macos)
  virtual.addFile(executable)

  let frameworkBinary
  if (framework) {
    const frameworks = path.join(contents, 'Frameworks')
    const frameworkRoot = path.join(frameworks, 'Electron Framework.framework')
    const versions = path.join(frameworkRoot, 'Versions')
    const versionA = path.join(versions, 'A')
    frameworkBinary = path.join(versionA, 'Electron Framework')
    virtual.addDirectory(frameworks)
    virtual.addDirectory(frameworkRoot)
    virtual.addDirectory(versions)
    virtual.addDirectory(versionA)
    virtual.addFile(frameworkBinary)
    virtual.addSymlink(path.join(versions, 'Current'), 'A')
    virtual.addSymlink(path.join(frameworkRoot, 'Electron Framework'), path.join('Versions', 'Current', 'Electron Framework'))
  }

  return { ...virtual, root, executable, frameworkBinary }
}

function fatInspector(inspected = []) {
  return (filePath) => {
    inspected.push(filePath)
    return { kind: 'macho', architectures: ['x86_64', 'arm64'] }
  }
}

test('accepts a universal app and deduplicates an internal versioned framework symlink', () => {
  const app = makeApp({ framework: true })
  const inspected = []
  const result = verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: fatInspector(inspected),
  })

  assert.equal(result.machoFiles.length, 2)
  assert.equal(result.scannedRegularFiles, 2)
  assert.equal(inspected.length, 2)
  assert.ok(inspected.includes(app.frameworkBinary))
  assert.ok(result.machoFiles.every((file) => !path.isAbsolute(file)))
  assert.equal(result.nativeHostMode, 'disabled')
  assert.equal(result.nativeHostAvailable, false)
})

test('inspects dylib, node, and extensionless files without relying on filename filters', () => {
  const app = makeApp()
  const frameworks = path.join(app.root, 'Contents', 'Frameworks')
  const resources = path.join(app.root, 'Contents', 'Resources')
  const dylib = path.join(frameworks, 'libsample.dylib')
  const nodeAddon = path.join(resources, 'addon.node')
  const opaque = path.join(resources, 'binary-payload')
  app.addDirectory(frameworks)
  app.addDirectory(resources)
  app.addFile(dylib)
  app.addFile(nodeAddon)
  app.addFile(opaque)
  const machoPaths = new Set([app.executable, dylib, nodeAddon, opaque])
  const result = verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile(filePath) {
      return machoPaths.has(filePath)
        ? { kind: 'macho', architectures: ['arm64', 'x86_64'] }
        : { kind: 'other' }
    },
  })

  assert.equal(result.machoFiles.length, 4)
  assert.ok(result.machoFiles.includes(path.join('Contents', 'Frameworks', 'libsample.dylib')))
  assert.ok(result.machoFiles.includes(path.join('Contents', 'Resources', 'addon.node')))
  assert.ok(result.machoFiles.includes(path.join('Contents', 'Resources', 'binary-payload')))
})

test('rejects a thin Mach-O and names its bundle-relative path', () => {
  const app = makeApp()
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: () => ({ kind: 'macho', architectures: ['x86_64'] }),
  }), /缺少 Universal 架构切片 \(arm64\).*Contents[\\/]MacOS[\\/]ZTools/)
})

test('rejects Mach-O slices that omit x86_64 even when arm64 is present', () => {
  const app = makeApp()
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: () => ({ kind: 'macho', architectures: ['arm64', 'armv7'] }),
  }), /缺少 Universal 架构切片 \(x86_64\)/)
})

test('rejects malformed injected inspector results for the offending file', () => {
  const app = makeApp()
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: () => ({ kind: 'macho', architectures: 'arm64 x86_64' }),
  }), /检查器返回了无法识别的文件类型或架构列表: Contents[\\/]MacOS[\\/]ZTools/)
})

test('parses the macOS file/lipo contract and invokes tools without a shell', () => {
  const calls = []
  const inspect = inspectMacosFile('/Applications/ZTools.app/Contents/MacOS/ZTools', {
    exec(executable, args, options) {
      calls.push({ executable, args, options })
      return executable === 'file' ? 'Mach-O 64-bit universal binary\n' : 'x86_64 arm64\n'
    },
  })

  assert.deepEqual(inspect, { kind: 'macho', architectures: ['x86_64', 'arm64'] })
  assert.deepEqual(calls.map(({ executable, args }) => [executable, args]), [
    ['file', ['-b', '/Applications/ZTools.app/Contents/MacOS/ZTools']],
    ['lipo', ['-archs', '/Applications/ZTools.app/Contents/MacOS/ZTools']],
  ])
  assert.ok(calls.every(({ options }) => options.shell === false))
})

test('fails closed on malformed lipo output', () => {
  assert.throws(() => inspectMacosFile('/tmp/Test.app/bin', {
    exec(executable) {
      return executable === 'file' ? 'Mach-O 64-bit executable\n' : 'Architectures in file: x86_64 arm64\nextra'
    },
  }), /lipo -archs 输出格式无效/)
})

test('rejects an internal symlink that escapes the app bundle', () => {
  const app = makeApp()
  const external = path.resolve(process.cwd(), '__outside__', 'payload')
  app.addDirectory(path.dirname(external))
  app.addFile(external)
  const link = path.join(app.root, 'Contents', 'escape')
  app.addSymlink(link, external)

  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: fatInspector(),
  }), /符号链接越出 .app bundle: Contents[\\/]escape/)
})

test('rejects a dangling symlink and names its relative path', () => {
  const app = makeApp()
  const link = path.join(app.root, 'Contents', 'dangling')
  app.addSymlink(link, 'missing-target')

  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: fatInspector(),
  }), /符号链接悬空或无法解析: Contents[\\/]dangling/)
})

test('rejects an app bundle with no discovered Mach-O files', () => {
  const app = makeApp()
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: () => ({ kind: 'other' }),
  }), /没有发现 Mach-O 文件/)
})

test('requires exactly one .app path at the CLI boundary', () => {
  const messages = []
  assert.equal(main([], { stdout: (value) => messages.push(value), stderr: (value) => messages.push(value) }), 2)
  assert.match(messages[0], /用法:/)
})


test('checks App minimum OS and both slices of every required Mach-O', () => {
  const app = makeApp({ framework: true })
  const inspected = []
  const result = verifyMacosUniversalBundle({ bundlePath: app.root, fsApi: app.fsApi,
    inspectFile: fatInspector(), minimumOs: '12.0', inspectBundleMinimumOs: () => '12.0.0',
    inspectDeployment: (file, architecture) => { inspected.push([file, architecture]); return architecture === 'arm64' ? '12.0' : '10.15' }
  })
  assert.equal(result.minimumOs, '12.0')
  assert.equal(inspected.length, 4)
  for (const file of [app.executable, app.frameworkBinary]) {
    assert.ok(inspected.some(([f, arch]) => f === file && arch === 'arm64'))
    assert.ok(inspected.some(([f, arch]) => f === file && arch === 'x86_64'))
  }
})

test('rejects deployment requirements above policy and App metadata mismatch', () => {
  const app = makeApp()
  const common = { bundlePath: app.root, fsApi: app.fsApi, inspectFile: fatInspector(), minimumOs: '12.0' }
  assert.throws(() => verifyMacosUniversalBundle({ ...common, inspectBundleMinimumOs: () => '12.0', inspectDeployment: () => '13.0' }), /Mach-O/)
  assert.throws(() => verifyMacosUniversalBundle({ ...common, inspectBundleMinimumOs: () => '13.0', inspectDeployment: () => '12.0' }), /App/)
  assert.throws(() => verifyMacosUniversalBundle({ ...common, minimumOs: 'unknown' }), /OS/)
})

test('rejects a complete Mac NativeHost group because pre-initializer same-object proof is unavailable', () => {
  const app = makeApp()
  const resources = path.join(app.root, 'Contents', 'Resources')
  const native = path.join(resources, 'native')
  const host = path.join(native, 'ZToolsMacNativeHost')
  const worker = path.join(native, 'ZToolsMacNativeWorker')
  const policy = path.join(native, 'ztools-mac-native-policy.json')
  app.addDirectory(resources)
  app.addDirectory(native)
  app.addFile(host)
  app.addFile(worker)
  app.addFile(policy, '{"schemaVersion":1}')
  const machoPaths = new Set([app.executable, host, worker])

  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile(filePath) {
      return machoPaths.has(filePath)
        ? { kind: 'macho', architectures: ['arm64', 'x86_64'] }
        : { kind: 'other' }
    }
  }), /MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE/)
})

test('accepts an explicitly disabled NativeHost mode for a pure JavaScript app', () => {
  const app = makeApp()
  const resources = path.join(app.root, 'Contents', 'Resources')
  app.addDirectory(resources)
  app.addFile(path.join(resources, 'ztools-bundle-versions.json'),
    JSON.stringify({ schemaVersion: 1, nativeHostMode: 'disabled' }))

  const result = verifyMacosUniversalBundle({
    bundlePath: app.root,
    fsApi: app.fsApi,
    inspectFile: fatInspector()
  })
  assert.equal(result.nativeHostMode, 'disabled')
  assert.equal(result.nativeHostAvailable, false)
})

test('rejects partial or declared-enabled Mac NativeHost groups as incomplete', () => {
  const partial = makeApp()
  const resources = path.join(partial.root, 'Contents', 'Resources')
  const native = path.join(resources, 'native')
  partial.addDirectory(resources)
  partial.addDirectory(native)
  partial.addFile(path.join(native, 'ZToolsMacNativeHost'))
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: partial.root,
    fsApi: partial.fsApi,
    inspectFile: fatInspector()
  }), /MAC_NATIVE_GROUP_INCOMPLETE_UNAVAILABLE/)

  const declared = makeApp()
  const declaredResources = path.join(declared.root, 'Contents', 'Resources')
  declared.addDirectory(declaredResources)
  declared.addFile(path.join(declaredResources, 'ztools-bundle-versions.json'),
    JSON.stringify({ schemaVersion: 1, nativeHostMode: 'enabled' }))
  assert.throws(() => verifyMacosUniversalBundle({
    bundlePath: declared.root,
    fsApi: declared.fsApi,
    inspectFile: fatInspector()
  }), /MAC_NATIVE_GROUP_INCOMPLETE_UNAVAILABLE/)
})
