import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ReferenceBrowserSnapshotService } from '../services/reference-browser-snapshot-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'
export function createReferenceBrowserSnapshotHandlers(service: ReferenceBrowserSnapshotService): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  return { sqlite_read_browser_snapshot: { execute: (value, caller, signal) => service.read(value, caller, signal) } }
}
