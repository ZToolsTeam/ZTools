import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { parseReferenceDialog, type ReferenceDialogOptions } from '../../contracts/path-dialog.js'
import type { PathGrantRef, PathGrantOperation } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'

interface Selection { absolutePath: string; kind: 'file' | 'directory' | 'save' }
export interface ReferenceDialogProvider {
  /** Trusted main native chooser only; Renderer never supplies these selection results. */
  select(mode: 'open' | 'save' | 'folder', options: ReferenceDialogOptions, caller: CallerIdentity): Promise<{ canceled: boolean; selections: readonly Selection[] }>
}
export interface DialogPathRef extends PathGrantRef { readonly fileUrl?: string }
type Grants = Pick<PathGrantService, 'create' | 'revoke' | 'resourceUrl'>
const failed = () => new ZToolsError(errorCodes.fileError, '文件选择授权未完成')

/** Native picker results are pinned immediately, projected to refs, and rolled back on partial acquisition. */
export class PathReferenceDialogs {
  constructor(private readonly provider: ReferenceDialogProvider, private readonly grants: Grants) {}
  async show(mode: 'open' | 'save' | 'folder', value: unknown, caller: CallerIdentity, signal?: AbortSignal): Promise<{ canceled: boolean; references: readonly DialogPathRef[] }> {
    const options = parseReferenceDialog(value, mode)
    if (!Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0) throw failed()
    if (signal?.aborted) return { canceled: true, references: [] }
    const selection = await this.provider.select(mode, options, caller)
    if (selection.canceled === true || signal?.aborted) return { canceled: true, references: [] }
    if (selection.canceled !== false || !Array.isArray(selection.selections) || !selection.selections.length || selection.selections.length > 64 ||
        ((mode !== 'open' || !options.properties?.includes('multiSelections')) && selection.selections.length !== 1)) throw failed()
    const created: string[] = [], references: DialogPathRef[] = []
    try {
      for (const item of selection.selections) {
        if (signal?.aborted) throw failed()
        if (!item || typeof item.absolutePath !== 'string' || !path.isAbsolute(item.absolutePath) || Buffer.byteLength(item.absolutePath) > 4096 ||
            item.absolutePath.includes('\0') || (mode === 'save' ? item.kind !== 'save' : mode === 'folder' ? item.kind !== 'directory' :
              item.kind !== 'file' && item.kind !== 'directory')) throw failed()
        if (mode === 'open') {
          const directories = options.properties?.includes('openDirectory') === true
          const files = !directories || options.properties?.includes('openFile') === true
          if (item.kind === 'directory' ? !directories : !files) throw failed()
        }
        const operations: PathGrantOperation[] = item.kind === 'save' ? ['write'] : item.kind === 'file' ? ['read'] :
          mode === 'folder' && options.access === 'read-write' ? ['read', 'write', 'list'] : ['read', 'list']
        const grant = await this.grants.create(caller.webContentsId, item.absolutePath, item.kind, operations, signal)
        created.push(grant.grantId)
        if (signal?.aborted) throw failed()
        if (grant.kind !== item.kind || !/^[A-Za-z0-9_-]{43}$/.test(grant.grantId)) throw failed()
        references.push(Object.freeze({ grantId: grant.grantId, displayName: grant.displayName, kind: grant.kind,
          operations: Object.freeze([...grant.operations]), ...(item.kind === 'file' ? { fileUrl: this.grants.resourceUrl(caller.webContentsId, grant.grantId) } : {}) }))
      }
      if (signal?.aborted) throw failed()
      return { canceled: false, references: Object.freeze(references) }
    } catch (error) {
      const cleanup = await Promise.allSettled(created.map(id => this.grants.revoke(caller.webContentsId, id)))
      if (cleanup.some(result => result.status === 'rejected')) throw new ZToolsError(errorCodes.fileError, '部分文件选择授权释放未确认')
      throw error
    }
  }
}
