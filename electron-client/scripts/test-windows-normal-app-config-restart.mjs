import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { WindowsNormalAppHarness } from './lib/windows-normal-app-harness.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const parseJson = text => JSON.parse(text.replace(/^\uFEFF/, ''))

export function parseConfigRestartArgs(args) {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean' }, output: { type: 'string' } }, strict: true, allowPositionals: false })
  if (values.help) return { help: true }
  if (values.output !== undefined && (!values.output.trim() || !path.isAbsolute(values.output))) throw new Error('OUTPUT_MUST_BE_ABSOLUTE')
  return { help: false, ...(values.output === undefined ? {} : { output: path.resolve(values.output) }) }
}

export function readConfigRestartEvidence(file, expectedValue) {
  const bytes = fs.readFileSync(file)
  const document = parseJson(bytes.toString('utf8'))
  if (document.mergeCheckpointProbe?.value !== expectedValue) throw new Error('PERSISTED_CONFIG_MISMATCH')
  return { sha256: hash(bytes), byteLength: bytes.length, valueMatches: true }
}

function buildIdentity() {
  const packageInfo = parseJson(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'))
  const protocol = fs.readFileSync(path.join(clientRoot, 'src/contracts/protocol-versions.ts'), 'utf8')
  const sdk = protocol.match(/SDK_CONTRACT\s*=\s*(\d+)/)
  const electron = parseJson(fs.readFileSync(path.join(clientRoot, 'node_modules/electron/package.json'), 'utf8'))
  if (!sdk || electron.version !== '43.4.1' || typeof packageInfo.version !== 'string') throw new Error('RUNTIME_VERSION_METADATA_INVALID')
  const paths = ['out/main/bootstrap.js', 'out/preload/main.js', 'out/assets/web/sdk/ztools-api.js',
    'scripts/lib/windows-normal-app-harness.mjs', 'scripts/test-windows-normal-app-config-restart.mjs']
  const inputs = paths.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(clientRoot, file))) }))
  const generatedSdk = fs.readFileSync(path.resolve(clientRoot, '../frontend/public/sdk/ztools-api.js'))
  if (hash(generatedSdk) !== inputs[2].sha256) throw new Error('RUNNING_SDK_BUILD_MISMATCH')
  return { versions: { appName: packageInfo.productName ?? packageInfo.name, appVersion: packageInfo.version,
    electronVersion: electron.version, sdkContractVersion: Number(sdk[1]) }, inputs }
}

export async function runConfigRestart({ output } = {}) {
  if (process.platform !== 'win32') return { status: 'NOT_RUN', reason: 'WINDOWS_NORMAL_APP_ONLY' }
  const identity = buildIdentity()
  const outputRoot = output ?? path.join(os.tmpdir(), `ZTools-normal-app-config-${randomUUID()}`)
  fs.mkdirSync(outputRoot, { recursive: false })
  if (fs.lstatSync(outputRoot).isSymbolicLink() || path.resolve(fs.realpathSync.native(outputRoot)) !== path.resolve(outputRoot)) throw new Error('OUTPUT_REALPATH_MISMATCH')
  const runId = randomUUID()
  const report = { version: 1, runId, scope: 'normal-ZTools-config-save-restart', completeCase: false,
    coverage: ['normal-start', 'public-config-write-read', 'actual-persisted-bytes', 'normal-quit', 'restart-read', 'owned-descendant-cleanup'],
    notCovered: ['plugin-business', 'native-dialogs', 'real-clipboard', 'crash-recovery', 'macOS', 'final-package'],
    macAcceptance: 'NOT_RUN', releaseAcceptance: false, input: identity, phases: {}, startedAt: new Date().toISOString(), success: false }
  const harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable: path.join(clientRoot, 'node_modules/electron/dist/electron.exe'), outputRoot, versions: identity.versions })
  const profile = harness.createProfile(path.join(outputRoot, 'profile'))
  let session
  try {
    session = await harness.start({ profile, phase: 'config-initial', report })
    report.probe = await session.browserPage.page.evaluate(`(async () => {
      if (window.ztools.isElectron() !== true) throw new Error('NOT_ELECTRON');
      if (await window.ztools.config.set('mergeCheckpointProbe.value', ${JSON.stringify(runId)}) !== true) throw new Error('CONFIG_WRITE_REJECTED');
      return { electron: window.ztools.isElectron(), value: await window.ztools.config.get('mergeCheckpointProbe.value', ''), url: location.href };
    })()`)
    if (report.probe.value !== runId || !report.probe.url.startsWith('ztools://web/')) throw new Error('CONFIG_ROUNDTRIP_FAILED')
    report.initialCleanup = await harness.stop(session)
    session = undefined
    if (!report.initialCleanup.cleanupConfirmed || report.initialCleanup.forcedOwnedMainTermination) throw new Error('INITIAL_NORMAL_QUIT_FAILED')
    const persistedFile = path.join(profile.appDataPath, 'ZTools', 'Data', 'user_settings.json')
    report.persisted = { path: persistedFile, ...readConfigRestartEvidence(persistedFile, runId) }
    session = await harness.start({ profile, phase: 'config-restart', report })
    report.restartValue = await session.browserPage.page.evaluate("window.ztools.config.get('mergeCheckpointProbe.value', '')")
    if (report.restartValue !== runId) throw new Error('RESTART_CONFIG_MISMATCH')
    report.finalCleanup = await harness.stop(session)
    session = undefined
    if (!report.finalCleanup.cleanupConfirmed || report.finalCleanup.forcedOwnedMainTermination) throw new Error('RESTART_NORMAL_QUIT_FAILED')
    for (const input of identity.inputs) if (hash(fs.readFileSync(path.join(clientRoot, input.file))) !== input.sha256) throw new Error('BUILD_INPUT_CHANGED_DURING_TEST')
    report.success = true
  } catch (error) {
    report.error = { message: String(error?.message ?? 'CONFIG_RESTART_FAILED'), stage: error?.stage, cdpException: error?.cdpException, cdpDiagnostics: error?.cdpDiagnostics, cleanup: error?.cleanup }
  } finally {
    if (session) {
      try { report.finalCleanup = await harness.stop(session) } catch (error) {
        report.success = false
        report.cleanupError = { message: String(error?.message ?? 'CLEANUP_FAILED') }
      }
    }
    report.finishedAt = new Date().toISOString()
    fs.writeFileSync(path.join(outputRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  return { status: report.success ? 'PASS' : 'FAIL', outputRoot, reportPath: path.join(outputRoot, 'report.json'), error: report.error }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseConfigRestartArgs(process.argv.slice(2))
    if (options.help) console.log('Usage: npm run test:win:normal-app:config-restart -- [--output <fresh absolute directory>]\nTests current Electron ZTools through CDP with isolated data and synthetic empty clipboard; retains evidence and never claims Mac or plugin acceptance.')
    else {
      const result = await runConfigRestart(options)
      console.log(JSON.stringify(result))
      process.exitCode = result.status === 'FAIL' ? 1 : 0
    }
  } catch (error) { console.error(error); process.exitCode = 1 }
}
