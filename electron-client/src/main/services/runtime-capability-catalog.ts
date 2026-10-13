import type { RuntimeCapabilityDefinition } from './runtime-capability-service.js'

/** IDs are limited to entries already present in the shared capability contract fixtures/docs. */
export const RUNTIME_CAPABILITY_CATALOG: readonly RuntimeCapabilityDefinition[] = Object.freeze([
  {
    id: 'screen.capture',
    callerGate: { method: 'screen_capture', methodGateCallers: ['main', 'plugin'] }
  },
  {
    id: 'clipboard.files.read',
    callerGate: { method: 'clipboard_read_files', methodGateCallers: ['main', 'plugin'] }
  },
  {
    id: 'system.hibernate',
    callerGate: { method: 'system_hibernate', methodGateCallers: ['main', 'plugin'] }
  }
])
