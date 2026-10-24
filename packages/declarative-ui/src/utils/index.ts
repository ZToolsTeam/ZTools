/**
 * @raycast/utils 兼容层：插件可用的 Hook 与类型（实现见 ./hooks.ts）
 *
 * 这里只列出插件可以用的名字。宿主专用的 createCacheScope 不在此导出，
 * 由 ../host/index.ts 提供给客户端加载器。
 */
export { usePromise, useCachedPromise, useFetch, useCachedState } from "./hooks.js";
export type {
  UsePromiseOptions,
  UsePromiseResult,
  UseCachedPromiseOptions,
  UseFetchOptions
} from "./hooks.js";
