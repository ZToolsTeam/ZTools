let customBridge = null;
/**
 * 允许宿主或测试环境设置自定义 Bridge
 */
export function setDeclarativeBridge(bridge) {
    customBridge = bridge;
}
/**
 * 获取当前有效的 Bridge
 */
export function getDeclarativeBridge() {
    if (customBridge) {
        return customBridge;
    }
    if (typeof globalThis !== "undefined" && globalThis.__ZTOOLS_RAYCAST_BRIDGE__) {
        return globalThis.__ZTOOLS_RAYCAST_BRIDGE__;
    }
    return null;
}
