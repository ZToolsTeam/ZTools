/**
 * environment.ts
 * Raycast 兼容扩展运行环境信息对象
 */
let activeEnvironment = {
    extensionName: "ztools-extension",
    commandName: "main",
    commandMode: "view",
    isDevelopment: process.env.NODE_ENV !== "production",
    supportPath: process.env.ZTOOLS_SUPPORT_PATH || "",
    assetsPath: process.env.ZTOOLS_ASSETS_PATH || "",
    textSize: "medium",
    theme: "dark"
};
/**
 * 获取当前命令运行时的环境上下文
 */
export const environment = new Proxy({}, {
    get(_target, prop) {
        return activeEnvironment[prop];
    }
});
/**
 * 宿主/测试配置当前扩展环境
 */
export function setEnvironment(env) {
    activeEnvironment = { ...activeEnvironment, ...env };
}
