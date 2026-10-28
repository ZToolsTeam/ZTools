import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inspectMacApp, parseMacTestArguments } from './macos-preflight.mjs'
import { verifyMacosUniversalBundle } from './verify-macos-universal.mjs'
import { compareOsVersions } from './macos-minimum-os.mjs'
import plist from 'plist'
import { NETWORK_HELPER_BUNDLE, NETWORK_HELPER_EXECUTABLE, NETWORK_ENTITLEMENT, networkBundleId } from './macos-network-bundle.mjs'
import { loadNetworkProfile, embedNetworkProfile, verifyNetworkEntitlements } from './macos-network-profile.mjs'

const MAC_NATIVE_LOAD_PROOF_UNAVAILABLE = 'MAC_NATIVE_SAME_OBJECT_PROOF_UNAVAILABLE'

function requestsNativeHostGroup(options) {
  if (!options || typeof options !== 'object') return false
  if ((options.nativeHostMode !== undefined && options.nativeHostMode !== 'disabled') ||
      options.includeNativeHost === true || options.nativeCatalog !== undefined) return true
  return Object.keys(options).some((key) => key !== 'nativeHostMode' && options[key] !== undefined && options[key] !== false &&
    (/^(?:nativeHost|nativeWorker|nativeCatalog|nativeTeam|nativeCmake|nativeArchitectures)/i.test(key) ||
      /^(?:hostBundleId|workerBundleId|teamId)$/.test(key)))
}

export function macSigningOrder(bundlePath, machoFiles) {
  const root = path.resolve(bundlePath), units = new Map()
  for (const relative of machoFiles) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) ||
        relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw new Error('INVALID_SIGNING_INVENTORY')
    const absolute = path.resolve(root, relative)
    units.set(absolute, 'binary')
    for (let parent = path.dirname(absolute); parent !== root; parent = path.dirname(parent)) {
      if (parent === path.dirname(parent)) throw new Error('INVALID_SIGNING_INVENTORY')
      if (/\.(?:app|framework|xpc|bundle)$/.test(parent)) units.set(parent, 'bundle')
    }
  }
  if (units.size === 0) throw new Error('EMPTY_SIGNING_INVENTORY')
  return [...units.entries()].sort((a, b) => b[0].split(path.sep).length - a[0].split(path.sep).length ||
    (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'binary' ? -1 : 1)).map(([target, kind]) => ({ target, kind }))
}

export function signMacosRelease(options, {
  platform = process.platform, fsApi = fs, exec = execFileSync,
  preflight = inspectMacApp, verify = verifyMacosUniversalBundle
} = {}) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', phase: 2, stage: 'preflight', code: 'DARWIN_REQUIRED' }
  let stage = 'preflight'
  const completedStages = []
  if (requestsNativeHostGroup(options)) {
    return { status: 'FAIL', phase: 2, stage, completedStages, code: MAC_NATIVE_LOAD_PROOF_UNAVAILABLE }
  }
  const tool = (executable, argv, timeout = 120_000) => exec(executable, argv,
    { encoding: 'utf8', shell: false, timeout, maxBuffer: 4 * 1024 * 1024 })
  try {
    compareOsVersions(options['minimum-os'], options['minimum-os'])
    if (!/^Developer ID Application: [^\r\n]+ \([A-Z0-9]{10}\)$/.test(options.identity ?? '') ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(options['keychain-profile'] ?? '')) throw new Error('INVALID_SIGNING_INPUT')
    const checked = preflight(options)
    if (checked.status !== 'PASS') return { status: checked.status, phase: 2, stage, code: checked.code }
    const appRoot = checked.appRoot
    for (const key of ['entitlements', 'helper-entitlements']) {
      const target = options[key]
      if (!target || !path.isAbsolute(target) || !fsApi.statSync(target).isFile()) throw new Error('ENTITLEMENTS_REQUIRED')
      const relative = path.relative(appRoot, target)
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('ENTITLEMENTS_MUST_BE_EXTERNAL')
      }
      const entitlement = JSON.parse(tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', target]))
      // A prototype must not weaken the approved native trust boundary.
      if (entitlement['com.apple.security.cs.disable-library-validation'] === true ||
          Object.hasOwn(entitlement, NETWORK_ENTITLEMENT) ||
          entitlement['com.apple.security.get-task-allow'] === true ||
          entitlement['com.apple.security.app-sandbox'] === true ||
          entitlement['com.apple.security.cs.allow-jit'] !== true) throw new Error('ENTITLEMENTS_POLICY_REQUIRED')
    }
    const audit = verify({ bundlePath: appRoot, minimumOs: options['minimum-os'] })
    if ((audit.nativeHostMode !== undefined && audit.nativeHostMode !== 'disabled') ||
        audit.nativeHostAvailable === true ||
        (Array.isArray(audit.nativeHostArtifacts) && audit.nativeHostArtifacts.length > 0)) {
      const error = new Error(MAC_NATIVE_LOAD_PROOF_UNAVAILABLE)
      error.code = MAC_NATIVE_LOAD_PROOF_UNAVAILABLE
      throw error
    }
    const units = macSigningOrder(appRoot, audit.machoFiles)
    const networkBundle = path.join(appRoot, NETWORK_HELPER_BUNDLE)
    const hasNetwork = audit.machoFiles.includes(NETWORK_HELPER_EXECUTABLE)
    let networkProfile
    if (hasNetwork && options['network-profile']) {
      const bundleId = networkBundleId(options['bundle-id'])
      const info = plist.parse(fsApi.readFileSync(path.join(networkBundle, 'Contents', 'Info.plist'), 'utf8'))
      if (info.CFBundleIdentifier !== bundleId) throw new Error('NETWORK_PROFILE_APP_MISMATCH')
      networkProfile = loadNetworkProfile({ profilePath: options['network-profile'], bundleId, identity: options.identity }, { fsApi, exec })
    } else if (options['network-profile']) throw new Error('NETWORK_HELPER_MISSING')
    // Reserve a fresh external output root; never overwrite a previous release.
    fsApi.mkdirSync(path.dirname(options.output), { recursive: true })
    fsApi.mkdirSync(options.output)
    const networkEntitlements = path.join(options.output, 'network-entitlements.plist')
    if (networkProfile) embedNetworkProfile({ bundlePath: networkBundle, profile: networkProfile, entitlementsPath: networkEntitlements, fsApi })
    completedStages.push(stage)
    stage = 'nested-sign'
    for (const unit of units) {
      const argv = ['--force', '--options', 'runtime', '--timestamp', '--sign', options.identity]
      if (unit.target === networkBundle) {
        if (networkProfile) argv.push('--entitlements', networkEntitlements)
      }
      else if (unit.target.endsWith('.app')) argv.push('--entitlements', options['helper-entitlements'])
      argv.push(unit.target)
      tool('/usr/bin/codesign', argv)
    }
    completedStages.push(stage)
    stage = 'app-sign'
    tool('/usr/bin/codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', options.identity,
      '--entitlements', options.entitlements, appRoot])
    completedStages.push(stage)
    stage = 'signature-verify'
    tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', appRoot])
    if (networkProfile) verifyNetworkEntitlements(tool('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', networkBundle]), networkProfile.entitlements)
    completedStages.push(stage)
    stage = 'submission-archive'
    const submission = path.join(options.output, 'notary-submission.zip')
    tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appRoot, submission])
    completedStages.push(stage)
    stage = 'notarize'
    const notarization = JSON.parse(tool('/usr/bin/xcrun', ['notarytool', 'submit', submission,
      '--keychain-profile', options['keychain-profile'], '--wait', '--output-format', 'json'], 3_600_000)) // 苹果公证排队偶尔要二三十分钟
    if (notarization.status !== 'Accepted' || typeof notarization.id !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(notarization.id)) throw new Error('NOTARY_NOT_ACCEPTED')
    completedStages.push(stage)
    stage = 'staple'
    tool('/usr/bin/xcrun', ['stapler', 'staple', appRoot])
    tool('/usr/bin/xcrun', ['stapler', 'validate', appRoot])
    completedStages.push(stage)
    stage = 'gatekeeper'
    tool('/usr/sbin/spctl', ['--assess', '--type', 'execute', appRoot])
    tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', appRoot])
    verify({ bundlePath: appRoot, minimumOs: options['minimum-os'] })
    completedStages.push(stage)
    stage = 'distribution-archive'
    const archive = path.join(options.output, 'ZTools-notarized.zip')
    tool('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appRoot, archive])
    completedStages.push(stage)
    return { status: 'PASS', phase: 2, scope: 'signing-prototype', stage: 'complete', completedStages,
      archive, notarizationId: notarization.id,
      remainingGate: 'Both CPU slices, quarantine, installation, update and permissions require separate acceptance' }
  } catch (error) {
    // Tool stderr/argv can contain identities, paths and credentials. Do not echo it.
    return {
      status: 'FAIL', phase: 2, stage, completedStages,
      code: /^NETWORK_[A-Z_]+$/.test(error?.message ?? '') ? error.message : error?.code === MAC_NATIVE_LOAD_PROOF_UNAVAILABLE || error?.message === MAC_NATIVE_LOAD_PROOF_UNAVAILABLE
        ? MAC_NATIVE_LOAD_PROOF_UNAVAILABLE
        : 'SIGNING_STAGE_FAILED'
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('npm run sign:mac:prototype -- --app <absolute.app> --output <new absolute directory> --bundle-id <approved ID> --minimum-os <approved version> --expect-process-arch <x64|arm64> --identity <Developer ID Application: Name (TEAMID)> --keychain-profile <stored profile> --entitlements <approved absolute.plist> --helper-entitlements <approved absolute.plist> [--network-profile <网络辅助进程的 Developer ID 描述文件绝对路径>]')
    return 0
  }
  let options
  try {
    const { values } = parseArgs({ args: argv, options: Object.fromEntries(
      ['app', 'output', 'bundle-id', 'minimum-os', 'expect-process-arch', 'identity', 'keychain-profile', 'entitlements', 'helper-entitlements', 'network-profile'].map(k => [k, { type: 'string' }])) })
    parseMacTestArguments(['--app', values.app ?? '', '--output', values.output ?? '', '--bundle-id', values['bundle-id'] ?? '',
      '--minimum-os', values['minimum-os'] ?? '', '--expect-process-arch', values['expect-process-arch'] ?? ''])
    options = values
  } catch { console.error('签名参数无效；使用 --help 查看要求'); return 1 }
  const result = signMacosRelease(options)
  console.log(JSON.stringify(result))
  return result.status === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
