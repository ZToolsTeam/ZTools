import { isAllowedMethod, type AllowedMethod } from './capabilities.js'
import type { ReferenceMethod } from './reference-transport.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from './protocol-versions.js'
import { validateSdkApiLane, type SdkApiLane } from './sdk-api-lane.js'

export type ReferenceMethodClassification = 'protocol-stable' | 'protocol-versioned' | 'reference-only'
export type SdkMethodClassification =
  | 'legacy-only'
  | 'legacy-stable'
  | ReferenceMethodClassification

/**
 * Explicit protocol review for every method exposed by the reference transport.
 * Keep this exhaustive: adding a ReferenceMethod requires choosing a lane/schema class.
 */
export const REFERENCE_METHOD_CLASSIFICATIONS = {
  filesystem_write_file: 'protocol-versioned',
  filesystem_write_cache: 'protocol-versioned',
  filesystem_delete_file: 'protocol-versioned',
  filesystem_copy_file: 'protocol-versioned',
  filesystem_move_file: 'protocol-versioned',
  filesystem_create_directory: 'protocol-versioned',
  filesystem_delete_directory: 'protocol-versioned',
  network_http_download: 'protocol-versioned',
  clipboard_copy_text: 'protocol-versioned',
  clipboard_copy_image: 'protocol-versioned',
  clipboard_clear: 'protocol-stable',
  clipboard_copy_file: 'protocol-versioned',
  clipboard_copy_files: 'protocol-versioned',
  shell_trash_item: 'protocol-versioned',
  clipboard_read_image: 'protocol-versioned',
  screen_capture: 'protocol-versioned',
  screen_capture_region: 'reference-only',
  image_transform: 'reference-only',
  image_encode_base64: 'reference-only',
  image_decode_base64: 'reference-only',
  image_preview: 'reference-only',
  image_to_pdf: 'reference-only',
  image_to_gif: 'reference-only',
  image_preview_gif: 'reference-only',
  zip_compress: 'reference-only',
  zip_extract: 'reference-only',
  filesystem_read_file: 'protocol-versioned',
  filesystem_read_file_range: 'reference-only',
  filesystem_read_cache: 'protocol-versioned',
  filesystem_file_exists: 'protocol-versioned',
  filesystem_get_file_size: 'protocol-versioned',
  filesystem_directory_exists: 'protocol-versioned',
  filesystem_get_directory_contents: 'protocol-versioned',
  filesystem_get_current_directory: 'protocol-versioned',
  filesystem_set_current_directory: 'protocol-versioned',
  filesystem_find_files: 'protocol-versioned',
  filesystem_find_directories: 'protocol-versioned',
  filesystem_derive_read: 'reference-only',
  filesystem_derive_save: 'reference-only',
  filesystem_derive_directory: 'reference-only',
  filesystem_describe: 'reference-only',
  filesystem_revoke: 'reference-only',
  window_show_open_dialog: 'protocol-versioned',
  window_show_save_dialog: 'protocol-versioned',
  window_show_select_folder_dialog: 'protocol-versioned',
  network_http_upload: 'protocol-versioned',
  clipboard_read_files: 'protocol-versioned',
  filesystem_list_write_recovery: 'reference-only',
  filesystem_inspect_write_recovery: 'reference-only',
  sqlite_read_browser_snapshot: 'reference-only',
  ocr_local_languages: 'reference-only',
  ocr_recognize_reference: 'reference-only',
  clipboard_read_text: 'protocol-stable',
  image_get_info: 'reference-only',
  zip_list: 'reference-only',
  zip_test: 'reference-only',
  screen_get_cursor_pos: 'protocol-stable',
  screen_get_primary_display: 'protocol-stable',
  screen_get_all_displays: 'protocol-stable',
  screen_get_display_nearest: 'protocol-stable',
  screen_get_display_matching: 'protocol-stable'
} as const satisfies Record<ReferenceMethod, ReferenceMethodClassification>

/**
 * Legacy-only methods that remain safe to use on lane 2 because their contracts are
 * stable and they do not accept filesystem paths or native-reference payloads.
 * Everything else in AllowedMethod but outside the reference API is lane-1-only
 * until a reviewed lane-2 adapter exists.
 */
export const STABLE_LEGACY_ONLY_METHODS = [
  'app_ready',
  'analytics_report',
  'features_get',
  'features_set',
  'plugin_revoke',
  'clipboard_history_query',
  'clipboard_history_toggle_pin',
  'clipboard_history_delete',
  'clipboard_history_restore',
  'system_list_volumes',
  'clipboard_history_clear_unpinned',
  'clipboard_history_paste_sequential',
  'clipboard_history_reset_sequence',
  'snippets_list',
  'snippets_create',
  'snippets_update',
  'snippets_delete',
  'snippets_toggle',
  'snippets_match_and_expand',
  'snippets_import',
  'snippets_export',
  'filesearch_query',
  'filesearch_open',
  'filesearch_reveal',
  'filesearch_sha256',
  'window_manage_action',
  'window_manage_list_actions',
  'plugin_open',
  'plugin_window_close',
  'system_get_app_name',
  'system_get_app_version',
  'system_is_dev',
  'system_get_platform',
  'system_get_runtime_identity',
  'runtime_capability_get',
  'runtime_capability_request',
  'runtime_capability_revoke',
  'runtime_capability_grants_list',
  'runtime_capability_grant_revoke',
  'window_close',
  'window_minimize',
  'window_maximize',
  'window_fullscreen_toggle',
  'window_drag',
  'window_hide',
  'window_show',
  'pluginwin_hide',
  'pluginwin_show',
  'pluginwin_minimize',
  'pluginwin_restore',
  'window_set_height',
  'window_out_plugin',
  'window_set_size',
  'window_get_bounds',
  'window_set_opacity',
  'window_set_always_on_top',
  'window_show_tooltip',
  'window_hide_tooltip',
  'window_show_record_bar',
  'window_update_record_bar',
  'window_hide_record_bar',
  'window_toggle_devtools',
  'event_subscribe',
  'event_unsubscribe',
  'event_publish',
  'event_request',
  'network_http_request',
  'network_set_cookie',
  'network_get_cookie',
  'network_clear_cookies',
  'db_compare_and_set',
  'db_put',
  'db_get',
  'db_delete',
  'db_exists',
  'db_query',
  'db_batch',
  'db_put_secure',
  'db_get_secure',
  'credential_v1_status',
  'credential_v1_compare_and_set',
  'credential_v1_set',
  'credential_v1_get',
  'credential_v1_delete',
  'db_compact',
  'process_terminate_pid',
  'developer_create_extension',
  'developer_import_extension',
  'developer_list_extensions',
  'developer_toggle_extension',
  'developer_remove_extension',
  'developer_diagnostics',
  'mcp_install_server',
  'mcp_manage_servers',
  'mcp_toggle_server',
  'mcp_remove_server',
  'focus_start',
  'focus_toggle',
  'focus_pause',
  'focus_resume',
  'focus_complete',
  'focus_cancel',
  'focus_get_current',
  'focus_list_categories',
  'focus_create_category',
  'focus_get_stats',
  'screen_awareness_selected_text',
  'screen_awareness_screen',
  'screen_awareness_screen_area',
  'screen_awareness_focused_window',
  'dictation_start',
  'dictation_finish',
  'dictation_cancel',
  'dictation_get_last',
  'dictation_search',
  'dictation_add_word',
  'dictation_list_words',
  'calendar_create_event',
  'calendar_upcoming_events',
  'calendar_list_events',
  'calendar_count_events',
  'calendar_delete_event',
  'calendar_export_ics',
  'navigation_list_windows',
  'navigation_activate_window',
  'navigation_close_window',
  'web_search',
  'url_quick_open',
  'browser_get_active_tab',
  'contacts_list',
  'contacts_create',
  'contacts_delete',
  'games_list',
  'games_launch',
  'typing_get_challenges',
  'typing_evaluate',
  'game_2048_create',
  'game_2048_move',
  'debug_sample_memory',
  'debug_create_clipboard_history',
  'emoji_search',
  'emoji_record_usage',
  'emoji_toggle_favorite',
  'emoji_get_recents',
  'emoji_get_favorites',
  'translator_translate',
  'translator_detect_language',
  'translator_get_history',
  'notes_list',
  'notes_get',
  'notes_save',
  'notes_delete',
  'notes_restore',
  'notes_toggle_pin',
  'notes_count',
  'windows_run_search',
  'windows_run_execute',
  'windows_run_register_alias',
  'windows_run_remove_alias',
  'taskbar_toggle',
  'taskbar_show',
  'taskbar_hide',
  'taskbar_status',
  'screenshots_scan',
  'screenshots_paste_latest',
  'screenshots_toggle_pin',
  'screenshots_delete',
  'applications_list',
  'applications_uninstall',
  'dictionary_lookup',
  'dictionary_suggestions',
  'dictionary_toggle_favorite',
  'dictionary_get_favorites',
  'dictionary_get_history'
] as const satisfies readonly AllowedMethod[]

export type SdkMethodRouteDecision =
  | { route: 'legacy'; lane: SdkApiLane; classification: 'legacy-only' | 'legacy-stable' | 'protocol-stable' | 'protocol-versioned' }
  | { route: 'reference'; lane: SdkApiLane; classification: 'protocol-stable' | 'protocol-versioned' | 'reference-only' }
  | { route: 'reject'; reason: 'unknown-method' | 'unsupported-lane' | 'lane-2-required' | 'lane-2-adapter-required' }

const referencePolicy = REFERENCE_METHOD_CLASSIFICATIONS as Record<string, ReferenceMethodClassification>
const stableLegacyOnlySet = new Set<string>(STABLE_LEGACY_ONLY_METHODS)

/**
 * Decide the Main transport for one allowed method and the Registry-selected lane.
 * Request envelopes and Renderer-provided lane fields are deliberately not accepted.
 */
export function selectSdkMethodRoute(
  methodValue: unknown,
  trustedLaneValue: unknown,
  hostMaximum: unknown = SDK_HOST_MAXIMUM_CONTRACT_VERSION
): SdkMethodRouteDecision {
  let lane: SdkApiLane
  try {
    lane = validateSdkApiLane(trustedLaneValue, hostMaximum)
  } catch {
    return { route: 'reject', reason: 'unsupported-lane' }
  }

  if (typeof methodValue !== 'string') return { route: 'reject', reason: 'unknown-method' }
  const allowedByLegacy = isAllowedMethod(methodValue)
  const referenceClassification = referencePolicy[methodValue]
  if (!allowedByLegacy && referenceClassification === undefined) {
    return { route: 'reject', reason: 'unknown-method' }
  }

  if (referenceClassification !== undefined) {
    if (referenceClassification !== 'reference-only' && !allowedByLegacy) {
      return { route: 'reject', reason: 'unknown-method' }
    }
    if (referenceClassification === 'reference-only') {
      return lane === 1
        ? { route: 'reject', reason: 'lane-2-required' }
        : { route: 'reference', lane, classification: referenceClassification }
    }
    return lane === 1
      ? { route: 'legacy', lane, classification: referenceClassification }
      : { route: 'reference', lane, classification: referenceClassification }
  }

  if (!allowedByLegacy) return { route: 'reject', reason: 'unknown-method' }
  if (lane === 1) return { route: 'legacy', lane, classification: 'legacy-only' }
  return stableLegacyOnlySet.has(methodValue)
    ? { route: 'legacy', lane, classification: 'legacy-stable' }
    : { route: 'reject', reason: 'lane-2-adapter-required' }
}
