/**
 * preferences.ts
 * Raycast 兼容扩展用户配置读取 API
 */

let preferencesStore: Record<string, any> = {};

/**
 * 获取当前扩展的用户偏好配置项 (Preferences)
 */
export function getPreferenceValues<T = Record<string, any>>(): T {
  return { ...preferencesStore } as T;
}

/**
 * 宿主/测试设置偏好项注入值
 */
export function setPreferenceValues(prefs: Record<string, any>): void {
  preferencesStore = { ...preferencesStore, ...prefs };
}

/**
 * 清空配置存储（供测试或扩展重置）
 */
export function clearPreferenceValues(): void {
  preferencesStore = {};
}
