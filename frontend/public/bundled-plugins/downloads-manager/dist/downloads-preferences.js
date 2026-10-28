import { LocalStorage } from '@ztools/declarative-ui';
const KEY = 'ztools_downloads_preferences_v2';
const LEGACY_PINS = 'ztools_downloads_pinned_v1';
const LEGACY_DIRS = 'ztools_downloads_custom_dirs_v1';
const empty = () => ({ pins: [], directories: [] });
function stringArray(value) {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length > 0 && !item.includes('\0'))) {
        throw new Error('下载管理设置损坏，已保留原数据，请修复设置后重试。');
    }
    return [...new Set(value)];
}
function parse(value) {
    if (value === undefined)
        return empty();
    if (!value || typeof value !== 'object' || !('pins' in value) || !('directories' in value))
        throw new Error('下载管理设置格式无效，已停止写入。');
    return { pins: stringArray(value.pins), directories: stringArray(value.directories) };
}
export async function readDownloadPreferences() {
    const stored = await LocalStorage.getItem(KEY);
    if (stored !== undefined)
        return parse(stored);
    // 只在新版记录不存在时迁移旧数据；保留旧记录，读取或保存失败时不得当作空设置。
    if (typeof localStorage === 'undefined')
        return empty();
    const pins = localStorage.getItem(LEGACY_PINS), directories = localStorage.getItem(LEGACY_DIRS);
    if (pins === null && directories === null)
        return empty();
    const migrated = { pins: pins === null ? [] : stringArray(JSON.parse(pins)), directories: directories === null ? [] : stringArray(JSON.parse(directories)) };
    if (await LocalStorage.compareAndSet(KEY, undefined, migrated))
        return migrated;
    const current = await LocalStorage.getItem(KEY);
    if (current === undefined)
        throw new Error('设置迁移未确认成功，请重试；旧数据未删除。');
    return parse(current);
}
export async function updateDownloadPreferences(change) {
    await readDownloadPreferences();
    return LocalStorage.updateItem(KEY, raw => parse(change(parse(raw))));
}
