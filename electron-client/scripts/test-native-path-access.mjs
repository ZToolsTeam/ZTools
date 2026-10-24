import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareOsVersions, inspectMacDeployment } from './macos-minimum-os.mjs'
import { assertPeMachine, PE_MACHINE_X86, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let reportPath, report
try {
  const { values } = parseArgs({ options: { help: { type: 'boolean' }, cmake: { type: 'string' },
    'minimum-os': { type: 'string' }, 'expect-process-arch': { type: 'string' }, 'expect-native-arch': { type: 'string' } } })
  if (values.help) console.log('npm run test:native:path-access -- --cmake <absolute executable> [Windows: --expect-native-arch x64|ia32 (default x64, ia32 is test-only)] [Darwin: --minimum-os <approved version> --expect-process-arch arm64|x64]')
  else {
    if (!['win32', 'darwin'].includes(process.platform)) throw new Error('PLATFORM_UNSUPPORTED')
    if (!values.cmake || !path.isAbsolute(values.cmake) || !fs.lstatSync(values.cmake).isFile() || fs.lstatSync(values.cmake).isSymbolicLink()) throw new Error('CMAKE_REQUIRED')
    if (process.platform === 'darwin') {
      if (values['expect-native-arch']) throw new Error('WINDOWS_PARAMETERS_ON_MAC')
      compareOsVersions(values['minimum-os'], values['minimum-os'])
      if (!['arm64', 'x64'].includes(values['expect-process-arch'])) throw new Error('MAC_ARCH_REQUIRED')
    } else if (values['minimum-os'] || values['expect-process-arch']) throw new Error('MAC_PARAMETERS_ON_WINDOWS')
    const nativeArch = process.platform === 'win32' ? values['expect-native-arch'] ?? 'x64' : 'universal'
    if (process.platform === 'win32' && !['x64', 'ia32'].includes(nativeArch)) throw new Error('WINDOWS_NATIVE_ARCH_INVALID')
    const runId = randomUUID(), output = path.join(root, 'out-test', 'path-access', runId), bin = path.join(output, 'bin')
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output)
    const temporary = path.join(output, 'temporary'); fs.mkdirSync(temporary)
    reportPath = path.join(output, 'report.json')
    report = { schemaVersion: 1, phase: 1, runId, platform: process.platform, arch: process.arch, nativeArch, osRelease: os.release(),
      scope: 'native-pinned-file-operations-and-broker-contract', status: 'FAIL', output,
      pending: ['production journal bootstrap/recovery UI/scratch-name disposition', 'recursive directory operations', 'SDK/protocol/NetworkService production consumer migration', 'Mac real OS/APFS acceptance'] }
    let stage = 0
    const run = (exe, args) => {
      const result = spawnSync(exe, args, { cwd: root, env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
        encoding: 'utf8', shell: false, windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 })
      fs.writeFileSync(path.join(output, `${++stage}-stage.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'wx' })
      if (result.error || result.status !== 0) throw new Error('NATIVE_STAGE_FAILED')
      return result.stdout
    }
    run(values.cmake, ['-S', path.join(root, 'native', 'ZToolsPathAccess'), '-B', path.join(output, 'build'),
      `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${bin}`, `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${bin}`,
      ...(process.platform === 'win32' ? ['-G', 'Visual Studio 17 2022', '-A', nativeArch === 'ia32' ? 'Win32' : 'x64']
        : ['-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64', `-DCMAKE_OSX_DEPLOYMENT_TARGET=${values['minimum-os']}`])])
    run(values.cmake, ['--build', path.join(output, 'build'), '--config', 'Release'])
    const suffix = process.platform === 'win32' ? '.exe' : '', executable = path.join(bin, `ZToolsPathAccessTest${suffix}`), broker = path.join(bin, `ZToolsPathAccessBroker${suffix}`), namesExecutable = path.join(bin, `ZToolsPathAccessNamesTest${suffix}`)
    if (process.platform === 'win32') for (const file of [executable, broker, namesExecutable]) assertPeMachine(file, nativeArch === 'ia32' ? PE_MACHINE_X86 : PE_MACHINE_X64)
    if (process.platform === 'darwin') {
      for (const file of [executable, broker, namesExecutable]) {
        const arches = run('/usr/bin/lipo', ['-archs', file]).trim().split(/\s+/).sort()
        if (JSON.stringify(arches) !== JSON.stringify(['arm64', 'x86_64'])) throw new Error('UNIVERSAL_REQUIRED')
        for (const arch of arches) if (compareOsVersions(inspectMacDeployment(file, arch), values['minimum-os']) > 0) throw new Error('MINIMUM_OS_MISMATCH')
      }
    }
    const selectedArch = values['expect-process-arch'] === 'x64' ? '-x86_64' : '-arm64'
    const native = JSON.parse(process.platform === 'darwin'
      ? run('/usr/bin/arch', [selectedArch, executable, path.join(output, 'core-fixture')])
      : run(executable, [path.join(output, 'core-fixture')]))
    const nativeNames = JSON.parse(process.platform === 'darwin'
      ? run('/usr/bin/arch', [selectedArch, namesExecutable, path.join(output, 'names-fixture')])
      : run(namesExecutable, [path.join(output, 'names-fixture')]))
    if (nativeNames.status !== 'PASS' || nativeNames.scope !== 'native-pinned-name-contract' || nativeNames.tests !== 26 + (nativeNames.caseSensitive ? 0 : 2) + (nativeNames.unicodeNormalizationAlias ? 2 : 0) ||
        typeof nativeNames.caseSensitive !== 'boolean' || typeof nativeNames.unicodeNormalizationAlias !== 'boolean') throw new Error('INVALID_NATIVE_NAMES_RESULT')
    report.nativeNames = nativeNames
    const aliasStates = ['PRESENT_AND_DENIED', 'NOT_PRESENT']
    const aliasCount = [native.shortNameAlias, native.unicodeCaseAlias].filter(state => state === 'PRESENT_AND_DENIED').length
    if (native.status !== 'PASS' || native.scope !== 'native-pinned-path-contract' ||
        !aliasStates.includes(native.shortNameAlias) || !aliasStates.includes(native.unicodeCaseAlias) ||
        native.aliasChecks !== aliasCount * 8 || native.tests !== (process.platform === 'darwin' ? 199 : 197) + native.aliasChecks) throw new Error('INVALID_NATIVE_RESULT')
    report.binaries = [executable, broker, namesExecutable].map(file => ({ file: path.basename(file), sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }))
    const tsc = path.join(root, 'node_modules/typescript/bin/tsc')
    const compiled = path.join(output, 'compiled')
    run(process.execPath, [tsc, '-p', 'tsconfig.test.json', '--outDir', compiled])
    report.bridgeModules = ['src/contracts/path-find.js', 'src/main/services/reference-name-matcher.js', 'src/contracts/errors.js', 'src/contracts/path-reference.js', 'src/contracts/path-dialog.js', 'src/contracts/reference-transport.js', 'src/preload/reference-transport.js', 'src/main/ipc/reference-endpoint.js', 'src/main/ipc/reference-file-handlers.js', 'src/main/ipc/reference-producer-handlers.js', 'src/contracts/path-transfer.js', 'src/main/ipc/reference-network-handlers.js', 'src/main/ipc/reference-recovery-handlers.js', 'src/main/platform/reference-cache-roots.js', 'src/main/platform/reference-file-runtime.js', 'src/main/platform/native-path-access.js', 'src/main/platform/path-access-runtime.js', 'src/main/platform/owned-path-access.js', 'src/main/platform/path-write-journal.js', 'src/main/platform/path-write-journal-crypto.js', 'src/main/platform/path-write-journal-store.js', 'src/main/services/path-grant-service.js', 'src/main/services/path-reference-dialogs.js', 'src/main/services/reference-file-drop-service.js', 'src/main/services/reference-clipboard-files-service.js', 'src/main/services/event-service.js', 'src/main/services/reference-directory-locations.js', 'src/main/services/reference-cache-service.js', 'src/contracts/path-clipboard.js', 'src/main/services/clipboard-service.js', 'src/main/services/screen-service.js', 'src/main/services/reference-request-tracker.js', 'src/main/services/path-write-recovery-service.js', 'src/main/services/anchored-file-system-service.js', 'src/main/services/anchored-download.js', 'src/main/services/network-service.js', 'src/main/protocol/reference-file-resources.js', 'src/main/protocol/anchored-file-capability.js'].map(file => ({
      file, sha256: createHash('sha256').update(fs.readFileSync(path.join(compiled, file))).digest('hex') }))
    const { NativePathAccessAdapter } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/native-path-access.js')).href)
    const { PathGrantService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/path-grant-service.js')).href)
    const { AnchoredFileSystemService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/anchored-file-system-service.js')).href)
    const { anchoredFileCapabilityResponse } = await import(pathToFileURL(path.join(compiled, 'src/main/protocol/anchored-file-capability.js')).href)
    const { createOwnedPathAccessProvider } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/owned-path-access.js')).href)
    const { persistAnchoredDownload } = await import(pathToFileURL(path.join(compiled, 'src/main/services/anchored-download.js')).href)
    const { NetworkService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/network-service.js')).href)
    const { PathWriteJournal } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/path-write-journal.js')).href)
    const { createReferenceRecoveryHandlers } = await import(pathToFileURL(path.join(compiled, 'src/main/ipc/reference-recovery-handlers.js')).href)
    const { PathWriteRecoveryService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/path-write-recovery-service.js')).href)
    const { createReferenceFileRuntime } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/reference-file-runtime.js')).href)
    const { createPathAccessRuntime } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/path-access-runtime.js')).href)
    const { PathReferenceDialogs } = await import(pathToFileURL(path.join(compiled, 'src/main/services/path-reference-dialogs.js')).href)
    const { ReferenceFileDropService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/reference-file-drop-service.js')).href)
    const { ReferenceClipboardFilesService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/reference-clipboard-files-service.js')).href)
    const { EventService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/event-service.js')).href)
    const { ReferenceDirectoryLocations } = await import(pathToFileURL(path.join(compiled, 'src/main/services/reference-directory-locations.js')).href)
    const { ReferenceCacheService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/reference-cache-service.js')).href)
    const { ClipboardService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/clipboard-service.js')).href)
    const { ScreenService } = await import(pathToFileURL(path.join(compiled, 'src/main/services/screen-service.js')).href)
    const { ReferenceRequestTracker } = await import(pathToFileURL(path.join(compiled, 'src/main/services/reference-request-tracker.js')).href)
    const { createReferenceTransportBridge } = await import(pathToFileURL(path.join(compiled, 'src/preload/reference-transport.js')).href)
    const { ReferenceIpcEndpoint } = await import(pathToFileURL(path.join(compiled, 'src/main/ipc/reference-endpoint.js')).href)
    const { createReferenceFileHandlers } = await import(pathToFileURL(path.join(compiled, 'src/main/ipc/reference-file-handlers.js')).href)
    const { ReferenceCacheRoots } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/reference-cache-roots.js')).href)
    const { createReferenceProducerHandlers } = await import(pathToFileURL(path.join(compiled, 'src/main/ipc/reference-producer-handlers.js')).href)
    const { createReferenceNetworkHandlers } = await import(pathToFileURL(path.join(compiled, 'src/main/ipc/reference-network-handlers.js')).href)

    const { AnchoredJournalStore } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/path-write-journal-store.js')).href)
    const { createJournalSealer } = await import(pathToFileURL(path.join(compiled, 'src/main/platform/path-write-journal-crypto.js')).href)
    const fixture = path.join(output, 'broker-fixture'); fs.mkdirSync(fixture)
    const source = path.join(fixture, '空 格.txt'); fs.writeFileSync(source, 'synthetic broker input', { flag: 'wx' })
    const adapter = new NativePathAccessAdapter(broker), grants = new PathGrantService(adapter)
    let checks = 0
    const denied = async (action, expectedCode) => { let rejected = false; try { await action() } catch (error) {
      if (expectedCode && error.code !== expectedCode) throw new Error('DENIAL_CODE_MISMATCH')
      rejected = true
    }; if (!rejected) throw new Error('EXPECTED_DENIAL'); checks++ }
    try {
      const grant = await grants.create(42, source, 'file', ['read'])
      if ((await grants.read(42, grant.grantId)).toString() !== 'synthetic broker input') throw new Error('BROKER_READ_MISMATCH')
      checks++
      const fileFacade = new AnchoredFileSystemService(grants), caller = { type: 'main', webContentsId: 42 }
      if ((await fileFacade.readFile({ grantId: grant.grantId }, caller)).content !== 'synthetic broker input') throw new Error('REFERENCE_FACADE_READ_MISMATCH')
      checks++
      await denied(() => fileFacade.readFile({ path: source }, caller), 'INVALID_REQUEST')
      await denied(() => fileFacade.readFile({ grantId: grant.grantId }, { type: 'main', webContentsId: 99 }), 'PERMISSION_DENIED')
      const facadeRange = await fileFacade.readFileRange({ grantId: grant.grantId, offset: 10, length: 6 }, caller)
      if (facadeRange.encoding !== 'base64' || facadeRange.offset !== 10 || facadeRange.size !== 6 || Buffer.from(facadeRange.content, 'base64').toString() !== 'broker') throw new Error('REFERENCE_FACADE_RANGE_MISMATCH')
      checks++
      if ((await fileFacade.readFileRange({ grantId: grant.grantId, offset: 1000, length: 4 }, caller)).size !== 0) throw new Error('REFERENCE_FACADE_RANGE_EOF_MISMATCH')
      checks++
      await denied(() => fileFacade.readFileRange({ grantId: grant.grantId, offset: 0, length: 1 }, { type: 'plugin', webContentsId: 99 }), 'PERMISSION_DENIED')
      await denied(() => fileFacade.readFileRange({ grantId: grant.grantId, offset: Number.MAX_SAFE_INTEGER, length: 1 }, caller), 'INVALID_REQUEST')
      const facadeOutput = path.join(fixture, 'reference-facade.txt'), facadeGrant = await grants.create(42, facadeOutput, 'save', ['write'])
      await fileFacade.writeFile({ saveGrantId: facadeGrant.grantId, content: 'reference facade' }, caller)
      if (fs.readFileSync(facadeOutput, 'utf8') !== 'reference facade') throw new Error('REFERENCE_FACADE_SAVE_MISMATCH')
      checks++
      await denied(() => fileFacade.writeFile({ saveGrantId: facadeGrant.grantId, content: 'forbidden default overwrite' }, caller), 'FILE_ALREADY_EXISTS')
      await denied(() => fileFacade.writeFile({ saveGrantId: facadeGrant.grantId, content: 'invalid=', encoding: 'base64', replace: true }, caller), 'INVALID_REQUEST')
      const metadata = await grants.describe(42, grant.grantId)
      if (metadata.isDirectory || metadata.size !== Buffer.byteLength('synthetic broker input') || metadata.lastModifiedMs <= 0) throw new Error('BROKER_METADATA_MISMATCH')
      checks++
      if ((await grants.readRange(42, grant.grantId, '', 10, 6)).toString() !== 'broker') throw new Error('BROKER_RANGE_MISMATCH')
      checks++
      if ((await grants.readRange(42, grant.grantId, '', 1000, 4)).length !== 0) throw new Error('BROKER_RANGE_EOF_MISMATCH')
      checks++
      await denied(() => grants.readRange(99, grant.grantId, '', 0, 1))
      await denied(() => grants.readRange(42, grant.grantId, '', Number.MAX_SAFE_INTEGER, 1))
      await denied(() => grants.read(99, grant.grantId))
      await denied(() => grants.read(42, grant.grantId, '', 1))
      if ((await grants.read(42, grant.grantId)).toString() !== 'synthetic broker input') throw new Error('BROKER_ERROR_RECOVERY_FAILED')
      checks++
      fs.renameSync(source, path.join(fixture, 'old.txt')); fs.writeFileSync(source, 'replacement', { flag: 'wx' })
      await denied(() => grants.read(42, grant.grantId))
      await denied(() => grants.readRange(42, grant.grantId, '', 0, 1))
      await denied(() => grants.describe(42, grant.grantId))
      await grants.revoke(42, grant.grantId)
      await denied(() => grants.read(42, grant.grantId))
      await denied(() => adapter.release({ handle: 'foreign:1', kind: 'file', displayName: 'foreign' }))
      await denied(() => grants.create(42, source, 'save', ['read']))
      const destination = path.join(fixture, 'saved.txt'), save = await grants.create(42, destination, 'save', ['write'])
      const committed = await grants.save(42, save.grantId, Buffer.from('saved fixture'))
      if (committed.status !== 'committed' || fs.readFileSync(destination, 'utf8') !== 'saved fixture') throw new Error('SAVE_COMMIT_MISMATCH')
      checks++
      await denied(() => grants.save(99, save.grantId, Buffer.from('forbidden')))
      await denied(() => grants.read(42, save.grantId))
      await denied(() => grants.save(42, save.grantId, Buffer.from('not-replaced')), 'FILE_ALREADY_EXISTS')
      if (fs.readFileSync(destination, 'utf8') !== 'saved fixture') throw new Error('SAVE_EXCLUSIVE_MISMATCH')
      checks++
      await grants.save(42, save.grantId, Buffer.from('replaced'), true)
      if (fs.readFileSync(destination, 'utf8') !== 'replaced') throw new Error('SAVE_REPLACE_MISMATCH')
      checks++
      const binary = Buffer.alloc(65537); for (let index = 0; index < binary.length; index++) binary[index] = index % 251
      await grants.save(42, save.grantId, binary, true)
      if (!fs.readFileSync(destination).equals(binary)) throw new Error('SAVE_BINARY_FRAME_MISMATCH')
      checks++
      async function* binaryStream() { yield binary.subarray(0, 123); yield binary.subarray(123) }
      await grants.streamSave(42, save.grantId, binary.length, binaryStream(), true)
      if (!fs.readFileSync(destination).equals(binary)) throw new Error('STREAM_BINARY_MISMATCH')
      checks++
      async function* shortStream() { yield Buffer.from('short') }
      await denied(() => grants.streamSave(42, save.grantId, 6, shortStream(), true))
      if (!fs.readFileSync(destination).equals(binary)) throw new Error('STREAM_ABORT_PRESERVATION_MISMATCH')
      checks++
      const folder = await grants.create(42, fixture, 'directory', ['list'])
      const entries = await grants.list(42, folder.grantId)
      if (!entries.some(entry => entry.name === '空 格.txt' && entry.size === 11 && !entry.isDirectory) || entries.some(entry => path.isAbsolute(entry.name))) throw new Error('DIRECTORY_METADATA_MISMATCH')
      checks++
      await denied(() => grants.read(42, folder.grantId, '空 格.txt'))
      await denied(() => grants.list(42, folder.grantId, '../outside'))
      await denied(() => grants.deriveSave(42, folder.grantId, 'denied.txt'))
      const writable = await grants.create(42, fixture, 'directory', ['write'])
      const derived = await grants.deriveSave(42, writable.grantId, 'derived.txt')
      await grants.save(42, derived.grantId, Buffer.from('derived output'))
      if (fs.readFileSync(path.join(fixture, 'derived.txt'), 'utf8') !== 'derived output') throw new Error('DERIVED_SAVE_MISMATCH')
      checks++
      await grants.revoke(42, writable.grantId)
      await denied(() => grants.save(42, derived.grantId, Buffer.from('revoked')))
      const readable = await grants.create(42, fixture, 'directory', ['read'])
      const childRead = await grants.deriveRead(42, readable.grantId, 'derived.txt')
      if ((await grants.read(42, childRead.grantId)).toString() !== 'derived output' || (await grants.describe(42, childRead.grantId)).size !== 14) throw new Error('DERIVED_READ_MISMATCH')
      checks++
      await denied(() => grants.save(42, childRead.grantId, Buffer.from('forbidden')))
      const copied = await grants.copy(42, childRead.grantId, save.grantId, true)
      if (copied.bytesWritten !== 14 || fs.readFileSync(destination, 'utf8') !== 'derived output') throw new Error('NATIVE_COPY_MISMATCH')
      checks++
      await denied(() => grants.copy(99, childRead.grantId, save.grantId, true))
      await denied(() => grants.copy(42, save.grantId, childRead.grantId))
      await denied(() => grants.copy(42, childRead.grantId, save.grantId), 'FILE_ALREADY_EXISTS')
      if (fs.readFileSync(destination, 'utf8') !== 'derived output' || fs.readFileSync(path.join(fixture, 'derived.txt'), 'utf8') !== 'derived output') throw new Error('COPY_PRESERVATION_MISMATCH')
      checks++
      const removable = await grants.create(42, fixture, 'directory', ['write'])
      await denied(() => grants.remove(99, removable.grantId, 'derived.txt'))
      await denied(() => grants.remove(42, readable.grantId, 'derived.txt'))
      await denied(() => grants.remove(42, childRead.grantId, 'derived.txt'))
      await denied(() => grants.remove(42, removable.grantId, ''))
      await denied(() => grants.remove(42, removable.grantId, '../outside'))
      await grants.remove(42, removable.grantId, 'derived.txt')
      if (fs.existsSync(path.join(fixture, 'derived.txt')) || fs.readFileSync(destination, 'utf8') !== 'derived output') throw new Error('REMOVE_SCOPE_MISMATCH')
      checks++
      fs.mkdirSync(path.join(fixture, 'empty-directory'))
      await grants.remove(42, removable.grantId, 'empty-directory', true)
      if (fs.existsSync(path.join(fixture, 'empty-directory'))) throw new Error('REMOVE_DIRECTORY_MISMATCH')
      checks++
      fs.writeFileSync(path.join(fixture, 'move-input.txt'), 'move input', { flag: 'wx' })
      const moveTarget = await grants.deriveSave(42, removable.grantId, 'move-output.txt')
      await denied(() => grants.move(99, removable.grantId, 'move-input.txt', moveTarget.grantId))
      await denied(() => grants.move(42, readable.grantId, 'move-input.txt', moveTarget.grantId))
      await denied(() => grants.move(42, removable.grantId, '../outside', moveTarget.grantId))
      await grants.move(42, removable.grantId, 'move-input.txt', moveTarget.grantId)
      if (fs.existsSync(path.join(fixture, 'move-input.txt')) || fs.readFileSync(path.join(fixture, 'move-output.txt'), 'utf8') !== 'move input') throw new Error('MOVE_COMMIT_MISMATCH')
      checks++
      fs.writeFileSync(path.join(fixture, 'move-input.txt'), 'move replacement', { flag: 'wx' })
      await denied(() => grants.move(42, removable.grantId, 'move-input.txt', moveTarget.grantId), 'FILE_ALREADY_EXISTS')
      await grants.move(42, removable.grantId, 'move-input.txt', moveTarget.grantId, true)
      if (fs.existsSync(path.join(fixture, 'move-input.txt')) || fs.readFileSync(path.join(fixture, 'move-output.txt'), 'utf8') !== 'move replacement') throw new Error('MOVE_REPLACE_MISMATCH')
      checks++
      await grants.revoke(42, readable.grantId)
      await denied(() => grants.describe(42, childRead.grantId))
      const made = await grants.createDirectory(42, removable.grantId, 'created-directory')
      if (made.status !== 'created' || !fs.statSync(path.join(fixture, 'created-directory')).isDirectory()) throw new Error('CREATE_DIRECTORY_MISMATCH')
      checks++
      if ((await grants.createDirectory(42, removable.grantId, 'created-directory')).status !== 'existing') throw new Error('EXISTING_DIRECTORY_MISMATCH')
      checks++
      const childDirectory = await fileFacade.deriveDirectory({ directoryGrantId: removable.grantId, relativePath: 'created-directory' }, caller)
      if (childDirectory.kind !== 'directory' || JSON.stringify(childDirectory.operations) !== JSON.stringify(['write'])) throw new Error('DERIVED_DIRECTORY_RIGHTS_MISMATCH')
      checks++
      await denied(() => fileFacade.getDirectoryContents({ directoryGrantId: childDirectory.grantId }, caller), 'PERMISSION_DENIED')
      const childOutput = await fileFacade.deriveSave({ directoryGrantId: childDirectory.grantId, relativePath: 'child-output.txt' }, caller)
      await fileFacade.writeFile({ saveGrantId: childOutput.grantId, content: 'directory reference output' }, caller)
      if (fs.readFileSync(path.join(fixture, 'created-directory/child-output.txt'), 'utf8') !== 'directory reference output') throw new Error('DERIVED_DIRECTORY_OUTPUT_MISMATCH')
      checks++
      await denied(() => grants.createDirectory(99, removable.grantId, 'new-directory'))
      await denied(() => grants.createDirectory(42, save.grantId, 'new-directory'))
      await denied(() => grants.createDirectory(42, removable.grantId, '../outside'))
      const nestedSave = await grants.deriveSave(42, removable.grantId, 'created-directory/output.txt')
      await grants.save(42, nestedSave.grantId, Buffer.from('new directory output'))
      if (fs.readFileSync(path.join(fixture, 'created-directory/output.txt'), 'utf8') !== 'new directory output') throw new Error('CREATED_DIRECTORY_SAVE_MISMATCH')
      checks++
      const media = await grants.create(42, destination, 'file', ['read'])
      const mediaUrl = grants.resourceUrl(42, media.grantId)
      if (!grants.canLoadResource(mediaUrl, 42) || grants.canLoadResource(mediaUrl, 99)) throw new Error('RESOURCE_OWNER_MISMATCH')
      checks++
      const response = await anchoredFileCapabilityResponse(new Request(mediaUrl, { headers: { range: 'bytes=0-6' } }), grants)
      if (response.status !== 206 || await response.text() !== 'derived') throw new Error('RESOURCE_RANGE_MISMATCH')
      checks++
      const resourceHead = await anchoredFileCapabilityResponse(new Request(mediaUrl, { method: 'HEAD' }), grants)
      if (resourceHead.status !== 200 || resourceHead.headers.get('content-length') !== '14' || await resourceHead.text() !== '') throw new Error('RESOURCE_HEAD_MISMATCH')
      checks++
      const invalidRange = await anchoredFileCapabilityResponse(new Request(mediaUrl, { headers: { range: 'bytes=999-' } }), grants)
      if (invalidRange.status !== 416) throw new Error('RESOURCE_RANGE_DENIAL_MISMATCH')
      checks++
      await grants.revoke(42, media.grantId)
      if ((await anchoredFileCapabilityResponse(new Request(mediaUrl), grants)).status !== 404) throw new Error('RESOURCE_REVOKE_MISMATCH')
      checks++
    } finally { await grants.stop(); await adapter.stop() }
    const provider = createOwnedPathAccessProvider(broker, process.platform), isolated = new PathGrantService(provider)
    try {
      const savedFile = path.join(fixture, 'saved.txt')
      const first = await isolated.create(42, savedFile, 'file', ['read']), second = await isolated.create(99, savedFile, 'file', ['read'])
      if ((await isolated.read(42, first.grantId)).toString() !== 'derived output') throw new Error('OWNER_FIRST_READ_MISMATCH')
      checks++
      await isolated.closeOwner(42)
      await denied(() => isolated.read(42, first.grantId))
      if ((await isolated.read(99, second.grantId)).toString() !== 'derived output') throw new Error('OWNER_ISOLATION_MISMATCH')
      checks++
    } finally { await isolated.stop() }
    const downloadAdapter = new NativePathAccessAdapter(broker), downloads = new PathGrantService(downloadAdapter)
    const httpData = Buffer.alloc(65537, 31)
    const server = createServer((request, response) => {
      if (request.url === '/upload' && request.method === 'POST') {
        const chunks = []; let size = 0
        request.on('data', chunk => { size += chunk.length; if (size > 16384) { request.destroy(); return }; chunks.push(chunk) })
        request.on('end', () => {
          const valid = Buffer.concat(chunks).includes(Buffer.from('chunked download'))
          response.statusCode = valid ? 200 : 400; response.end(valid ? 'uploaded fixture' : 'invalid fixture')
        })
      }
      else if (request.url === '/known') { response.setHeader('content-length', httpData.length); response.end(httpData) }
      else if (request.url === '/chunked') { response.write('chunked '); response.end('download') }
      else { response.statusCode = 404; response.end('fixture missing') }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address(), base = `http://127.0.0.1:${address.port}`
      const callerSession = { fetch: (url, init) => fetch(url, init) }
      const network = new NetworkService({}, { sessionResolver: () => callerSession, pathGrants: downloads })
      const networkCaller = { type: 'main', webContentsId: 42 }
      const downloadPath = path.join(fixture, 'http-download.bin'), outputGrant = await downloads.create(42, downloadPath, 'save', ['write'])
      for (const endpoint of ['known', 'chunked']) {
        const controller = new AbortController()
        const result = await network.downloadRef({ url: `${base}/${endpoint}`, saveGrantId: outputGrant.grantId, replace: endpoint !== 'known' }, networkCaller, controller.signal)
        const expected = endpoint === 'known' ? httpData : Buffer.from('chunked download')
        if (result.size !== expected.length || result.grantId !== outputGrant.grantId || !fs.readFileSync(downloadPath).equals(expected)) throw new Error('HTTP_NATIVE_DOWNLOAD_MISMATCH')
        checks++
      }
      const response = await fetch(`${base}/missing`)
      await denied(() => persistAnchoredDownload({ response, owner: 42, saveGrantId: outputGrant.grantId, grants: downloads, signal: new AbortController().signal, replace: true }), 'NETWORK_ERROR')
      if (fs.readFileSync(downloadPath, 'utf8') !== 'chunked download') throw new Error('HTTP_FAILURE_PRESERVATION_MISMATCH')
      checks++
      const uploadGrant = await downloads.create(42, downloadPath, 'file', ['read'])
      const uploaded = await network.uploadRef({ url: `${base}/upload`, fileGrantId: uploadGrant.grantId }, networkCaller, new AbortController().signal)
      if (uploaded.data.statusCode !== 200 || uploaded.data.body !== 'uploaded fixture') throw new Error('HTTP_NATIVE_UPLOAD_MISMATCH')
      checks++
      await denied(() => network.uploadRef({ url: `${base}/upload`, fileGrantId: uploadGrant.grantId }, { type: 'main', webContentsId: 99 }, new AbortController().signal), 'PERMISSION_DENIED')
    } finally {
      try { await downloads.stop() }
      finally {
        server.closeAllConnections()
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    }
    // Only synthetic key wrapping here. Actual DPAPI/Keychain remains a separate Electron/native gate.
    const journalRoot = path.join(fixture, 'private-journal'); fs.mkdirSync(journalRoot)
    const journalAdapter = new NativePathAccessAdapter(broker)
    let writingAdapter, recoveryAdapter
    try {
      const signal = new AbortController().signal
      const rootObject = await journalAdapter.pin(journalRoot, 'directory', ['read', 'write', 'list'], signal)
      const journalStore = new AnchoredJournalStore(journalAdapter, rootObject)
      const sealer = createJournalSealer({ isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async bytes => ({ result: bytes.toString() }) })
      const journal = new PathWriteJournal(journalStore, sealer)
      writingAdapter = new NativePathAccessAdapter(broker, 5000, { writeJournal: journal })
      const outputPath = path.join(fixture, 'journal-output.txt')
      const target = await writingAdapter.pin(outputPath, 'save', ['write'], signal)
      await writingAdapter.save(target, Buffer.from('journal output'), false, signal)
      if (fs.readFileSync(outputPath, 'utf8') !== 'journal output' || (await journal.pending()).length !== 0) throw new Error('JOURNAL_NATIVE_SAVE_MISMATCH')
      checks++
      const sourceObject = await writingAdapter.pin(outputPath, 'file', ['read'], signal)
      const copyPath = path.join(fixture, 'journal-copy.txt'), copyObject = await writingAdapter.pin(copyPath, 'save', ['write'], signal)
      await writingAdapter.copy(sourceObject, copyObject, false, signal)
      if (fs.readFileSync(copyPath, 'utf8') !== 'journal output' || (await journal.pending()).length !== 0) throw new Error('JOURNAL_NATIVE_COPY_MISMATCH')
      checks++
      async function* interruptedBytes() { yield Buffer.from('retained scratch'); await writingAdapter.stop(); throw new Error('synthetic owned broker exit') }
      await denied(() => writingAdapter.streamSave(target, undefined, interruptedBytes(), true, signal), 'FILE_ERROR')
      const reconstructed = new PathWriteJournal(journalStore, sealer), records = await reconstructed.pending()
      if (records.length !== 1 || !records[0].proof || records[0].phase !== 'unknown') throw new Error('JOURNAL_CRASH_EVIDENCE_MISMATCH')
      checks++
      recoveryAdapter = new NativePathAccessAdapter(broker)
      const recoveredTarget = await recoveryAdapter.pin(records[0].selectedPath, 'save', ['write'], signal)
      const observation = await recoveryAdapter.observeWrite(recoveredTarget, Buffer.from(records[0].proof, 'base64'), signal)
      if (observation.state !== 'staging' || observation.size !== Buffer.byteLength('retained scratch')) throw new Error('JOURNAL_RECOVERY_IDENTITY_MISMATCH')
      checks++
      await recoveryAdapter.release(recoveredTarget)
      const recovery = new PathWriteRecoveryService(reconstructed, recoveryAdapter), mainCaller = { type: 'main', webContentsId: 42 }
      const publicEntries = await recovery.list(mainCaller)
      if (publicEntries.length !== 1 || publicEntries[0].displayName !== 'journal-output.txt' || JSON.stringify(publicEntries).includes(fixture) || JSON.stringify(publicEntries).includes(records[0].proof)) throw new Error('RECOVERY_PRIVATE_METADATA_EXPOSED')
      checks++
      const inspected = await recovery.inspect(records[0].id, mainCaller)
      if (inspected.observation.state !== 'staging' || inspected.observation.size !== 16 || inspected.businessResult !== 'unconfirmed') throw new Error('RECOVERY_FACADE_OBSERVATION_MISMATCH')
      checks++
      const recoveryTarget = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://web/index.html' } }
      const recoveryPluginTarget = { id: 43, isDestroyed: () => false, mainFrame: { url: 'ztools://plugins/example/index.html' } }
      const recoveryEvent = { sender: recoveryTarget, senderFrame: recoveryTarget.mainFrame }
      const recoveryRequests = new ReferenceRequestTracker({ isActive: owner => owner === 42 || owner === 43, onRemoved: () => () => {} })
      try {
        const recoveryEndpoint = new ReferenceIpcEndpoint({
          get: owner => owner === 42 ? mainCaller : owner === 43 ? { type: 'plugin', webContentsId: 43, pluginId: 'example', pluginInstanceId: 'recovery-one' } : undefined,
          getWebContents: owner => owner === 42 ? recoveryTarget : owner === 43 ? recoveryPluginTarget : undefined,
          getSdkApiLane: () => 2
        }, recoveryRequests, createReferenceRecoveryHandlers(recovery), () => true)
        const recoveryBridge = createReferenceTransportBridge({ invoke: (channel, value) => {
          const cloned = JSON.parse(JSON.stringify(value))
          return channel === 'ztools:reference-cancel' ? recoveryEndpoint.cancel(recoveryEvent, cloned) : recoveryEndpoint.call(recoveryEvent, cloned)
        } }, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }, true)
        const recoverySdkRoot = path.join(root, '../frontend/public/js/cef-ipc/src')
        const recoverySourceFiles = ['core/transport.js', 'core/reference-transport.js', 'api/fs.js', 'api/fs-reference.js']
        const recoverySource = recoverySourceFiles.map(file => fs.readFileSync(path.join(recoverySdkRoot, file), 'utf8').replace(/^export .+$/mg, '')).join('\n')
        report.recoverySdkSources = recoverySourceFiles.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(recoverySdkRoot, file))).digest('hex') }))
        const constructors = vm.runInNewContext(recoverySource + '\n({ ReferenceTransport, ReferenceFileSystemAPI })', {
          window: { __ztoolsElectron: { contractVersion: 2, transport: recoveryBridge } },
          environment: { showEnvironmentWarning() {}, getInfo: () => ({}), isElectron: () => true }, MockProvider: class {},
          TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout, console
        })
        const transport = new constructors.ReferenceTransport(), recoverySdk = new constructors.ReferenceFileSystemAPI(transport)
        try {
          const entries = await recoverySdk.listWriteRecovery()
          if (entries.length !== 1 || entries[0].recoveryId !== records[0].id || !Object.isFrozen(entries) || JSON.stringify(entries).includes(fixture)) throw new Error('SDK_RECOVERY_METADATA_MISMATCH')
          checks++
          const inspectedSdk = await recoverySdk.inspectWriteRecovery(records[0].id)
          if (inspectedSdk.observation.state !== 'staging' || inspectedSdk.observation.size !== 16 || inspectedSdk.businessResult !== 'unconfirmed' || !Object.isFrozen(inspectedSdk.observation)) throw new Error('SDK_RECOVERY_NATIVE_OBSERVATION_MISMATCH')
          checks++
          const pluginResult = await recoveryEndpoint.call({ sender: recoveryPluginTarget, senderFrame: recoveryPluginTarget.mainFrame },
            { messageId: 'recovery-plugin', method: 'filesystem_list_write_recovery', params: {} })
          if (pluginResult.success || pluginResult.error.code !== 'PERMISSION_DENIED') throw new Error('SDK_RECOVERY_PLUGIN_ACCEPTED')
          checks++
        } finally { transport.destroy() }
      } finally { await recoveryRequests.stop() }
      await denied(() => recovery.inspect(records[0].id, { type: 'plugin', webContentsId: 42 }), 'PERMISSION_DENIED')
      if ((await reconstructed.pending()).length !== 1) throw new Error('RECOVERY_FACADE_ERASED_EVIDENCE')
      checks++
      if (fs.readFileSync(outputPath, 'utf8') !== 'journal output' || fs.readFileSync(copyPath, 'utf8') !== 'journal output') throw new Error('JOURNAL_RECOVERY_MUTATED_TARGET')
      checks++
      report.journal = { scope: 'synthetic-key-wrapping-and-native-store-crash-observation', retainedRecords: records.length,
        observation, automaticReplay: false, automaticScratchDeletion: false }
    } finally {
      const results = await Promise.allSettled([writingAdapter?.stop(), recoveryAdapter?.stop(), journalAdapter.stop()])
      if (results.some(result => result.status === 'rejected')) throw new Error('JOURNAL_OWNED_CLEANUP_UNCONFIRMED')
    }
    const runtimeData = path.join(fixture, 'runtime-data'); fs.mkdirSync(runtimeData)
    const runtime = await createPathAccessRuntime({ executable: broker, dataRoot: runtimeData, platform: process.platform,
      sealer: createJournalSealer({ isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async bytes => ({ result: bytes.toString() }) }) })
    try {
      const mainCaller = { type: 'main', webContentsId: 42 }
      const saveGrant = await runtime.grants.create(42, path.join(runtimeData, 'runtime-output.txt'), 'save', ['write'])
      const cancelled = new AbortController(); cancelled.abort()
      await denied(() => runtime.fileSystem.writeFile({ saveGrantId: saveGrant.grantId, content: 'cancelled write' }, mainCaller, cancelled.signal), 'PERMISSION_DENIED')
      if (fs.existsSync(path.join(runtimeData, 'runtime-output.txt')) || (await runtime.recovery.list(mainCaller)).length !== 0) throw new Error('CANCELLED_RUNTIME_WRITE_CREATED_OUTPUT')
      checks++
      await runtime.fileSystem.writeFile({ saveGrantId: saveGrant.grantId, content: 'composed runtime' }, mainCaller)
      const readGrant = await runtime.grants.create(42, path.join(runtimeData, 'runtime-output.txt'), 'file', ['read'])
      await denied(() => runtime.fileSystem.readFileRange({ grantId: readGrant.grantId, offset: 0, length: 1 }, mainCaller, cancelled.signal), 'PERMISSION_DENIED')
      if ((await runtime.fileSystem.readFile({ grantId: readGrant.grantId }, mainCaller)).content !== 'composed runtime') throw new Error('COMPOSED_RUNTIME_NATIVE_READ_MISMATCH')
      checks++
      if ((await runtime.recovery.list(mainCaller)).length !== 0 || !fs.existsSync(path.join(runtimeData, 'FileWriteJournal/file-write-journal.bin'))) throw new Error('COMPOSED_RUNTIME_JOURNAL_MISSING')
      checks++
      // Chooser results and registry are injected; object pinning, metadata, I/O and cleanup are real native.
      const selectedOutput = path.join(runtimeData, 'runtime-output.txt'), dialogOutput = path.join(runtimeData, 'dialog-output.txt')
      const dialogs = new PathReferenceDialogs({ select: async mode => ({ canceled: false, selections: [{
        absolutePath: mode === 'open' ? selectedOutput : mode === 'save' ? dialogOutput : runtimeData,
        kind: mode === 'open' ? 'file' : mode === 'save' ? 'save' : 'directory'
      }] }) }, runtime.grants)
      const opened = await dialogs.show('open', {}, mainCaller)
      if (JSON.stringify(opened).includes(runtimeData) || (await runtime.fileSystem.readFile({ grantId: opened.references[0].grantId }, mainCaller)).content !== 'composed runtime') throw new Error('NATIVE_DIALOG_REFERENCE_READ_MISMATCH')
      checks++
      const saving = await dialogs.show('save', { defaultName: 'dialog-output.txt' }, mainCaller)
      await runtime.fileSystem.writeFile({ saveGrantId: saving.references[0].grantId, content: 'native dialog save' }, mainCaller)
      if (saving.references[0].fileUrl || fs.readFileSync(dialogOutput, 'utf8') !== 'native dialog save') throw new Error('NATIVE_DIALOG_REFERENCE_SAVE_MISMATCH')
      checks++
      const folder = await dialogs.show('folder', {}, mainCaller)
      await denied(() => runtime.fileSystem.createDirectory({ directoryGrantId: folder.references[0].grantId, relativePath: 'forbidden' }, mainCaller), 'PERMISSION_DENIED')
      const noSelection = await dialogs.show('open', {}, mainCaller, cancelled.signal)
      if (!noSelection.canceled || noSelection.references.length) throw new Error('CANCELLED_NATIVE_DIALOG_GRANTED_REFERENCE')
      checks++
      const pluginCaller = { type: 'plugin', webContentsId: 42, pluginId: 'synthetic-native-drop', pluginInstanceId: 'one' }
      let dropEnvelope
      const drops = new ReferenceFileDropService({ get: owner => owner === 42 ? pluginCaller : undefined,
        send: (_, __, value) => { dropEnvelope = value.msgData.envelope; return true } }, runtime.grants)
      const dropped = await drops.accept(42, [selectedOutput])
      if (dropped.accepted !== 1 || dropEnvelope.payload.contractVersion !== 2 || JSON.stringify(dropEnvelope).includes(runtimeData)) throw new Error('NATIVE_DROP_REFERENCE_PROJECTION_MISMATCH')
      checks++
      if ((await runtime.fileSystem.readFile({ grantId: dropEnvelope.payload.files[0].grantId }, pluginCaller)).content !== 'composed runtime') throw new Error('NATIVE_DROP_REFERENCE_READ_MISMATCH')
      checks++
      await denied(() => drops.accept(99, [selectedOutput]), 'PERMISSION_DENIED')
      // OS clipboard is injected; opcode 21 classifies the retained native object without a path reopen.
      const referenceClipboard = new ReferenceClipboardFilesService({ readFiles: async () => [selectedOutput, runtimeData, selectedOutput] }, runtime.grants)
      const clipboardResult = await referenceClipboard.read(mainCaller, new AbortController().signal)
      if (clipboardResult.files.length !== 2 || clipboardResult.errors.length || JSON.stringify(clipboardResult).includes(runtimeData)) throw new Error('NATIVE_CLIPBOARD_REFERENCE_PROJECTION_MISMATCH')
      checks++
      const clipboardFile = clipboardResult.files.find(item => item.kind === 'file')
      const clipboardDirectory = clipboardResult.files.find(item => item.kind === 'directory')
      if (!clipboardFile?.fileUrl || clipboardDirectory?.fileUrl || (await runtime.fileSystem.readFile({ grantId: clipboardFile.grantId }, mainCaller)).content !== 'composed runtime') throw new Error('NATIVE_CLIPBOARD_REFERENCE_READ_MISMATCH')
      checks++
      await runtime.fileSystem.getDirectoryContents({ directoryGrantId: clipboardDirectory.grantId }, mainCaller)
      await denied(() => runtime.fileSystem.createDirectory({ directoryGrantId: clipboardDirectory.grantId, relativePath: 'clipboard-forbidden' }, mainCaller), 'PERMISSION_DENIED')
      checks++
      const locations = new ReferenceDirectoryLocations(runtime.grants, { isActive: owner => owner === 42, onRemoved: () => () => {} })
      try {
        await locations.setCurrentDirectory(clipboardDirectory.grantId, mainCaller)
        if (locations.getCurrentDirectory(mainCaller).reference.grantId !== clipboardDirectory.grantId || JSON.stringify(locations.getCurrentDirectory(mainCaller)).includes(runtimeData)) throw new Error('NATIVE_CWD_REFERENCE_MISMATCH')
        checks++
        await denied(() => locations.setCurrentDirectory(clipboardFile.grantId, mainCaller), 'PERMISSION_DENIED')
        await runtime.grants.revoke(42, clipboardDirectory.grantId)
        await denied(() => locations.getCurrentDirectory(mainCaller), 'PERMISSION_DENIED')
        if (locations.getCurrentDirectory(mainCaller).reference !== null) throw new Error('REVOKED_CWD_REFERENCE_RETAINED')
        checks++
      } finally { locations.stop() }
      const cacheParent = await runtime.grants.create(42, runtimeData, 'directory', ['read', 'write', 'list'])
      await runtime.grants.createDirectory(42, cacheParent.grantId, 'Cache')
      const cacheRoot = await runtime.grants.deriveDirectory(42, cacheParent.grantId, 'Cache')
      const cache = new ReferenceCacheService(runtime.grants, async () => cacheRoot)
      const cached = await cache.writeCache({ name: 'nested/output.txt', content: 'native cache' }, mainCaller)
      if (JSON.stringify(cached).includes(runtimeData) || (await runtime.fileSystem.readFile({ grantId: cached.reference.grantId }, mainCaller)).content !== 'native cache') throw new Error('NATIVE_CACHE_REFERENCE_MISMATCH')
      checks++
      if ((await cache.readCache({ name: 'nested/output.txt' }, mainCaller)).content !== 'native cache') throw new Error('NATIVE_CACHE_RELATIVE_READ_MISMATCH')
      checks++
      await denied(() => cache.writeCache({ name: '../outside', content: '' }, mainCaller), 'INVALID_REQUEST')
      await denied(() => cache.readCache({ name: 'nested/output.txt' }, { type: 'main', webContentsId: 99 }), 'PERMISSION_DENIED')
      await denied(() => cache.writeCache({ name: 'nested/output.txt', content: 'must not replace' }, mainCaller), 'FILE_ALREADY_EXISTS')
      const generated = await cache.writeGeneratedCacheFile(Buffer.from('synthetic image bytes'), mainCaller, 'png')
      if (!generated.fileUrl || (await runtime.fileSystem.readFile({ grantId: generated.reference.grantId }, mainCaller)).content !== 'synthetic image bytes') throw new Error('NATIVE_GENERATED_CACHE_REFERENCE_MISMATCH')
      checks++
      // Only data acquisition is injected; maintained consumers persist/read via the real native cache.
      let clipboardText = ''
      const contentEvents = new EventService({ send: () => true, onRemoved: () => () => {} })
      const clipboardContent = new ClipboardService({}, contentEvents, {
        availableFormats: () => ['image/png'], clear() {}, has: () => false,
        readText: () => clipboardText, writeText: value => { clipboardText = value }, writeImage() {},
        readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.alloc(600 * 1024, 7) })
      }, {}, { readFiles: async () => [], writeFiles: async () => {} }, 750, undefined, { cache, grants: runtime.grants })
      try {
        await clipboardContent.copyTextReference({ fileGrantId: cached.reference.grantId }, mainCaller, new AbortController().signal)
        if (clipboardText !== 'native cache') throw new Error('NATIVE_CLIPBOARD_TEXT_REFERENCE_MISMATCH')
        checks++
        await denied(() => clipboardContent.copyTextReference({ fileGrantId: cached.reference.grantId }, { type: 'main', webContentsId: 99 }, new AbortController().signal), 'PERMISSION_DENIED')
        const image = await clipboardContent.readImageReference(mainCaller, new AbortController().signal)
        const imageHead = await runtime.fileSystem.readFileRange({ grantId: image.reference.grantId, offset: 0, length: 4 }, mainCaller)
        if (!image.useReference || image.size !== 600 * 1024 || imageHead.content !== Buffer.alloc(4, 7).toString('base64') || JSON.stringify(image).includes(runtimeData)) throw new Error('NATIVE_CLIPBOARD_IMAGE_REFERENCE_MISMATCH')
        checks++
      } finally { clipboardContent.stop(); contentEvents.stop() }
      const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64')
      const screenDisplay = { id: 1, label: 'synthetic', bounds: { x: 0, y: 0, width: 1, height: 1 }, workArea: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1, rotation: 0, touchSupport: 'unknown' }
      const screenImage = { getSize: () => ({ width: 1, height: 1 }), resize() { return this }, toBitmap: () => Buffer.from([0, 0, 0, 255]), toPNG: () => pngFixture }
      const screenContent = new ScreenService({}, {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }), getPrimaryDisplay: () => screenDisplay, getAllDisplays: () => [screenDisplay],
        getDisplayNearestPoint: () => screenDisplay, getDisplayMatching: () => screenDisplay,
        getSources: async () => [{ displayId: '1', image: screenImage }], createFromBitmap: () => screenImage,
        getScreenCapturePermissionStatus: () => 'granted'
      }, undefined, cache)
      const captured = await screenContent.captureReference({}, mainCaller, new AbortController().signal)
      const captureBytes = await runtime.fileSystem.readFile({ grantId: captured.reference.grantId, encoding: 'base64' }, mainCaller)
      if (captureBytes.content !== pngFixture.toString('base64') || captured.width !== 1 || captured.height !== 1 || JSON.stringify(captured).includes(runtimeData)) throw new Error('NATIVE_SCREEN_REFERENCE_MISMATCH')
      checks++
      const requests = new ReferenceRequestTracker({ isActive: owner => owner === 42, onRemoved: () => () => {} })
      try {
        requests.cancel(42, 'filesystem_read_file', 'cancel-before-register')
        let dispatched = false
        await denied(() => requests.execute(42, 'filesystem_read_file', 'cancel-before-register', async () => { dispatched = true }), 'CALLER_DESTROYED')
        if (dispatched) throw new Error('PRE_CANCELLED_NATIVE_REQUEST_DISPATCHED')
        checks++
        const trackedSave = await runtime.grants.deriveSave(42, cacheRoot.grantId, 'tracker-output.txt')
        await denied(() => requests.execute(42, 'filesystem_write_file', 'late-receipt', async signal => {
          const receipt = await runtime.fileSystem.writeFile({ saveGrantId: trackedSave.grantId, content: 'committed before delivery' }, mainCaller, signal)
          requests.cancel(42, 'filesystem_write_file', 'late-receipt')
          return receipt
        }), 'FILE_WRITE_OUTCOME_UNKNOWN')
        if (fs.readFileSync(path.join(runtimeData, 'Cache/tracker-output.txt'), 'utf8') !== 'committed before delivery') throw new Error('CANCELLED_COMMIT_FALSE_ROLLBACK')
        checks++
        let undelivered
        await denied(() => requests.execute(42, 'filesystem_derive_read', 'late-reference', async signal => {
          undelivered = await runtime.grants.deriveRead(42, cacheRoot.grantId, 'tracker-output.txt', signal)
          requests.cancel(42, 'filesystem_derive_read', 'late-reference')
          return undelivered
        }, 10_000, async reference => { await runtime.grants.revoke(42, reference.grantId) }), 'CALLER_DESTROYED')
        await denied(() => runtime.grants.read(42, undelivered.grantId), 'PERMISSION_DENIED')
      } finally { await requests.stop() }

      // Maintained SDK/Transport -> fixed preload bridge -> Main identity/handlers -> real native.
      // The browser/OS picker is not launched: this is a synthetic VM and isolated native data root.
      const sdkTarget = { id: 42, isDestroyed: () => false, mainFrame: { url: 'ztools://web/index.html' } }
      const sdkEvent = { sender: sdkTarget, senderFrame: sdkTarget.mainFrame }
      const sdkRequests = new ReferenceRequestTracker({ isActive: owner => owner === 42, onRemoved: () => () => {} })
      const sdkLocations = new ReferenceDirectoryLocations(runtime.grants, { isActive: owner => owner === 42, onRemoved: () => () => {} })
      let cancelNextReceipt = false, sdkCancel
      const privatePlugin = { type: 'plugin', webContentsId: 43, pluginId: 'synthetic-cache', pluginInstanceId: 'private-one' }
      const privateCacheRoots = new ReferenceCacheRoots(runtimeData, process.platform, runtime.grants, {
        isActive: owner => owner === 42 || owner === 43, onRemoved: () => () => {},
        get: owner => owner === 42 ? mainCaller : owner === 43 ? privatePlugin : undefined
      })
      const privateCache = new ReferenceCacheService(runtime.grants, (caller, signal) => privateCacheRoots.rootForCaller(caller, signal))
      const privateMainFile = await privateCache.writeCache({ name: 'namespace.txt', content: 'main cache' }, mainCaller)
      const privatePluginFile = await privateCache.writeCache({ name: 'namespace.txt', content: 'plugin cache' }, privatePlugin)
      if ((await privateCache.readCache({ name: 'namespace.txt' }, mainCaller)).content !== 'main cache' ||
          (await privateCache.readCache({ name: 'namespace.txt' }, privatePlugin)).content !== 'plugin cache' ||
          JSON.stringify([privateMainFile, privatePluginFile]).includes(runtimeData)) throw new Error('NATIVE_PRIVATE_CACHE_NAMESPACE_MISMATCH')
      checks++
      await denied(() => runtime.fileSystem.readFile({ grantId: privatePluginFile.reference.grantId }, mainCaller), 'PERMISSION_DENIED')
      await denied(() => privateCacheRoots.rootForCaller({ ...privatePlugin, pluginId: 'forged' }), 'PERMISSION_DENIED')
      const sdkHandlers = { ...createReferenceFileHandlers(runtime.fileSystem, privateCache, sdkLocations), ...createReferenceRecoveryHandlers(runtime.recovery) }
      const sdkEvents = new EventService({ send: () => true, onRemoved: () => () => {} })
      const sdkClipboard = new ClipboardService({}, sdkEvents, {
        availableFormats: () => ['image/png'], clear() {}, has: () => false,
        readText: () => clipboardText, writeText: value => { clipboardText = value }, writeImage() {},
        readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toPNG: () => Buffer.alloc(600 * 1024, 7) })
      }, {}, { readFiles: async () => [], writeFiles: async () => {} }, 750, undefined, { cache: privateCache, grants: runtime.grants })
      Object.assign(sdkHandlers, createReferenceProducerHandlers({ dialogs, clipboardFiles: referenceClipboard,
        clipboard: sdkClipboard, screen: screenContent, grants: runtime.grants }))

      const saveExecute = sdkHandlers.filesystem_write_file.execute
      sdkHandlers.filesystem_write_file.execute = async (...args) => {
        const receipt = await saveExecute(...args)
        if (cancelNextReceipt) { cancelNextReceipt = false; sdkCancel.abort() }
        return receipt
      }
      const sdkEndpoint = new ReferenceIpcEndpoint({ get: owner => owner === 42 ? mainCaller : undefined,
        getWebContents: owner => owner === 42 ? sdkTarget : undefined, getSdkApiLane: () => 2 }, sdkRequests, sdkHandlers, () => true)
      const sdkBridge = createReferenceTransportBridge({ invoke: (channel, value) => {
        // Electron IPC structured clone reconstructs records in the receiving realm.
        const cloned = JSON.parse(JSON.stringify(value))
        if (JSON.stringify(cloned).includes(runtimeData)) throw new Error('SDK_TRANSMITTED_NATIVE_PATH')
        return channel === 'ztools:reference-cancel' ? sdkEndpoint.cancel(sdkEvent, cloned) : sdkEndpoint.call(sdkEvent, cloned)
      } }, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }, true)
      const sdkFiles = ['core/transport.js', 'core/reference-transport.js', 'api/fs.js', 'api/fs-reference.js', 'api/window.js', 'api/clipboard.js', 'api/screen.js', 'api/file-producers-reference.js', 'api/network.js', 'api/network-reference.js']
      const sdkRoot = path.join(root, '../frontend/public/js/cef-ipc/src')
      report.sdkSources = sdkFiles.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(sdkRoot, file))).digest('hex') }))
      const sdkSource = sdkFiles.map(file => fs.readFileSync(path.join(sdkRoot, file), 'utf8').replace(/^export .+$/mg, '')).join('\n')
      const sdkConstructors = vm.runInNewContext(sdkSource + '\n({ ReferenceTransport, ReferenceFileSystemAPI, ReferenceWindowAPI, ReferenceClipboardAPI, ReferenceScreenAPI, ReferenceNetworkAPI })', {
        window: { __ztoolsElectron: { contractVersion: 2, transport: sdkBridge } },
        environment: { showEnvironmentWarning() {}, getInfo: () => ({}), isElectron: () => true },
        MockProvider: class {}, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, setTimeout, clearTimeout, console
      })
      const sdkTransport = new sdkConstructors.ReferenceTransport(), sdk = new sdkConstructors.ReferenceFileSystemAPI(sdkTransport)
      const sdkHttpBytes = Buffer.from('sdk HTTP bytes')
      const sdkHttpServer = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/fixture') {
          response.setHeader('content-length', sdkHttpBytes.length); response.end(sdkHttpBytes)
        } else if (request.method === 'POST' && request.url === '/upload') {
          const chunks = []; let bytes = 0
          request.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) { request.destroy(); return }; chunks.push(chunk) })
          request.on('end', () => {
            const valid = Buffer.concat(chunks).includes(sdkHttpBytes)
            response.statusCode = valid ? 200 : 400; response.end(valid ? 'sdk upload accepted' : 'fixture mismatch')
          })
        } else { response.statusCode = 404; response.end('fixture missing') }
      })
      try {
        await new Promise((resolve, reject) => { sdkHttpServer.once('error', reject); sdkHttpServer.listen(0, '127.0.0.1', resolve) })
        const sdkHttpAddress = sdkHttpServer.address(), sdkHttpBase = `http://127.0.0.1:${sdkHttpAddress.port}`
        const sdkHttpService = new NetworkService({}, { pathGrants: runtime.grants, sessionResolver: () => ({ fetch: (url, init) => fetch(url, init) }) })
        Object.assign(sdkHandlers, createReferenceNetworkHandlers(sdkHttpService))
        const sdkNetwork = new sdkConstructors.ReferenceNetworkAPI(sdkTransport)
        const sdkHttpSave = await sdk.deriveSave(cacheRoot, 'sdk-http.bin')
        const downloaded = await sdkNetwork.download(sdkHttpBase + '/fixture', sdkHttpSave)
        const sdkHttpRead = await sdk.deriveRead(cacheRoot, 'sdk-http.bin')
        if (downloaded.size !== sdkHttpBytes.length || Buffer.from(await sdk.readFileAsBinary(sdkHttpRead)).compare(sdkHttpBytes) !== 0) throw new Error('SDK_HTTP_NATIVE_DOWNLOAD_MISMATCH')
        checks++
        const uploaded = await sdkNetwork.upload(sdkHttpBase + '/upload', sdkHttpRead)
        if (uploaded.data.body !== 'sdk upload accepted') throw new Error('SDK_HTTP_NATIVE_UPLOAD_MISMATCH')
        checks++
        await denied(() => sdkNetwork.download(sdkHttpBase + '/fixture', sdkHttpSave), 'FILE_ALREADY_EXISTS')
        const sdkWindow = new sdkConstructors.ReferenceWindowAPI(sdkTransport)
        const sdkClipboardAPI = new sdkConstructors.ReferenceClipboardAPI(sdkTransport)
        const sdkScreenAPI = new sdkConstructors.ReferenceScreenAPI(sdkTransport)
        const sdkOpened = await sdkWindow.showOpenDialog()
        if ((await sdk.readFile(sdkOpened.references[0])) !== 'composed runtime' || JSON.stringify(sdkOpened).includes(runtimeData)) throw new Error('SDK_NATIVE_DIALOG_REFERENCE_MISMATCH')
        checks++
        const sdkClipboardFiles = await sdkClipboardAPI.readFiles()
        const sdkClipboardFile = sdkClipboardFiles.files.find(file => file.kind === 'file')
        await sdkClipboardAPI.copyText(sdkClipboardFile)
        if (clipboardText !== 'composed runtime') throw new Error('SDK_NATIVE_CLIPBOARD_TEXT_MISMATCH')
        checks++
        await sdkClipboardAPI.copyText('x'.repeat(2 * 1024 * 1024))
        if (clipboardText.length !== 2 * 1024 * 1024 || clipboardText[0] !== 'x') throw new Error('SDK_NATIVE_LARGE_TEXT_MISMATCH')
        checks++

        const sdkImage = await sdkClipboardAPI.readImage()
        if (!sdkImage.useReference || Buffer.from(await sdk.readFileRange(sdkImage.reference, 0, 4)).toString('hex') !== '07070707') throw new Error('SDK_NATIVE_CLIPBOARD_IMAGE_MISMATCH')
        checks++
        const sdkCapture = await sdkScreenAPI.capture()
        if (Buffer.from(await sdk.readFileAsBinary(sdkCapture.reference)).compare(pngFixture) !== 0) throw new Error('SDK_NATIVE_SCREEN_IMAGE_MISMATCH')
        checks++
        const sdkSave = await sdk.deriveSave(cacheRoot, 'sdk-output.bin')
        await sdk.writeFile(sdkSave, new Uint8Array([0, 255, 7]))
        const sdkRead = await sdk.deriveRead(cacheRoot, 'sdk-output.bin')
        if (Buffer.from(await sdk.readFileAsBinary(sdkRead)).toString('hex') !== '00ff07' ||
            Buffer.from(await sdk.readFileRange(sdkRead, 1, 2)).toString('hex') !== 'ff07') throw new Error('SDK_NATIVE_BYTES_MISMATCH')
        checks++
        await sdk.setCurrentDirectory(cacheRoot)
        if ((await sdk.getCurrentDirectory()).grantId !== cacheRoot.grantId) throw new Error('SDK_NATIVE_DIRECTORY_MISMATCH')
        checks++
        const sdkCache = await sdk.writeCache('sdk-cache.txt', 'sdk native cache')
        if (await sdk.readFile(sdkCache.reference) !== 'sdk native cache' || await sdk.readCache('sdk-cache.txt') !== 'sdk native cache') throw new Error('SDK_NATIVE_CACHE_MISMATCH')
        checks++
        await sdk.createDirectory(cacheRoot, 'sdk-search')
        const sdkSearch = await sdk.deriveDirectory(cacheRoot, 'sdk-search')
        await sdk.writeFile(await sdk.deriveSave(sdkSearch, 'Case.TXT'), 'case fixture')
        await sdk.createDirectory(sdkSearch, 'folder.txt')
        const searched = await sdk.findFiles(sdkSearch, '*.txt', { caseSensitive: false })
        if (searched.length !== 1 || searched[0].name !== 'Case.TXT' || searched[0].size !== 12) throw new Error('SDK_NATIVE_FILE_SEARCH_MISMATCH')
        checks++
        if ((await sdk.findFiles(sdkSearch, '*.txt')).length !== 0) throw new Error('SDK_NATIVE_CASE_SEARCH_MISMATCH')
        checks++
        const searchedDirectories = await sdk.findDirectories(sdkSearch, '*.txt')
        if (searchedDirectories.length !== 1 || searchedDirectories[0].name !== 'folder.txt' || !searchedDirectories[0].isDirectory) throw new Error('SDK_NATIVE_DIRECTORY_SEARCH_MISMATCH')
        checks++
        await denied(() => sdk.readFile({ ...sdkRead, path: selectedOutput }), 'INVALID_REQUEST')
        await denied(() => sdk.deriveSave(cacheRoot, '../escape'), 'INVALID_REQUEST')
        sdkCancel = new AbortController()
        const lateSave = await sdk.deriveSave(cacheRoot, 'sdk-late.txt')
        cancelNextReceipt = true
        await denied(() => sdk.writeFile(lateSave, 'sdk committed before cancellation', { signal: sdkCancel.signal }), 'FILE_WRITE_OUTCOME_UNKNOWN')
        if (fs.readFileSync(path.join(runtimeData, 'Cache/sdk-late.txt'), 'utf8') !== 'sdk committed before cancellation') throw new Error('SDK_CANCELLED_COMMIT_FALSE_ROLLBACK')
        checks++
        await sdk.revoke(sdkRead)
        await denied(() => sdk.readFileAsBinary(sdkRead), 'PERMISSION_DENIED')
      } finally {
        if (sdkHttpServer.listening) {
          sdkHttpServer.closeAllConnections()
          await new Promise((resolve, reject) => sdkHttpServer.close(error => error ? reject(error) : resolve()))
        }
        sdkClipboard.stop(); sdkEvents.stop(); sdkTransport.destroy(); sdkLocations.stop(); await sdkRequests.stop(); await privateCacheRoots.stop()
      }
      await denied(() => runtime.fileSystem.readFile({ grantId: privateMainFile.reference.grantId }, mainCaller), 'PERMISSION_DENIED')
      if (fs.readFileSync(path.join(runtimeData, 'ReferenceCache/main/namespace.txt'), 'utf8') !== 'main cache') throw new Error('PRIVATE_CACHE_STOP_DELETED_FILE')
      checks++
      await denied(() => referenceClipboard.read(mainCaller, cancelled.signal), 'CLIPBOARD_ERROR')
      await denied(() => runtime.fileSystem.readFile({ grantId: clipboardFile.grantId }, { type: 'main', webContentsId: 99 }), 'PERMISSION_DENIED')
      const eventDeliveries = []
      const clipboardEvents = new EventService({ send: (owner, _, value) => { eventDeliveries.push({ owner, value }); return true }, onRemoved: () => () => {} })
      try {
        const secondOwner = { ...pluginCaller, webContentsId: 43 }
        clipboardEvents.subscribe({ key: 'clipboard_change' }, mainCaller)
        clipboardEvents.subscribe({ key: '*' }, secondOwner)
        const published = await referenceClipboard.publishChange(clipboardEvents, new AbortController().signal, () => true)
        if (published.delivered !== 2 || eventDeliveries.length !== 2 || eventDeliveries[0].owner !== 42 || eventDeliveries[1].owner !== 43) throw new Error('NATIVE_CLIPBOARD_EVENT_OWNER_MISMATCH')
        checks++
        const ownerFiles = eventDeliveries.map(item => item.value.msgData.envelope.payload.files.find(file => file.kind === 'file'))
        if (ownerFiles[0].grantId === ownerFiles[1].grantId || JSON.stringify(eventDeliveries).includes(runtimeData)) throw new Error('NATIVE_CLIPBOARD_EVENT_REFERENCE_LEAK')
        checks++
        if ((await runtime.fileSystem.readFile({ grantId: ownerFiles[1].grantId }, secondOwner)).content !== 'composed runtime') throw new Error('NATIVE_CLIPBOARD_EVENT_READ_MISMATCH')
        checks++
        await denied(() => runtime.fileSystem.readFile({ grantId: ownerFiles[1].grantId }, mainCaller), 'PERMISSION_DENIED')
      } finally { clipboardEvents.stop() }
      await denied(() => runtime.fileSystem.readFile({ grantId: readGrant.grantId }, { type: 'plugin', webContentsId: 99 }), 'PERMISSION_DENIED')
    } finally { await runtime.stop() }
    await denied(() => runtime.grants.create(42, path.join(runtimeData, 'later.txt'), 'save', ['write']), 'PERMISSION_DENIED')
    // Composition factory: actual owner lifecycle, private roots, journal and native I/O; OS providers remain injected.
    const composedData = path.join(fixture, 'reference-composition'); fs.mkdirSync(composedData)
    const composedSelected = path.join(composedData, 'selected.txt'); fs.writeFileSync(composedSelected, 'factory native bytes', { flag: 'wx' })
    const composedSession = {}, composedListeners = new Set(), composedCaller = { type: 'main', webContentsId: 142 }
    const composedPluginCaller = { type: 'plugin', webContentsId: 143, pluginId: 'example', pluginInstanceId: 'composition-plugin-one' }
    const composedPluginTarget = { id: 143, isDestroyed: () => false, mainFrame: { url: 'ztools://plugins/example/index.html' } }
    const composedEventHandlers = new Map(), composedDocumentHandlers = new Map(), composedDropPayloads = []
    const composedTarget = { id: 142, isDestroyed: () => false, mainFrame: { url: 'ztools://web/index.html' } }
    const composedRegistry = { get: owner => owner === 142 ? composedCaller : owner === 143 ? composedPluginCaller : undefined,
      getWebContents: owner => owner === 142 ? composedTarget : owner === 143 ? composedPluginTarget : undefined,
      getSdkApiLane: caller => caller === composedCaller || caller === composedPluginCaller ? 2 : undefined,
      send: (owner, _channel, value) => {
        if (owner !== 143) return false
        composedDropPayloads.push(value.msgData.envelope)
        composedEventHandlers.get('plugin_files_dropped')?.(value.msgData.envelope)
        return true
      }, getSession: () => composedSession,
      onRemoved: listener => { composedListeners.add(listener); return () => composedListeners.delete(listener) } }
    const composedEvents = new EventService(composedRegistry)
    let composedRuntime
    try {
      const unusedImage = () => { throw new Error('UNUSED_COMPOSED_IMAGE_PORT') }
      composedRuntime = await createReferenceFileRuntime({ pathAccess: { executable: broker, dataRoot: composedData, platform: process.platform,
        sealer: createJournalSealer({ isAsyncEncryptionAvailable: async () => true,
          encryptStringAsync: async text => Buffer.from(text), decryptStringAsync: async bytes => ({ result: bytes.toString() }) }) },
        registry: composedRegistry, events: composedEvents, authorize: () => true, legacyFiles: {},
        dialogProvider: { select: async () => ({ canceled: false, selections: [{ absolutePath: composedSelected, kind: 'file' }] }) },
        clipboard: { availableFormats: () => [], clear() {}, has: () => false, readText: () => '', writeText() {}, writeImage() {},
          readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) }) },
        images: { createFromBuffer: unusedImage, createFromDataURL: unusedImage, createFromBitmap: unusedImage },
        fileClipboard: { readFiles: async () => [], writeFiles: async () => {} },
        screen: { getSources: async () => [], createFromBitmap: unusedImage, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
          getPrimaryDisplay: unusedImage, getAllDisplays: () => [], getDisplayNearestPoint: unusedImage, getDisplayMatching: unusedImage } })
      const pluginSdkSourcePath = path.join(root, '../frontend/src/sdk/plugin-sdk.js')
      const pluginSdkSource = fs.readFileSync(pluginSdkSourcePath, 'utf8')
      report.pluginSdkSource = { file: 'frontend/src/sdk/plugin-sdk.js', sha256: createHash('sha256').update(pluginSdkSource).digest('hex') }
      const pluginSdkWindow = { location: { href: composedPluginTarget.mainFrame.url }, __ztoolsElectron: { contractVersion: 2 },
        ztools: { events: { on: (name, callback) => composedEventHandlers.set(name, callback), off: () => { throw new Error('FOREIGN_EVENT_REMOVAL') } } } }
      vm.runInNewContext(pluginSdkSource, { window: pluginSdkWindow, document: { readyState: 'loading', documentElement: { classList: { toggle() {} } },
        addEventListener: (name, callback) => composedDocumentHandlers.set(name, callback) },
        TextEncoder, setTimeout, clearTimeout, console: { log() {}, error: () => { throw new Error('PLUGIN_SDK_DROP_DISPATCH_FAILED') } } })
      composedDocumentHandlers.get('DOMContentLoaded')()
      let composedDropFiles
      const removeDrop = pluginSdkWindow.ztoolsPlugin.onFileDrop((files, errors) => {
        if (errors.length || !Object.isFrozen(files)) throw new Error('FACTORY_PLUGIN_DROP_REFERENCE_MISMATCH')
        composedDropFiles = files
      })
      const composedPluginEvent = { sender: composedPluginTarget, senderFrame: composedPluginTarget.mainFrame }
      const acceptedDrop = await composedRuntime.endpoint.acceptDrop(composedPluginEvent, [composedSelected])
      if (!acceptedDrop.success || acceptedDrop.accepted !== 1 || composedDropFiles?.length !== 1 ||
          JSON.stringify(composedDropFiles).includes(composedData)) throw new Error('FACTORY_PLUGIN_DROP_REFERENCE_MISMATCH')
      checks++
      const dropRead = await composedRuntime.endpoint.call(composedPluginEvent, { messageId: 'factory-drop-read', method: 'filesystem_read_file',
        params: { grantId: composedDropFiles[0].grantId } })
      if (!dropRead.success || dropRead.data.content !== 'factory native bytes') throw new Error('FACTORY_PLUGIN_DROP_NATIVE_READ_MISMATCH')
      checks++
      if ((await composedRuntime.endpoint.acceptDrop({ ...composedPluginEvent, senderFrame: { ...composedPluginTarget.mainFrame } }, [composedSelected])).success ||
          composedDropPayloads.length !== 1) throw new Error('FACTORY_PLUGIN_DROP_FRAME_ACCEPTED')
      checks++
      removeDrop()
      const composedEvent = { sender: composedTarget, senderFrame: composedTarget.mainFrame }
      const opened = await composedRuntime.endpoint.call(composedEvent, { messageId: 'factory-open', method: 'window_show_open_dialog', params: {} })
      if (!opened.success || JSON.stringify(opened).includes(composedData)) throw new Error('FACTORY_REFERENCE_DIALOG_MISMATCH')
      const foreignDropRead = await composedRuntime.endpoint.call(composedEvent, { messageId: 'factory-foreign-drop', method: 'filesystem_read_file',
        params: { grantId: composedDropFiles[0].grantId } })
      if (foreignDropRead.success || foreignDropRead.error?.code !== 'PERMISSION_DENIED') throw new Error('FACTORY_PLUGIN_DROP_FOREIGN_OWNER_ACCEPTED')
      checks++
      const read = await composedRuntime.endpoint.call(composedEvent, { messageId: 'factory-read', method: 'filesystem_read_file',
        params: { grantId: opened.data.references[0].grantId } })
      if (!read.success || read.data.content !== 'factory native bytes') throw new Error('FACTORY_REFERENCE_NATIVE_READ_MISMATCH')
      checks++
      const resourceUrl = opened.data.references[0].fileUrl
      const resourceDetails = { url: resourceUrl, method: 'GET', webContentsId: 142, webContents: composedTarget, frame: composedTarget.mainFrame }
      if (!composedRuntime.resources.allowsNativeRequest(resourceDetails, composedSession) ||
          composedRuntime.resources.allowsNativeRequest({ ...resourceDetails, webContentsId: 99 }, composedSession)) throw new Error('FACTORY_RESOURCE_OWNER_GUARD_MISMATCH')
      checks++
      const media = await composedRuntime.resources.respond(new Request(resourceUrl, { headers: { range: 'bytes=1-4' } }))
      if (media.status !== 206 || await media.text() !== 'acto') throw new Error('FACTORY_RESOURCE_NATIVE_RANGE_MISMATCH')
      checks++
      const cached = await composedRuntime.endpoint.call(composedEvent, { messageId: 'factory-cache', method: 'filesystem_write_cache',
        params: { name: 'factory-cache.txt', content: 'factory private cache' } })
      if (!cached.success || JSON.stringify(cached).includes(composedData) ||
          fs.readFileSync(path.join(composedData, 'ReferenceCache/main/factory-cache.txt'), 'utf8') !== 'factory private cache') throw new Error('FACTORY_REFERENCE_PRIVATE_CACHE_MISMATCH')
      checks++
      if ((await composedRuntime.recovery.list(composedCaller)).length !== 0) throw new Error('FACTORY_REFERENCE_JOURNAL_MISMATCH')
      checks++
      const stopped = composedRuntime.stop()
      if (composedRuntime.stop() !== stopped) throw new Error('FACTORY_REFERENCE_STOP_NOT_IDEMPOTENT')
      await stopped
      if ((await composedRuntime.endpoint.acceptDrop(composedPluginEvent, [composedSelected])).success) throw new Error('FACTORY_PLUGIN_DROP_POST_STOP_ACCEPTED')
      checks++
      if (composedListeners.size !== 1 || !fs.existsSync(composedSelected)) throw new Error('FACTORY_REFERENCE_STOP_OWNERSHIP_MISMATCH')
      checks++
      if ((await composedRuntime.endpoint.call(composedEvent, { messageId: 'factory-after', method: 'filesystem_read_file',
          params: { grantId: opened.data.references[0].grantId } })).success) throw new Error('FACTORY_REFERENCE_POST_STOP_ACCEPTED')
      checks++
    } finally { await composedRuntime?.stop(); composedEvents.stop() }
    if (composedListeners.size !== 0) throw new Error('FACTORY_REFERENCE_LISTENER_LEAK')
    report.referenceComposition = { sourceFactory: true, realNativeIo: true, syntheticOsProviders: true, productionBootstrap: false }
    report.status = 'PASS'; report.native = native; report.brokerChecks = checks
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(report))
  }
} catch (error) {
  const detail = typeof error?.message === 'string' && /^[A-Z0-9_]+$/.test(error.message) ? error.message :
    typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'NATIVE_UNCLASSIFIED_FAILURE'
  if (report) report.failureCode = detail
  console.error(detail)
  if (reportPath && report && !fs.existsSync(reportPath)) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.error('NATIVE_PATH_ACCESS_TEST_FAILED'); process.exitCode = 1
}
