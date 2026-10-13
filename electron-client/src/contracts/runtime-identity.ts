export type RuntimeIdentityArchitecture = 'ia32' | 'x64' | 'arm64' | 'unknown'
export type RuntimeIdentityTranslationMode =
  | 'native'
  | 'translated'
  | 'compatibility'
  | 'not-applicable'
  | 'unknown'

export interface RuntimeIdentityTarget {
  id?: string
  platform: 'windows' | 'macos'
  runtime: 'electron'
  arch: 'ia32' | 'x64' | 'arm64' | 'universal'
}

export interface RuntimeIdentity {
  contractVersion: 1
  appVersion: string
  target: RuntimeIdentityTarget
  os: {
    productVersion: string
    kernelVersion?: string
    arch: RuntimeIdentityArchitecture
  }
  process: {
    arch: RuntimeIdentityArchitecture
    translationMode: RuntimeIdentityTranslationMode
  }
  nativeHost: {
    state: 'not-applicable' | 'available' | 'unavailable' | 'unknown'
    arch: RuntimeIdentityArchitecture
    protocolVersion: number | null
  }
}
