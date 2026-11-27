import { AiMcpError } from '../i18n.js';

export interface ValidateRemoteServiceUrlOptions {
  /**
   * 是否显式放行非回环私有内网地址（如 10.x / 172.16-31.x / 192.168.x / fc00::/7），默认 false
   */
  allowPrivateNetwork?: boolean;
  /**
   * 显式指定错误文案语言
   */
  locale?: string;
}

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data'
]);

/**
 * 去除 IPv6 字面量方括号并转为小写
 */
function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/**
 * 解析标准点分 IPv4 或 IPv4-mapped IPv6（含十进制与 Node URL 归一化后的十六进制形式）
 */
function extractIpv4Octets(normalizedHost: string): [number, number, number, number] | null {
  // 1. 标准点分十进制 IPv4
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalizedHost);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.every((n) => n >= 0 && n <= 255)) {
      return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
    }
    return null;
  }

  // 2. IPv4-mapped IPv6 点分形式 ::ffff:a.b.c.d 或 0:0:0:0:0:ffff:a.b.c.d
  const mappedDottedMatch = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(
    normalizedHost
  );
  if (mappedDottedMatch) {
    const octets = mappedDottedMatch.slice(1).map((part) => Number.parseInt(part, 10));
    if (octets.every((n) => n >= 0 && n <= 255)) {
      return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
    }
    return null;
  }

  // 3. Node URL 规范化后的 IPv4-mapped IPv6 十六进制形式 ::ffff:xxxx:yyyy
  const mappedHexMatch = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
    normalizedHost
  );
  if (mappedHexMatch) {
    const hi = Number.parseInt(mappedHexMatch[1]!, 16);
    const lo = Number.parseInt(mappedHexMatch[2]!, 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }

  return null;
}

/**
 * 判断主机是否为允许的回环地址（127.0.0.1 / localhost / [::1]）
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1'
  );
}

/**
 * 判断主机是否属于禁止访问的云元数据、链路本地或未指定地址
 */
function isBlockedMetadataOrLinkLocal(normalizedHost: string): boolean {
  if (METADATA_HOSTNAMES.has(normalizedHost)) {
    return true;
  }

  // IPv6 未指定地址 ::
  if (normalizedHost === '::' || normalizedHost === '0:0:0:0:0:0:0:0') {
    return true;
  }

  const ipv4 = extractIpv4Octets(normalizedHost);
  if (ipv4) {
    const [a, b, c, d] = ipv4;
    // 0.0.0.0/8（未指定网络）
    if (a === 0) return true;
    // 169.254.0.0/16（链路本地与 AWS/Azure/GCP 元数据服务）
    if (a === 169 && b === 254) return true;
    // 100.100.100.200（阿里云元数据服务）
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    return false;
  }

  // IPv6 链路本地 fe80::/10（首 16 位段 0xfe80 ~ 0xfebf）
  if (normalizedHost.includes(':')) {
    const firstHextetStr = normalizedHost.split(':')[0];
    if (firstHextetStr && /^[0-9a-f]{1,4}$/i.test(firstHextetStr)) {
      const firstHextet = Number.parseInt(firstHextetStr, 16);
      if ((firstHextet & 0xffc0) === 0xfe80) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 判断主机是否属于非回环私有内网地址
 */
function isPrivateNetworkHostname(normalizedHost: string): boolean {
  if (isLoopbackHostname(normalizedHost)) {
    return false;
  }

  const ipv4 = extractIpv4Octets(normalizedHost);
  if (ipv4) {
    const [a, b] = ipv4;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 100.64.0.0/10（运营商级 NAT 内网段）
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 其余 127.0.0.0/8 非 127.0.0.1 地址（包括 ::ffff:127.x.y.z）
    if (a === 127) return true;
    return false;
  }

  // IPv6 唯一本地地址 fc00::/7（fc00:: ~ fdff::）
  if (normalizedHost.includes(':')) {
    const firstHextetStr = normalizedHost.split(':')[0];
    if (firstHextetStr && /^[0-9a-f]{1,4}$/i.test(firstHextetStr)) {
      const firstHextet = Number.parseInt(firstHextetStr, 16);
      if ((firstHextet & 0xfe00) === 0xfc00) {
        return true;
      }
    }
  }

  // 常见内网保留域名后缀
  if (normalizedHost.endsWith('.local') || normalizedHost.endsWith('.internal')) {
    return true;
  }

  return false;
}

/**
 * 校验远程 AI Provider 或 MCP HTTP/SSE 服务 URL（防 SSRF / 凭据注入 / 明文传输）
 * - 仅允许 https:（仅对回环主机 127.0.0.1 / localhost / [::1] 放行 http:）
 * - 禁止 username/password 内嵌凭据
 * - 始终禁止云元数据与链路本地/未指定地址（169.254.0.0/16、fe80::/10、0.0.0.0、::）
 * - 非回环私有内网默认拒绝，除非显式设置 allowPrivateNetwork: true
 */
export function validateRemoteServiceUrl(
  rawUrl: string,
  options: ValidateRemoteServiceUrlOptions = {}
): URL {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AiMcpError('security.invalidUrl', { url: String(rawUrl ?? '') }, options.locale);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new AiMcpError(
      'security.credentialsInUrlNotAllowed',
      { url: `${parsed.protocol}//${parsed.host}${parsed.pathname}` },
      options.locale
    );
  }

  const normalizedHost = normalizeHostname(parsed.hostname);

  // 先拦截非 http/https 协议（例如 file: / ftp: / javascript:）
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiMcpError(
      'security.protocolNotAllowed',
      { protocol: parsed.protocol, host: normalizedHost || trimmed },
      options.locale
    );
  }

  if (!normalizedHost) {
    throw new AiMcpError('security.invalidUrl', { url: trimmed }, options.locale);
  }

  // 优先拦截云元数据、链路本地与未指定地址（任何场景均不允许放行）
  if (isBlockedMetadataOrLinkLocal(normalizedHost)) {
    throw new AiMcpError(
      'security.blockedMetadataOrLinkLocal',
      { host: normalizedHost },
      options.locale
    );
  }

  const loopback = isLoopbackHostname(normalizedHost);
  if (parsed.protocol === 'http:' && !loopback) {
    throw new AiMcpError(
      'security.protocolNotAllowed',
      { protocol: parsed.protocol, host: normalizedHost },
      options.locale
    );
  }

  if (!loopback && options.allowPrivateNetwork !== true && isPrivateNetworkHostname(normalizedHost)) {
    throw new AiMcpError(
      'security.privateNetworkNotAllowed',
      { host: normalizedHost },
      options.locale
    );
  }

  return parsed;
}

/**
 * 校验本地模型嗅探 URL：仅允许 http:/https: 且主机必须为回环地址（127.0.0.1 / localhost / [::1]），禁止内嵌凭据
 */
export function validateLoopbackUrl(rawUrl: string, locale?: string): URL {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AiMcpError('security.invalidUrl', { url: String(rawUrl ?? '') }, locale);
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new AiMcpError(
      'security.credentialsInUrlNotAllowed',
      { url: `${parsed.protocol}//${parsed.host}${parsed.pathname}` },
      locale
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiMcpError(
      'security.loopbackProtocolNotAllowed',
      { protocol: parsed.protocol },
      locale
    );
  }

  const normalizedHost = normalizeHostname(parsed.hostname);
  if (!isLoopbackHostname(normalizedHost)) {
    throw new AiMcpError('security.loopbackRequired', { host: normalizedHost || trimmed }, locale);
  }

  return parsed;
}
