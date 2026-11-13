import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createMacFixtures, verifyMacFixtures } from './macos-fixtures.mjs'

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b)
const devicePattern = /^\/dev\/disk\d+(?:s\d+)*$/
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

function defaultTools(tool, args) {
  return execFileSync(tool, args, { shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
}

function defaultPlist(xml) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: xml, shell: false, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024
  }))
}

export function verifyOwnedApfsVolume(volume, { run = defaultTools, parsePlist = defaultPlist } = {}) {
  if (!devicePattern.test(volume.device) || !uuidPattern.test(volume.uuid)) throw new Error('INVALID_VOLUME_IDENTITY')
  const images = parsePlist(run('/usr/bin/hdiutil', ['info', '-plist']))
  const image = images.images?.find(item => samePath(item['image-path'], volume.image))
  if (!image?.['system-entities']?.some(entity => entity['dev-entry'] === volume.device && samePath(entity['mount-point'], volume.mount))) {
    throw new Error('OWNED_IMAGE_MISMATCH')
  }
  const info = parsePlist(run('/usr/sbin/diskutil', ['info', '-plist', volume.device]))
  if (info.VolumeUUID !== volume.uuid || info.DeviceNode !== volume.device || !samePath(info.MountPoint, volume.mount) ||
      info.FilesystemType !== 'apfs') throw new Error('OWNED_VOLUME_MISMATCH')
  return info
}

function probeCaseSensitivity(mount, expected) {
  fs.writeFileSync(path.join(mount, 'CaseProbe'), 'synthetic upper', { flag: 'wx' })
  let sensitive = true
  try { fs.writeFileSync(path.join(mount, 'caseprobe'), 'synthetic lower', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error; sensitive = false }
  if (sensitive !== expected) throw new Error('APFS_CASE_BEHAVIOR_MISMATCH')
  return sensitive
}

// execute receives both mounted owned volumes. No physical disk erase, sudo, forced detach,
// global TCC change or recursive deletion occurs. Images remain for evidence after detach.
export async function withMacApfsFixtures(outputRoot, execute = async volumes => ({ status: 'PASS', cases: volumes.map(volume => verifyMacFixtures(volume.fixtures)) }), {
  platform = process.platform, run = defaultTools, parsePlist = defaultPlist, probe = probeCaseSensitivity,
  createFixtures = createMacFixtures, signal
} = {}) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', cleanup: [] }
  signal?.throwIfAborted()
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('ABSOLUTE_FIXTURE_ROOT_REQUIRED')
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
  fs.mkdirSync(outputRoot)
  const root = fs.realpathSync(outputRoot), runId = randomUUID(), volumes = [], cleanup = []
  let status = 'FAIL', code, results, pendingAttachment
  const checkpoint = () => fs.writeFileSync(path.join(root, 'apfs-run.json'), JSON.stringify({ version: 1, runId, root, status, code, volumes, cleanup, results, pendingAttachment }, null, 2) + '\n')
  try {
    for (const sensitive of [false, true]) {
      signal?.throwIfAborted()
      const label = sensitive ? 'case-sensitive' : 'case-insensitive'
      const image = path.join(root, `${label}.sparseimage`)
      const mount = path.join(root, label)
      fs.mkdirSync(mount)
      run('/usr/bin/hdiutil', ['create', '-size', '256m', '-type', 'SPARSE', '-fs',
        sensitive ? 'Case-sensitive APFS' : 'APFS', '-volname', `ZTools-${runId.slice(0, 8)}-${label}`, image])
      signal?.throwIfAborted()
      pendingAttachment = { image, mount }
      checkpoint()
      const attached = parsePlist(run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, '-plist', image]))
      const entity = attached['system-entities']?.find(item => samePath(item['mount-point'], mount))
      if (!devicePattern.test(entity?.['dev-entry'] ?? '')) throw new Error('INVALID_ATTACHED_DEVICE')
      const info = parsePlist(run('/usr/sbin/diskutil', ['info', '-plist', entity['dev-entry']]))
      const volume = { image, mount, device: entity['dev-entry'], uuid: info.VolumeUUID, caseSensitive: sensitive }
      volumes.push(volume)
      pendingAttachment = undefined
      checkpoint() // Preserve device evidence before any later probe/fixture failure.
      verifyOwnedApfsVolume(volume, { run, parsePlist })
      probe(mount, sensitive)
      volume.fixtures = path.join(mount, 'fixtures')
      await createFixtures(volume.fixtures)
      checkpoint()
      signal?.throwIfAborted()
    }
    signal?.throwIfAborted()
    results = await execute(volumes, signal)
    signal?.throwIfAborted()
    if (results?.status !== 'PASS') throw new Error('APFS_CASE_FAILED')
    status = 'PASS'
  } catch (error) {
    code = /^[A-Z_]+$/.test(error.message) ? error.message : 'APFS_FIXTURE_FAILED'
  } finally {
    if (pendingAttachment) cleanup.push({ image: pendingAttachment.image, status: 'FAIL', code: 'ATTACH_OUTCOME_UNKNOWN' })
    for (const volume of [...volumes].reverse()) {
      try {
        verifyOwnedApfsVolume(volume, { run, parsePlist })
        run('/usr/bin/hdiutil', ['detach', volume.device])
        const remaining = parsePlist(run('/usr/bin/hdiutil', ['info', '-plist']))
        if (remaining.images?.some(image => samePath(image['image-path'], volume.image) &&
            image['system-entities']?.some(entity => samePath(entity['mount-point'], volume.mount)))) throw new Error('VOLUME_STILL_MOUNTED')
        cleanup.push({ device: volume.device, status: 'OWNED_VOLUME_DETACHED' })
      } catch {
        cleanup.push({ device: volume.device, status: 'FAIL', code: 'OWNED_VOLUME_DETACH_REFUSED_OR_FAILED' })
        status = 'FAIL'
      }
    }
    checkpoint()
  }
  return { status, code, runId, root, volumes, cleanup, results }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({ args: argv, options: { output: { type: 'string' }, help: { type: 'boolean' } } })
    if (values.help) { console.log('npm run test:mac:fixtures:apfs -- --output <fresh absolute run directory>'); return 0 }
    const controller = new AbortController()
    const onStop = () => controller.abort(new Error('APFS_CANCELLED'))
    process.once('SIGINT', onStop)
    process.once('SIGTERM', onStop)
    let result
    try { result = await withMacApfsFixtures(values.output, undefined, { signal: controller.signal }) }
    finally { process.off('SIGINT', onStop); process.off('SIGTERM', onStop) }
    console.log(JSON.stringify(result))
    return result.status === 'PASS' ? 0 : 1
  } catch { console.error('APFS_FIXTURE_FAILED'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
