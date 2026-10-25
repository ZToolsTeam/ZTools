export type IOType = 'input' | 'output'

export type AudioPlatform = 'Windows' | 'macOS'

export enum TransportType {
  Avb = 'avb',
  Aggregate = 'aggregate',
  Airplay = 'airplay',
  Autoaggregate = 'autoaggregate',
  Bluetooth = 'bluetooth',
  BluetoothLowEnergy = 'bluetoothle',
  BuiltIn = 'builtin',
  DisplayPort = 'displayport',
  Firewire = 'firewire',
  HDMI = 'hdmi',
  PCI = 'pci',
  Thunderbolt = 'thunderbolt',
  Usb = 'usb',
  Virtual = 'virtual',
  Headphones = 'headphones',
  Microphone = 'microphone',
  Speakers = 'speakers',
  SPDIF = 'spdif',
  Unknown = 'unknown'
}

export interface AudioDevice {
  id: string
  uid: string
  name: string
  type: IOType
  isInput: boolean
  isOutput: boolean
  isDefault: boolean
  isCommunicationDefault?: boolean
  volume: number
  isMuted: boolean
  transportType: TransportType | string
  sampleRate?: number
  channels?: number
  isFavourite?: boolean
  isHidden?: boolean
}

export interface AudioComboPreset {
  id: string
  name: string
  description: string
  outputDeviceId: string
  inputDeviceId: string
  outputVolume?: number
  inputVolume?: number
  muteInput?: boolean
  shortcut?: string
}

export interface AudioFilterOptions {
  ioType?: IOType | 'all' | 'favourites'
  transportType?: TransportType | string | 'all'
  query?: string
  includeHidden?: boolean
}

export interface AudioPlatformCommand {
  platform: AudioPlatform
  executable: string
  args: string[]
  commandLine: string
  description: string
}

export interface AudioActionResult {
  success: boolean
  action:
    | 'switch-default'
    | 'set-volume'
    | 'step-volume'
    | 'toggle-mute'
    | 'toggle-favourite'
    | 'apply-combo'
  device?: AudioDevice
  combo?: AudioComboPreset
  command?: AudioPlatformCommand
  errorCode?: string
  error?: string
}
