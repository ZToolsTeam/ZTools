import vm from 'node:vm'

// Test-only module shim: no real Electron IPC, filesystem or application process.
export function runInBoundedModuleShim(code, { invoke } = {}) {
  const exposed = new Map()
  const window = { location: { protocol: 'ztools:', hostname: 'web' }, addEventListener() {} }
  window.top = window
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
    ipcRenderer: { on() {}, invoke, sendSync: () => ({ hostMaximumSdkContractVersion: 1, windowSdkApiLane: 1 }) },
    webUtils: { getPathForFile() { throw new Error('UNUSED_FILE_ACCESS') } }
  }
  vm.runInNewContext(code, {
    require: name => {
      if (name !== 'electron') throw new Error('SANDBOX_MODULE_UNAVAILABLE:' + name)
      return electron
    },
    exports: {}, module: { exports: {} }, process: { argv: [] },
    window, document: { addEventListener() {}, removeEventListener() {} }
  }, { timeout: 1000 })
  return exposed
}
