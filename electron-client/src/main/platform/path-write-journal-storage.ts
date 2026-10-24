import { safeStorage } from 'electron'
import type { JournalSealer } from './path-write-journal.js'
import { createJournalSealer } from './path-write-journal-crypto.js'

/** Invoke only after app.ready. No plaintext or synchronous Keychain fallback. */
export const electronJournalSealer: JournalSealer = createJournalSealer(safeStorage)
export { AnchoredJournalStore } from './path-write-journal-store.js'
