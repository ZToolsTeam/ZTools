import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import plist from 'plist'
import { NETWORK_ENTITLEMENT } from './macos-network-bundle.mjs'

/** 描述文件只授权固定的网络辅助进程，不照抄文件中的其它权限。 */
export function validateNetworkProfile(profile, { bundleId, identity, identities, now = new Date() }) {
  const team = /^Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\)$/.exec(identity ?? '')?.[1]
  const entitlements = profile?.Entitlements
  const prefix = profile?.ApplicationIdentifierPrefix
  const applicationId = entitlements?.['com.apple.application-identifier']
  if (!team || profile?.TeamIdentifier?.length !== 1 || profile.TeamIdentifier[0] !== team ||
      entitlements?.['com.apple.developer.team-identifier'] !== team) throw new Error('NETWORK_PROFILE_TEAM_MISMATCH')
  if (!Array.isArray(prefix) || prefix.length !== 1 || !/^[A-Z0-9]{10}$/.test(prefix[0]) ||
      applicationId !== `${prefix[0]}.${bundleId}`) throw new Error('NETWORK_PROFILE_APP_MISMATCH')
  if (!Array.isArray(profile.Platform) || !profile.Platform.includes('OSX') || profile.ProvisionsAllDevices !== true ||
      profile.ProvisionedDevices !== undefined || entitlements['com.apple.security.get-task-allow'] === true)
    throw new Error('NETWORK_PROFILE_DEVELOPER_ID_REQUIRED')
  if (!(profile.CreationDate instanceof Date) || !(profile.ExpirationDate instanceof Date) ||
      !Number.isFinite(+profile.CreationDate) || !Number.isFinite(+profile.ExpirationDate) ||
      +profile.CreationDate > +now || +profile.ExpirationDate <= +now) throw new Error('NETWORK_PROFILE_EXPIRED')
  if (entitlements[NETWORK_ENTITLEMENT] !== true) throw new Error('NETWORK_PROFILE_CAPABILITY_MISSING')
  const matching = String(identities).split(/\r?\n/).map(line => /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"/.exec(line))
    .filter(match => match?.[2] === identity)
  const allowedCertificates = Array.isArray(profile.DeveloperCertificates) ? profile.DeveloperCertificates : []
  if (matching.length !== 1 || !allowedCertificates.some(cert => Buffer.isBuffer(cert) &&
      createHash('sha1').update(cert).digest('hex').toLowerCase() === matching[0][1].toLowerCase()))
    throw new Error('NETWORK_PROFILE_CERTIFICATE_MISMATCH')
  return { 'com.apple.application-identifier': applicationId,
    'com.apple.developer.team-identifier': team, [NETWORK_ENTITLEMENT]: true }
}

export function loadNetworkProfile({ profilePath, bundleId, identity }, { fsApi = fs, exec = execFileSync, now } = {}) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) throw new Error('NETWORK_PROFILE_REQUIRED')
  const stat = fsApi.lstatSync(profilePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('NETWORK_PROFILE_INVALID')
  const bytes = fsApi.readFileSync(profilePath)
  const options = { encoding: 'utf8', shell: false, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }
  // 解码和嵌入使用同一份快照，避免检查后文件变动。
  const profile = plist.parse(exec('/usr/bin/security', ['cms', '-D'], { ...options, input: bytes }))
  const identities = exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], options)
  return { bytes, entitlements: validateNetworkProfile(profile, { bundleId, identity, identities, now }) }
}

export function embedNetworkProfile({ bundlePath, profile, entitlementsPath, fsApi = fs }) {
  fsApi.writeFileSync(path.join(bundlePath, 'Contents', 'embedded.provisionprofile'), profile.bytes, { flag: 'wx', mode: 0o644 })
  fsApi.writeFileSync(entitlementsPath, plist.build(profile.entitlements), { flag: 'wx', mode: 0o600 })
}

export function verifyNetworkEntitlements(output, expected) {
  const actual = plist.parse(output)
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => actual[key] !== value))
    throw new Error('NETWORK_SIGNED_ENTITLEMENTS_MISMATCH')
}
