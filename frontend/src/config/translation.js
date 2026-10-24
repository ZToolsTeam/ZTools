/**
 * 内置翻译命令的在线翻译服务地址
 *
 * 地址在构建时由 VITE_TRANSLATION_ENDPOINT 注入（官方构建读 .env.production 或环境变量），
 * 源码里不写死任何翻译服务地址。未配置时翻译命令只用内置词典，其他内容提示「未配置翻译服务」。
 */
import { configureTranslationService } from '@ztools/declarative-ui/host'

/**
 * 把构建时注入的翻译服务地址交给内置翻译命令
 * @param {string} [endpoint] 默认读取 import.meta.env.VITE_TRANSLATION_ENDPOINT
 * @returns {string} 实际生效的地址；未配置或地址无效时为空字符串
 */
export function applyTranslationServiceConfig(endpoint = import.meta.env.VITE_TRANSLATION_ENDPOINT) {
  return configureTranslationService({ endpoint: typeof endpoint === 'string' ? endpoint : '' })
}
