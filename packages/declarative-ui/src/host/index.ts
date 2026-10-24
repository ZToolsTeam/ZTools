/**
 * 宿主专用接口（客户端插件加载器使用，不属于插件 SDK）
 *
 * 不从包入口 @ztools/declarative-ui 导出；插件运行时也拿不到（插件加载器的模块白名单只放行包入口，
 * require('@ztools/declarative-ui/host') 会被拦截）。客户端通过 package.json 的 "./host" 子路径
 * （Vite/Vitest 另有同名别名）引用本文件编译后的 dist/host/index.js。
 */
export { createCacheScope } from "../utils/hooks.js";
export type { CacheScope } from "../utils/hooks.js";
export { configureTranslationService, getTranslationEndpoint } from "../examples/google-translate/translation-config.js";
