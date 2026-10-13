import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { startMacNormalDatabaseChainSession, validateMacIsolatedMainSnapshot } from './macos-app-integration.mjs'
import { validatePrebootProfile } from './lib/normal-app-preboot-isolation.mjs'
import { main, parseMacDatabaseChainArguments, runMacNormalAppDatabaseChain,
  validateMacTodoPluginZip, createMacDatabaseProfile } from './test-macos-normal-app-database-chain.mjs'

const fixtureApp = path.join(os.tmpdir(), 'approved', 'ZTools.app')
const fixtureZip = path.join(os.tmpdir(), 'plugin-build', 'todo-1.2.0-macos-electron-any.zip')
const approved = { app: fixtureApp, output: path.join(os.tmpdir(), `f12-mac-output-${randomUUID()}`),
  'bundle-id': 'org.example.ztools', 'minimum-os': '13.0', 'expect-process-arch': 'arm64' }
const validArgs = ['--app', approved.app, '--output', approved.output, '--bundle-id', approved['bundle-id'],
  '--minimum-os', approved['minimum-os'], '--expect-process-arch', approved['expect-process-arch'], '--zip', fixtureZip]

function makeTempDirectory(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)) }

test('Windows returns NOT_RUN before parsing paths, inspecting the app, validating ZIPs or starting a process', async () => {
  const calls = []
  const result = await runMacNormalAppDatabaseChain(['--app', 'not-a-bundle', '--zip', 'relative.zip'], {
    platform: 'win32', inspectApp: () => { calls.push('inspect'); throw new Error('must-not-run') },
    validateZip: () => { calls.push('zip'); throw new Error('must-not-run') },
    startSession: () => { calls.push('start'); throw new Error('must-not-run') }
  })
  assert.deepEqual(result, { status: 'NOT_RUN', caseId: 'F12-MAC-PACKAGED-DATABASE', code: 'DARWIN_REQUIRED',
    appStarted: false, processCreated: false, completeCase: false, macAcceptance: 'NOT_RUN' })
  assert.deepEqual(calls, [])
})

test('Darwin requires the approved App identity, actual slice, fresh output and absolute fresh Mac-target ZIP', () => {
  assert.throws(() => parseMacDatabaseChainArguments(['--app', approved.app, '--output', approved.output]), /ZIP_ABSOLUTE_PATH_REQUIRED/)
  assert.throws(() => parseMacDatabaseChainArguments([...validArgs, '--zip', fixtureZip]), /DUPLICATE_ZIP/)
  assert.throws(() => parseMacDatabaseChainArguments([...validArgs.slice(0, -2), '--zip', 'relative.zip']), /ZIP_ABSOLUTE_PATH_REQUIRED/)
})

test('Mac preboot session refuses reserved shared harness ports before spawning the App', async () => {
  const options = { app: '/Applications/ZTools.app', output: '/tmp/f12-run', 'bundle-id': 'com.example.ZTools',
    'minimum-os': '13.0.0', 'expect-process-arch': 'arm64', profile: { root: '/tmp/f12-run/profile' } }
  const preflight = { status: 'PASS', appRoot: options.app, executable: '/Applications/ZTools.app/Contents/MacOS/ZTools',
    bundleId: options['bundle-id'], minimumOs: options['minimum-os'], expectedProcessArch: 'arm64',
    slices: ['arm64', 'x86_64'], appVersion: '1.1.7.1' }
  let spawnCalls = 0
  const dependencies = { platform: 'darwin', preflight, spawnApp: () => { spawnCalls += 1 },
    allocatePort: async () => 9336 }
  await assert.rejects(startMacNormalDatabaseChainSession(options, dependencies), /INVALID_CDP_PORT/)
  assert.equal(spawnCalls, 0)

  const ports = [44444, 9337]
  await assert.rejects(startMacNormalDatabaseChainSession(options, { ...dependencies,
    allocatePort: async () => ports.shift() }), /INSPECTOR_PORT_COLLISION/)
  assert.equal(spawnCalls, 0)
})

test('failed App preflight stops before ZIP validation or process launch', async () => {
  let zipCalls = 0, startCalls = 0
  const result = await runMacNormalAppDatabaseChain(validArgs, {
    platform: 'darwin', inspectApp: () => ({ status: 'NOT_RUN', code: 'OS_BELOW_MINIMUM' }),
    validateZip: () => { zipCalls += 1 }, startSession: () => { startCalls += 1 }
  })
  assert.equal(result.status, 'NOT_RUN')
  assert.equal(result.code, 'OS_BELOW_MINIMUM')
  assert.equal(result.appStarted, false)
  assert.equal(zipCalls, 0)
  assert.equal(startCalls, 0)
})

test('a failed Mac target ZIP check stops before creating output or starting the App', async () => {
  const temp = makeTempDirectory('f12-mac-zip-reject-')
  const output = path.join(temp, 'fresh-output')
  let startCalls = 0
  const result = await runMacNormalAppDatabaseChain([...validArgs.slice(0, 3), output, ...validArgs.slice(4)], {
    platform: 'darwin', inspectApp: () => ({ status: 'PASS', bundleId: approved['bundle-id'], appVersion: '1.1.7.1' }),
    validateZip: async () => { throw new Error('TODO_ZIP_TARGET_MISMATCH') },
    startSession: () => { startCalls += 1 }, stdout: () => {}
  })
  assert.equal(result.status, 'FAIL')
  assert.equal(result.code, 'TODO_ZIP_TARGET_MISMATCH')
  assert.equal(fs.existsSync(output), false)
  assert.equal(startCalls, 0)
})

test('valid Mac preflight reaches the preboot integration hook with an exclusive UUID profile', async () => {
  const temp = makeTempDirectory('f12-mac-gate-hook-')
  const output = path.join(temp, 'new-output')
  const args = [...validArgs]
  args[3] = output
  let started
  const result = await runMacNormalAppDatabaseChain(args, {
    platform: 'darwin',
    inspectApp: options => ({ status: 'PASS', bundleId: options['bundle-id'], appVersion: '1.1.7.1',
      minimumOs: options['minimum-os'], slices: ['arm64', 'x86_64'], expectedProcessArch: options['expect-process-arch'],
      executable: path.join(options.app, 'Contents', 'MacOS', 'ZTools'), executableSha256: 'a'.repeat(64) }),
    validateZip: async zip => ({ path: zip, fileSize: 16, checksum: 'b'.repeat(64), buildRun: 'fresh-mac-run',
      targetId: 'macos-electron-any', entryCount: 3, uncompressedBytes: 12 }),
    startSession: async (options, dependencies) => {
      started = { options, dependencies }
      const error = new Error('PREBOOT_GATE_TEST_STOP')
      error.cleanup = { cleanup: 'OWNED_PROCESS_EXITED', normalQuitConfirmed: false, ownedPid: 123 }
      throw error
    },
    writeReport: async report => ({ status: 'PASS', reportPath: path.join(report.output, 'report.json') }),
    stdout: () => {}
  })
  assert.equal(started.dependencies.platform, 'darwin')
  assert.equal(started.dependencies.preflight.bundleId, approved['bundle-id'])
  assert.equal(started.options.profile.root.startsWith(path.join(output, 'profiles')), true)
  assert.match(path.basename(started.options.profile.root), /^[0-9a-f-]{36}$/i)
  assert.equal(started.options.profile.appDataPath, path.join(started.options.profile.root, 'appData'))
  assert.equal(started.options.profile.userDataPath, path.join(started.options.profile.appDataPath, 'ZTools'))
  assert.equal(started.options.profile.sessionDataPath, path.join(started.options.profile.root, 'sessionData'))
  assert.equal(result.status, 'FAIL')
  assert.equal(result.failureCode, 'PREBOOT_GATE_TEST_STOP')
  assert.equal(result.processCreated, false)
  assert.equal(fs.existsSync(started.options.profile.root), true)
})

test('Darwin isolation profile precreates the production appData/ZTools userData path', () => {
  const temp = makeTempDirectory('f12-mac-profile-layout-')
  const output = path.join(temp, 'fresh-output')
  fs.mkdirSync(output)
  const profile = createMacDatabaseProfile(output)
  assert.equal(profile.userDataPath, path.join(profile.appDataPath, 'ZTools'))
  assert.equal(fs.lstatSync(profile.appDataPath).isDirectory(), true)
  assert.equal(fs.lstatSync(profile.userDataPath).isDirectory(), true)
  assert.equal(fs.lstatSync(profile.sessionDataPath).isDirectory(), true)
  assert.equal(validatePrebootProfile(profile, output, { platform: 'win32' }).code, 'ISOLATED_PROFILE_PATH_MISMATCH')
})

test('post-bootstrap Main readback accepts only the isolated appData/ZTools userData path', () => {
  const appRoot = '/Applications/ZTools.app'
  const appArchivePath = path.posix.join(appRoot, 'Contents', 'Resources', 'app.asar')
  const appDataPath = '/tmp/f12-profile/appData'
  const profile = { appDataPath, userDataPath: path.posix.join(appDataPath, 'ZTools'), sessionDataPath: '/tmp/f12-profile/sessionData' }
  const preflight = { appRoot, executable: path.posix.join(appRoot, 'Contents', 'MacOS', 'ZTools'),
    bundleId: approved['bundle-id'], appVersion: '1.1.7.1' }
  const options = { 'expect-process-arch': 'arm64' }
  const snapshot = { pid: 123, execPath: preflight.executable, processArch: 'arm64', electronVersion: '43.4.1',
    mainEntry: path.posix.join(appArchivePath, 'out', 'main', 'bootstrap.js'), appPath: appArchivePath,
    appVersion: preflight.appVersion, isPackaged: true, appDataPath: profile.appDataPath,
    userDataPath: profile.userDataPath, sessionDataPath: profile.sessionDataPath,
    appDataRealPath: profile.appDataPath, userDataRealPath: profile.userDataPath,
    sessionDataRealPath: profile.sessionDataPath }
  const expected = { childPid: snapshot.pid, preflight, options, profile }
  assert.equal(validateMacIsolatedMainSnapshot(snapshot, expected).status, 'PASS')
  assert.equal(validateMacIsolatedMainSnapshot({ ...snapshot, userDataPath: '/Users/real-user/Library/Application Support/ZTools' }, expected).code,
    'ISOLATED_PATH_READBACK_FAILED')
  assert.equal(validateMacIsolatedMainSnapshot({ ...snapshot, userDataRealPath: '/Users/real-user/Library/Application Support/ZTools' }, expected).code,
    'ISOLATED_PATH_READBACK_FAILED')
})

test('profile creation refuses a reused output and never cleans the isolated profile', () => {
  const temp = makeTempDirectory('f12-mac-profile-')
  const output = path.join(temp, 'fresh-output')
  fs.mkdirSync(output)
  const profile = createMacDatabaseProfile(output)
  assert.equal(fs.existsSync(profile.root), true)
  assert.equal(fs.lstatSync(profile.root).isDirectory(), true)
  assert.notEqual(profile.appDataPath, profile.userDataPath)
  assert.notEqual(profile.userDataPath, profile.sessionDataPath)
  assert.throws(() => createMacDatabaseProfile(output), /EEXIST/)
  assert.equal(fs.existsSync(profile.root), true)
})

test('fresh Mac todo ZIP validator accepts only a single exact Mac target from a build run', async () => {
  const temp = makeTempDirectory('f12-mac-zip-validator-')
  const plugin = path.join(temp, 'create-plugin')
  const buildRoot = path.join(plugin, '.build-runs')
  const zipDirectory = path.join(buildRoot, 'f12-mac-run', 'zips')
  const sourceDirectory = path.join(plugin, 'src', 'plugins', 'todo')
  fs.mkdirSync(zipDirectory, { recursive: true })
  fs.mkdirSync(sourceDirectory, { recursive: true })
  const target = { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
  const sourceManifest = { id: 'todo', version: '1.2.0', targets: [
    { id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }, target] }
  fs.writeFileSync(path.join(sourceDirectory, 'plugin.json'), JSON.stringify(sourceManifest))
  const zipPath = path.join(zipDirectory, 'todo-1.2.0-macos-electron-any.zip')
  fs.writeFileSync(zipPath, 'zip-placeholder')
  const archive = { manifest: { ...sourceManifest, targets: [target], nativeComponents: [] },
    entryNames: ['plugin.json', 'index.html', 'app.js'], uncompressedBytes: 42 }
  const accepted = await validateMacTodoPluginZip(zipPath, plugin, { readArchive: async () => archive })
  assert.equal(accepted.targetId, 'macos-electron-any')
  assert.equal(accepted.buildRun, 'f12-mac-run')
  assert.equal(accepted.fileSize, Buffer.byteLength('zip-placeholder'))
  await assert.rejects(validateMacTodoPluginZip(path.join(zipDirectory, 'todo-1.2.0-windows-electron-x64.zip'), plugin,
    { readArchive: async () => archive }), /ZIP_OUTSIDE_FRESH_MAC_PLUGIN_RUN/)
  await assert.rejects(validateMacTodoPluginZip(zipPath, plugin, { readArchive: async () => ({ ...archive,
    manifest: { ...archive.manifest, targets: [sourceManifest.targets[0]] } }) }), /TODO_ZIP_TARGET_MISMATCH/)
})

test('CLI returns reviewable NOT_RUN on Windows without creating an output directory', async () => {
  const messages = []
  const code = await main([], { platform: 'win32', stdout: value => messages.push(JSON.parse(value)) })
  assert.equal(code, 1)
  assert.equal(messages[0].status, 'NOT_RUN')
  assert.equal(messages[0].completeCase, false)
})
