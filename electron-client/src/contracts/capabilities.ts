export type CallerType = 'main' | 'plugin'

/**
 * 主窗口里声明式插件的会话归属（由主进程按「令牌 + 发送窗口」查出，渲染层无法自报）。
 * 注意：这不是安全隔离边界——插件与宿主界面同一 JS 上下文，见 DeclarativePluginAttributionService。
 */
export interface AttributedPlugin {
  readonly pluginId: string
  readonly sessionId: string
  readonly permissions: ReadonlySet<string>
  readonly source: 'installed' | 'bundled'
}

export interface CallerIdentity {
  type: CallerType
  webContentsId: number
  pluginId?: string
  pluginInstanceId?: string
  /** 仅 type:'main' 且请求带有效会话令牌时存在；type 与 pluginId 保持不变 */
  readonly attributedPlugin?: AttributedPlugin
  /**
   * 仅 type:'main' 且请求带了已失效 / 不属于本窗口的会话令牌时为 true。
   * 能力判定上仍按未归属处理；但带令牌说明调用来自插件代码，不能当作宿主自身（例如拿不到登录凭据）。
   */
  readonly stalePluginSession?: true
}

export const methodCapabilities = {
  app_ready: ['main', 'plugin'],
  diagnostics_get: ['main', 'plugin'],
  config_get: ['main'],
  config_set: ['main'],
  settings_get: ['main'],
  settings_set: ['main'],
  features_get: ['main', 'plugin'],
  features_set: ['main'],
  user_get_info: ['main', 'plugin'],
  user_set_token: ['main'],
  user_logout: ['main'],
  analytics_report: ['main', 'plugin'],
  plugin_list_get: ['main'],
  plugin_refresh: ['main', 'plugin'],
  plugin_toggle: ['main'],
  plugin_window_close: ['main', 'plugin'],
  plugin_create_shortcut: ['main', 'plugin'],
  plugin_refresh_icon: ['main', 'plugin'],
  plugin_open: ['main', 'plugin'],
  plugin_install: ['main'],
  plugin_install_status: ['main'],
  plugin_update: ['main'],
  plugin_uninstall: ['main'],
  plugin_revoke: ['main'],
  plugin_data_list: ['main'],
  plugin_data_restore: ['main'],
  update_check: ['main'],
  update_get_version: ['main'],
  update_download_start: ['main'],
  update_install_start: ['main'],
  update_cancel: ['main'],
  privileged_execute: ['main', 'plugin'],
  builtin_reg_write: ['main', 'plugin'],
  builtin_reg_delete: ['main', 'plugin'],
  builtin_file_write: ['main', 'plugin'],
  builtin_restart_explorer: ['main', 'plugin'],
  trigger_register: ['main', 'plugin'],
  trigger_unregister: ['main', 'plugin'],
  trigger_list: ['main', 'plugin'],
  trigger_set_enabled: ['main', 'plugin'],
  trigger_check_conflict: ['main', 'plugin'],
  system_notify: ['main', 'plugin'],
  system_set_dark_mode: ['main', 'plugin'],
  get_system_info: ['main', 'plugin'],
  system_get_native_id: ['main', 'plugin'],
  system_get_app_name: ['main', 'plugin'],
  system_get_app_version: ['main', 'plugin'],
  system_get_autostart: ['main'],
  system_set_autostart: ['main'],
  system_get_path: ['main', 'plugin'],
  // 常用目录：路径由主进程计算，主窗口调用时存在的目录登记为只读结果授权
  system_list_common_folders: ['main', 'plugin'],
  system_get_file_icon: ['main', 'plugin'],
  system_read_current_folder: ['main', 'plugin'],
  system_read_current_browser_url: ['main', 'plugin'],
  system_is_dev: ['main', 'plugin'],
  system_get_platform: ['main', 'plugin'],
  system_get_runtime_identity: ['main', 'plugin'],
  runtime_capability_get: ['main', 'plugin'],
  runtime_capability_request: ['plugin'],
  runtime_capability_revoke: ['plugin'],
  runtime_capability_grants_list: ['main'],
  runtime_capability_grant_revoke: ['main'],
  system_shutdown: ['main', 'plugin'],
  system_restart: ['main', 'plugin'],
  system_logout: ['main', 'plugin'],
  system_lock: ['main', 'plugin'],
  system_sleep: ['main', 'plugin'],
  system_hibernate: ['main', 'plugin'],
  system_prevent_sleep: ['main', 'plugin'],
  system_power_session: ['main', 'plugin'],
  system_simulate_key_press: ['main', 'plugin'],
  system_simulate_key_combo: ['main', 'plugin'],
  system_simulate_text: ['main', 'plugin'],
  system_simulate_mouse_move: ['main', 'plugin'],
  system_simulate_mouse_click: ['main', 'plugin'],
  system_simulate_mouse_wheel: ['main', 'plugin'],
  system_get_hardware_summary: ['main', 'plugin'],
  system_get_cpu_usage: ['main', 'plugin'],
  system_get_memory_usage: ['main', 'plugin'],
  system_list_volumes: ['main', 'plugin'],
  system_get_disk_usage: ['main', 'plugin'],
  system_get_network_stats: ['main', 'plugin'],
  system_get_battery_status: ['main', 'plugin'],
  system_reload_hotkeys: ['main', 'plugin'],
  system_get_panel_local_apps: ['main', 'plugin'],
  system_search_files: ['main', 'plugin'],
  dllplugin_list: ['main', 'plugin'],
  dllplugin_call: ['main', 'plugin'],
  dllplugin_call_async: ['main', 'plugin'],
  dllplugin_call_with_callback: ['main', 'plugin'],
  dllplugin_query_task: ['main', 'plugin'],
  dllplugin_cancel_task: ['main', 'plugin'],
  dllplugin_clear_callback_task: ['main', 'plugin'],
  window_open: ['main'],
  // 独立窗口取走弹出前交接的插件状态：只交给登记时的新窗口，一次性
  window_popout_handoff_take: ['main'],
  window_close: ['main', 'plugin'],
  window_minimize: ['main', 'plugin'],
  window_maximize: ['main', 'plugin'],
  window_fullscreen_toggle: ['main', 'plugin'],
  window_drag: ['main', 'plugin'],
  window_hide: ['main', 'plugin'],
  window_show: ['main', 'plugin'],
  pluginwin_hide: ['plugin'],
  pluginwin_show: ['plugin'],
  pluginwin_minimize: ['plugin'],
  pluginwin_restore: ['plugin'],
  window_set_height: ['main', 'plugin'],
  window_out_plugin: ['plugin'],
  window_redirect: ['main', 'plugin'],
  window_show_open_dialog: ['main', 'plugin'],
  window_show_save_dialog: ['main', 'plugin'],
  window_show_select_folder_dialog: ['main', 'plugin'],
  window_set_size: ['main', 'plugin'],
  window_get_bounds: ['main', 'plugin'],
  window_set_opacity: ['main', 'plugin'],
  window_set_always_on_top: ['main', 'plugin'],
  window_show_tooltip: ['main', 'plugin'],
  window_hide_tooltip: ['main', 'plugin'],
  window_show_record_bar: ['main', 'plugin'],
  window_update_record_bar: ['main', 'plugin'],
  window_hide_record_bar: ['main', 'plugin'],
  window_toggle_devtools: ['main', 'plugin'],
  ui_close_confirm_result: ['main'],
  event_subscribe: ['main', 'plugin'],
  event_unsubscribe: ['main', 'plugin'],
  event_publish: ['main', 'plugin'],
  event_request: ['main', 'plugin'],
  network_http_request: ['main', 'plugin'],
  network_http_download: ['main', 'plugin'],
  network_http_upload: ['main', 'plugin'],
  network_set_cookie: ['main', 'plugin'],
  network_get_cookie: ['main', 'plugin'],
  network_clear_cookies: ['main', 'plugin'],
  network_set_proxy: ['main'],
  filesystem_read_file: ['main', 'plugin'],
  filesystem_write_file: ['main', 'plugin'],
  filesystem_read_cache: ['main', 'plugin'],
  filesystem_write_cache: ['main', 'plugin'],
  filesystem_read_file_chunk: ['main', 'plugin'],
  filesystem_read_cache_chunk: ['main', 'plugin'],
  filesystem_write_file_start: ['main', 'plugin'],
  filesystem_write_cache_start: ['main', 'plugin'],
  filesystem_write_file_chunk: ['main', 'plugin'],
  filesystem_write_cache_chunk: ['main', 'plugin'],
  filesystem_write_file_end: ['main', 'plugin'],
  filesystem_write_cache_end: ['main', 'plugin'],
  filesystem_write_file_cancel: ['main', 'plugin'],
  filesystem_write_cache_cancel: ['main', 'plugin'],
  filesystem_delete_file: ['main', 'plugin'],
  filesystem_copy_file: ['main', 'plugin'],
  filesystem_move_file: ['main', 'plugin'],
  filesystem_move_file_no_replace: ['main', 'plugin'],
  filesystem_file_exists: ['main', 'plugin'],
  filesystem_get_file_size: ['main', 'plugin'],
  filesystem_create_directory: ['main', 'plugin'],
  filesystem_delete_directory: ['main', 'plugin'],
  filesystem_directory_exists: ['main', 'plugin'],
  filesystem_get_directory_contents: ['main', 'plugin'],
  filesystem_get_current_directory: ['main', 'plugin'],
  filesystem_set_current_directory: ['main', 'plugin'],
  filesystem_find_files: ['main', 'plugin'],
  filesystem_find_directories: ['main', 'plugin'],
  filesystem_get_full_path: ['main', 'plugin'],
  filesystem_combine_path: ['main', 'plugin'],
  filesystem_get_file_name: ['main', 'plugin'],
  filesystem_get_extension: ['main', 'plugin'],
  filesystem_get_parent_directory: ['main', 'plugin'],
  shell_open_path: ['main', 'plugin'],
  shell_trash_item: ['main', 'plugin'],
  shell_show_item_in_folder: ['main', 'plugin'],
  shell_open_external: ['main', 'plugin'],
  shell_beep: ['main', 'plugin'],
  shell_exec: ['main', 'plugin'],
  process_list: ['main', 'plugin'],
  process_list_ports: ['main', 'plugin'],
  process_info: ['main', 'plugin'],
  process_exists: ['main', 'plugin'],
  process_find: ['main', 'plugin'],
  process_start: ['main', 'plugin'],
  process_kill: ['main', 'plugin'],
  process_kill_by_name: ['main', 'plugin'],
  process_wait: ['main', 'plugin'],
  process_get_window: ['main', 'plugin'],
  process_run_ffmpeg: ['main', 'plugin'],
  screen_capture: ['main', 'plugin'],
  screen_get_cursor_pos: ['main', 'plugin'],
  screen_get_primary_display: ['main', 'plugin'],
  screen_get_all_displays: ['main', 'plugin'],
  screen_get_display_nearest: ['main', 'plugin'],
  screen_get_display_matching: ['main', 'plugin'],
  clipboard_copy_text: ['main', 'plugin'],
  clipboard_copy_image: ['main', 'plugin'],
  clipboard_copy_file: ['main', 'plugin'],
  clipboard_copy_files: ['main', 'plugin'],
  clipboard_read_text: ['main', 'plugin'],
  clipboard_read_image: ['main', 'plugin'],
  clipboard_read_files: ['main', 'plugin'],
  clipboard_hide_and_paste_text: ['main', 'plugin'],
  clipboard_hide_and_paste_image: ['main', 'plugin'],
  clipboard_hide_and_paste_file: ['main', 'plugin'],
  clipboard_hide_and_type: ['main', 'plugin'],
  clipboard_clear: ['main', 'plugin'],
  db_compare_and_set: ['main', 'plugin'],
  db_put: ['main', 'plugin'],
  db_get: ['main', 'plugin'],
  db_delete: ['main', 'plugin'],
  db_exists: ['main', 'plugin'],
  db_query: ['main', 'plugin'],
  db_batch: ['main', 'plugin'],
  db_put_secure: ['main', 'plugin'],
  db_get_secure: ['main', 'plugin'],
  // 主窗口只有带会话归属的调用能用（DatabaseService 内判定），未归属调用返回 PLUGIN_IDENTITY_REQUIRED
  credential_v1_status: ['main', 'plugin'],
  credential_v1_compare_and_set: ['main', 'plugin'],
  credential_v1_set: ['main', 'plugin'],
  credential_v1_get: ['main', 'plugin'],
  credential_v1_delete: ['main', 'plugin'],
  db_compact: ['main', 'plugin'],
  declarative_session_open: ['main'],
  declarative_session_close: ['main'],
  // 由 requirePluginPermission('process') 把关：插件必须声明 process 权限，未归属调用拒绝
  process_terminate_pid: ['main', 'plugin'],
  clipboard_history_query: ['main', 'plugin'],
  clipboard_history_toggle_pin: ['main', 'plugin'],
  clipboard_history_delete: ['main', 'plugin'],
  clipboard_history_restore: ['main', 'plugin'],
  clipboard_history_clear_unpinned: ['main', 'plugin'],
  clipboard_history_paste_sequential: ['main', 'plugin'],
  clipboard_history_reset_sequence: ['main', 'plugin'],
  snippets_list: ['main', 'plugin'],
  snippets_create: ['main', 'plugin'],
  snippets_update: ['main', 'plugin'],
  snippets_delete: ['main', 'plugin'],
  snippets_toggle: ['main', 'plugin'],
  snippets_match_and_expand: ['main', 'plugin'],
  snippets_import: ['main', 'plugin'],
  snippets_export: ['main', 'plugin'],
  filesearch_query: ['main', 'plugin'],
  filesearch_open: ['main', 'plugin'],
  filesearch_reveal: ['main', 'plugin'],
  filesearch_sha256: ['main', 'plugin'],
  window_manage_action: ['main', 'plugin'],
  window_manage_list_actions: ['main', 'plugin'],
  developer_create_extension: ['main', 'plugin'],
  developer_import_extension: ['main', 'plugin'],
  developer_list_extensions: ['main', 'plugin'],
  developer_toggle_extension: ['main', 'plugin'],
  developer_remove_extension: ['main', 'plugin'],
  developer_diagnostics: ['main', 'plugin'],
  mcp_install_server: ['main', 'plugin'],
  mcp_manage_servers: ['main', 'plugin'],
  mcp_toggle_server: ['main', 'plugin'],
  mcp_remove_server: ['main', 'plugin'],
  focus_start: ['main', 'plugin'],
  focus_toggle: ['main', 'plugin'],
  focus_pause: ['main', 'plugin'],
  focus_resume: ['main', 'plugin'],
  focus_complete: ['main', 'plugin'],
  focus_cancel: ['main', 'plugin'],
  focus_get_current: ['main', 'plugin'],
  focus_list_categories: ['main', 'plugin'],
  focus_create_category: ['main', 'plugin'],
  focus_get_stats: ['main', 'plugin'],
  screen_awareness_selected_text: ['main', 'plugin'],
  screen_awareness_screen: ['main', 'plugin'],
  screen_awareness_screen_area: ['main', 'plugin'],
  screen_awareness_focused_window: ['main', 'plugin'],
  dictation_start: ['main', 'plugin'],
  dictation_finish: ['main', 'plugin'],
  dictation_cancel: ['main', 'plugin'],
  dictation_get_last: ['main', 'plugin'],
  dictation_search: ['main', 'plugin'],
  dictation_add_word: ['main', 'plugin'],
  dictation_list_words: ['main', 'plugin'],
  calendar_create_event: ['main', 'plugin'],
  calendar_upcoming_events: ['main', 'plugin'],
  calendar_list_events: ['main', 'plugin'],
  calendar_count_events: ['main', 'plugin'],
  calendar_delete_event: ['main', 'plugin'],
  calendar_export_ics: ['main', 'plugin'],
  navigation_list_windows: ['main', 'plugin'],
  navigation_activate_window: ['main', 'plugin'],
  navigation_close_window: ['main', 'plugin'],
  web_search: ['main', 'plugin'],
  url_quick_open: ['main', 'plugin'],
  browser_get_active_tab: ['main', 'plugin'],
  contacts_list: ['main', 'plugin'],
  contacts_create: ['main', 'plugin'],
  contacts_delete: ['main', 'plugin'],
  games_list: ['main', 'plugin'],
  games_launch: ['main', 'plugin'],
  typing_get_challenges: ['main', 'plugin'],
  typing_evaluate: ['main', 'plugin'],
  game_2048_create: ['main', 'plugin'],
  game_2048_move: ['main', 'plugin'],
  debug_sample_memory: ['main', 'plugin'],
  debug_create_clipboard_history: ['main', 'plugin'],
  // M1.5 Group 2: 8 High-Frequency Services
  emoji_search: ['main', 'plugin'],
  emoji_record_usage: ['main', 'plugin'],
  emoji_toggle_favorite: ['main', 'plugin'],
  emoji_get_recents: ['main', 'plugin'],
  emoji_get_favorites: ['main', 'plugin'],
  translator_translate: ['main', 'plugin'],
  translator_detect_language: ['main', 'plugin'],
  translator_get_history: ['main', 'plugin'],
  notes_list: ['main', 'plugin'],
  notes_get: ['main', 'plugin'],
  notes_save: ['main', 'plugin'],
  notes_delete: ['main', 'plugin'],
  notes_restore: ['main', 'plugin'],
  notes_toggle_pin: ['main', 'plugin'],
  notes_count: ['main', 'plugin'],
  windows_run_search: ['main', 'plugin'],
  windows_run_execute: ['main', 'plugin'],
  windows_run_register_alias: ['main', 'plugin'],
  windows_run_remove_alias: ['main', 'plugin'],
  taskbar_toggle: ['main', 'plugin'],
  taskbar_show: ['main', 'plugin'],
  taskbar_hide: ['main', 'plugin'],
  taskbar_status: ['main', 'plugin'],
  screenshots_scan: ['main', 'plugin'],
  screenshots_paste_latest: ['main', 'plugin'],
  screenshots_toggle_pin: ['main', 'plugin'],
  screenshots_delete: ['main', 'plugin'],
  applications_list: ['main', 'plugin'],
  applications_uninstall: ['main', 'plugin'],
  dictionary_lookup: ['main', 'plugin'],
  dictionary_suggestions: ['main', 'plugin'],
  dictionary_toggle_favorite: ['main', 'plugin'],
  dictionary_get_favorites: ['main', 'plugin'],
  dictionary_get_history: ['main', 'plugin'],
  // M1.6 macOS & Cross-Platform Parity Methods
  filesearch_quick_look: ['main', 'plugin'],
  system_execute_action: ['main', 'plugin'],
  shortcuts_list: ['main', 'plugin'],
  shortcuts_run: ['main', 'plugin'],
  shortcuts_view: ['main', 'plugin'],
  navigation_search_menu_items: ['main', 'plugin'],
  navigation_click_menu_item: ['main', 'plugin'],
  folder_sync: ['main', 'plugin'],
  folder_sync_cancel: ['main', 'plugin'],
  font_manager: ['main', 'plugin'],
  font_manager_cancel: ['main', 'plugin'],
  recent_projects: ['main', 'plugin'],
  startup_manager: ['main', 'plugin'],
  browser_bookmarks_scan: ['main', 'plugin'],
  downloads_manager: ['main', 'plugin'],
  keyboard_lock: ['main', 'plugin'],
  docker_manager: ['main', 'plugin'],
  environment_manager: ['main', 'plugin'],
  file_unlock: ['main', 'plugin'],
  hosts_manager: ['main', 'plugin'],
  lan_network: ['main', 'plugin'],
  network_speedtest: ['main', 'plugin'],
  hotkey_probe: ['main', 'plugin'],
  dns_benchmark: ['main', 'plugin'],
  browser_bookmarks_cancel: ['main', 'plugin'],
  media_metadata: ['main', 'plugin'],
  media_metadata_cancel: ['main', 'plugin'],
  office_document: ['main', 'plugin'],
  markdown_document: ['main', 'plugin'],
  monitor_control: ['main', 'plugin'],
  ssh_proxy: ['main', 'plugin'],
  tls_inspect: ['main', 'plugin'],
  office_cancel: ['main', 'plugin'],
  audio_get_devices: ['main', 'plugin'],
  audio_set_default_device: ['main', 'plugin'],
  audio_set_volume: ['main', 'plugin'],
  audio_toggle_mute: ['main', 'plugin'],
  wifi_get_profiles: ['main', 'plugin'],
  wifi_get_password: ['main', 'plugin'],
  dictionary_speak: ['main', 'plugin'],
  brew_exec: ['main', 'plugin'],
  taskbar_set_dock_position: ['main', 'plugin'],
  taskbar_restart_dock: ['main', 'plugin'],
  script_commands_list: ['main', 'plugin'],
  script_commands_execute: ['main', 'plugin'],
  script_commands_create: ['main', 'plugin'],
  script_commands_reload: ['main', 'plugin']
} as const satisfies Record<string, readonly CallerType[]>

export type AllowedMethod = keyof typeof methodCapabilities

export function isAllowedMethod(method: string): method is AllowedMethod {
  return Object.hasOwn(methodCapabilities, method)
}

export function canCall(method: AllowedMethod, caller: CallerIdentity): boolean {
  if (caller.type === 'main') {
    return (methodCapabilities[method] as readonly CallerType[]).includes('main')
  }
  if (caller.type === 'plugin') {
    // 官方受信任内置插件具备系统特权，可调用主程序与特权 API
    if (isInternalPlugin(caller.pluginId)) {
      return true
    }
    return (methodCapabilities[method] as readonly CallerType[]).includes('plugin')
  }
  return false
}

/**
 * 系统内置受信任插件标识列表。
 * 内置插件采用 "internal-" 命名空间前缀，并在系统内部登记受信任。
 */
export const TRUSTED_INTERNAL_PLUGINS = [
  'internal-settings',
  'internal-super-panel',
  'internal-clipboard'
] as const

const trustedInternalPluginSet = new Set<string>(TRUSTED_INTERNAL_PLUGINS)

/**
 * 判断指定插件 ID 是否为官方受信任内置插件。
 * 遵循规范：
 * 1. 命名规范：必须以 "internal-" 开头；
 * 2. 注册规范：必须在系统内部受信任列表中明确登记。
 */
export function isInternalPlugin(pluginId: string | undefined | null): boolean {
  if (!pluginId || typeof pluginId !== 'string') return false
  return pluginId.startsWith('internal-') && trustedInternalPluginSet.has(pluginId)
}

/** 供测试或内部扩展注册受信任内置插件（必须以 internal- 为前缀） */
export function registerTrustedInternalPlugin(pluginId: string): void {
  if (typeof pluginId === 'string' && pluginId.startsWith('internal-')) {
    trustedInternalPluginSet.add(pluginId)
  }
}

/** 供测试或清理注销内置插件 */
export function unregisterTrustedInternalPlugin(pluginId: string): void {
  trustedInternalPluginSet.delete(pluginId)
}

/**
 * 系统特权 API 集合。
 * 包含修改系统设置、注册全局热键、深度系统信息、HMR 重载与插件管理、底层原生特权等。
 * 普通第三方插件无权调用此类 API；仅主进程（Main）及官方受信任内置插件（Internal Plugin）具备调用特权。
 */
export const PRIVILEGED_METHODS = new Set<AllowedMethod>([
  // 1. 修改/读取系统全局配置与设置
  'config_get',
  'config_set',
  'settings_get',
  'settings_set',
  'features_set',
  'system_get_autostart',
  'system_set_autostart',
  'system_set_dark_mode',
  'network_set_proxy',

  // 2. 注册与管理全局热键
  'trigger_register',
  'trigger_unregister',
  'trigger_set_enabled',
  'system_reload_hotkeys',

  // 3. 深度系统与硬件监控信息
  'system_get_hardware_summary',
  'system_get_cpu_usage',
  'system_get_memory_usage',
  'system_list_volumes',
  'system_get_disk_usage',
  'system_get_network_stats',
  'system_get_battery_status',
  'system_get_native_id',

  // 4. 插件管理与 HMR / 开发者工作台特权
  'plugin_list_get',
  'plugin_refresh',
  'plugin_toggle',
  'plugin_install',
  'plugin_install_status',
  'plugin_update',
  'plugin_uninstall',
  'plugin_revoke',
  'plugin_data_list',
  'plugin_data_restore',
  'window_toggle_devtools',

  // 5. 应用与系统更新
  'update_check',
  'update_get_version',
  'update_download_start',
  'update_install_start',
  'update_cancel',

  // 6. 底层原生特权执行与注册表写入
  'privileged_execute',
  'builtin_reg_write',
  'builtin_reg_delete',
  'builtin_file_write',
  'builtin_restart_explorer',

  // 7. 运行时授权管理
  'runtime_capability_grants_list',
  'runtime_capability_grant_revoke'
])

export function isPrivilegedMethod(method: AllowedMethod): boolean {
  return PRIVILEGED_METHODS.has(method)
}

export type SupportedPlatform = 'win32' | 'darwin'

/** Methods restricted to specific operating systems. Unlisted methods are universally supported. */
export const methodPlatformSupport: Partial<Record<AllowedMethod, readonly SupportedPlatform[]>> = {
  privileged_execute: ['win32'],
  builtin_reg_write: ['win32'],
  builtin_reg_delete: ['win32'],
  builtin_file_write: ['win32'],
  builtin_restart_explorer: ['win32'],
  dllplugin_list: ['win32'],
  dllplugin_call: ['win32'],
  dllplugin_call_async: ['win32'],
  dllplugin_call_with_callback: ['win32'],
  dllplugin_query_task: ['win32'],
  dllplugin_cancel_task: ['win32'],
  dllplugin_clear_callback_task: ['win32'],
  plugin_create_shortcut: ['win32']
}

export function isPlatformSupportedMethod(method: AllowedMethod, platform: string = process.platform): boolean {
  const platforms = methodPlatformSupport[method]
  if (!platforms) return true
  return platforms.includes(platform as SupportedPlatform)
}


