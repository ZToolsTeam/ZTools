export const SUPER_PANEL_CALL_CHANNEL = 'ztools:super-panel-call' as const

export const SUPER_PANEL_METHODS = [
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
] as const

export type SuperPanelMethod = typeof SUPER_PANEL_METHODS[number]

export function isSuperPanelMethod(value: unknown): value is SuperPanelMethod {
  return typeof value === 'string' && (SUPER_PANEL_METHODS as readonly string[]).includes(value)
}
