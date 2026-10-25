export interface NetworkInterfaceInfo {
  name: string
  ip: string
  subnetMask: string
  subnetDisplay: string
  broadcastIp: string
}

export interface LanDevice {
  ip: string
  mac?: string
  vendor?: string
  hostname?: string
  customName?: string
  pingMs: number
  openPorts: number[]
  openPortsText: string
  openPortsMarkdown?: string
  primaryWebUrl?: string
  hasRdp: boolean
  isFavorite: boolean
}
