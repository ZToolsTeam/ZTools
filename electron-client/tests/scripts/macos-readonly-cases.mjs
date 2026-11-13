// These collectors execute through the real window.ztools facade in the normal App.
// Keep them self-contained: their source is serialized into the page by the CDP runner.
export async function collectMacCapabilityBaseline(sdk) {
  const ids = ['screen.capture', 'clipboard.files.read', 'system.hibernate']
  const first = await Promise.all(ids.map(id => sdk.sys.getCapability(id)))
  await new Promise(resolve => setTimeout(resolve, 250))
  const second = await Promise.all(ids.map(id => sdk.sys.getCapability(id)))
  return { first, second }
}

export async function collectMacDisplayBaseline(sdk) {
  const displays = await sdk.screen.getAllDisplays()
  const primary = await sdk.screen.getPrimaryDisplay()
  const cursor = await sdk.screen.getCursorScreenPoint()
  const nearest = await sdk.screen.getDisplayNearestPoint(cursor)
  const matching = await sdk.screen.getDisplayMatching(primary.bounds)
  return { displays, primary, cursor, nearest, matching }
}

export async function collectMacOwnedProcessBaseline(sdk, ownedPid) {
  const list = await sdk.process.list()
  const listed = list.find(item => item.pid === ownedPid)
  const info = await sdk.process.getInfo(ownedPid)
  const exists = await sdk.process.exists(ownedPid)
  const found = listed ? await sdk.process.find(listed.name) : []
  let invalidPidCode = null
  try { await sdk.process.getInfo(0) }
  catch (error) { invalidPidCode = typeof error?.code === 'string' ? error.code : null }
  // Never return or log other users'/applications' process inventory or extra fields.
  const safe = item => item ? { pid: item.pid, name: item.name, path: item.path, cpuUsage: item.cpuUsage, memoryUsage: item.memoryUsage,
    fieldAvailability: { path: item.fieldAvailability?.path, cpuUsage: item.fieldAvailability?.cpuUsage, memoryUsage: item.fieldAvailability?.memoryUsage } } : null
  return { listed: safe(listed), info: safe(info?.data), infoSuccess: info?.success, existsSuccess: exists?.success, exists: exists?.data?.exists,
    foundOwn: found.some(item => item.pid === ownedPid), invalidPidCode }
}

export function validateCapabilityBaseline(value, expectedArch) {
  const ids = ['screen.capture', 'clipboard.files.read', 'system.hibernate']
  const fail = code => ({ status: 'FAIL', code })
  if (!Array.isArray(value?.first) || !Array.isArray(value.second) || value.first.length !== 3 || value.second.length !== 3) return fail('INVALID_CAPABILITY_COLLECTION')
  for (let index = 0; index < ids.length; index++) {
    const before = value.first[index], after = value.second[index]
    for (const snapshot of [before, after]) {
      if (snapshot?.contractVersion !== 1 || snapshot.capability !== ids[index] ||
          snapshot.target?.platform !== 'macos' || snapshot.target.runtime !== 'electron' || snapshot.target.arch !== expectedArch ||
          !['supported', 'unsupported', 'unavailable'].includes(snapshot.implementation) ||
          !['granted', 'denied', 'unknown'].includes(snapshot.authorization) ||
          !['not-required', 'not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(snapshot.osPermission) ||
          !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return fail('CAPABILITY_CONTRACT_MISMATCH')
    }
    const unchanged = ['implementation', 'authorization', 'osPermission'].every(axis => before[axis] === after[axis])
    if (after.revision < before.revision || (!unchanged && after.revision === before.revision)) return fail('CAPABILITY_REVISION_MISMATCH')
  }
  return { status: 'MANUAL_PENDING', checks: 'PASS', scope: 'readonly-capability-revision-baseline', snapshots: value,
    pending: ['first permission request/rejection', 'OS setting revoke/restore', 'permission-change event/restart requirements'] }
}

export function validateDisplayBaseline(value) {
  const fail = code => ({ status: 'FAIL', code })
  const rect = item => item && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(item[key])) && item.width > 0 && item.height > 0
  const display = item => item && Number.isSafeInteger(item.id) && Number.isSafeInteger(item.index) && item.index >= 0 &&
    typeof item.name === 'string' && typeof item.primary === 'boolean' && rect(item.bounds) && rect(item.workArea) &&
    Number.isFinite(item.scaleFactor) && item.scaleFactor > 0 && item.scaleFactor <= 16 &&
    [0, 90, 180, 270].includes(item.rotation) && typeof item.touchSupport === 'string'
  if (!Array.isArray(value?.displays) || value.displays.length === 0 || value.displays.length > 64 ||
      !value.displays.every(display) || ![value.primary, value.nearest, value.matching].every(display) ||
      !value.cursor || !Number.isFinite(value.cursor.x) || !Number.isFinite(value.cursor.y)) return fail('DISPLAY_CONTRACT_MISMATCH')
  const ids = new Set(value.displays.map(item => item.id))
  const indexes = new Set(value.displays.map(item => item.index))
  if (ids.size !== value.displays.length || indexes.size !== value.displays.length ||
      value.displays.filter(item => item.primary).length !== 1 || !value.primary.primary ||
      value.displays.find(item => item.primary)?.id !== value.primary.id ||
      value.displays.some(item => item.index >= value.displays.length) ||
      ![value.primary, value.nearest, value.matching].every(item => ids.has(item.id)) ||
      value.matching.id !== value.primary.id) return fail('DISPLAY_TOPOLOGY_MISMATCH')
  return { status: 'MANUAL_PENDING', checks: 'PASS', scope: 'readonly-display-coordinate-baseline', snapshot: value,
    pending: ['Retina/non-Retina mixed calibration', 'screen disconnect/Space/fullscreen', 'capture pixel/selection calibration', 'AX denial/cancellation'] }
}

export function validateOwnedProcessBaseline(value, ownedPid) {
  const valid = item => item?.pid === ownedPid && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 512 &&
    typeof item.path === 'string' && item.path === '' && item.fieldAvailability?.path === false &&
    typeof item.fieldAvailability.cpuUsage === 'boolean' && typeof item.fieldAvailability.memoryUsage === 'boolean' &&
    Number.isFinite(item.cpuUsage) && item.cpuUsage >= 0 && Number.isSafeInteger(item.memoryUsage) && item.memoryUsage >= 0
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0 || ownedPid > 0x7fffffff || !valid(value?.listed) || !valid(value.info) ||
      value.infoSuccess !== true || value.existsSuccess !== true || value.listed.name !== value.info.name ||
      value.exists !== true || value.foundOwn !== true || value.invalidPidCode !== 'INVALID_REQUEST') {
    return { status: 'FAIL', code: 'OWNED_PROCESS_CONTRACT_MISMATCH' }
  }
  return { status: 'MANUAL_PENDING', checks: 'PASS', scope: 'readonly-owned-process-baseline', snapshot: value,
    pending: ['managed App/tool spawn/env/argv', 'nonzero/crash/cancel/PID reuse', 'port SDK discovery/permission denial', 'lan-share session stop/revoke'] }
}
