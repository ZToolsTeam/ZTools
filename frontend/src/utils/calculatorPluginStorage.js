import { createScopedLocalStorage } from './pluginStorage.js'

/**
 * 内置计算器插件的存储空间。主搜索框的即时计算把历史写到这里，
 * 计算器插件里也能看到同一份计算历史。
 */
export const calculatorPluginStorage = createScopedLocalStorage('calculator')
