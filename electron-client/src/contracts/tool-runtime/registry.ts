import type { ToolDomainId, ToolRuntimePermission } from './common.js'
import {
  DOWNLOAD_DOMAIN_ID,
  DOWNLOAD_IPC_METHODS,
  DOWNLOAD_PRIMITIVE_IDS,
  type DownloadIpcMethod,
  type DownloadPrimitiveId
} from './domains/download.js'
import {
  MEDIA_DOMAIN_ID,
  MEDIA_IPC_METHODS,
  MEDIA_PRIMITIVE_IDS,
  type MediaIpcMethod,
  type MediaPrimitiveId
} from './domains/media.js'

/**
 * 宿主薄原语单一事实总表（Single Source of Truth）
 * 任何新增能力域或薄原语必须在此集中登记，并严格映射到 contracts/tool-runtime/domains/<domain>.ts 与 main/tool-runtime/domains/<domain>/。
 */

export type ToolPrimitiveId = MediaPrimitiveId | DownloadPrimitiveId

export const TOOL_RUNTIME_CORE_IPC_METHODS = [
  'tool_runtime_capabilities',
  'tool_runtime_ensure',
  'tool_task_cancel'
] as const

export const TOOL_RUNTIME_ADMIN_IPC_METHODS = [
  'tool_commonlibs_list',
  'tool_commonlibs_clean'
] as const

export type ToolRuntimeCoreIpcMethod = (typeof TOOL_RUNTIME_CORE_IPC_METHODS)[number]
export type ToolRuntimeAdminIpcMethod = (typeof TOOL_RUNTIME_ADMIN_IPC_METHODS)[number]
export type ToolRuntimeDomainIpcMethod = MediaIpcMethod | DownloadIpcMethod
export type ToolRuntimeIpcMethod =
  | ToolRuntimeCoreIpcMethod
  | ToolRuntimeAdminIpcMethod
  | ToolRuntimeDomainIpcMethod

export const TOOL_RUNTIME_DOMAIN_IDS: readonly ToolDomainId[] = Object.freeze([
  MEDIA_DOMAIN_ID,
  DOWNLOAD_DOMAIN_ID
])

export interface ToolPrimitiveCatalogEntry {
  readonly primitiveId: ToolPrimitiveId
  readonly domain: ToolDomainId
  readonly summary: string
  readonly ipcMethods: readonly ToolRuntimeDomainIpcMethod[]
  readonly requiredPermissions: readonly ToolRuntimePermission[]
}

export const TOOL_RUNTIME_PRIMITIVES: readonly ToolPrimitiveCatalogEntry[] = Object.freeze([
  Object.freeze({
    primitiveId: MEDIA_PRIMITIVE_IDS.probe,
    domain: MEDIA_DOMAIN_ID,
    summary: 'Inspect structured stream metadata of authorized media files',
    ipcMethods: Object.freeze(['tool_media_probe'] as const),
    requiredPermissions: Object.freeze(['media.read'] as const)
  }),
  Object.freeze({
    primitiveId: MEDIA_PRIMITIVE_IDS.transcode,
    domain: MEDIA_DOMAIN_ID,
    summary: 'Run controlled structured media transformation with progress and cancellation',
    ipcMethods: Object.freeze(['tool_media_transcode_run'] as const),
    requiredPermissions: Object.freeze(['media.process'] as const)
  }),
  Object.freeze({
    primitiveId: DOWNLOAD_PRIMITIVE_IDS.stream,
    domain: DOWNLOAD_DOMAIN_ID,
    summary: 'Probe stream metadata and download selected media tracks to an authorized directory',
    ipcMethods: Object.freeze(['tool_download_stream_probe', 'tool_download_stream_run'] as const),
    requiredPermissions: Object.freeze(['network'] as const)
  }),
  Object.freeze({
    primitiveId: DOWNLOAD_PRIMITIVE_IDS.transfer,
    domain: DOWNLOAD_DOMAIN_ID,
    summary: 'Manage resumable multi-connection file downloads with pause, resume, rate limit, and cancel',
    ipcMethods: Object.freeze([
      'tool_download_transfer_add',
      'tool_download_transfer_pause',
      'tool_download_transfer_resume',
      'tool_download_transfer_cancel',
      'tool_download_transfer_status'
    ] as const),
    requiredPermissions: Object.freeze(['network'] as const)
  })
])

export const TOOL_RUNTIME_DOMAIN_IPC_METHODS: readonly ToolRuntimeDomainIpcMethod[] = Object.freeze([
  ...MEDIA_IPC_METHODS,
  ...DOWNLOAD_IPC_METHODS
])

export const TOOL_RUNTIME_IPC_METHODS: readonly ToolRuntimeIpcMethod[] = Object.freeze([
  ...TOOL_RUNTIME_CORE_IPC_METHODS,
  ...TOOL_RUNTIME_ADMIN_IPC_METHODS,
  ...TOOL_RUNTIME_DOMAIN_IPC_METHODS
])

export const TOOL_RUNTIME_PRIMITIVE_ID_SET: ReadonlySet<string> = new Set(
  TOOL_RUNTIME_PRIMITIVES.map((entry) => entry.primitiveId)
)

export function isKnownToolPrimitiveId(value: string): value is ToolPrimitiveId {
  return TOOL_RUNTIME_PRIMITIVE_ID_SET.has(value)
}

export function getToolPrimitiveCatalogEntry(primitiveId: ToolPrimitiveId): ToolPrimitiveCatalogEntry {
  const found = TOOL_RUNTIME_PRIMITIVES.find((entry) => entry.primitiveId === primitiveId)
  if (!found) {
    throw new Error(`Unknown tool primitive: ${primitiveId}`)
  }
  return found
}

export * from './common.js'
export * from './domains/media.js'
export * from './domains/download.js'
