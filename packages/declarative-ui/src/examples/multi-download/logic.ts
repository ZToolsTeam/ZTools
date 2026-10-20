/**
 * ZTools 2.0 标杆原生插件: 多线程分块高速下载工作台 (Multi-Download 2.0 - 1:1 复刻原版 Aria2 多线程分块引擎 + 100% 真实宿主驱动)
 *
 * 严格遵循 ZTools Declarative UI 2.0 零模拟数据铁律与 1:1 原版能力复刻规范：
 * 1. 完整复刻 C++ 原版 `MultiDownloadPlugin` (`Aria2Manager.h`) 核心能力：
 *    - 16 / 8 / 4 线程分块并发下载配置 (`-x16 -s16 -k1M`)
 *    - 真实探测 Aria2 JSON-RPC 守护进程 (`http://127.0.0.1:6800/jsonrpc`) 与本机下载环境
 *    - 真实读取本机剪贴板自动嗅探 HTTP/HTTPS/FTP/Magnet/Torrent 下载链接
 *    - 真实扫描本机 `Downloads` 目录下的全部已下载文件（安装包、压缩归档、视频媒体、镜像与文档）
 *    - 真实探测下载盘符剩余可用空间，防止磁盘写满
 *    - 支持三态勾选批量移入回收站、打开文件、在 Explorer 中定位文件与发起真实下载任务
 */

import {
  callHostTransport,
  getRealFileSize,
  invokeHostCapability,
  invokePluginService,
  isRealElectronHost,
  openRealPath,
  resolveRealSpecialPaths,
  scanRealDirectoryTree,
  showRealItemInFolder,
  showRealToast,
  trashRealItem,
  writeRealClipboardText,
  formatBytes,
  type NativeInvocationResult
} from "../shared/native-ipc.js";

export { formatBytes };
export type { NativeInvocationResult };

export const DLL_PLUGIN_NAME = "MultiDownloadPlugin";

export const FORBIDDEN_TARGET_PATTERN =
  /(^|[\\/])(Windows|System32|SysWOW64|Program Files|Program Files \(x86\)|Boot|Recovery)($|[\\/])/i;
export const FORBIDDEN_REASON = "禁止操作 Windows 系统核心目录中的受保护文件";

export type DownloadFileCategory =
  | "all"
  | "installer"
  | "archive"
  | "media"
  | "iso_image"
  | "document"
  | "other";

export interface DownloadCategoryMeta {
  id: DownloadFileCategory;
  name: string;
  icon: string;
  color: string;
  exts: string[];
}

export const DOWNLOAD_CATEGORIES: DownloadCategoryMeta[] = [
  {
    id: "installer",
    name: "应用安装包",
    icon: "Icon.Box",
    color: "#3b82f6",
    exts: [".exe", ".msi", ".msix", ".appx", ".dmg", ".deb", ".rpm"]
  },
  {
    id: "archive",
    name: "压缩归档包",
    icon: "Icon.Archive",
    color: "#f59e0b",
    exts: [".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".tgz"]
  },
  {
    id: "media",
    name: "音视频与图像",
    icon: "Icon.Video",
    color: "#ec4899",
    exts: [".mp4", ".mkv", ".mov", ".webm", ".avi", ".mp3", ".flac", ".wav", ".png", ".jpg", ".webp"]
  },
  {
    id: "iso_image",
    name: "系统镜像与模型",
    icon: "Icon.Disc",
    color: "#8b5cf6",
    exts: [".iso", ".img", ".vhd", ".vhdx", ".gguf", ".safetensors", ".onnx", ".bin"]
  },
  {
    id: "document",
    name: "办公文档与脚本",
    icon: "Icon.Document",
    color: "#10b981",
    exts: [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md", ".csv", ".json", ".sql"]
  },
  {
    id: "other",
    name: "其他下载文件",
    icon: "Icon.Folder",
    color: "#64748b",
    exts: []
  }
];

export type ThreadSplitPresetId = "threads_16" | "threads_8" | "threads_4" | "threads_1";

export interface ThreadSplitPreset {
  id: ThreadSplitPresetId;
  name: string;
  threads: number;
  splitSize: string;
  aria2Flags: string;
  description: string;
}

export const THREAD_SPLIT_PRESETS: ThreadSplitPreset[] = [
  {
    id: "threads_16",
    name: "16 线程极速分块",
    threads: 16,
    splitSize: "1M",
    aria2Flags: "--max-connection-per-server=16 --split=16 --min-split-size=1M --continue=true",
    description: "复刻原版 Aria2Manager 16 路并发连接与 1MB 最小分块，跑满千兆宽带与大文件直链"
  },
  {
    id: "threads_8",
    name: "8 线程均衡加速",
    threads: 8,
    splitSize: "2M",
    aria2Flags: "--max-connection-per-server=8 --split=8 --min-split-size=2M --continue=true",
    description: "兼顾高速传输与远端服务器并发连接限制（防 CDN 429 限流拦截）"
  },
  {
    id: "threads_4",
    name: "4 线程稳健省流",
    threads: 4,
    splitSize: "4M",
    aria2Flags: "--max-connection-per-server=4 --split=4 --min-split-size=4M --continue=true",
    description: "适合严格限制单 IP 连接数的镜像站与网盘直链，支持断点续传"
  },
  {
    id: "threads_1",
    name: "单线程顺序流",
    threads: 1,
    splitSize: "10M",
    aria2Flags: "--max-connection-per-server=1 --split=1 --continue=true",
    description: "针对不支持 Range 分块请求（HTTP 200 非 206）的动态签名流式下载"
  }
];

export interface DownloadedFileItem {
  id: string;
  name: string;
  path: string;
  ext: string;
  sizeBytes: number;
  mtimeMs: number;
  category: DownloadFileCategory;
  categoryName: string;
  categoryColor: string;
  categoryIcon: string;
}

export interface MultiDownloadSnapshot {
  downloadDir: string;
  driveLetter: string;
  driveFreeBytes: number;
  driveTotalBytes: number;
  aria2RpcOnline: boolean;
  aria2Endpoint: string;
  sniffedClipboardUrl: string;
  sniffedProtocol: string;
  files: DownloadedFileItem[];
  totalSizeBytes: number;
  categoryStats: Array<{
    category: DownloadFileCategory;
    name: string;
    color: string;
    sizeBytes: number;
    count: number;
  }>;
  updatedAt: string;
}

export function classifyDownloadedExtension(extRaw: string): DownloadCategoryMeta {
  const ext = String(extRaw || "").toLowerCase();
  for (const cat of DOWNLOAD_CATEGORIES) {
    if (cat.id !== "other" && cat.exts.includes(ext)) {
      return cat;
    }
  }
  return DOWNLOAD_CATEGORIES[DOWNLOAD_CATEGORIES.length - 1];
}

export function detectDownloadUrlFromText(rawText: string): {
  url: string;
  protocol: string;
  suggestedFileName: string;
} {
  const text = String(rawText || "").trim();
  if (!text) return { url: "", protocol: "无链接", suggestedFileName: "" };

  const magnetMatch = text.match(/magnet:\?xt=urn:[a-z0-9]+:[a-zA-Z0-9]{32,}/i);
  if (magnetMatch) {
    return {
      url: magnetMatch[0],
      protocol: "Magnet 磁力链",
      suggestedFileName: "magnet_task.torrent"
    };
  }

  const httpMatch = text.match(/(https?|ftp):\/\/[^\s"'<>]+/i);
  if (httpMatch) {
    const url = httpMatch[0];
    const cleanPath = url.split("?")[0].split("#")[0];
    const lastSeg = cleanPath.substring(cleanPath.lastIndexOf("/") + 1) || "downloaded_file.bin";
    const protocol = url.toLowerCase().startsWith("ftp") ? "FTP 协议" : "HTTPS 多线程直链";
    return {
      url,
      protocol,
      suggestedFileName: decodeURIComponent(lastSeg).slice(0, 80)
    };
  }

  return { url: "", protocol: "剪贴板未检测到下载链接", suggestedFileName: "" };
}

export async function probeAria2JsonRpc(endpoint = "http://127.0.0.1:6800/jsonrpc"): Promise<boolean> {
  try {
    if (typeof fetch !== "function") return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 450);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "ztools-ping",
        method: "aria2.getVersion",
        params: []
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function readClipboardDownloadUrl(hostBridge?: any): Promise<{
  url: string;
  protocol: string;
  suggestedFileName: string;
}> {
  try {
    const ipcClip = await callHostTransport<any>("clipboard_read_text", {}, hostBridge);
    if (ipcClip.ok && ipcClip.data) {
      const txt = typeof ipcClip.data === "string" ? ipcClip.data : String(ipcClip.data.text || "");
      return detectDownloadUrlFromText(txt);
    }
  } catch {
    // ignore
  }
  return { url: "", protocol: "支持 HTTP/FTP/Magnet", suggestedFileName: "" };
}

export async function fetchMultiDownloadSnapshot(hostBridge?: any): Promise<MultiDownloadSnapshot> {
  const paths = await resolveRealSpecialPaths(hostBridge);
  const downloadDir = paths.downloads || `${paths.userProfile}\\Downloads`;
  const driveLetter = (downloadDir.match(/^[A-Za-z]:/) || ["C:"])[0].toUpperCase();

  const [diskRes, sysRes, rawEntries, aria2RpcOnline, clipInfo] = await Promise.all([
    callHostTransport<{ total?: number; used?: number; available?: number; free?: number }>(
      "system_get_disk_usage",
      { drive: `${driveLetter}\\` },
      hostBridge
    ),
    invokeHostCapability<Record<string, unknown>>("system.info", { includeStorage: true }, hostBridge),
    scanRealDirectoryTree(downloadDir, { maxDepth: 2, maxFiles: 220, hostOverride: hostBridge }),
    probeAria2JsonRpc(),
    readClipboardDownloadUrl(hostBridge)
  ]);

  let driveFreeBytes = 0;
  let driveTotalBytes = 0;
  if (diskRes.ok && diskRes.data) {
    driveTotalBytes = Number(diskRes.data.total || 0);
    const used = Number(diskRes.data.used || 0);
    driveFreeBytes = Number(
      diskRes.data.available ?? diskRes.data.free ?? Math.max(0, driveTotalBytes - used)
    );
  } else if (sysRes.ok && sysRes.data) {
    const storageArr = Array.isArray((sysRes.data as { storage?: unknown }).storage)
      ? ((sysRes.data as { storage: Array<Record<string, unknown>> }).storage)
      : [];
    const matchedDrive =
      storageArr.find((d) => String(d.mount || d.fs || "").toUpperCase().startsWith(driveLetter)) ||
      storageArr[0];
    if (matchedDrive) {
      driveTotalBytes = Number(matchedDrive.size || matchedDrive.total || 0);
      const used = Number(matchedDrive.used || 0);
      driveFreeBytes = Number(matchedDrive.available || matchedDrive.free || Math.max(0, driveTotalBytes - used));
    }
  }

  const files: DownloadedFileItem[] = [];
  let totalSizeBytes = 0;
  const catMap = new Map<DownloadFileCategory, { sizeBytes: number; count: number }>();
  for (const cat of DOWNLOAD_CATEGORIES) {
    catMap.set(cat.id, { sizeBytes: 0, count: 0 });
  }

  const fileList = Array.isArray(rawEntries) ? rawEntries : (rawEntries?.files || []);
  for (const entry of fileList) {
    const isDir = Boolean(entry.isDirectory || entry.isDir);
    const sz = Number(entry.sizeBytes ?? entry.size ?? 0);
    if (isDir || sz <= 0) continue;
    const ext = String(entry.ext || "").toLowerCase() || ".bin";
    const catMeta = classifyDownloadedExtension(ext);
    totalSizeBytes += sz;
    const stat = catMap.get(catMeta.id)!;
    stat.sizeBytes += sz;
    stat.count += 1;

    files.push({
      id: entry.path,
      name: entry.name,
      path: entry.path,
      ext,
      sizeBytes: sz,
      mtimeMs: Number(entry.mtimeMs ?? entry.mtime ?? Date.now()),
      category: catMeta.id,
      categoryName: catMeta.name,
      categoryColor: catMeta.color,
      categoryIcon: catMeta.icon
    });
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.sizeBytes - a.sizeBytes);

  const categoryStats = DOWNLOAD_CATEGORIES.map((c) => {
    const st = catMap.get(c.id) || { sizeBytes: 0, count: 0 };
    return {
      category: c.id,
      name: c.name,
      color: c.color,
      sizeBytes: st.sizeBytes,
      count: st.count
    };
  }).filter((s) => s.sizeBytes > 0);

  return {
    downloadDir,
    driveLetter,
    driveFreeBytes,
    driveTotalBytes,
    aria2RpcOnline,
    aria2Endpoint: "http://127.0.0.1:6800/jsonrpc",
    sniffedClipboardUrl: clipInfo.url,
    sniffedProtocol: clipInfo.protocol,
    files,
    totalSizeBytes,
    categoryStats,
    updatedAt: new Date().toLocaleTimeString()
  };
}

export async function startMultiThreadDownloadTask(
  url: string,
  downloadDir: string,
  preset: ThreadSplitPreset,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const trimmed = String(url || "").trim();
  if (!trimmed || !/^(https?|ftp|magnet):/i.test(trimmed)) {
    return {
      ok: false,
      code: -1,
      message: "未提供有效的 HTTP/HTTPS/FTP/Magnet 下载链接，请先复制下载链接到剪贴板"
    };
  }

  // 1. 优先尝试调用原生插件
  const rpcRes = await invokePluginService(
    DLL_PLUGIN_NAME,
    "AddDownloadTask",
    {
      url: trimmed,
      dir: downloadDir,
      threads: preset.threads,
      split: preset.threads,
      minSplitSize: preset.splitSize
    },
    hostBridge
  );
  if (rpcRes.ok) {
    await showRealToast(`已启动 ${preset.threads} 线程高速分块下载任务`, "success");
    return rpcRes;
  }

  // 2. 尝试直连本机 Aria2 JSON-RPC
  try {
    if (typeof fetch === "function") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const resp = await fetch("http://127.0.0.1:6800/jsonrpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `ztools-${Date.now()}`,
          method: "aria2.addUri",
          params: [
            [trimmed],
            {
              dir: downloadDir,
              "max-connection-per-server": String(preset.threads),
              split: String(preset.threads),
              "min-split-size": preset.splitSize,
              continue: "true"
            }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (resp.ok) {
        await showRealToast(`已派发至本机 Aria2 引擎 (${preset.threads} 线程并发)`, "success");
        return { ok: true, code: 0, message: "Aria2 JSON-RPC 任务创建成功" };
      }
    }
  } catch {
    // fallback to host network_http_download
  }

  // 3. 调用宿主真实 HTTP 下载通道 network_http_download
  const parsedUrl = detectDownloadUrlFromText(trimmed);
  const fileName = parsedUrl.suggestedFileName || `download_${Date.now()}.bin`;
  const sep = downloadDir.includes("/") ? "/" : "\\";
  const targetPath = `${downloadDir.replace(/[\\/]+$/, "")}${sep}${fileName}`;

  if (/^https?:/i.test(trimmed)) {
    const httpRes = await callHostTransport(
      "network_http_download",
      { url: trimmed, destPath: targetPath },
      hostBridge
    );
    if (httpRes.ok) {
      await showRealToast(`已完成下载并保存至: ${targetPath}`, "success");
      return {
        ok: true,
        code: 0,
        message: `已通过宿主网络引擎真实下载至: ${targetPath}`,
        data: { destPath: targetPath, ...(typeof httpRes.data === "object" ? httpRes.data : {}) }
      };
    }
    if (isRealElectronHost(hostBridge) || hostBridge) {
      return {
        ok: false,
        code: -1,
        message: httpRes.error || "宿主网络下载失败",
        error: httpRes.error || "宿主网络下载失败"
      };
    }
  } else if (isRealElectronHost(hostBridge) || hostBridge) {
    const openRes = await callHostTransport("shell_open_external", { url: trimmed }, hostBridge);
    if (!openRes.ok) {
      return {
        ok: false,
        code: -1,
        message: openRes.error || "未检测到 Aria2 守护进程且无法打开协议链接",
        error: openRes.error || "DOWNLOAD_FAILED"
      };
    }
  }

  // 4. 回退：将 Aria2 多线程命令写入剪贴板
  const cliCommand = `aria2c ${preset.aria2Flags} -d "${downloadDir}" "${trimmed}"`;
  await writeRealClipboardText(cliCommand, hostBridge);
  if (isRealElectronHost(hostBridge) || isRealElectronHost()) {
    return {
      ok: false,
      code: -1,
      message: "本机未检测到 yt-dlp/aria2c 下载引擎，已将命令复制到剪贴板",
      error: "ENGINE_NOT_FOUND"
    };
  }
  await invokeHostCapability("system.openUrl", { url: trimmed }, hostBridge);
  return {
    ok: true,
    code: 0,
    message: `已触发下载并生成命令: ${cliCommand}`
  };
}

export async function deleteDownloadedFiles(
  paths: string[],
  knownFiles: DownloadedFileItem[] = [],
  hostBridge?: any
): Promise<{
  deletedCount: number;
  freedBytes: number;
}> {
  let deletedCount = 0;
  let freedBytes = 0;
  const sizeMap = new Map<string, number>();
  for (const item of knownFiles) {
    if (item && item.path) {
      sizeMap.set(item.path, Number(item.sizeBytes || 0));
    }
  }

  for (const targetPath of paths) {
    if (!targetPath || FORBIDDEN_TARGET_PATTERN.test(targetPath)) continue;
    const knownSize = sizeMap.get(targetPath) ?? (await getRealFileSize(targetPath, hostBridge));
    const res = await trashRealItem(targetPath, hostBridge);
    if (res.ok) {
      deletedCount += 1;
      freedBytes += knownSize;
    }
  }
  if (deletedCount > 0) {
    await showRealToast(`已将 ${deletedCount} 个下载文件安全移入回收站`, "success");
  }
  return { deletedCount, freedBytes };
}

export async function openDownloadedFileLocation(
  targetPath: string,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const ok = await showRealItemInFolder(targetPath, hostBridge);
  return {
    ok,
    code: ok ? 0 : -1,
    message: ok ? "已在资源管理器中定位文件" : "定位文件失败"
  };
}

export async function openDownloadedFile(
  targetPath: string,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const ok = await openRealPath(targetPath, hostBridge);
  return {
    ok,
    code: ok ? 0 : -1,
    message: ok ? "已打开文件" : "打开文件失败"
  };
}
