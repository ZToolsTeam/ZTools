export type DockerAction = 'start' | 'stop' | 'restart' | 'remove'
export interface DockerContainer {
  id: string; name: string; image: string; state: string; status: string; ports: string; createdAt: string
  cpu: string | null; memory: string | null
}
export interface DockerSnapshot {
  sessionId: string; context: string; containers: DockerContainer[]; statsError: string | null
}
export type DockerRequest = { action: 'list' } | { action: 'cancel' } | { action: 'logs'; sessionId: string; id: string } |
  { action: 'control'; sessionId: string; id: string; operation: Exclude<DockerAction, 'remove'> } |
  { action: 'remove'; sessionId: string; ids: string[] }
export const stoppedDockerStates = new Set(['created', 'exited', 'dead'])
export function dockerRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function validContainerId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }
export function validateDockerRequest(value: unknown): asserts value is DockerRequest {
  if (!dockerRecord(value) || typeof value.action !== 'string') throw new Error('Invalid Docker request')
  const fields: Record<string, string[]> = { list: [], cancel: [], logs: ['sessionId', 'id'], control: ['sessionId', 'id', 'operation'], remove: ['sessionId', 'ids'] }
  const allowed = Object.hasOwn(fields, value.action) ? fields[value.action] : undefined
  if (!allowed || Object.keys(value).some(k => !['action', ...allowed].includes(k))) throw new Error('Invalid Docker operation parameters')
  if (['list', 'cancel'].includes(value.action)) return
  if (typeof value.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.sessionId)) throw new Error('Refresh the container list first')
  if (value.action === 'remove') {
    if (!Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 100 || !value.ids.every(validContainerId) || new Set(value.ids).size !== value.ids.length) throw new Error('Select 1 to 100 containers to prune')
  } else if (!validContainerId(value.id)) throw new Error('Invalid container ID')
  if (value.action === 'control' && (typeof value.operation !== 'string' || !['start', 'stop', 'restart'].includes(value.operation))) throw new Error('Invalid container operation')
}
