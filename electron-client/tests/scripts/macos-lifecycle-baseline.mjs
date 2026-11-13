export function macAppLaunchCommand(executable, expectedArch, port) {
  if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0') ||
      !['arm64', 'x64'].includes(expectedArch) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('INVALID_MAC_LAUNCH_OPTIONS')
  }
  return { executable: '/usr/bin/arch', args: [expectedArch === 'arm64' ? '-arm64' : '-x86_64', executable,
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] }
}

// Normal launch -> SDK snapshot -> bounded quit, twice; no task replay or data mutation.
export async function runMacLifecycleBaseline(options, runApp) {
  const cycles = []
  for (let index = 0; index < 2; index += 1) {
    const result = await runApp({ ...options, case: 'M01', plugin: undefined })
    cycles.push(result)
    if (result.preflight.status !== 'PASS' || result.cleanup !== 'OWNED_PROCESS_EXITED' ||
        result.cases.length !== 1 || result.cases[0].status !== 'PASS' || !Number.isSafeInteger(result.ownedPid) || result.ownedPid <= 0) {
      return { preflight: result.preflight, cycles, cleanup: result.cleanup,
        cases: [{ caseId: 'M02', status: result.preflight.status === 'NOT_RUN' ? 'NOT_RUN' : 'FAIL', code: 'LIFECYCLE_BASELINE_INCOMPLETE' }] }
    }
  }
  const [first, second] = cycles.map(cycle => cycle.cases[0].identity)
  if (first.appVersion !== second.appVersion || first.process.arch !== second.process.arch ||
      JSON.stringify(first.target) !== JSON.stringify(second.target)) return {
    preflight: cycles[1].preflight, cycles, cleanup: 'OWNED_PROCESS_EXITED',
    cases: [{ caseId: 'M02', status: 'FAIL', code: 'RESTART_RUNTIME_IDENTITY_CHANGED' }]
  }
  return { preflight: cycles[1].preflight, cycles, cleanup: 'OWNED_PROCESS_EXITED',
    cases: [{ caseId: 'M02', status: 'MANUAL_PENDING', checks: 'PASS', scope: 'normal-start-quit-restart-readonly-baseline',
      pending: ['open-file-open-url', 'dock-menu-login-item', 'active-task-exit', 'native-descendant-cleanup', 'crash-recovery', 'state-persistence'] }] }
}
