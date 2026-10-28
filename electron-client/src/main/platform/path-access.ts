/** Native object references never cross preload/Renderer. No path-returning fallback. */
import type { PathGrantOperation, ReferenceWriteIssue } from '../../contracts/path-reference.js'
export type PathAccessRight = PathGrantOperation
export interface PathDirectoryEntry { name: string; isDirectory: boolean; size: number }
export interface PathSaveResult { status: 'committed'; bytesWritten: number; readonly cleanupIssues?: readonly ReferenceWriteIssue[] }
export interface PathMetadata { isDirectory: boolean; size: number; lastModifiedMs: number }
export interface PathMutationResult { status: 'committed' }
export interface PathDirectoryCreateResult { status: 'created' | 'existing' }
export interface AnchoredPathObject {
  readonly handle: string
  readonly kind: 'file' | 'directory' | 'save'
  readonly displayName: string
}
export interface PathAccessAdapter {
  readonly platform: 'win32' | 'darwin'
  /** 仅供主进程排除自身固定文件句柄，不发送到 Renderer。 */
  readonly ownedProcessId?: number | undefined
  /** Open/pin the OS object (save: existing parent plus one basename), reject links. */
  pin(selectedPath: string, kind: AnchoredPathObject['kind'], rights: readonly PathAccessRight[], signal: AbortSignal): Promise<AnchoredPathObject>
  /** Trusted native selection with unknown kind: classify and pin the same opened ordinary object, read-only. */
  pinSelected?(selectedPath: string, signal: AbortSignal): Promise<AnchoredPathObject>
  /** Re-pin the exact target of a confirmed save handle as a read-only file; accepts no caller-supplied path. */
  pinCommittedSave(object: AnchoredPathObject, signal: AbortSignal): Promise<AnchoredPathObject>
  /** Revalidate identity and perform the operation relative to the pinned object. */
  read(object: AnchoredPathObject, segments: readonly string[], maxBytes: number, signal: AbortSignal): Promise<Buffer>
  readRange(object: AnchoredPathObject, segments: readonly string[], offset: number, length: number, signal: AbortSignal): Promise<Buffer>
  save(object: AnchoredPathObject, data: Buffer, replace: boolean, signal: AbortSignal): Promise<PathSaveResult>
  streamSave(object: AnchoredPathObject, expectedBytes: number | undefined, chunks: AsyncIterable<Buffer>, replace: boolean, signal: AbortSignal): Promise<PathSaveResult>
  deriveSave(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject>
  deriveRead(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject>
  deriveDirectory(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject>
  describe(object: AnchoredPathObject, signal: AbortSignal): Promise<PathMetadata>
  /** 按固定对象身份移入系统回收站，不支持的平台必须失败。 */
  trash?(object: AnchoredPathObject, signal: AbortSignal): Promise<PathMutationResult>
  /** 同目录改名，目标已存在必须拒绝；完成后旧引用失效。 */
  rename?(object: AnchoredPathObject, name: string, signal: AbortSignal): Promise<PathMutationResult>
  copy(source: AnchoredPathObject, destination: AnchoredPathObject, replace: boolean, signal: AbortSignal): Promise<PathSaveResult>
  remove(directory: AnchoredPathObject, segments: readonly string[], isDirectory: boolean, signal: AbortSignal): Promise<PathMutationResult>
  move(directory: AnchoredPathObject, segments: readonly string[], destination: AnchoredPathObject, replace: boolean, signal: AbortSignal): Promise<PathMutationResult>
  createDirectory(directory: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<PathDirectoryCreateResult>
  /** strict 拒绝链接、特殊文件与扫描中消失的条目，供不能遗漏文件的同步使用。 */
  list(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal, strict?: boolean): Promise<PathDirectoryEntry[]>
  release(object: AnchoredPathObject): Promise<void>
  /** Confirm the owned native broker has exited, including failed pin operations. */
  stop(): Promise<void>
}
export interface PathAccessProvider {
  readonly platform: 'win32' | 'darwin'
  forOwner(owner: number): PathAccessAdapter
  closeOwner(owner: number): Promise<void>
  stop(): Promise<void>
}
