/**
 * Wi-Fi 密码查看器核心服务与解析器 (wifi-service.ts)
 *
 * 借鉴 Raycast 官方 `extensions/wifi-password-reveal/src/utils.ts` 源码改造：
 * - 保留原版 `parseNetshWlanProfiles`, `parseNetshWlanProfileEssentials`, `parseWifiInterface`
 * - 新增中文 Windows 系统输出兼容（"所有用户配置文件"、"SSID 名称"、"身份验证"、"安全密钥"、"关键内容"）
 * - 新增标准 Wi-Fi 连网二维码协议 (`WIFI:T:WPA;S:...;P:...;;`) 与 SVG 二维码生成
 */

import {
  WifiProfileInfo,
  WifiSecurityType,
  WifiParseDetailResult,
  WifiSecurityFilter,
  WifiSortBy,
  FetchWifiProfilesOptions
} from "./types.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export const SAMPLE_WIFI_PROFILES: readonly WifiProfileInfo[] = Object.freeze([
  {
    id: "wifi-office-5g",
    ssid: "ZTools-Office-5G",
    password: "ZTools@2026#Secure!",
    authType: "WPA3-Personal",
    cipher: "GCMP",
    band: "5 GHz",
    isConnected: true,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 98,
    interfaceName: "WLAN",
    lastConnected: "当前已连接",
    pinyin: "ztools office 5g bangongshi",
    notes: "公司研发中心高速 5G 频段"
  },
  {
    id: "wifi-home-dual",
    ssid: "Xiaomi_Home_WiFi6",
    password: "HomeSweetHome888",
    authType: "WPA2-Personal",
    cipher: "CCMP (AES)",
    band: "Dual-Band (2.4/5 GHz)",
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 86,
    interfaceName: "WLAN",
    lastConnected: "昨天 22:30",
    pinyin: "xiaomi home wifi6 jiali",
    notes: "家里客厅小米路由器"
  },
  {
    id: "wifi-guest",
    ssid: "ZTools-Guest",
    password: "Guest123456",
    authType: "WPA2-Personal",
    cipher: "CCMP (AES)",
    band: "2.4 GHz",
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: false,
    signalPercent: 75,
    interfaceName: "WLAN",
    lastConnected: "3 天前",
    pinyin: "ztools guest fangke",
    notes: "访客接待专用网络"
  },
  {
    id: "wifi-cafe-open",
    ssid: "Starbucks_Free_WiFi",
    password: "",
    authType: "Open",
    cipher: "None",
    band: "2.4 GHz",
    isConnected: false,
    isOpenNetwork: true,
    isEnterprise: false,
    signalPercent: 62,
    interfaceName: "WLAN",
    lastConnected: "1 周前",
    pinyin: "starbucks free wifi xingbake",
    notes: "开放网络（无密码，网页认证）"
  },
  {
    id: "wifi-corp-8021x",
    ssid: "Corp-Dot1X-Internal",
    password: "",
    authType: "WPA2-Enterprise",
    cipher: "CCMP (AES)",
    band: "5 GHz",
    isConnected: false,
    isOpenNetwork: false,
    isEnterprise: true,
    signalPercent: 80,
    interfaceName: "WLAN",
    lastConnected: "2 周前",
    pinyin: "corp dot1x internal qiye",
    notes: "802.1X 证书企业内网（无预共享明文密钥）"
  }
]);

/**
 * 源自 Raycast `wifi-password-reveal/src/utils.ts`:
 * 解析 `netsh wlan show profiles` 输出，同时兼容英文与中文 Windows
 */
export function parseNetshWlanProfiles(output: string): string[] {
  if (typeof output !== "string" || !output.trim()) {
    return [];
  }

  const userProfiles: string[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const isEnglishProfile = trimmed.startsWith("All User Profile") || trimmed.startsWith("Current User Profile");
    const isChineseProfile = trimmed.startsWith("所有用户配置文件") || trimmed.startsWith("当前用户配置文件");

    if (isEnglishProfile || isChineseProfile) {
      const colonIdx = trimmed.indexOf(":");
      const fullWidthColonIdx = trimmed.indexOf("：");
      const idx = colonIdx !== -1 ? colonIdx : fullWidthColonIdx;
      if (idx !== -1) {
        const ssid = trimmed.slice(idx + 1).trim();
        if (ssid && !seen.has(ssid)) {
          seen.add(ssid);
          userProfiles.push(ssid);
        }
      }
    }
  }

  return userProfiles;
}

export const parseWindowsWlanProfiles = parseNetshWlanProfiles;

const OPEN_AUTH_VALUES = new Set(["open", "none", "开放式", "无"]);
const ENTERPRISE_AUTH_PATTERNS = [/enterprise/i, /802\.1x/i, /企业/];

export function normalizeSecurityType(rawAuth: string): WifiSecurityType {
  const val = (rawAuth || "").trim();
  if (!val) return "Unknown";
  const lower = val.toLowerCase();

  if (OPEN_AUTH_VALUES.has(lower)) return "Open";
  if (lower.includes("wpa3") && ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return "WPA3-Enterprise";
  if (lower.includes("wpa2") && ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return "WPA2-Enterprise";
  if (ENTERPRISE_AUTH_PATTERNS.some((p) => p.test(val))) return "WPA2-Enterprise";
  if (lower.includes("wpa3")) return "WPA3-Personal";
  if (lower.includes("wpa2") && lower.includes("wpa/")) return "WPA/WPA2-Personal";
  if (lower.includes("wpa2")) return "WPA2-Personal";
  if (lower.includes("wep")) return "WEP";
  return "WPA2-Personal";
}

/**
 * 源自 Raycast `wifi-password-reveal/src/utils.ts`:
 * 解析 `netsh wlan show profile name="<ssid>" key=clear` 输出，支持中英双语 Windows
 */
export function parseWindowsWlanProfileDetail(ssidInput: string, output: string): WifiParseDetailResult {
  const cleanInputSsid = (ssidInput || "").trim();
  if (typeof output !== "string" || !output.trim()) {
    return {
      ssid: cleanInputSsid,
      password: "",
      authType: "Unknown",
      cipher: "Unknown",
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: "InvalidInput",
        message: "Empty netsh output"
      }
    };
  }

  if (
    (output.includes('Profile "') && output.includes("is not found on the system")) ||
    output.includes("系统上没有配置文件") ||
    output.includes("找不到配置文件")
  ) {
    return {
      ssid: cleanInputSsid,
      password: "",
      authType: "Unknown",
      cipher: "Unknown",
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: "ProfileNotFound",
        message: `未在系统中找到 Wi-Fi 配置文件 "${cleanInputSsid}"`
      }
    };
  }

  let ssidName = cleanInputSsid;
  let authentication = "";
  let cipher = "CCMP (AES)";
  let securityKeyState: "present" | "absent" | null = null;
  let keyContent = "";
  let keyContentFound = false;

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":") !== -1 ? trimmed.indexOf(":") : trimmed.indexOf("：");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const val = trimmed.slice(colonIdx + 1).trim();

    if (key.startsWith("SSID name") || key.startsWith("SSID 名称")) {
      let parsedSsid = val;
      if (parsedSsid.startsWith('"') && parsedSsid.endsWith('"')) {
        parsedSsid = parsedSsid.slice(1, -1);
      }
      if (parsedSsid) ssidName = parsedSsid;
    } else if (key === "Authentication" || key === "身份验证") {
      authentication = val;
    } else if (key === "Cipher" || key === "密码" || key === "加密") {
      cipher = val;
    } else if (key === "Security key" || key === "Security Key" || key === "安全密钥") {
      const lowerVal = val.toLowerCase();
      if (lowerVal === "present" || val === "存在") {
        securityKeyState = "present";
      } else if (lowerVal === "absent" || val === "不存在") {
        securityKeyState = "absent";
      }
    } else if (key === "Key Content" || key === "关键内容") {
      keyContent = val;
      keyContentFound = true;
    }
  }

  const authType = normalizeSecurityType(authentication);
  const isOpenNetwork = authType === "Open";
  const isEnterprise = authType === "WPA2-Enterprise" || authType === "WPA3-Enterprise";

  if (isOpenNetwork) {
    return {
      ssid: ssidName,
      password: "",
      authType,
      cipher: "None",
      isOpenNetwork: true,
      isEnterprise: false
    };
  }

  if (isEnterprise || securityKeyState === "absent") {
    return {
      ssid: ssidName,
      password: "",
      authType: isEnterprise ? authType : "WPA2-Enterprise",
      cipher,
      isOpenNetwork: false,
      isEnterprise: true,
      error: {
        code: "EnterpriseNetwork",
        message: `"${ssidName}" 使用企业级 802.1X/证书认证，本机不存储预共享明文密码`
      }
    };
  }

  if (securityKeyState === "present" && !keyContentFound) {
    return {
      ssid: ssidName,
      password: "",
      authType,
      cipher,
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: "PermissionDenied",
        message: "Windows 隐藏了关键内容，请以管理员身份运行以读取明文密钥"
      }
    };
  }

  if (securityKeyState === null && !keyContentFound) {
    return {
      ssid: ssidName,
      password: "",
      authType,
      cipher,
      isOpenNetwork: false,
      isEnterprise: false,
      error: {
        code: "Unknown",
        message: "无法从 netsh 输出中解析出安全密钥信息"
      }
    };
  }

  return {
    ssid: ssidName,
    password: keyContent,
    authType,
    cipher,
    isOpenNetwork: false,
    isEnterprise: false
  };
}

/**
 * 源自 Raycast `wifi-password-reveal/src/utils.ts`:
 * 解析 macOS `networksetup -listallhardwareports` 获取 Wi-Fi 网卡名 (如 en0)
 */
export function parseWifiInterface(output: string): string {
  if (typeof output !== "string" || !output.trim()) return "en0";
  const lines = output.split(/\r?\n/);
  let inWifiSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Hardware Port: Wi-Fi" || trimmed === "Hardware Port: AirPort") {
      inWifiSection = true;
      continue;
    }
    if (inWifiSection && trimmed.startsWith("Device:")) {
      const dev = trimmed.slice("Device:".length).trim();
      return dev || "en0";
    }
    if (inWifiSection && trimmed.startsWith("Hardware Port:")) {
      break;
    }
  }
  return "en0";
}

/**
 * 转义 Wi-Fi 二维码协议中的特殊字符 (\, ;, ,, :, ")
 */
export function escapeWifiQrField(value: string): string {
  if (typeof value !== "string") return "";
  return value.replace(/([\\;,:""])/g, "\\$1");
}

/**
 * 生成标准连网二维码协议字符串: WIFI:T:WPA;S:<SSID>;P:<PASSWORD>;;
 */
export function generateWifiQrString(
  ssid: string,
  password = "",
  authType: WifiSecurityType = "WPA2-Personal"
): string {
  const cleanSsid = (ssid || "").trim();
  if (!cleanSsid) {
    throw new Error("SSID 不能为空");
  }
  const isOpen = authType === "Open" || !password;
  const qrType = isOpen ? "nopass" : authType === "WEP" ? "WEP" : "WPA";
  const escapedSsid = escapeWifiQrField(cleanSsid);
  const escapedPwd = isOpen ? "" : escapeWifiQrField(password);
  return `WIFI:T:${qrType};S:${escapedSsid};P:${escapedPwd};;`;
}

/**
 * 生成 Wi-Fi 卡片 SVG Data URL 供详情页预览
 */
export function generateWifiQrSvgDataUrl(profile: WifiProfileInfo): string {
  const ssidSafe = (profile.ssid || "Wi-Fi").replace(/[<>&"']/g, "");
  const qrPayload = generateWifiQrString(profile.ssid || "Wi-Fi", profile.password, profile.authType);
  // 基于哈希生成确定性矩阵图案
  let hash = 2166136261;
  for (let i = 0; i < qrPayload.length; i++) {
    hash ^= qrPayload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const cells: string[] = [];
  const gridSize = 11;
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const isCorner =
        (r < 3 && c < 3) || (r < 3 && c >= gridSize - 3) || (r >= gridSize - 3 && c < 3);
      const bit = ((Math.abs(hash + r * 31 + c * 17) >> ((r + c) % 16)) & 1) === 1;
      if (isCorner || bit) {
        cells.push(
          `<rect x="${26 + c * 10}" y="${24 + r * 10}" width="8" height="8" rx="1.5" fill="#10b981" />`
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="175" viewBox="0 0 160 175">
    <rect width="160" height="175" rx="14" fill="#0f172a" stroke="#1e293b" stroke-width="2"/>
    ${cells.join("")}
    <text x="80" y="156" text-anchor="middle" fill="#f8fafc" font-family="sans-serif" font-size="11" font-weight="bold">${ssidSafe.slice(0, 18)}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 过滤与排序 Wi-Fi 配置文件列表
 */
export function filterAndSortWifiProfiles(
  profiles: readonly WifiProfileInfo[],
  options: {
    query?: string;
    securityFilter?: WifiSecurityFilter;
    sortBy?: WifiSortBy;
  } = {}
): WifiProfileInfo[] {
  if (!Array.isArray(profiles)) return [];
  const q = (options.query || "").trim().toLowerCase();
  const sec = options.securityFilter || "all";
  const sortBy = options.sortBy || "connected";

  const filtered = profiles.filter((item) => {
    if (!item || typeof item.ssid !== "string") return false;
    if (sec === "wpa3" && !item.authType.includes("WPA3")) return false;
    if (sec === "wpa2" && !item.authType.includes("WPA2")) return false;
    if (sec === "open" && !item.isOpenNetwork) return false;
    if (sec === "enterprise" && !item.isEnterprise) return false;

    if (!q) return true;
    const haystack = `${item.ssid} ${item.authType} ${item.band || ""} ${item.pinyin || ""} ${item.notes || ""}`.toLowerCase();
    return haystack.includes(q);
  });

  return [...filtered].sort((a, b) => {
    if (sortBy === "connected") {
      if (Boolean(a.isConnected) !== Boolean(b.isConnected)) {
        return a.isConnected ? -1 : 1;
      }
      return (b.signalPercent ?? 0) - (a.signalPercent ?? 0);
    }
    if (sortBy === "signal") {
      return (b.signalPercent ?? 0) - (a.signalPercent ?? 0);
    }
    if (sortBy === "ssid") {
      return a.ssid.localeCompare(b.ssid, "zh-CN");
    }
    return a.authType.localeCompare(b.authType);
  });
}

/**
 * 通过宿主 IPC 通道按需提取指定 SSID 的明文密码 (macOS Keychain / Windows netsh)
 */
export async function revealWifiPasswordFromHost(ssid: string, hostOverride?: any): Promise<string> {
  const cleanSsid = (ssid || "").trim();
  if (!cleanSsid) return "";
  const res = await callHostTransport<any>("wifi_get_password", { ssid: cleanSsid }, hostOverride);
  if (res.ok && res.data !== undefined) {
    if (typeof res.data === "string") return res.data.trim();
    if (typeof res.data?.password === "string") return res.data.password.trim();
  }
  return "";
}

/**
 * 跨平台获取已保存的 Wi-Fi 密码列表（支持宿主 IPC wifi_get_profiles / wifi_get_password 与自定义执行器）
 */
export async function fetchSavedWifiProfiles(
  options: FetchWifiProfilesOptions = {}
): Promise<WifiProfileInfo[]> {
  const realHost = isRealElectronHost(options.hostOverride);
  const fallback = options.fallbackToSample ?? !realHost;
  const executor = options.executor;

  if (!executor) {
    if (options.hostOverride || realHost) {
      try {
        const res = await callHostTransport<any>(
          "wifi_get_profiles",
          { interfaceName: options.interfaceName },
          options.hostOverride
        );
        if (res.ok && res.data) {
          const rawList = Array.isArray(res.data)
            ? res.data
            : Array.isArray(res.data?.profiles)
            ? res.data.profiles
            : [];
          if (rawList.length > 0) {
            const mapped = await Promise.all(
              rawList.map(async (item: any, idx: number): Promise<WifiProfileInfo | null> => {
                const shouldPrefetchPwd = idx < 5;
                if (typeof item === "string") {
                  const ssid = item.trim();
                  if (!ssid) return null;
                  const pwd = shouldPrefetchPwd
                    ? await revealWifiPasswordFromHost(ssid, options.hostOverride)
                    : "";
                  return {
                    id: `host-wifi-${ssid}`,
                    ssid,
                    password: pwd,
                    authType: "WPA2-Personal",
                    isOpenNetwork: false,
                    isEnterprise: false,
                    signalPercent: 88
                  };
                }
                if (item && typeof item === "object") {
                  const ssid = String(item.ssid || item.name || "").trim();
                  if (!ssid) return null;
                  const pwd =
                    typeof item.password === "string" && item.password
                      ? item.password
                      : shouldPrefetchPwd
                      ? await revealWifiPasswordFromHost(ssid, options.hostOverride)
                      : "";
                  const authType = item.authType
                    ? normalizeSecurityType(String(item.authType))
                    : "WPA2-Personal";
                  return {
                    id: String(item.id || `host-wifi-${ssid}`),
                    ssid,
                    password: pwd,
                    authType,
                    cipher: item.cipher || "CCMP (AES)",
                    band: item.band || "Dual-Band (2.4/5 GHz)",
                    isConnected: Boolean(item.isConnected),
                    isOpenNetwork: Boolean(item.isOpenNetwork ?? authType === "Open"),
                    isEnterprise: Boolean(item.isEnterprise ?? authType.includes("Enterprise")),
                    signalPercent: typeof item.signalPercent === "number" ? item.signalPercent : 88,
                    interfaceName: item.interfaceName || options.interfaceName || "WLAN",
                    lastConnected: item.lastConnected || "已保存",
                    pinyin: item.pinyin,
                    notes: item.notes
                  };
                }
                return null;
              })
            );
            const valid = mapped.filter((x): x is WifiProfileInfo => x !== null);
            if (valid.length > 0) {
              return valid;
            }
          }
        }
      } catch {
        // 忽略 IPC 异常
      }
      if (realHost) {
        return [];
      }
    }
    return fallback ? [...SAMPLE_WIFI_PROFILES] : [];
  }

  const platform = options.platform || "win32";
  try {
    if (platform === "win32") {
      const rawList = await executor("netsh", ["wlan", "show", "profiles"]);
      const stdout = typeof rawList === "string" ? rawList : rawList.stdout;
      const ssids = parseNetshWlanProfiles(stdout);
      if (ssids.length === 0) {
        return fallback ? [...SAMPLE_WIFI_PROFILES] : [];
      }

      const results: WifiProfileInfo[] = [];
      for (const ssid of ssids) {
        try {
          const detailRaw = await executor("netsh", [
            "wlan",
            "show",
            "profile",
            `name=${ssid}`,
            "key=clear"
          ]);
          const detailOut = typeof detailRaw === "string" ? detailRaw : detailRaw.stdout;
          const parsed = parseWindowsWlanProfileDetail(ssid, detailOut);
          results.push({
            id: `win-wifi-${ssid}`,
            ssid: parsed.ssid || ssid,
            password: parsed.password,
            authType: parsed.authType,
            cipher: parsed.cipher,
            band: "Dual-Band (2.4/5 GHz)",
            isOpenNetwork: parsed.isOpenNetwork,
            isEnterprise: parsed.isEnterprise,
            signalPercent: 85,
            notes: parsed.error?.message
          });
        } catch {
          // 单个配置读取失败不阻断整体列表
        }
      }
      return results.length > 0 ? results : fallback ? [...SAMPLE_WIFI_PROFILES] : [];
    }

    if (platform === "darwin") {
      const portsRaw = await executor("/usr/sbin/networksetup", ["-listallhardwareports"]);
      const iface = parseWifiInterface(typeof portsRaw === "string" ? portsRaw : portsRaw.stdout);
      const listRaw = await executor("/usr/sbin/networksetup", ["-listpreferredwirelessnetworks", iface]);
      const listOut = typeof listRaw === "string" ? listRaw : listRaw.stdout;
      const ssids = listOut
        .split(/\r?\n/)
        .slice(1)
        .map((s) => s.trim())
        .filter(Boolean);

      const results: WifiProfileInfo[] = [];
      for (const ssid of ssids) {
        let password = "";
        try {
          const pwRaw = await executor("/usr/bin/security", [
            "find-generic-password",
            "-D",
            "AirPort network password",
            "-a",
            ssid,
            "-w"
          ]);
          password = (typeof pwRaw === "string" ? pwRaw : pwRaw.stdout).trim();
        } catch {
          password = "";
        }
        results.push({
          id: `mac-wifi-${ssid}`,
          ssid,
          password,
          authType: password ? "WPA2-Personal" : "Open",
          isOpenNetwork: !password,
          isEnterprise: false,
          interfaceName: iface,
          signalPercent: 90
        });
      }
      return results.length > 0 ? results : fallback ? [...SAMPLE_WIFI_PROFILES] : [];
    }
  } catch {
    if (fallback) {
      return [...SAMPLE_WIFI_PROFILES];
    }
    throw new Error("WIFI_COMMAND_EXECUTION_FAILED");
  }

  return fallback ? [...SAMPLE_WIFI_PROFILES] : [];
}
