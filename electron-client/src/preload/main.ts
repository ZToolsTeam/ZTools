import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { SDK_LEGACY_CONTRACT_VERSION } from '../contracts/protocol-versions.js'
import { SDK_LANE_HANDSHAKE_CHANNEL } from '../contracts/sdk-lane-handshake.js'
import { createReferenceTransportBridge } from './reference-transport.js'
import { createNetworkRequestCancellationBridge } from './network-request-cancellation.js'
import { createRuntimeCapabilityRequestCancellationBridge } from './runtime-capability-request-cancellation.js'

const IPC_CALL_CHANNEL = 'ztools:call'
const IPC_EVENT_CHANNEL = 'ztools:event'
const FILE_DROP_CHANNEL = 'ztools:native-file-drop'
const IPC_LEGACY_FILE_CHANNEL = 'ztools:legacy-file-sync'
let sequence = 0
let messageCallback: ((msgType: string, msgData: unknown) => void) | null = null

type ZToolsResponse =
  | { messageId: string; success: true; data: unknown }
  | { messageId: string; success: false; error: { code: string; message: string } }

type PreloadMethod =
  | 'app_ready'
  | 'diagnostics_get'
  | 'config_get'
  | 'config_set'
  | 'settings_get'
  | 'settings_set'
  | 'features_get'
  | 'features_set'
  | 'user_get_info'
  | 'user_set_token'
  | 'user_logout'
  | 'analytics_report'
  | 'plugin_list_get'
  | 'plugin_refresh'
  | 'plugin_toggle'
  | 'plugin_revoke'
  | 'plugin_window_close'
  | 'plugin_create_shortcut'
  | 'plugin_refresh_icon'
  | 'plugin_open'
  | 'plugin_window_close'
  | 'plugin_install'
  | 'plugin_update'
  | 'plugin_uninstall'
  | 'plugin_data_list'
  | 'plugin_data_restore'
  | 'update_check'
  | 'update_get_version'
  | 'update_download_start'
  | 'update_install_start'
  | 'update_cancel'
  | 'privileged_execute'
  | 'builtin_reg_write'
  | 'builtin_reg_delete'
  | 'builtin_file_write'
  | 'builtin_restart_explorer'
  | 'trigger_register'
  | 'trigger_unregister'
  | 'trigger_list'
  | 'trigger_set_enabled'
  | 'trigger_check_conflict'
  | 'system_notify'
  | 'system_set_dark_mode'
  | 'get_system_info'
  | 'system_get_native_id'
  | 'system_get_app_name'
  | 'system_get_app_version'
  | 'system_get_autostart'
  | 'system_set_autostart'
  | 'system_get_path'
  | 'system_get_file_icon'
  | 'system_read_current_folder'
  | 'system_read_current_browser_url'
  | 'system_is_dev'
  | 'system_get_platform'
  | 'system_get_runtime_identity'
  | 'runtime_capability_get'
  | 'runtime_capability_request'
  | 'runtime_capability_revoke'
  | 'runtime_capability_grants_list'
  | 'runtime_capability_grant_revoke'
  | 'system_shutdown'
  | 'system_restart'
  | 'system_logout'
  | 'system_lock'
  | 'system_sleep'
  | 'system_hibernate'
  | 'system_prevent_sleep'
  | 'system_simulate_key_press'
  | 'system_simulate_key_combo'
  | 'system_simulate_text'
  | 'system_simulate_mouse_move'
  | 'system_simulate_mouse_click'
  | 'system_simulate_mouse_wheel'
  | 'system_get_hardware_summary'
  | 'system_get_cpu_usage'
  | 'system_get_memory_usage'
  | 'system_get_disk_usage'
  | 'system_get_network_stats'
  | 'system_get_battery_status'
  | 'system_reload_hotkeys'
  | 'system_get_panel_local_apps'
  | 'system_search_files'
  | 'dllplugin_list'
  | 'dllplugin_call'
  | 'dllplugin_call_async'
  | 'dllplugin_call_with_callback'
  | 'dllplugin_query_task'
  | 'dllplugin_cancel_task'
  | 'dllplugin_clear_callback_task'
  | 'event_subscribe'
  | 'event_unsubscribe'
  | 'event_publish'
  | 'event_request'
  | 'network_http_request'
  | 'network_http_download'
  | 'network_http_upload'
  | 'network_set_cookie'
  | 'network_get_cookie'
  | 'network_clear_cookies'
  | 'network_set_proxy'
  | 'filesystem_read_file'
  | 'filesystem_write_file'
  | 'filesystem_read_cache'
  | 'filesystem_write_cache'
  | 'filesystem_read_file_chunk'
  | 'filesystem_read_cache_chunk'
  | 'filesystem_write_file_start'
  | 'filesystem_write_cache_start'
  | 'filesystem_write_file_chunk'
  | 'filesystem_write_cache_chunk'
  | 'filesystem_write_file_end'
  | 'filesystem_write_cache_end'
  | 'filesystem_write_file_cancel'
  | 'filesystem_write_cache_cancel'
  | 'filesystem_delete_file'
  | 'filesystem_copy_file'
  | 'filesystem_move_file'
  | 'filesystem_file_exists'
  | 'filesystem_get_file_size'
  | 'filesystem_create_directory'
  | 'filesystem_delete_directory'
  | 'filesystem_directory_exists'
  | 'filesystem_get_directory_contents'
  | 'filesystem_get_current_directory'
  | 'filesystem_set_current_directory'
  | 'filesystem_find_files'
  | 'filesystem_find_directories'
  | 'filesystem_get_full_path'
  | 'filesystem_combine_path'
  | 'filesystem_get_file_name'
  | 'filesystem_get_extension'
  | 'filesystem_get_parent_directory'
  | 'shell_open_path'
  | 'shell_trash_item'
  | 'shell_show_item_in_folder'
  | 'shell_open_external'
  | 'shell_beep'
  | 'shell_exec'
  | 'process_list'
  | 'process_list_ports'
  | 'process_info'
  | 'process_exists'
  | 'process_find'
  | 'process_start'
  | 'process_kill'
  | 'process_kill_by_name'
  | 'process_wait'
  | 'process_get_window'
  | 'process_run_ffmpeg'
  | 'screen_capture'
  | 'screen_get_cursor_pos'
  | 'screen_get_primary_display'
  | 'screen_get_all_displays'
  | 'screen_get_display_nearest'
  | 'screen_get_display_matching'
  | 'clipboard_copy_text'
  | 'clipboard_copy_image'
  | 'clipboard_copy_file'
  | 'clipboard_copy_files'
  | 'clipboard_read_text'
  | 'clipboard_read_image'
  | 'clipboard_read_files'
  | 'clipboard_hide_and_paste_text'
  | 'clipboard_hide_and_paste_image'
  | 'clipboard_hide_and_paste_file'
  | 'clipboard_hide_and_type'
  | 'clipboard_clear'
  | 'clipboard_history_query'
  | 'clipboard_history_toggle_pin'
  | 'clipboard_history_delete'
  | 'clipboard_history_clear_unpinned'
  | 'clipboard_history_paste_sequential'
  | 'clipboard_history_reset_sequence'
  | 'snippets_list'
  | 'snippets_create'
  | 'snippets_update'
  | 'snippets_delete'
  | 'snippets_toggle'
  | 'snippets_match_and_expand'
  | 'snippets_import'
  | 'snippets_export'
  | 'filesearch_query'
  | 'filesearch_open'
  | 'filesearch_reveal'
  | 'filesearch_sha256'
  | 'window_manage_action'
  | 'window_manage_list_actions'
  | 'db_put'
  | 'db_get'
  | 'db_delete'
  | 'db_exists'
  | 'db_query'
  | 'db_batch'
  | 'db_put_secure'
  | 'db_get_secure'
  | 'credential_v1_status'
  | 'credential_v1_set'
  | 'credential_v1_get'
  | 'credential_v1_delete'
  | 'window_open'
  | 'window_close'
  | 'window_minimize'
  | 'window_maximize'
  | 'window_fullscreen_toggle'
  | 'window_drag'
  | 'window_hide'
  | 'window_show'
  | 'window_set_height'
  | 'window_redirect'
  | 'window_show_open_dialog'
  | 'window_show_save_dialog'
  | 'window_show_select_folder_dialog'
  | 'window_set_size'
  | 'window_get_bounds'
  | 'window_set_opacity'
  | 'window_set_always_on_top'
  | 'window_show_tooltip'
  | 'window_hide_tooltip'
  | 'window_show_record_bar'
  | 'window_update_record_bar'
  | 'window_hide_record_bar'
  | 'window_toggle_devtools'
  | 'ui_close_confirm_result'
  | 'emoji_search'
  | 'emoji_record_usage'
  | 'emoji_toggle_favorite'
  | 'emoji_get_recents'
  | 'emoji_get_favorites'
  | 'translator_translate'
  | 'translator_detect_language'
  | 'translator_get_history'
  | 'notes_list'
  | 'notes_get'
  | 'notes_save'
  | 'notes_delete'
  | 'notes_restore'
  | 'notes_toggle_pin'
  | 'notes_count'
  | 'windows_run_search'
  | 'windows_run_execute'
  | 'windows_run_register_alias'
  | 'windows_run_remove_alias'
  | 'taskbar_toggle'
  | 'taskbar_show'
  | 'taskbar_hide'
  | 'taskbar_status'
  | 'screenshots_scan'
  | 'screenshots_paste_latest'
  | 'screenshots_toggle_pin'
  | 'screenshots_delete'
  | 'applications_list'
  | 'applications_uninstall'
  | 'dictionary_lookup'
  | 'dictionary_suggestions'
  | 'dictionary_toggle_favorite'
  | 'dictionary_get_favorites'
  | 'dictionary_get_history'
  | 'focus_start'
  | 'focus_toggle'
  | 'focus_pause'
  | 'focus_resume'
  | 'focus_complete'
  | 'focus_cancel'
  | 'focus_get_current'
  | 'focus_list_categories'
  | 'focus_create_category'
  | 'focus_get_stats'
  | 'screen_awareness_selected_text'
  | 'screen_awareness_screen'
  | 'screen_awareness_screen_area'
  | 'screen_awareness_focused_window'
  | 'dictation_start'
  | 'dictation_finish'
  | 'dictation_cancel'
  | 'dictation_get_last'
  | 'dictation_search'
  | 'dictation_add_word'
  | 'dictation_list_words'
  | 'calendar_create_event'
  | 'calendar_upcoming_events'
  | 'calendar_list_events'
  | 'calendar_delete_event'
  | 'calendar_export_ics'
  | 'navigation_list_windows'
  | 'navigation_activate_window'
  | 'navigation_close_window'
  | 'web_search'
  | 'url_quick_open'
  | 'browser_get_active_tab'
  | 'contacts_list'
  | 'contacts_create'
  | 'contacts_delete'
  | 'filesearch_quick_look'
  | 'system_execute_action'
  | 'shortcuts_list'
  | 'shortcuts_run'
  | 'shortcuts_view'
  | 'navigation_search_menu_items'
  | 'navigation_click_menu_item'
  | 'audio_get_devices'
  | 'audio_set_default_device'
  | 'audio_set_volume'
  | 'audio_toggle_mute'
  | 'wifi_get_profiles'
  | 'wifi_get_password'
  | 'dictionary_speak'
  | 'brew_exec'
  | 'taskbar_set_dock_position'
  | 'taskbar_restart_dock'
  | 'script_commands_list'
  | 'script_commands_execute'
  | 'script_commands_create'
  | 'script_commands_reload'

function nextMessageId(): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER
  return `electron:${Date.now()}:${sequence}`
}

async function invoke(method: PreloadMethod, params: unknown): Promise<ZToolsResponse> {
  return invokeMethod(method, {
    messageId: nextMessageId(),
    params
  }) as Promise<ZToolsResponse>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invokeMethod(method: PreloadMethod, request: unknown): Promise<unknown> {
  const source = isRecord(request) ? request : {}
  const hasEnvelope = 'messageId' in source || 'params' in source
  const messageId = (typeof source.messageId === 'string' && source.messageId)
    ? source.messageId
    : nextMessageId()
  const params = hasEnvelope ? source.params : request

  return ipcRenderer.invoke(IPC_CALL_CHANNEL, {
    messageId,
    method,
    params,
    ...(Object.hasOwn(source, 'timeoutMs') ? { timeoutMs: source.timeoutMs } : {})
  })
}

ipcRenderer.on(IPC_EVENT_CHANNEL, (_event, value: unknown) => {
  if (!messageCallback || !isRecord(value) || typeof value.msgType !== 'string') return
  messageCallback(value.msgType, value.msgData)
})

// Keep disk File objects inside the isolated world; no path/grant method is exposed.
const onNativeFileDrop = (event: DragEvent): void => {
  if (!event.isTrusted || !event.dataTransfer || event.dataTransfer.files.length === 0) return
  event.preventDefault()
  if (event.dataTransfer.files.length > 100) {
    void ipcRenderer.invoke(FILE_DROP_CHANNEL, { overflowCount: event.dataTransfer.files.length }).catch(() => undefined)
    return
  }
  const files = Array.from(event.dataTransfer.files)
  const paths: string[] = []
  for (const file of files) {
    try {
      if (!(file instanceof File)) return
      const diskPath = webUtils.getPathForFile(file)
      if (!diskPath) return
      paths.push(diskPath)
    } catch { return }
  }
  void ipcRenderer.invoke(FILE_DROP_CHANNEL, paths).catch(() => undefined)
}
document.addEventListener('drop', onNativeFileDrop, true)
window.addEventListener('unload', () => {
  document.removeEventListener('drop', onNativeFileDrop, true)
  messageCallback = null
}, { once: true })

const isMainFrame = (() => {
  try { return window.top === window } catch { return false }
})()
let laneHandshake: unknown
if (isMainFrame) {
  try { laneHandshake = ipcRenderer.sendSync(SDK_LANE_HANDSHAKE_CHANNEL) } catch { laneHandshake = undefined }
}
const referenceTransport = createReferenceTransportBridge({
  invoke: (channel, value) => ipcRenderer.invoke(channel, value)
}, laneHandshake, isMainFrame)
const runtimeCapabilityCancellations = createRuntimeCapabilityRequestCancellationBridge({
  invoke: (channel, value) => ipcRenderer.invoke(channel, value)
}, laneHandshake, isMainFrame)
const networkRequestCancellations = createNetworkRequestCancellationBridge({
  invoke: (channel, value) => ipcRenderer.invoke(channel, value)
}, laneHandshake, isMainFrame)
const cancellations = Object.freeze(Object.assign({},
  referenceTransport?.cancellations ?? {},
  runtimeCapabilityCancellations ?? {},
  networkRequestCancellations ?? {}
))

const bridge = Object.freeze({
  contractVersion: referenceTransport ? 2 : SDK_LEGACY_CONTRACT_VERSION,
  app: Object.freeze({
    ready: (params: unknown = { status: 'initialized' }) => invoke('app_ready', params),
    getDiagnostics: () => invoke('diagnostics_get', {})
  }),
  features: Object.freeze({
    get: (key?: string) => invoke('features_get', key ? { key } : {}),
    getAll: () => invoke('features_get', {})
  }),
  transport: Object.freeze({
    methods: Object.freeze(Object.assign({
      app_ready: (request: unknown) => invokeMethod('app_ready', request),
      diagnostics_get: (request: unknown) => invokeMethod('diagnostics_get', request),
      config_get: (request: unknown) => invokeMethod('config_get', request),
      config_set: (request: unknown) => invokeMethod('config_set', request),
      settings_get: (request: unknown) => invokeMethod('settings_get', request),
      settings_set: (request: unknown) => invokeMethod('settings_set', request),
      features_get: (request: unknown) => invokeMethod('features_get', request),
      features_set: (request: unknown) => invokeMethod('features_set', request),
      user_get_info: (request: unknown) => invokeMethod('user_get_info', request),
      user_set_token: (request: unknown) => invokeMethod('user_set_token', request),
      user_logout: (request: unknown) => invokeMethod('user_logout', request),
      analytics_report: (request: unknown) => invokeMethod('analytics_report', request),
      event_subscribe: (request: unknown) => invokeMethod('event_subscribe', request),
      event_unsubscribe: (request: unknown) => invokeMethod('event_unsubscribe', request),
      event_publish: (request: unknown) => invokeMethod('event_publish', request),
      event_request: (request: unknown) => invokeMethod('event_request', request),
      network_http_request: (request: unknown) => invokeMethod('network_http_request', request),
      network_http_download: (request: unknown) => invokeMethod('network_http_download', request),
      network_http_upload: (request: unknown) => invokeMethod('network_http_upload', request),
      network_set_cookie: (request: unknown) => invokeMethod('network_set_cookie', request),
      network_get_cookie: (request: unknown) => invokeMethod('network_get_cookie', request),
      network_clear_cookies: (request: unknown) => invokeMethod('network_clear_cookies', request),
      network_set_proxy: (request: unknown) => invokeMethod('network_set_proxy', request),
      filesystem_read_file: (request: unknown) => invokeMethod('filesystem_read_file', request),
      filesystem_write_file: (request: unknown) => invokeMethod('filesystem_write_file', request),
      filesystem_read_cache: (request: unknown) => invokeMethod('filesystem_read_cache', request),
      filesystem_write_cache: (request: unknown) => invokeMethod('filesystem_write_cache', request),
      filesystem_read_file_chunk: (request: unknown) => invokeMethod('filesystem_read_file_chunk', request),
      filesystem_read_cache_chunk: (request: unknown) => invokeMethod('filesystem_read_cache_chunk', request),
      filesystem_write_file_start: (request: unknown) => invokeMethod('filesystem_write_file_start', request),
      filesystem_write_cache_start: (request: unknown) => invokeMethod('filesystem_write_cache_start', request),
      filesystem_write_file_chunk: (request: unknown) => invokeMethod('filesystem_write_file_chunk', request),
      filesystem_write_cache_chunk: (request: unknown) => invokeMethod('filesystem_write_cache_chunk', request),
      filesystem_write_file_end: (request: unknown) => invokeMethod('filesystem_write_file_end', request),
      filesystem_write_cache_end: (request: unknown) => invokeMethod('filesystem_write_cache_end', request),
      filesystem_write_file_cancel: (request: unknown) => invokeMethod('filesystem_write_file_cancel', request),
      filesystem_write_cache_cancel: (request: unknown) => invokeMethod('filesystem_write_cache_cancel', request),
      filesystem_delete_file: (request: unknown) => invokeMethod('filesystem_delete_file', request),
      filesystem_copy_file: (request: unknown) => invokeMethod('filesystem_copy_file', request),
      filesystem_move_file: (request: unknown) => invokeMethod('filesystem_move_file', request),
      filesystem_file_exists: (request: unknown) => invokeMethod('filesystem_file_exists', request),
      filesystem_get_file_size: (request: unknown) => invokeMethod('filesystem_get_file_size', request),
      filesystem_create_directory: (request: unknown) => invokeMethod('filesystem_create_directory', request),
      filesystem_delete_directory: (request: unknown) => invokeMethod('filesystem_delete_directory', request),
      filesystem_directory_exists: (request: unknown) => invokeMethod('filesystem_directory_exists', request),
      filesystem_get_directory_contents: (request: unknown) => invokeMethod('filesystem_get_directory_contents', request),
      filesystem_get_current_directory: (request: unknown) => invokeMethod('filesystem_get_current_directory', request),
      filesystem_set_current_directory: (request: unknown) => invokeMethod('filesystem_set_current_directory', request),
      filesystem_find_files: (request: unknown) => invokeMethod('filesystem_find_files', request),
      filesystem_find_directories: (request: unknown) => invokeMethod('filesystem_find_directories', request),
      filesystem_get_full_path: (request: unknown) => invokeMethod('filesystem_get_full_path', request),
      filesystem_combine_path: (request: unknown) => invokeMethod('filesystem_combine_path', request),
      filesystem_get_file_name: (request: unknown) => invokeMethod('filesystem_get_file_name', request),
      filesystem_get_extension: (request: unknown) => invokeMethod('filesystem_get_extension', request),
      filesystem_get_parent_directory: (request: unknown) => invokeMethod('filesystem_get_parent_directory', request),
      shell_open_path: (request: unknown) => invokeMethod('shell_open_path', request),
      shell_trash_item: (request: unknown) => invokeMethod('shell_trash_item', request),
      shell_show_item_in_folder: (request: unknown) => invokeMethod('shell_show_item_in_folder', request),
      shell_open_external: (request: unknown) => invokeMethod('shell_open_external', request),
      shell_beep: (request: unknown) => invokeMethod('shell_beep', request),
      shell_exec: (request: unknown) => invokeMethod('shell_exec', request),
      process_list: (request: unknown) => invokeMethod('process_list', request),
      process_list_ports: (request: unknown) => invokeMethod('process_list_ports', request),
      process_info: (request: unknown) => invokeMethod('process_info', request),
      process_exists: (request: unknown) => invokeMethod('process_exists', request),
      process_find: (request: unknown) => invokeMethod('process_find', request),
      process_start: (request: unknown) => invokeMethod('process_start', request),
      process_kill: (request: unknown) => invokeMethod('process_kill', request),
      process_kill_by_name: (request: unknown) => invokeMethod('process_kill_by_name', request),
      process_wait: (request: unknown) => invokeMethod('process_wait', request),
      process_get_window: (request: unknown) => invokeMethod('process_get_window', request),
      process_run_ffmpeg: (request: unknown) => invokeMethod('process_run_ffmpeg', request),
      screen_capture: (request: unknown) => invokeMethod('screen_capture', request),
      screen_get_cursor_pos: (request: unknown) => invokeMethod('screen_get_cursor_pos', request),
      screen_get_primary_display: (request: unknown) => invokeMethod('screen_get_primary_display', request),
      screen_get_all_displays: (request: unknown) => invokeMethod('screen_get_all_displays', request),
      screen_get_display_nearest: (request: unknown) => invokeMethod('screen_get_display_nearest', request),
      screen_get_display_matching: (request: unknown) => invokeMethod('screen_get_display_matching', request),
      clipboard_copy_text: (request: unknown) => invokeMethod('clipboard_copy_text', request),
      clipboard_copy_image: (request: unknown) => invokeMethod('clipboard_copy_image', request),
      clipboard_copy_file: (request: unknown) => invokeMethod('clipboard_copy_file', request),
      clipboard_copy_files: (request: unknown) => invokeMethod('clipboard_copy_files', request),
      clipboard_read_text: (request: unknown) => invokeMethod('clipboard_read_text', request),
      clipboard_read_image: (request: unknown) => invokeMethod('clipboard_read_image', request),
      clipboard_read_files: (request: unknown) => invokeMethod('clipboard_read_files', request),
      clipboard_hide_and_paste_text: (request: unknown) => invokeMethod('clipboard_hide_and_paste_text', request),
      clipboard_hide_and_paste_image: (request: unknown) => invokeMethod('clipboard_hide_and_paste_image', request),
      clipboard_hide_and_paste_file: (request: unknown) => invokeMethod('clipboard_hide_and_paste_file', request),
      clipboard_hide_and_type: (request: unknown) => invokeMethod('clipboard_hide_and_type', request),
      clipboard_clear: (request: unknown) => invokeMethod('clipboard_clear', request),
      clipboard_history_query: (request: unknown) => invokeMethod('clipboard_history_query', request),
      clipboard_history_toggle_pin: (request: unknown) => invokeMethod('clipboard_history_toggle_pin', request),
      clipboard_history_delete: (request: unknown) => invokeMethod('clipboard_history_delete', request),
      clipboard_history_clear_unpinned: (request: unknown) => invokeMethod('clipboard_history_clear_unpinned', request),
      clipboard_history_paste_sequential: (request: unknown) => invokeMethod('clipboard_history_paste_sequential', request),
      clipboard_history_reset_sequence: (request: unknown) => invokeMethod('clipboard_history_reset_sequence', request),
      snippets_list: (request: unknown) => invokeMethod('snippets_list', request),
      snippets_create: (request: unknown) => invokeMethod('snippets_create', request),
      snippets_update: (request: unknown) => invokeMethod('snippets_update', request),
      snippets_delete: (request: unknown) => invokeMethod('snippets_delete', request),
      snippets_toggle: (request: unknown) => invokeMethod('snippets_toggle', request),
      snippets_match_and_expand: (request: unknown) => invokeMethod('snippets_match_and_expand', request),
      snippets_import: (request: unknown) => invokeMethod('snippets_import', request),
      snippets_export: (request: unknown) => invokeMethod('snippets_export', request),
      filesearch_query: (request: unknown) => invokeMethod('filesearch_query', request),
      filesearch_open: (request: unknown) => invokeMethod('filesearch_open', request),
      filesearch_reveal: (request: unknown) => invokeMethod('filesearch_reveal', request),
      filesearch_sha256: (request: unknown) => invokeMethod('filesearch_sha256', request),
      window_manage_action: (request: unknown) => invokeMethod('window_manage_action', request),
      window_manage_list_actions: (request: unknown) => invokeMethod('window_manage_list_actions', request),
      db_put: (request: unknown) => invokeMethod('db_put', request),
      db_get: (request: unknown) => invokeMethod('db_get', request),
      db_delete: (request: unknown) => invokeMethod('db_delete', request),
      db_exists: (request: unknown) => invokeMethod('db_exists', request),
      db_query: (request: unknown) => invokeMethod('db_query', request),
      db_batch: (request: unknown) => invokeMethod('db_batch', request),
      db_put_secure: (request: unknown) => invokeMethod('db_put_secure', request),
      db_get_secure: (request: unknown) => invokeMethod('db_get_secure', request),
      credential_v1_status: (request: unknown) => invokeMethod('credential_v1_status', request),
      credential_v1_set: (request: unknown) => invokeMethod('credential_v1_set', request),
      credential_v1_get: (request: unknown) => invokeMethod('credential_v1_get', request),
      credential_v1_delete: (request: unknown) => invokeMethod('credential_v1_delete', request),
      plugin_list_get: (request: unknown) => invokeMethod('plugin_list_get', request),
      plugin_refresh: (request: unknown) => invokeMethod('plugin_refresh', request),
      plugin_toggle: (request: unknown) => invokeMethod('plugin_toggle', request),
      plugin_revoke: (request: unknown) => invokeMethod('plugin_revoke', request),
      plugin_window_close: (request: unknown) => invokeMethod('plugin_window_close', request),
      plugin_create_shortcut: (request: unknown) => invokeMethod('plugin_create_shortcut', request),
      plugin_refresh_icon: (request: unknown) => invokeMethod('plugin_refresh_icon', request),
      plugin_open: (request: unknown) => invokeMethod('plugin_open', request),
      plugin_install: (request: unknown) => invokeMethod('plugin_install', request),
      plugin_update: (request: unknown) => invokeMethod('plugin_update', request),
      plugin_uninstall: (request: unknown) => invokeMethod('plugin_uninstall', request),
      plugin_data_list: (request: unknown) => invokeMethod('plugin_data_list', request),
      plugin_data_restore: (request: unknown) => invokeMethod('plugin_data_restore', request),
      update_check: (request: unknown) => invokeMethod('update_check', request),
      update_get_version: (request: unknown) => invokeMethod('update_get_version', request),
      update_download_start: (request: unknown) => invokeMethod('update_download_start', request),
      update_install_start: (request: unknown) => invokeMethod('update_install_start', request),
      update_cancel: (request: unknown) => invokeMethod('update_cancel', request),
      privileged_execute: (request: unknown) => invokeMethod('privileged_execute', request),
      builtin_reg_write: (request: unknown) => invokeMethod('builtin_reg_write', request),
      builtin_reg_delete: (request: unknown) => invokeMethod('builtin_reg_delete', request),
      builtin_file_write: (request: unknown) => invokeMethod('builtin_file_write', request),
      builtin_restart_explorer: (request: unknown) => invokeMethod('builtin_restart_explorer', request),
      trigger_register: (request: unknown) => invokeMethod('trigger_register', request),
      trigger_unregister: (request: unknown) => invokeMethod('trigger_unregister', request),
      trigger_list: (request: unknown) => invokeMethod('trigger_list', request),
      trigger_set_enabled: (request: unknown) => invokeMethod('trigger_set_enabled', request),
      trigger_check_conflict: (request: unknown) => invokeMethod('trigger_check_conflict', request),
      system_notify: (request: unknown) => invokeMethod('system_notify', request),
      system_set_dark_mode: (request: unknown) => invokeMethod('system_set_dark_mode', request),
      get_system_info: (request: unknown) => invokeMethod('get_system_info', request),
      system_get_native_id: (request: unknown) => invokeMethod('system_get_native_id', request),
      system_get_app_name: (request: unknown) => invokeMethod('system_get_app_name', request),
      system_get_app_version: (request: unknown) => invokeMethod('system_get_app_version', request),
      system_get_autostart: (request: unknown) => invokeMethod('system_get_autostart', request),
      system_set_autostart: (request: unknown) => invokeMethod('system_set_autostart', request),
      system_get_path: (request: unknown) => invokeMethod('system_get_path', request),
      system_get_file_icon: (request: unknown) => invokeMethod('system_get_file_icon', request),
      system_read_current_folder: (request: unknown) => invokeMethod('system_read_current_folder', request),
      system_read_current_browser_url: (request: unknown) => invokeMethod('system_read_current_browser_url', request),
      system_is_dev: (request: unknown) => invokeMethod('system_is_dev', request),
      system_get_platform: (request: unknown) => invokeMethod('system_get_platform', request),
      system_get_runtime_identity: (request: unknown) => invokeMethod('system_get_runtime_identity', request),
      runtime_capability_get: (request: unknown) => invokeMethod('runtime_capability_get', request),
      runtime_capability_request: (request: unknown) => invokeMethod('runtime_capability_request', request),
      runtime_capability_revoke: (request: unknown) => invokeMethod('runtime_capability_revoke', request),
      runtime_capability_grants_list: (request: unknown) => invokeMethod('runtime_capability_grants_list', request),
      runtime_capability_grant_revoke: (request: unknown) => invokeMethod('runtime_capability_grant_revoke', request),
      system_shutdown: (request: unknown) => invokeMethod('system_shutdown', request),
      system_restart: (request: unknown) => invokeMethod('system_restart', request),
      system_logout: (request: unknown) => invokeMethod('system_logout', request),
      system_lock: (request: unknown) => invokeMethod('system_lock', request),
      system_sleep: (request: unknown) => invokeMethod('system_sleep', request),
      system_hibernate: (request: unknown) => invokeMethod('system_hibernate', request),
      system_prevent_sleep: (request: unknown) => invokeMethod('system_prevent_sleep', request),
      system_simulate_key_press: (request: unknown) => invokeMethod('system_simulate_key_press', request),
      system_simulate_key_combo: (request: unknown) => invokeMethod('system_simulate_key_combo', request),
      system_simulate_text: (request: unknown) => invokeMethod('system_simulate_text', request),
      system_simulate_mouse_move: (request: unknown) => invokeMethod('system_simulate_mouse_move', request),
      system_simulate_mouse_click: (request: unknown) => invokeMethod('system_simulate_mouse_click', request),
      system_simulate_mouse_wheel: (request: unknown) => invokeMethod('system_simulate_mouse_wheel', request),
      system_get_hardware_summary: (request: unknown) => invokeMethod('system_get_hardware_summary', request),
      system_get_cpu_usage: (request: unknown) => invokeMethod('system_get_cpu_usage', request),
      system_get_memory_usage: (request: unknown) => invokeMethod('system_get_memory_usage', request),
      system_get_disk_usage: (request: unknown) => invokeMethod('system_get_disk_usage', request),
      system_get_network_stats: (request: unknown) => invokeMethod('system_get_network_stats', request),
      system_get_battery_status: (request: unknown) => invokeMethod('system_get_battery_status', request),
      system_reload_hotkeys: (request: unknown) => invokeMethod('system_reload_hotkeys', request),
      system_get_panel_local_apps: (request: unknown) => invokeMethod('system_get_panel_local_apps', request),
      system_search_files: (request: unknown) => invokeMethod('system_search_files', request),
      dllplugin_list: (request: unknown) => invokeMethod('dllplugin_list', request),
      dllplugin_call: (request: unknown) => invokeMethod('dllplugin_call', request),
      dllplugin_call_async: (request: unknown) => invokeMethod('dllplugin_call_async', request),
      dllplugin_call_with_callback: (request: unknown) => invokeMethod('dllplugin_call_with_callback', request),
      dllplugin_query_task: (request: unknown) => invokeMethod('dllplugin_query_task', request),
      dllplugin_cancel_task: (request: unknown) => invokeMethod('dllplugin_cancel_task', request),
      dllplugin_clear_callback_task: (request: unknown) => invokeMethod('dllplugin_clear_callback_task', request),
      window_open: (request: unknown) => invokeMethod('window_open', request),
      window_close: (request: unknown) => invokeMethod('window_close', request),
      window_minimize: (request: unknown) => invokeMethod('window_minimize', request),
      window_maximize: (request: unknown) => invokeMethod('window_maximize', request),
      window_fullscreen_toggle: (request: unknown) => invokeMethod('window_fullscreen_toggle', request),
      window_drag: (request: unknown) => invokeMethod('window_drag', request),
      window_hide: (request: unknown) => invokeMethod('window_hide', request),
      window_show: (request: unknown) => invokeMethod('window_show', request),
      window_set_height: (request: unknown) => invokeMethod('window_set_height', request),
      window_redirect: (request: unknown) => invokeMethod('window_redirect', request),
      window_show_open_dialog: (request: unknown) => invokeMethod('window_show_open_dialog', request),
      window_show_save_dialog: (request: unknown) => invokeMethod('window_show_save_dialog', request),
      window_show_select_folder_dialog: (request: unknown) => invokeMethod('window_show_select_folder_dialog', request),
      window_set_size: (request: unknown) => invokeMethod('window_set_size', request),
      window_get_bounds: (request: unknown) => invokeMethod('window_get_bounds', request),
      window_set_opacity: (request: unknown) => invokeMethod('window_set_opacity', request),
      window_set_always_on_top: (request: unknown) => invokeMethod('window_set_always_on_top', request),
      window_show_tooltip: (request: unknown) => invokeMethod('window_show_tooltip', request),
      window_hide_tooltip: (request: unknown) => invokeMethod('window_hide_tooltip', request),
      window_show_record_bar: (request: unknown) => invokeMethod('window_show_record_bar', request),
      window_update_record_bar: (request: unknown) => invokeMethod('window_update_record_bar', request),
      window_hide_record_bar: (request: unknown) => invokeMethod('window_hide_record_bar', request),
      window_toggle_devtools: (request: unknown) => invokeMethod('window_toggle_devtools', request),
      ui_close_confirm_result: (request: unknown) => invokeMethod('ui_close_confirm_result', request),
      emoji_search: (request: unknown) => invokeMethod('emoji_search', request),
      emoji_record_usage: (request: unknown) => invokeMethod('emoji_record_usage', request),
      emoji_toggle_favorite: (request: unknown) => invokeMethod('emoji_toggle_favorite', request),
      emoji_get_recents: (request: unknown) => invokeMethod('emoji_get_recents', request),
      emoji_get_favorites: (request: unknown) => invokeMethod('emoji_get_favorites', request),
      translator_translate: (request: unknown) => invokeMethod('translator_translate', request),
      translator_detect_language: (request: unknown) => invokeMethod('translator_detect_language', request),
      translator_get_history: (request: unknown) => invokeMethod('translator_get_history', request),
      notes_list: (request: unknown) => invokeMethod('notes_list', request),
      notes_get: (request: unknown) => invokeMethod('notes_get', request),
      notes_save: (request: unknown) => invokeMethod('notes_save', request),
      notes_delete: (request: unknown) => invokeMethod('notes_delete', request),
      notes_restore: (request: unknown) => invokeMethod('notes_restore', request),
      notes_toggle_pin: (request: unknown) => invokeMethod('notes_toggle_pin', request),
      notes_count: (request: unknown) => invokeMethod('notes_count', request),
      windows_run_search: (request: unknown) => invokeMethod('windows_run_search', request),
      windows_run_execute: (request: unknown) => invokeMethod('windows_run_execute', request),
      windows_run_register_alias: (request: unknown) => invokeMethod('windows_run_register_alias', request),
      windows_run_remove_alias: (request: unknown) => invokeMethod('windows_run_remove_alias', request),
      taskbar_toggle: (request: unknown) => invokeMethod('taskbar_toggle', request),
      taskbar_show: (request: unknown) => invokeMethod('taskbar_show', request),
      taskbar_hide: (request: unknown) => invokeMethod('taskbar_hide', request),
      taskbar_status: (request: unknown) => invokeMethod('taskbar_status', request),
      screenshots_scan: (request: unknown) => invokeMethod('screenshots_scan', request),
      screenshots_paste_latest: (request: unknown) => invokeMethod('screenshots_paste_latest', request),
      screenshots_toggle_pin: (request: unknown) => invokeMethod('screenshots_toggle_pin', request),
      screenshots_delete: (request: unknown) => invokeMethod('screenshots_delete', request),
      applications_list: (request: unknown) => invokeMethod('applications_list', request),
      applications_uninstall: (request: unknown) => invokeMethod('applications_uninstall', request),
      dictionary_lookup: (request: unknown) => invokeMethod('dictionary_lookup', request),
      dictionary_suggestions: (request: unknown) => invokeMethod('dictionary_suggestions', request),
      dictionary_toggle_favorite: (request: unknown) => invokeMethod('dictionary_toggle_favorite', request),
      dictionary_get_favorites: (request: unknown) => invokeMethod('dictionary_get_favorites', request),
      dictionary_get_history: (request: unknown) => invokeMethod('dictionary_get_history', request),
      focus_start: (request: unknown) => invokeMethod('focus_start', request),
      focus_toggle: (request: unknown) => invokeMethod('focus_toggle', request),
      focus_pause: (request: unknown) => invokeMethod('focus_pause', request),
      focus_resume: (request: unknown) => invokeMethod('focus_resume', request),
      focus_complete: (request: unknown) => invokeMethod('focus_complete', request),
      focus_cancel: (request: unknown) => invokeMethod('focus_cancel', request),
      focus_get_current: (request: unknown) => invokeMethod('focus_get_current', request),
      focus_list_categories: (request: unknown) => invokeMethod('focus_list_categories', request),
      focus_create_category: (request: unknown) => invokeMethod('focus_create_category', request),
      focus_get_stats: (request: unknown) => invokeMethod('focus_get_stats', request),
      screen_awareness_selected_text: (request: unknown) => invokeMethod('screen_awareness_selected_text', request),
      screen_awareness_screen: (request: unknown) => invokeMethod('screen_awareness_screen', request),
      screen_awareness_screen_area: (request: unknown) => invokeMethod('screen_awareness_screen_area', request),
      screen_awareness_focused_window: (request: unknown) => invokeMethod('screen_awareness_focused_window', request),
      dictation_start: (request: unknown) => invokeMethod('dictation_start', request),
      dictation_finish: (request: unknown) => invokeMethod('dictation_finish', request),
      dictation_cancel: (request: unknown) => invokeMethod('dictation_cancel', request),
      dictation_get_last: (request: unknown) => invokeMethod('dictation_get_last', request),
      dictation_search: (request: unknown) => invokeMethod('dictation_search', request),
      dictation_add_word: (request: unknown) => invokeMethod('dictation_add_word', request),
      dictation_list_words: (request: unknown) => invokeMethod('dictation_list_words', request),
      calendar_create_event: (request: unknown) => invokeMethod('calendar_create_event', request),
      calendar_upcoming_events: (request: unknown) => invokeMethod('calendar_upcoming_events', request),
      calendar_list_events: (request: unknown) => invokeMethod('calendar_list_events', request),
      calendar_delete_event: (request: unknown) => invokeMethod('calendar_delete_event', request),
      calendar_export_ics: (request: unknown) => invokeMethod('calendar_export_ics', request),
      navigation_list_windows: (request: unknown) => invokeMethod('navigation_list_windows', request),
      navigation_activate_window: (request: unknown) => invokeMethod('navigation_activate_window', request),
      navigation_close_window: (request: unknown) => invokeMethod('navigation_close_window', request),
      web_search: (request: unknown) => invokeMethod('web_search', request),
      url_quick_open: (request: unknown) => invokeMethod('url_quick_open', request),
      browser_get_active_tab: (request: unknown) => invokeMethod('browser_get_active_tab', request),
      contacts_list: (request: unknown) => invokeMethod('contacts_list', request),
      contacts_create: (request: unknown) => invokeMethod('contacts_create', request),
      contacts_delete: (request: unknown) => invokeMethod('contacts_delete', request),
      filesearch_quick_look: (request: unknown) => invokeMethod('filesearch_quick_look', request),
      system_execute_action: (request: unknown) => invokeMethod('system_execute_action', request),
      shortcuts_list: (request: unknown) => invokeMethod('shortcuts_list', request),
      shortcuts_run: (request: unknown) => invokeMethod('shortcuts_run', request),
      shortcuts_view: (request: unknown) => invokeMethod('shortcuts_view', request),
      navigation_search_menu_items: (request: unknown) => invokeMethod('navigation_search_menu_items', request),
      navigation_click_menu_item: (request: unknown) => invokeMethod('navigation_click_menu_item', request),
      audio_get_devices: (request: unknown) => invokeMethod('audio_get_devices', request),
      audio_set_default_device: (request: unknown) => invokeMethod('audio_set_default_device', request),
      audio_set_volume: (request: unknown) => invokeMethod('audio_set_volume', request),
      audio_toggle_mute: (request: unknown) => invokeMethod('audio_toggle_mute', request),
      wifi_get_profiles: (request: unknown) => invokeMethod('wifi_get_profiles', request),
      wifi_get_password: (request: unknown) => invokeMethod('wifi_get_password', request),
      dictionary_speak: (request: unknown) => invokeMethod('dictionary_speak', request),
      brew_exec: (request: unknown) => invokeMethod('brew_exec', request),
      taskbar_set_dock_position: (request: unknown) => invokeMethod('taskbar_set_dock_position', request),
      taskbar_restart_dock: (request: unknown) => invokeMethod('taskbar_restart_dock', request),
      script_commands_list: (request: unknown) => invokeMethod('script_commands_list', request),
      script_commands_execute: (request: unknown) => invokeMethod('script_commands_execute', request),
      script_commands_create: (request: unknown) => invokeMethod('script_commands_create', request),
      script_commands_reload: (request: unknown) => invokeMethod('script_commands_reload', request)
    }, referenceTransport?.methods ?? {})),
    ...(Object.keys(cancellations).length ? { cancellations } : {}),
    setMessageCallback: (callback: unknown) => {
      messageCallback = typeof callback === 'function'
        ? callback as (msgType: string, msgData: unknown) => void
        : null
    }
  })
})

contextBridge.exposeInMainWorld('__ztoolsElectron', bridge)

contextBridge.exposeInMainWorld('__ztoolsLauncher', Object.freeze({
  show: () => ipcRenderer.invoke('ztools:launcher_call', 'show'),
  hide: () => ipcRenderer.invoke('ztools:launcher_call', 'hide'),
  toggle: () => ipcRenderer.invoke('ztools:launcher_call', 'toggle'),
  expandToDashboard: (route?: string) => typeof route === 'string'
    ? ipcRenderer.invoke('ztools:launcher_call', 'expand_to_dashboard', { route })
    : ipcRenderer.invoke('ztools:launcher_call', 'expand_to_dashboard'),
  searchFiles: async (query: string, limit = 20) => {
    const res = await invoke('system_search_files', { query, limit }) as { success?: boolean; data?: unknown }
    return res?.data ?? res
  },
  openPath: (targetPath: string) => invoke('shell_open_path', { fullPath: targetPath }),
  showItemInFolder: (targetPath: string) => invoke('shell_show_item_in_folder', { fullPath: targetPath })
}))

const isLauncherWindow = process.argv.includes('--ztools-window-mode=launcher')
contextBridge.exposeInMainWorld('__ztoolsWindowMode', isLauncherWindow ? 'launcher' : 'dashboard')

// Internal selector windows stay outside WindowRegistry, so they have no public SDK caller identity.
const regionToken = process.argv.find(value => value.startsWith('--ztools-region-selection='))?.slice('--ztools-region-selection='.length)
if (regionToken && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(regionToken)) {
  contextBridge.exposeInMainWorld('__ztoolsRegionSelection', Object.freeze({
    submit: (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const rect = value as Record<string, unknown>
      if (Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
          !['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(rect[key]) && Number(rect[key]) >= 0 && Number(rect[key]) <= 32768) || Number(rect.width) < 1 || Number(rect.height) < 1) return
      ipcRenderer.send('ztools:region-selection', { nonce: regionToken, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
    },
    cancel: () => ipcRenderer.send('ztools:region-selection', { nonce: regionToken, cancel: true })
  }))
}
// Old plugin packages call these V8 bindings directly and require synchronous results.
function legacyFileCall(method: PreloadMethod, params: unknown): Record<string, unknown> {
  const response = ipcRenderer.sendSync(IPC_LEGACY_FILE_CHANNEL, {
    messageId: nextMessageId(), method, params
  }) as ZToolsResponse
  if (!response.success) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

function legacyRead(method: PreloadMethod, params: unknown): ArrayBuffer {
  const data = legacyFileCall(method, params)
  if (typeof data.content !== 'string' || data.content.length > 24 * 1024 * 1024) throw new Error('Invalid file data')
  return Uint8Array.from(atob(data.content), character => character.charCodeAt(0)).buffer
}

if (!referenceTransport && isMainFrame && window.location?.protocol === 'ztools:' && ['web', 'plugins'].includes(window.location.hostname)) {
contextBridge.exposeInMainWorld('_getFileSize', (path: string) =>
  legacyFileCall('filesystem_get_file_size', { path }).size)
contextBridge.exposeInMainWorld('_readFileArrayBuffer', (path: string) =>
  legacyRead('filesystem_read_file', { path, encoding: 'base64' }))
contextBridge.exposeInMainWorld('_readFileArrayBufferChunk', (path: string, offset: number, length: number) =>
  legacyRead('filesystem_read_file_chunk', { path, offset, length }))
contextBridge.exposeInMainWorld('_writeFileArrayBuffer', (path: string, bytes: unknown) => {
  if (!Array.isArray(bytes) || bytes.length > 16 * 1024 * 1024 ||
      !bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error('文件内容必须是字节数组，且不超过 16 MiB')
  }
  return legacyFileCall('filesystem_write_file', {
    path, content: btoa(bytes.map(value => String.fromCharCode(value)).join('')), encoding: 'base64'
  }).success
})
}
