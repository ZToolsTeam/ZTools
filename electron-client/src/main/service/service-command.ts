import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export const SERVICE_COMMAND_MAGIC = 0x31434d53
export const SERVICE_COMMAND_VERSION = 1
export const SERVICE_COMMAND_HEADER_BYTES = 24
export const SERVICE_POLICY_STATUS_MAGIC = 0x3150535a
export const SERVICE_POLICY_STATUS_VERSION = 1
export const SERVICE_POLICY_STATUS_BYTES = 12

const POLICY_CHECK_COMMAND = 1
const DLL_CALL_COMMAND = 0x100
const DLL_CALL_ASYNC_COMMAND = 0x106
const DLL_QUERY_TASK_COMMAND = 0x107
const DLL_CALL_WITH_CALLBACK_COMMAND = 0x102
const DLL_CANCEL_TASK_COMMAND = 0x103
const DLL_CLEAR_TASK_COMMAND = 0x104
const RESTART_EXPLORER_COMMAND = 0x500
const SERVICE_DLL_PAYLOAD_BYTES = 256 * 1024
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const POLICY_FLAG_MANIFEST_TRUSTED = 1
const POLICY_FLAG_SYSTEM_ONLY_DEPENDENCIES = 2
const POLICY_KNOWN_FLAGS =
  POLICY_FLAG_MANIFEST_TRUSTED | POLICY_FLAG_SYSTEM_ONLY_DEPENDENCIES

export interface ServicePolicyStatus {
  manifestTrusted: boolean
  systemOnlyDependencies: boolean
  allowedTargetCount: number
}

export interface ServiceDllTaskStatus {
  taskId: string
  mode: 'async' | 'callback'
  status: 'invoking' | 'running' | 'completed' | 'cancelled' | 'error'
  progress: number
  functionName: string
  error: string | null
  resultReady?: boolean
  result?: string | null
  callbackResults?: string[]
}

function encodeFixedCommand(
  type: number,
  fields: {
    pluginId?: string
    targetId?: string
    dllId?: string
    functionName?: string
    payload?: string
  }
): Buffer {
  const pluginId = Buffer.from(fields.pluginId ?? '', 'ascii')
  const targetId = Buffer.from(fields.targetId ?? '', 'ascii')
  const dllId = Buffer.from(fields.dllId ?? '', 'ascii')
  const functionName = Buffer.from(fields.functionName ?? '', 'ascii')
  const payload = Buffer.from(fields.payload ?? '', 'utf8')
  const command = Buffer.alloc(
    SERVICE_COMMAND_HEADER_BYTES + pluginId.length + targetId.length +
      dllId.length + functionName.length + payload.length
  )
  command.writeUInt32LE(SERVICE_COMMAND_MAGIC, 0)
  command.writeUInt16LE(SERVICE_COMMAND_VERSION, 4)
  command.writeUInt16LE(type, 6)
  command.writeUInt16LE(pluginId.length, 12)
  command.writeUInt16LE(targetId.length, 14)
  command.writeUInt16LE(dllId.length, 16)
  command.writeUInt16LE(functionName.length, 18)
  command.writeUInt32LE(payload.length, 20)
  let offset = SERVICE_COMMAND_HEADER_BYTES
  for (const field of [pluginId, targetId, dllId, functionName, payload]) {
    field.copy(command, offset)
    offset += field.length
  }
  return command
}

function decodeJsonObject(payload: Uint8Array): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService JSON 响应无效')
  }
}

export function encodeServicePolicyCheck(): Buffer {
  const command = Buffer.alloc(SERVICE_COMMAND_HEADER_BYTES)
  command.writeUInt32LE(SERVICE_COMMAND_MAGIC, 0)
  command.writeUInt16LE(SERVICE_COMMAND_VERSION, 4)
  command.writeUInt16LE(POLICY_CHECK_COMMAND, 6)
  return command
}

export function encodeServiceSubscribeTaskEvents(): Buffer {
  const command = encodeServicePolicyCheck()
  command.writeUInt16LE(0x108, 6)
  return command
}

export function encodeServiceContextMenuCheckAdmin(): Buffer {
  return encodeServiceDllCall('context-menu', 'ContextMenuPlugin', 'CheckAdmin', {})
}

export function encodeServiceDllCall(
  pluginId: string,
  dllId: string,
  functionName: string,
  params: Record<string, unknown>
): Buffer {
  if (!SAFE_IDENTIFIER.test(pluginId) || !SAFE_IDENTIFIER.test(dllId) ||
      !SAFE_IDENTIFIER.test(functionName)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 调用标识无效')
  }
  let payload: string
  try {
    payload = JSON.stringify(params)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 参数不可序列化')
  }
  if (Buffer.byteLength(payload, 'utf8') > SERVICE_DLL_PAYLOAD_BYTES) {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 参数过大')
  }
  return encodeFixedCommand(DLL_CALL_COMMAND, {
    pluginId,
    dllId,
    functionName,
    payload
  })
}

function encodeServiceDllTaskCall(
  command: number,
  pluginId: string,
  dllId: string,
  functionName: string,
  taskId: string,
  params: Record<string, unknown>
): Buffer {
  if (!SAFE_IDENTIFIER.test(pluginId) || !SAFE_IDENTIFIER.test(dllId) ||
      !SAFE_IDENTIFIER.test(functionName) || !/^task_[A-Za-z0-9_-]{1,123}$/.test(taskId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 任务标识无效')
  }
  let payload: string
  try {
    payload = JSON.stringify({ ...params, taskId })
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 参数不可序列化')
  }
  if (Buffer.byteLength(payload, 'utf8') > SERVICE_DLL_PAYLOAD_BYTES) {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 参数过大')
  }
  return encodeFixedCommand(command, {
    pluginId,
    dllId,
    functionName,
    payload
  })
}

export function encodeServiceDllCallAsync(
  pluginId: string,
  dllId: string,
  functionName: string,
  taskId: string,
  params: Record<string, unknown>
): Buffer {
  return encodeServiceDllTaskCall(
    DLL_CALL_ASYNC_COMMAND, pluginId, dllId, functionName, taskId, params
  )
}

export function encodeServiceDllCallWithCallback(
  pluginId: string,
  dllId: string,
  functionName: string,
  taskId: string,
  params: Record<string, unknown>
): Buffer {
  return encodeServiceDllTaskCall(
    DLL_CALL_WITH_CALLBACK_COMMAND, pluginId, dllId, functionName, taskId, params
  )
}

function encodeServiceDllTaskControl(command: number, pluginId: string, dllId: string, taskId: string): Buffer {
  if (!SAFE_IDENTIFIER.test(pluginId) || !SAFE_IDENTIFIER.test(dllId) ||
      !/^task_[A-Za-z0-9_-]{1,123}$/.test(taskId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'ZToolsService DLL 任务标识无效')
  }
  return encodeFixedCommand(command, { pluginId, dllId, payload: taskId })
}

export function encodeServiceDllTaskQuery(pluginId: string, dllId: string, taskId: string): Buffer {
  return encodeServiceDllTaskControl(DLL_QUERY_TASK_COMMAND, pluginId, dllId, taskId)
}

export function encodeServiceDllTaskCancel(pluginId: string, dllId: string, taskId: string): Buffer {
  return encodeServiceDllTaskControl(DLL_CANCEL_TASK_COMMAND, pluginId, dllId, taskId)
}

export function encodeServiceDllTaskClear(pluginId: string, dllId: string, taskId: string): Buffer {
  return encodeServiceDllTaskControl(DLL_CLEAR_TASK_COMMAND, pluginId, dllId, taskId)
}

export function encodeServiceContextMenuRestartExplorer(): Buffer {
  return encodeFixedCommand(RESTART_EXPLORER_COMMAND, {
    pluginId: 'context-menu',
    targetId: 'restart-explorer'
  })
}

export function decodeServiceContextMenuCheckAdmin(payload: Uint8Array): boolean {
  const result = decodeJsonObject(payload)
  if (Object.keys(result).length !== 2 || result.success !== true ||
      typeof result.isAdmin !== 'boolean') {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService CheckAdmin 响应无效')
  }
  return result.isAdmin
}

export function decodeServiceDllCall(payload: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 响应不是有效 UTF-8')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function decodeServiceDllTaskId(payload: Uint8Array, taskId: string): void {
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务响应不是有效 UTF-8')
  }
  if (value !== taskId) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务响应无效')
  }
}

export function decodeServiceDllTaskStatus(payload: Uint8Array, taskId: string): ServiceDllTaskStatus {
  const value = decodeJsonObject(payload)
  const modes = new Set(['async', 'callback'])
  const states = new Set(['invoking', 'running', 'completed', 'cancelled', 'error'])
  if (
    value.taskId !== taskId || !modes.has(String(value.mode)) ||
    !states.has(String(value.status)) || !Number.isInteger(value.progress) ||
    Number(value.progress) < 0 || Number(value.progress) > 100 ||
    typeof value.functionName !== 'string' ||
    (value.error !== null && typeof value.error !== 'string')
  ) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务状态无效')
  }
  if (value.resultReady !== undefined && typeof value.resultReady !== 'boolean') {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务结果状态无效')
  }
  if (value.result !== undefined && value.result !== null && typeof value.result !== 'string') {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务结果无效')
  }
  if (value.callbackResults !== undefined &&
      (!Array.isArray(value.callbackResults) ||
       !value.callbackResults.every((item) => typeof item === 'string'))) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 回调结果无效')
  }
  return value as unknown as ServiceDllTaskStatus
}

export function decodeServiceDllTaskCode(payload: Uint8Array): number {
  const value = decodeJsonObject(payload)
  if (Object.keys(value).length !== 1 || !Number.isInteger(value.code)) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务响应无效')
  }
  return value.code as number
}

export function decodeServiceDllTaskSuccess(payload: Uint8Array): void {
  const value = decodeJsonObject(payload)
  if (Object.keys(value).length !== 1 || value.success !== true) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService DLL 任务清理响应无效')
  }
}

export function decodeServiceContextMenuRestartExplorer(payload: Uint8Array): void {
  const result = decodeJsonObject(payload)
  if (Object.keys(result).length !== 1 || result.success !== true) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService Explorer 响应无效')
  }
}

export function decodeServicePolicyStatus(payload: Uint8Array): ServicePolicyStatus {
  if (!(payload instanceof Uint8Array) || payload.byteLength !== SERVICE_POLICY_STATUS_BYTES) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 策略状态长度无效')
  }
  const status = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  const flags = status.readUInt16LE(6)
  if (status.readUInt32LE(0) !== SERVICE_POLICY_STATUS_MAGIC ||
      status.readUInt16LE(4) !== SERVICE_POLICY_STATUS_VERSION ||
      (flags & ~POLICY_KNOWN_FLAGS) !== 0) {
    throw new ZToolsError(errorCodes.serviceProtocol, 'ZToolsService 策略状态格式无效')
  }
  return {
    manifestTrusted: (flags & POLICY_FLAG_MANIFEST_TRUSTED) !== 0,
    systemOnlyDependencies: (flags & POLICY_FLAG_SYSTEM_ONLY_DEPENDENCIES) !== 0,
    allowedTargetCount: status.readUInt32LE(8)
  }
}
