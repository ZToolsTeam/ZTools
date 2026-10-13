import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { inspectMacApp, parseMacTestArguments } from './macos-preflight.mjs'
import { verifyMacosUniversalBundle } from './verify-macos-universal.mjs'
import { auditMacReleaseEvidence, macReleaseEvidenceTemplate } from './macos-release-evidence.mjs'

export function auditMacRelease(options, { platform = process.platform, preflight = inspectMacApp,
  verify = verifyMacosUniversalBundle, exec = execFileSync, metadata = spawnSync, evidence = auditMacReleaseEvidence } = {}) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', phase: 2 }
  let stage = 'preflight'
  try {
    if (!/^[A-Z0-9]{10}$/.test(options['team-id'] ?? '')) throw new Error('APPROVED_TEAM_ID_REQUIRED')
    const app = preflight(options)
    if (app.status !== 'PASS') return { status: app.status, code: app.code, phase: 2, stage }
    stage = 'universal-minimum-os'
    const universal = verify({ bundlePath: app.appRoot, minimumOs: options['minimum-os'] })
    const toolOptions = { encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 }
    stage = 'signature'
    exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R',
      `anchor apple generic and certificate leaf[subject.OU] = "${options['team-id']}"`, app.appRoot], toolOptions)
    const codeDirectoryHashes = {}
    for (const [arch, nativeArch] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
      const result = metadata('/usr/bin/codesign', ['-d', '--verbose=4', '--arch', nativeArch, app.appRoot], { ...toolOptions, stdio: 'pipe' })
      if (result.error || result.status !== 0 || typeof result.stderr !== 'string') throw new Error('SIGNATURE_METADATA_UNAVAILABLE')
      const text = result.stderr, team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1], cdHash = /^CDHash=([a-f0-9]{40})$/mi.exec(text)?.[1]
      if (team !== options['team-id'] || !cdHash || !/^CodeDirectory .*flags=.*\bruntime\b/m.test(text) ||
          !text.split('\n').some(line => line.startsWith('Authority=Developer ID Application:') && line.trimEnd().endsWith(`(${team})`))) throw new Error('SIGNATURE_POLICY_MISMATCH')
      codeDirectoryHashes[arch] = cdHash.toLowerCase()
    }
    const signedEntitlements = metadata('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app.appRoot], { ...toolOptions, stdio: 'pipe' })
    if (signedEntitlements.error || signedEntitlements.status !== 0 || typeof signedEntitlements.stdout !== 'string' || !signedEntitlements.stdout.trim()) throw new Error('SIGNED_ENTITLEMENTS_UNAVAILABLE')
    const entitlements = JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { ...toolOptions, input: signedEntitlements.stdout }))
    if (entitlements['com.apple.security.cs.disable-library-validation'] === true ||
        entitlements['com.apple.security.get-task-allow'] === true || entitlements['com.apple.security.cs.allow-jit'] !== true) throw new Error('SIGNED_ENTITLEMENTS_POLICY_MISMATCH')
    stage = 'notary-gatekeeper'
    exec('/usr/bin/xcrun', ['stapler', 'validate', app.appRoot], toolOptions)
    exec('/usr/sbin/spctl', ['--assess', '--type', 'execute', app.appRoot], toolOptions)
    stage = 'complete-case-evidence'
    const acceptance = evidence(options.evidence, { bundleId: app.bundleId, appVersion: app.appVersion, codeDirectoryHashes })
    return { status: acceptance.status, phase: 2, scope: 'signed-bundle-and-evidence-audit', app,
      codeDirectoryHashes, machoCount: universal.machoFiles.length, acceptance,
      note: 'Audit does not execute missing OS/device/plugin scenarios or publish a release.' }
  } catch { return { status: 'FAIL', phase: 2, stage, code: 'MAC_RELEASE_AUDIT_FAILED' } }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const seen = new Set()
    for (const arg of argv) {
      if (!arg.startsWith('--')) continue
      const name = arg.split('=')[0]
      if (seen.has(name)) throw new Error('DUPLICATE_RELEASE_OPTION')
      seen.add(name)
    }
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean' }, template: { type: 'string' },
      app: { type: 'string' }, output: { type: 'string' }, fixtures: { type: 'string' }, evidence: { type: 'string' },
      'bundle-id': { type: 'string' }, 'minimum-os': { type: 'string' }, 'team-id': { type: 'string' }, 'expect-process-arch': { type: 'string' } } })
    if (values.help) { console.log('npm run test:mac:release -- --app <signed absolute.app> --output <external absolute reports> --bundle-id <approved ID> --minimum-os <approved OS> --team-id <approved Team ID> --expect-process-arch <arm64|x64> [--evidence <absolute index.json>] | --template <new absolute index.json>'); return 0 }
    if (values.template) {
      if (!path.isAbsolute(values.template) || Object.keys(values).length !== 1) throw new Error('INVALID_TEMPLATE_OPTIONS')
      fs.mkdirSync(path.dirname(values.template), { recursive: true })
      fs.writeFileSync(values.template, JSON.stringify(macReleaseEvidenceTemplate(), null, 2) + '\n', { flag: 'wx' })
      console.log(JSON.stringify({ status: 'MANUAL_PENDING', template: values.template })); return 1
    }
    parseMacTestArguments(['--app', values.app ?? '', '--output', values.output ?? '', '--bundle-id', values['bundle-id'] ?? '',
      '--minimum-os', values['minimum-os'] ?? '', '--expect-process-arch', values['expect-process-arch'] ?? ''])
    if (values.evidence && !path.isAbsolute(values.evidence)) throw new Error('ABSOLUTE_EVIDENCE_REQUIRED')
    const startedAt = new Date().toISOString(), result = auditMacRelease(values)
    const report = { schemaVersion: 1, runId: randomUUID(), startedAt, finishedAt: new Date().toISOString(), ...result }
    fs.mkdirSync(values.output, { recursive: true })
    const reportPath = path.join(values.output, `${report.runId}.json`)
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ status: report.status, reportPath })); return report.status === 'PASS' ? 0 : 1
  } catch { console.error('MAC_RELEASE_INPUT_OR_REPORT_FAILED'); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
