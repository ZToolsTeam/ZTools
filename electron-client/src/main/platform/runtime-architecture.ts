export type NativeOsArchitecture = 'x86' | 'x64' | 'arm64' | 'unknown'

export interface RuntimeArchitectureInput {
  platform: NodeJS.Platform
  processArch: string
  runningUnderARM64Translation: boolean | null
  processorArchitecture?: string | undefined
  processorArchitew6432?: string | undefined
}

export interface RuntimeArchitectureInfo {
  nativeOsArch: NativeOsArchitecture
  wow64: boolean | null
}

function normalizeWindowsArchitecture(value: string | undefined): NativeOsArchitecture {
  switch (value?.trim().toUpperCase()) {
    case 'X86':
    case 'IA32':
    case 'INTEL':
      return 'x86'
    case 'AMD64':
    case 'X64':
    case 'EM64T':
      return 'x64'
    case 'ARM64':
      return 'arm64'
    default:
      return 'unknown'
  }
}

function normalizeProcessArchitecture(processArch: string): NativeOsArchitecture {
  switch (processArch) {
    case 'ia32': return 'x86'
    case 'x64': return 'x64'
    case 'arm64': return 'arm64'
    default: return 'unknown'
  }
}

function windowsArchitecture(input: RuntimeArchitectureInput): RuntimeArchitectureInfo {
  const processArchitecture = normalizeProcessArchitecture(input.processArch)
  // A native arm64 process is already using the host architecture, not WOW64.
  if (processArchitecture === 'arm64') {
    return { nativeOsArch: 'arm64', wow64: false }
  }

  const nativeFromWow64Environment = normalizeWindowsArchitecture(input.processorArchitew6432)
  const processEnvironmentArchitecture = normalizeWindowsArchitecture(input.processorArchitecture)
  const nativeOsArch = nativeFromWow64Environment !== 'unknown'
    ? nativeFromWow64Environment
    : input.runningUnderARM64Translation === true &&
        (processArchitecture === 'x86' || processArchitecture === 'x64')
      ? 'arm64'
      : processEnvironmentArchitecture !== 'unknown'
        ? processEnvironmentArchitecture
        : processArchitecture === 'x64'
          ? 'x64'
          : 'unknown'

  let wow64: boolean | null = null
  if (processArchitecture !== 'unknown' && nativeOsArch !== 'unknown') {
    if (processArchitecture === 'x86') wow64 = nativeOsArch !== 'x86'
    else wow64 = processArchitecture !== nativeOsArch
  }
  return { nativeOsArch, wow64 }
}

function macosArchitecture(input: RuntimeArchitectureInput): RuntimeArchitectureInfo {
  const processArchitecture = normalizeProcessArchitecture(input.processArch)
  if (input.runningUnderARM64Translation === true && processArchitecture === 'x64') {
    return { nativeOsArch: 'arm64', wow64: null }
  }
  if (input.runningUnderARM64Translation === false &&
      (processArchitecture === 'x64' || processArchitecture === 'arm64')) {
    return { nativeOsArch: processArchitecture, wow64: null }
  }
  return { nativeOsArch: 'unknown', wow64: null }
}

export function resolveRuntimeArchitecture(
  input: RuntimeArchitectureInput
): RuntimeArchitectureInfo {
  switch (input.platform) {
    case 'win32': return windowsArchitecture(input)
    case 'darwin': return macosArchitecture(input)
    default: return { nativeOsArch: 'unknown', wow64: null }
  }
}
