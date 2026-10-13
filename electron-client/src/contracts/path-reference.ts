import { errorCodes, ZToolsError } from './errors.js'

/** Applied atomically with SDK/manifest/consumer migration, never inferred from the legacy path contract. */
export const PATH_REFERENCE_CONTRACT_VERSION = 2 as const
export type PathGrantOperation = 'read' | 'write' | 'list'
export interface PathGrantRef {
  readonly grantId: string
  readonly displayName: string
  readonly kind: 'file' | 'directory' | 'save'
  readonly operations: readonly PathGrantOperation[]
}
export interface ReferenceReadParams { grantId: string; relativePath: string; encoding: 'utf8' | 'base64' }
export interface ReferenceRangeParams { grantId: string; relativePath: string; offset: number; length: number }
export interface ReferenceWriteParams { saveGrantId: string; content: string; encoding: 'utf8' | 'base64'; replace: boolean }
export interface ReferenceWriteIssue {
  readonly stage: 'reference' | 'release'
  readonly code: typeof errorCodes.permissionDenied | typeof errorCodes.fileError
}
export interface ReferenceWriteUnavailableReceipt {
  readonly success: true
  readonly status: 'committed-reference-unavailable'
  readonly size: number
  readonly issues: readonly ReferenceWriteIssue[]
}
export type ReferenceWriteReceipt =
  | { readonly success: true; readonly status: 'committed'; readonly size: number; readonly reference: PathGrantRef & { readonly kind: 'file'; readonly operations: readonly ['read']; readonly fileUrl: string } }
  | ReferenceWriteUnavailableReceipt
  | { readonly success: false; readonly status: 'result-unknown'; readonly code: typeof errorCodes.fileWriteOutcomeUnknown }

function exactData(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return false
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
}

export function isReferenceWriteIssues(value: unknown): value is readonly ReferenceWriteIssue[] {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
        Reflect.ownKeys(value).length !== value.length + 1) return false
    let previous = -1
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return false
      const issue: unknown = descriptor.value
      if (!exactData(issue, ['stage', 'code'])) return false
      const order = issue.stage === 'reference' ? 0 : issue.stage === 'release' ? 1 : -1
      if (order <= previous || (issue.code !== errorCodes.fileError && issue.code !== errorCodes.permissionDenied) ||
          (issue.stage === 'release' && issue.code !== errorCodes.fileError)) return false
      previous = order
    }
    return true
  } catch { return false }
}

/** A structural guard for results from trusted Main handlers, never proof supplied by a Renderer. */
export function isConfirmedReferenceWriteReceipt(value: unknown): value is Exclude<ReferenceWriteReceipt, { success: false }> {
  try {
    const keys = value && typeof value === 'object' ? Reflect.ownKeys(value) : []
    if (!exactData(value, keys.length === 4 && keys.includes('issues')
      ? ['success', 'status', 'size', 'issues'] : ['success', 'status', 'size', 'reference']) ||
        value.success !== true || !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
        (value.size as number) > 16 * 1024 * 1024) return false
    if (value.status === 'committed-reference-unavailable') return isReferenceWriteIssues(value.issues)
    if (value.status !== 'committed' || !exactData(value.reference, ['grantId', 'displayName', 'kind', 'operations', 'fileUrl'])) return false
    const ref = value.reference
    return typeof ref.grantId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ref.grantId) && ref.kind === 'file' &&
      typeof ref.displayName === 'string' && ref.displayName.length > 0 && Buffer.byteLength(ref.displayName) <= 4096 &&
      !/[/\u0000]/.test(ref.displayName) && Array.isArray(ref.operations) && ref.operations.length === 1 &&
      Reflect.ownKeys(ref.operations).length === 2 && Object.getOwnPropertyDescriptor(ref.operations, '0')?.enumerable === true &&
      Object.getOwnPropertyDescriptor(ref.operations, '0')?.value === 'read' &&
      ref.fileUrl === `ztools://file/${ref.grantId}/${encodeURIComponent(ref.displayName)}`
  } catch { return false }
}

/** Drops all capability fields while retaining an already verified commit fact. */
export function withoutReferenceWriteReceipt(
  receipt: Exclude<ReferenceWriteReceipt, { success: false }>, releaseFailed = false
): ReferenceWriteUnavailableReceipt {
  const issues: ReferenceWriteIssue[] = receipt.status === 'committed' ? [{ stage: 'reference', code: errorCodes.permissionDenied }] : [...receipt.issues]
  if (releaseFailed && !issues.some(issue => issue.stage === 'release')) issues.push({ stage: 'release', code: errorCodes.fileError })
  return Object.freeze({ success: true, status: 'committed-reference-unavailable', size: receipt.size,
    issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))) })
}
export interface ReferenceCopyParams { fileGrantId: string; saveGrantId: string; replace: boolean }
export interface ReferenceDirectoryParams { directoryGrantId: string; relativePath: string }
export interface ReferenceRemoveParams extends ReferenceDirectoryParams { isDirectory: boolean }
export interface ReferenceMoveParams extends ReferenceDirectoryParams { saveGrantId: string; replace: boolean }
const invalid = () => new ZToolsError(errorCodes.invalidRequest, '文件引用参数无效；请使用当前SDK授权引用')
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
export function grantId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalid()
  return value
}
function relative(value: unknown, empty: boolean): string {
  const text = value === undefined && empty ? '' : value
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || text.includes('\0') || (!empty && !text)) throw invalid()
  if (text) { const segments = text.split('/'); if (segments.length > 64 || segments.some(part => !part || part === '.' || part === '..' || /^\.ztools-save-/i.test(part))) throw invalid() }
  // Preserve POSIX literal colon/backslash; the native platform enforces its own segment rules.
  return text
}
function encoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf8') return 'utf8'
  if (value === 'base64') return 'base64'
  throw invalid()
}
function replace(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw invalid()
  return value
}
export function parseReferenceRead(value: unknown): ReferenceReadParams {
  const v = record(value, ['grantId', 'relativePath', 'encoding'])
  return { grantId: grantId(v.grantId), relativePath: relative(v.relativePath, true), encoding: encoding(v.encoding) }
}
export function parseReferenceRange(value: unknown): ReferenceRangeParams {
  const v = record(value, ['grantId', 'relativePath', 'offset', 'length'])
  if (!Number.isSafeInteger(v.offset) || !Number.isSafeInteger(v.length) ||
      (v.offset as number) < 0 || (v.length as number) < 0 || (v.length as number) > 16 * 1024 * 1024 ||
      (v.offset as number) > Number.MAX_SAFE_INTEGER - (v.length as number)) throw invalid()
  return { grantId: grantId(v.grantId), relativePath: relative(v.relativePath, true), offset: v.offset as number, length: v.length as number }
}
export function parseReferenceWrite(value: unknown): ReferenceWriteParams {
  const v = record(value, ['saveGrantId', 'content', 'encoding', 'replace'])
  if (typeof v.content !== 'string' || v.content.length > 24 * 1024 * 1024) throw invalid()
  return { saveGrantId: grantId(v.saveGrantId), content: v.content, encoding: encoding(v.encoding), replace: replace(v.replace) }
}
export function parseReferenceCopy(value: unknown): ReferenceCopyParams {
  const v = record(value, ['fileGrantId', 'saveGrantId', 'replace'])
  return { fileGrantId: grantId(v.fileGrantId), saveGrantId: grantId(v.saveGrantId), replace: replace(v.replace) }
}
export function parseReferenceDirectory(value: unknown, allowRoot = false): ReferenceDirectoryParams {
  const v = record(value, ['directoryGrantId', 'relativePath'])
  return { directoryGrantId: grantId(v.directoryGrantId), relativePath: relative(v.relativePath, allowRoot) }
}
export function parseReferenceRemove(value: unknown): ReferenceRemoveParams {
  const v = record(value, ['directoryGrantId', 'relativePath', 'isDirectory'])
  if (typeof v.isDirectory !== 'boolean') throw invalid()
  return { directoryGrantId: grantId(v.directoryGrantId), relativePath: relative(v.relativePath, false), isDirectory: v.isDirectory }
}
export function parseReferenceMove(value: unknown): ReferenceMoveParams {
  const v = record(value, ['directoryGrantId', 'relativePath', 'saveGrantId', 'replace'])
  return { directoryGrantId: grantId(v.directoryGrantId), relativePath: relative(v.relativePath, false), saveGrantId: grantId(v.saveGrantId), replace: replace(v.replace) }
}
