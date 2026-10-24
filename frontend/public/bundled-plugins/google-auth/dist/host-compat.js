/**
 * 旧版客户端兼容：插件运行在比自己更旧的 ZTools 里时，给出明确的升级提示或安全的退路。
 *
 * - 插件里的 `@ztools/declarative-ui` 由客户端在运行时提供，SDK 里新增的方法在旧客户端上并不存在；
 * - 宿主接口在旧客户端上不存在时返回「未知方法」，这里统一换成用户看得懂的升级提示。
 */
export const HOST_UPGRADE_HINT = '当前 ZTools 版本过低，请升级到最新版本后再试';
/** 宿主是否因为不认识这个接口而失败（旧客户端） */
export function isHostMethodMissing(error) {
    const text = error instanceof Error ? error.message : String(error ?? '');
    return /METHOD_NOT_FOUND|METHOD_NOT_AVAILABLE|未知方法|is not a function/.test(text);
}
/** 生成「某功能需要新版客户端」的报错 */
export function hostUpgradeError(feature) {
    return new Error(`${feature}需要新版 ZTools，${HOST_UPGRADE_HINT}`);
}
/**
 * 读出最新值、修改后写回。
 * 客户端提供 updateItem 时用它保证多窗口不互相覆盖；旧客户端没有时退回读后写（与旧版插件行为一致）。
 */
export async function updateStorageItem(storage, key, update) {
    if (typeof storage.updateItem === 'function')
        return storage.updateItem(key, update);
    const current = await storage.getItem(key);
    const next = update(current);
    if (JSON.stringify(next) !== JSON.stringify(current))
        await storage.setItem(key, next);
    return next;
}
