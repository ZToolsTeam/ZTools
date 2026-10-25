export type ContainerStatusFilter = 'all' | 'running' | 'exited'

export interface ContainerSummary {
  id: string
  name: string
  image: string
  statusDisplay: string
  isRunning: boolean
  primaryPort?: string
  webUrl?: string
  portsDisplay: string
  createdFormatted: string
  tailLogs?: string
}
