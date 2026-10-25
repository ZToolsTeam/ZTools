export interface SshHostEntry {
  host: string
  hostName: string
  user?: string
  port?: number
  identityFile?: string
  identityFileShort?: string
  proxyJump?: string
  localForwards?: string[]
}

export interface ProxyStatus {
  isEnabled: boolean
  port: number
  isGitSet: boolean
  isNpmSet: boolean
  detectedPorts: number[]
}
