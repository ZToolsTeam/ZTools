const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export function validateOwnedMacBrowserProcess(value, ownedPid) {
  const info = value?.processInfo
  if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0 || !Array.isArray(info) || info.length === 0 || info.length > 4096) {
    throw new Error('OWNED_CDP_PROCESS_MISMATCH')
  }
  const browsers = info.filter(item => item?.type === 'browser')
  if (browsers.length !== 1 || browsers[0].id !== ownedPid) throw new Error('OWNED_CDP_PROCESS_MISMATCH')
}

// Only the retained child may be signalled. A leader exit does not prove descendant cleanup.
export async function cleanupOwnedMacApp({ child, hasExited, closeBrowser, waitMs = 5000, now = Date.now, pause = delay }) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new Error('INVALID_CLEANUP_TIMEOUT')
  let signalled = false
  const wait = async () => {
    const deadline = now() + waitMs
    while (!hasExited() && now() < deadline) await pause(50)
  }
  if (!hasExited()) {
    await closeBrowser().catch(() => {})
    await wait()
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (hasExited()) break
    signalled = true
    try { child.kill(signal) } catch { /* Keep the actual exit state authoritative. */ }
    await wait()
  }
  return { cleanup: !hasExited() ? 'OWNED_PROCESS_EXIT_TIMEOUT' : signalled
    ? 'SIGNALLED_LEADER_EXITED_DESCENDANTS_UNVERIFIED' : 'OWNED_PROCESS_EXITED',
  signalled, descendantAcceptance: 'requires-native-exit-tests' }
}
