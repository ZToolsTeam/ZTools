import { contextBridge, ipcRenderer } from 'electron'

const SUPER_PANEL_CALL_CHANNEL = 'ztools:super-panel-call'
const SUPER_PANEL_METHODS = new Set([
  'super_panel_get_data',
  'super_panel_open_item',
  'super_panel_toggle_pin',
  'super_panel_add_local_app',
  'super_panel_open_settings',
  'super_panel_open_shortcut_settings',
  'super_panel_drag',
  'super_panel_hide',
  'window_show_tooltip',
  'window_hide_tooltip'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const bridge = Object.freeze({
  call(method: unknown, params: unknown = {}): Promise<unknown> {
    if (typeof method !== 'string' || !SUPER_PANEL_METHODS.has(method) || !isRecord(params)) {
      return Promise.reject(new Error('超级面板调用参数无效'))
    }
    return ipcRenderer.invoke(SUPER_PANEL_CALL_CHANNEL, { method, params })
  }
})

contextBridge.exposeInMainWorld('__ztoolsSuperPanel', bridge)
