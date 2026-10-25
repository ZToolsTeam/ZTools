export type WifiSecurityType =
  | 'WPA3-Personal'
  | 'WPA2-Personal'
  | 'WPA/WPA2-Personal'
  | 'WPA2-Enterprise'
  | 'WPA3-Enterprise'
  | 'WEP'
  | 'Open'
  | 'Unknown'

export type WifiBand =
  | '2.4 GHz'
  | '5 GHz'
  | '6 GHz'
  | 'Dual-Band (2.4/5 GHz)'
  | 'Unknown'

export type WifiSortBy = 'connected' | 'signal' | 'ssid' | 'security'

export type WifiSecurityFilter = 'all' | 'wpa3' | 'wpa2' | 'open' | 'enterprise' | 'connected'

export interface WifiProfileInfo {
  id: string
  ssid: string
  password: string
  authType: WifiSecurityType
  cipher?: string
  band?: WifiBand
  isConnected?: boolean
  isOpenNetwork?: boolean
  isEnterprise?: boolean
  signalPercent?: number
  interfaceName?: string
  lastConnected?: string
  pinyin?: string
  notes?: string
}

export type WifiErrorCode =
  | 'ProfileNotFound'
  | 'PermissionDenied'
  | 'EnterpriseNetwork'
  | 'InvalidInput'
  | 'ExecutionFailed'
  | 'Unknown'

export interface WifiParseError {
  code: WifiErrorCode
  message: string
}

export interface WifiParseDetailResult {
  ssid: string
  password: string
  authType: WifiSecurityType
  cipher: string
  isOpenNetwork: boolean
  isEnterprise: boolean
  error?: WifiParseError
}

export interface CommandExecOutput {
  stdout: string
  stderr?: string
  exitCode?: number
}

export type WifiCommandExecutor = (
  command: string,
  args?: string[]
) => Promise<CommandExecOutput | string>

export interface FetchWifiProfilesOptions {
  platform?: 'win32' | 'darwin' | 'linux'
  executor?: WifiCommandExecutor
  fallbackToSample?: boolean
  interfaceName?: string
  hostOverride?: unknown
}
