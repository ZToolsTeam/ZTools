/**
 * 在线翻译服务地址配置
 *
 * 源码里不写任何翻译服务地址：由宿主在启动时通过 configureTranslationService 注入
 * （官方构建在构建时注入地址，开源构建默认不配置）。未配置时翻译命令只用内置词典，
 * 词典没有收录的内容提示「未配置翻译服务」。
 *
 * 配置入口只从宿主专用入口 @ztools/declarative-ui/host 导出，不从包入口导出，
 * 插件拿不到，无法把内置翻译命令的请求改发到别的地址。
 */

let translationEndpoint = "";

/** 只接受 http / https 地址，且不带账号密码；其他一律视为未配置 */
function normalizeEndpoint(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * 设置在线翻译服务地址（宿主启动时调用）；传空值或无效地址等于清除配置
 * @returns 实际生效的地址，未配置时为空字符串
 */
export function configureTranslationService(options: { endpoint?: unknown } = {}): string {
  translationEndpoint = normalizeEndpoint(options?.endpoint);
  return translationEndpoint;
}

/** 当前在线翻译服务地址，未配置时为空字符串 */
export function getTranslationEndpoint(): string {
  return translationEndpoint;
}
