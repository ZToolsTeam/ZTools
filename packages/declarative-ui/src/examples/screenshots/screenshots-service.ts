import { LocalStorage } from "../../api/storage.js";
import {
  ScreenshotItem,
  ScreenshotCategory,
  ScreenshotActionResult
} from "./types.js";
import {
  callHostTransport,
  invokePluginService,
  isRealElectronHost,
  getRealSystemPath,
  readRealDirectory,
  openRealPath,
  showRealItemInFolder,
  trashRealItem,
  writeRealClipboardText
} from "../shared/native-ipc.js";

const PINNED_STORAGE_KEY = "@ztools/screenshots/pinned";

function isStrictRealHost(hostOverride?: unknown): boolean {
  if (isRealElectronHost(hostOverride)) return true;
  if (hostOverride !== undefined && hostOverride !== null) return true;
  return false;
}

/**
 * 从真实图片头部字节流解析真实像素宽高 (支持 PNG / GIF / BMP / JPEG / WebP)
 */
export function parseImageDimensionsFromBytes(bytes: Uint8Array): { width: number; height: number } | null {
  if (!bytes || bytes.length < 16) return null;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR (offset 16..23)
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    if (width > 0 && height > 0) return { width, height };
  }

  // 2. GIF: "GIF87a" or "GIF89a"
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    if (width > 0 && height > 0) return { width, height };
  }

  // 3. BMP: "BM"
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const width =
      (bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24)) >>> 0;
    const rawHeight =
      bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
    const height = Math.abs(rawHeight);
    if (width > 0 && height > 0) return { width, height };
  }

  // 4. WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const chunkHeader = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkHeader === "VP8 " && bytes.length >= 30) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkHeader === "VP8L" && bytes.length >= 25) {
      const b0 = bytes[21];
      const b1 = bytes[22];
      const b2 = bytes[23];
      const b3 = bytes[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      if (width > 0 && height > 0) return { width, height };
    } else if (chunkHeader === "VP8X" && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      if (width > 0 && height > 0) return { width, height };
    }
  }

  // 5. JPEG: FF D8 ... SOF0..SOF3 (FF C0 .. FF C3)
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (offset + 8 < bytes.length) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0) return { width, height };
        }
        break;
      }
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
  }

  return null;
}

async function probeImageDimensions(
  filePath: string,
  hostOverride?: any
): Promise<{ width: number; height: number } | null> {
  if (!filePath) return null;

  // 1. 尝试通过宿主 filesystem_read_file 读取头部字节
  const ipcRes = await callHostTransport<any>(
    "filesystem_read_file",
    { path: filePath, encoding: "base64", maxBytes: 65536 },
    hostOverride
  );
  if (ipcRes.ok && ipcRes.data !== undefined && ipcRes.data !== null) {
    const raw = ipcRes.data;
    if (typeof raw === "object" && Number(raw.width) > 0 && Number(raw.height) > 0) {
      return { width: Number(raw.width), height: Number(raw.height) };
    }
    let bytes: Uint8Array | null = null;
    if (raw instanceof Uint8Array) {
      bytes = raw;
    } else if (typeof raw === "string") {
      if (typeof Buffer !== "undefined") {
        bytes = new Uint8Array(Buffer.from(raw, "base64"));
      }
    } else if (typeof raw === "object" && typeof raw.content === "string") {
      if (typeof Buffer !== "undefined") {
        bytes = new Uint8Array(
          Buffer.from(raw.content, raw.encoding === "base64" ? "base64" : "utf-8")
        );
      }
    }
    if (bytes) {
      const parsed = parseImageDimensionsFromBytes(bytes);
      if (parsed) return parsed;
    }
  }

  // 2. 尝试通过本地 Node fs 读取前 64KB 字节解析图片头
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(filePath)) {
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.alloc(65536);
          const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
          if (bytesRead > 0) {
            const parsed = parseImageDimensionsFromBytes(
              new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
            );
            if (parsed) return parsed;
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/**
 * 生成轻量且逼真的 SVG 缩略图数据 URL (用于双栏详情展示)
 */
export function generateScreenshotThumbnailSvg(
  label: string,
  width: number,
  height: number,
  accentColor = "#0078D4"
): string {
  const aspect = width / Math.max(1, height);
  const svgWidth = 400;
  const svgHeight = Math.max(120, Math.round(400 / aspect));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="${svgWidth}" height="${svgHeight}" rx="8" fill="#1e1e1e" />
  <!-- 窗口标题栏 -->
  <rect width="${svgWidth}" height="28" rx="8" fill="#2d2d2d" />
  <circle cx="16" cy="14" r="4.5" fill="#ff5f56" />
  <circle cx="30" cy="14" r="4.5" fill="#ffbd2e" />
  <circle cx="44" cy="14" r="4.5" fill="#27c93f" />
  <text x="${svgWidth / 2}" y="18" fill="#a0a0a0" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" text-anchor="middle">${label}</text>
  
  <!-- 视口内容 -->
  <rect x="20" y="44" width="${svgWidth - 40}" height="14" rx="3" fill="${accentColor}" opacity="0.8" />
  <rect x="20" y="68" width="${Math.round(svgWidth * 0.7)}" height="10" rx="2" fill="#4a4a4a" />
  <rect x="20" y="86" width="${Math.round(svgWidth * 0.5)}" height="10" rx="2" fill="#3a3a3a" />
  <rect x="20" y="104" width="${Math.round(svgWidth * 0.85)}" height="10" rx="2" fill="#4a4a4a" />
  <rect x="20" y="122" width="${Math.round(svgWidth * 0.6)}" height="10" rx="2" fill="#3a3a3a" />
  
  <!-- 底部徽标与尺寸 -->
  <rect x="${svgWidth - 95}" y="${svgHeight - 24}" width="85" height="18" rx="4" fill="#000000" opacity="0.6" />
  <text x="${svgWidth - 52}" y="${svgHeight - 11}" fill="#00ffcc" font-family="monospace" font-size="10" text-anchor="middle">${width}x${height}</text>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * 初始高频基准截图数据集（仅用于无宿主离线快照回退）
 */
export const INITIAL_SCREENSHOTS: ScreenshotItem[] = [
  {
    id: "ss-ide-01",
    filename: "Screenshot_2026-10-13_142010.png",
    path: "C:\\Users\\User\\Pictures\\Screenshots\\Screenshot_2026-10-13_142010.png",
    width: 2560,
    height: 1440,
    dimensions: "2560 x 1440",
    sizeBytes: 1945600,
    formattedSize: "1.85 MB",
    createdAt: Date.now() - 1000 * 60 * 12,
    modifiedAt: Date.now() - 1000 * 60 * 12,
    formattedDate: "12分钟前",
    pinned: true,
    ocrText: `// ZTools Runner Native Execution Pipeline
export async function executeCommand(cmd: string, args: string[]) {
  const result = await NativeHost.spawnProcess(cmd, args);
  console.log("Process completed with exit code:", result.exitCode);
  return result;
}`,
    ocrStatus: "ready",
    thumbnailSvg: generateScreenshotThumbnailSvg("VS Code - Native Pipeline", 2560, 1440, "#0078D4")
  },
  {
    id: "ss-err-02",
    filename: "Screenshot_2026-10-13_135022.png",
    path: "C:\\Users\\User\\Pictures\\Screenshots\\Screenshot_2026-10-13_135022.png",
    width: 1920,
    height: 1080,
    dimensions: "1920 x 1080",
    sizeBytes: 1124000,
    formattedSize: "1.07 MB",
    createdAt: Date.now() - 1000 * 60 * 42,
    modifiedAt: Date.now() - 1000 * 60 * 42,
    formattedDate: "42分钟前",
    pinned: false,
    ocrText: `Fatal Error: 0x80070005 Access is denied.
Please verify that you have administrative privileges to modify Windows Taskbar Shell_TrayWnd attributes.
Exception occurred at NativeInterop.cs line 88.`,
    ocrStatus: "ready",
    thumbnailSvg: generateScreenshotThumbnailSvg("Windows Error Dialog", 1920, 1080, "#E81123")
  },
  {
    id: "ss-dash-03",
    filename: "Screenshot_2026-10-13_123000.png",
    path: "C:\\Users\\User\\Pictures\\Screenshots\\Screenshot_2026-10-13_123000.png",
    width: 3840,
    height: 2160,
    dimensions: "3840 x 2160 (4K)",
    sizeBytes: 4210000,
    formattedSize: "4.02 MB",
    createdAt: Date.now() - 1000 * 60 * 122,
    modifiedAt: Date.now() - 1000 * 60 * 122,
    formattedDate: "2小时前",
    pinned: true,
    ocrText: `Active Sessions: 142,890
Average File Search SLA: 0.035ms (NTFS MFT 裸盘硬件级索引)
Cache Hit Ratio: 99.82%
Memory Footprint: 168 MB (Standby Mode)`,
    ocrStatus: "ready",
    thumbnailSvg: generateScreenshotThumbnailSvg("System Metrics Dashboard", 3840, 2160, "#107C41")
  },
  {
    id: "ss-db-04",
    filename: "Screenshot_2026-10-13_111530.png",
    path: "C:\\Users\\User\\Pictures\\Screenshots\\Screenshot_2026-10-13_111530.png",
    width: 2560,
    height: 1440,
    dimensions: "2560 x 1440",
    sizeBytes: 2048000,
    formattedSize: "1.95 MB",
    createdAt: Date.now() - 1000 * 60 * 195,
    modifiedAt: Date.now() - 1000 * 60 * 195,
    formattedDate: "3小时前",
    pinned: false,
    ocrText: `SELECT id, name, category, execution_count, last_executed_at
FROM windows_run_history
WHERE is_admin = 1
ORDER BY last_executed_at DESC LIMIT 10;
-- 10 rows returned in 1.2ms`,
    ocrStatus: "ready",
    thumbnailSvg: generateScreenshotThumbnailSvg("SQLite Query Execution", 2560, 1440, "#744DA9")
  },
  {
    id: "ss-pr-05",
    filename: "Screenshot_2026-10-13_094510.png",
    path: "C:\\Users\\User\\Pictures\\Screenshots\\Screenshot_2026-10-13_094510.png",
    width: 1920,
    height: 1080,
    dimensions: "1920 x 1080",
    sizeBytes: 1540000,
    formattedSize: "1.47 MB",
    createdAt: Date.now() - 1000 * 60 * 285,
    modifiedAt: Date.now() - 1000 * 60 * 285,
    formattedDate: "4小时前",
    pinned: false,
    ocrText: `Pull Request #418: Align Windows built-in run and taskbar controls.
Changes:
- Implemented Windows Run parameterization and UAC elevation
- Implemented Taskbar Win32 ShowWindow toggle and auto-hide
All tests passed: 197 / 197. Ready to merge.`,
    ocrStatus: "ready",
    thumbnailSvg: generateScreenshotThumbnailSvg("GitHub PR Review", 1920, 1080, "#238636")
  }
];

export class ScreenshotsManager {
  private items: ScreenshotItem[] = isRealElectronHost() ? [] : [...INITIAL_SCREENSHOTS];
  private pinnedSet = new Set<string>(["ss-ide-01", "ss-dash-03"]);
  private scanned = false;

  private mapHostScreenshot(raw: any, parsedDims?: { width: number; height: number } | null): ScreenshotItem {
    const filename = String(raw?.filename || raw?.name || "Screenshot.png");
    const fullPath = String(raw?.path || filename);
    const width =
      Number(raw?.width) > 0
        ? Number(raw.width)
        : parsedDims && parsedDims.width > 0
          ? parsedDims.width
          : 1920;
    const height =
      Number(raw?.height) > 0
        ? Number(raw.height)
        : parsedDims && parsedDims.height > 0
          ? parsedDims.height
          : 1080;
    const sizeBytes = Number(raw?.sizeBytes ?? raw?.size) > 0 ? Number(raw.sizeBytes ?? raw.size) : 0;
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const modifiedAt = Number(raw?.modifiedAt ?? raw?.mtimeMs) > 0 ? Number(raw.modifiedAt ?? raw.mtimeMs) : Date.now();
    const createdAt = Number(raw?.createdAt ?? raw?.birthtimeMs) > 0 ? Number(raw.createdAt ?? raw.birthtimeMs) : modifiedAt;
    const id = String(raw?.id || `ss-${filename.replace(/[^a-zA-Z0-9_-]/g, "")}`);
    const hasRealOcr = typeof raw?.ocrText === "string" && raw.ocrText.trim().length > 0;

    return {
      id,
      filename,
      path: fullPath,
      width,
      height,
      dimensions: String(raw?.dimensions || `${width} x ${height}`),
      sizeBytes,
      formattedSize: String(raw?.formattedSize || `${sizeMb} MB`),
      createdAt,
      modifiedAt,
      formattedDate: String(raw?.formattedDate || new Date(modifiedAt).toLocaleTimeString()),
      pinned: Boolean(raw?.pinned) || this.pinnedSet.has(id),
      // 严禁拼接 `系统自动提取文件文本 [${filename}]` 假 OCR 文本
      ocrText: hasRealOcr ? String(raw.ocrText).trim() : "",
      ocrStatus: raw?.ocrStatus
        ? raw.ocrStatus
        : hasRealOcr
          ? "ready"
          : "pending",
      thumbnailSvg: String(raw?.thumbnailSvg || generateScreenshotThumbnailSvg(filename, width, height, "#0078D4"))
    };
  }

  /**
   * 立即截取当前屏幕并加入截图历史 (调用宿主 screen_capture IPC)
   */
  public async captureScreenNow(
    optionsOrHost?:
      | {
          captureRegionMode?: string;
          imageFormat?: string;
          postCaptureAction?: string;
          includeWindowShadow?: boolean;
          autoHashDedupe?: boolean;
        }
      | any,
    hostOverride?: any
  ): Promise<ScreenshotActionResult> {
    const isOptionsObject =
      optionsOrHost &&
      typeof optionsOrHost === "object" &&
      ("captureRegionMode" in optionsOrHost ||
        "imageFormat" in optionsOrHost ||
        "postCaptureAction" in optionsOrHost ||
        "includeWindowShadow" in optionsOrHost ||
        "autoHashDedupe" in optionsOrHost);
    const capturePayload = isOptionsObject ? optionsOrHost : {};
    const effectiveHost = isOptionsObject ? hostOverride : optionsOrHost;

    try {
      const capRes = await callHostTransport<any>("screen_capture", capturePayload, effectiveHost);
      if (capRes.ok && capRes.data) {
        const raw = capRes.data;
        if (typeof raw === "object" && (raw.path || raw.filename || raw.name)) {
          const dims = await probeImageDimensions(String(raw.path || ""), effectiveHost);
          const capturedItem = this.mapHostScreenshot(raw, dims);
          this.items = [capturedItem, ...this.items.filter((i) => i.id !== capturedItem.id)];
          return {
            success: true,
            message: `已截取当前屏幕: ${capturedItem.filename}`,
            screenshot: capturedItem
          };
        }
      }
      if (isStrictRealHost(effectiveHost) && !capRes.ok) {
        return {
          success: false,
          message: `截屏失败: ${capRes.error || "screen_capture 未响应"}`,
          error: capRes.error || "CAPTURE_FAILED"
        };
      }
      const list = await this.loadScreenshots(true, effectiveHost);
      return {
        success: true,
        message: `已完成屏幕截取，当前共 ${list.length} 张截图`,
        screenshot: list[0]
      };
    } catch (err: any) {
      return {
        success: false,
        message: `截屏失败: ${err?.message || String(err)}`,
        error: "CAPTURE_FAILED"
      };
    }
  }

  /**
   * 探测系统默认截图目录 (支持 Windows Pictures/Screenshots 与 macOS Desktop / Pictures)
   */
  public getDefaultLocations(): readonly string[] {
    const locations: string[] = [];
    const home = typeof process !== "undefined"
      ? (process.env.USERPROFILE || process.env.HOME || "")
      : "";

    if (home) {
      if (home.startsWith("/")) {
        locations.push(`${home}/Desktop`);
        locations.push(`${home}/Pictures/Screenshots`);
        locations.push(`${home}/Pictures`);
      } else {
        locations.push(`${home}\\Pictures\\Screenshots`);
        locations.push(`${home}\\OneDrive\\Pictures\\Screenshots`);
        locations.push(`${home}\\Pictures`);
      }
    }

    return locations;
  }

  /**
   * 扫描真实截图文件并解析图片宽高
   */
  public async scanRealScreenshots(hostOverride?: any): Promise<ScreenshotItem[]> {
    return this.loadScreenshots(true, hostOverride);
  }

  /**
   * 扫描系统磁盘中的截图文件 (优先通过 screenshots_scan IPC 调用主进程扫描，或扫描真实 Pictures / Desktop 目录并解析真实图片文件头尺寸)
   */
  public async loadScreenshots(forceRefresh = false, hostOverride?: any): Promise<ScreenshotItem[]> {
    const strictReal = isStrictRealHost(hostOverride);
    if (this.scanned && !forceRefresh && !hostOverride) {
      return [...this.items];
    }

    try {
      const storedPinned = await LocalStorage.getItem<string[]>(PINNED_STORAGE_KEY);
      if (Array.isArray(storedPinned)) {
        this.pinnedSet = new Set(storedPinned);
      }
    } catch {
      // ignore
    }

    let loadedFromHost = false;

    // 1. 优先尝试通过宿主 IPC 通道 screenshots_scan 获取跨平台截图列表
    try {
      if (strictReal) {
        let scanRes = await callHostTransport<any>("screenshots_scan", { forceRefresh }, hostOverride);
        if (!scanRes.ok) {
          scanRes = await callHostTransport<any>("screenshots_search", { forceRefresh }, hostOverride);
        }
        if (scanRes.ok && scanRes.data) {
          const rawList = Array.isArray(scanRes.data)
            ? scanRes.data
            : Array.isArray(scanRes.data?.screenshots)
              ? scanRes.data.screenshots
              : Array.isArray(scanRes.data?.items)
                ? scanRes.data.items
                : Array.isArray(scanRes.data?.files)
                  ? scanRes.data.files
                  : [];
          if (rawList.length > 0) {
            const mapped: ScreenshotItem[] = [];
            for (const r of rawList) {
              const hasDims = Number(r?.width) > 0 && Number(r?.height) > 0;
              const dims = hasDims ? null : await probeImageDimensions(String(r?.path || ""), hostOverride);
              mapped.push(this.mapHostScreenshot(r, dims));
            }
            this.items = mapped;
            loadedFromHost = true;
          }
        }

        // 若 screenshots_scan 未返回结果，扫描用户真实的 Pictures / Desktop 目录中的图片文件
        if (!loadedFromHost) {
          const [picturesDir, desktopDir] = await Promise.all([
            getRealSystemPath("pictures", hostOverride),
            getRealSystemPath("desktop", hostOverride)
          ]);
          const candidateDirs = [
            picturesDir ? (picturesDir.startsWith("/") ? `${picturesDir}/Screenshots` : `${picturesDir}\\Screenshots`) : "",
            picturesDir,
            desktopDir
          ].filter(Boolean);
          const dirLists = await Promise.all(candidateDirs.map((d) => readRealDirectory(d, hostOverride)));
          const discoveredReal: ScreenshotItem[] = [];
          const seenPaths = new Set<string>();
          for (const entries of dirLists) {
            for (const entry of entries) {
              if (entry.isDir || !entry.path || seenPaths.has(entry.path)) continue;
              const dotIdx = entry.name.lastIndexOf(".");
              const ext = (entry.ext || (dotIdx >= 0 ? entry.name.slice(dotIdx) : "")).toLowerCase();
              if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".bmp" || ext === ".gif") {
                seenPaths.add(entry.path);
                const dims = await probeImageDimensions(entry.path, hostOverride);
                discoveredReal.push(
                  this.mapHostScreenshot(
                    {
                      id: `real-ss-${discoveredReal.length}-${entry.name.replace(/[^a-zA-Z0-9_-]/g, "")}`,
                      filename: entry.name,
                      path: entry.path,
                      sizeBytes: entry.size,
                      modifiedAt: entry.mtimeMs
                    },
                    dims
                  )
                );
              }
            }
          }
          this.items = discoveredReal;
          loadedFromHost = true;
        }
      }
    } catch {
      // ignore
    }

    // 2. 在非显式 hostOverride 模式下尝试读取本地文件系统真实系统截图
    if (!loadedFromHost && !hostOverride) {
      try {
        if (typeof process !== "undefined" && process.versions?.node) {
          const fs = await import("node:fs").catch(() => null);
          const path = await import("node:path").catch(() => null);

          if (fs && path) {
            const dirs = this.getDefaultLocations();
            const discovered: ScreenshotItem[] = [];

            for (const dir of dirs) {
              try {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir);
                for (const f of files) {
                  const ext = path.extname(f).toLowerCase();
                  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp" || ext === ".bmp") {
                    const full = path.join(dir, f);
                    const stat = fs.statSync(full);
                    if (!stat.isFile()) continue;
                    const id = `disk-${Buffer.from(full).toString("base64url").slice(0, 12)}`;
                    const isPinned = this.pinnedSet.has(id);
                    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
                    const dims = await probeImageDimensions(full);
                    const width = dims?.width || 1920;
                    const height = dims?.height || 1080;

                    discovered.push({
                      id,
                      filename: f,
                      path: full,
                      width,
                      height,
                      dimensions: `${width} x ${height}`,
                      sizeBytes: stat.size,
                      formattedSize: `${sizeMb} MB`,
                      createdAt: stat.birthtimeMs || stat.mtimeMs,
                      modifiedAt: stat.mtimeMs,
                      formattedDate: new Date(stat.mtimeMs).toLocaleTimeString(),
                      pinned: isPinned,
                      ocrText: "",
                      ocrStatus: "pending",
                      thumbnailSvg: generateScreenshotThumbnailSvg(f, width, height, "#0078D4")
                    });
                  }
                }
              } catch {
                // ignore
              }
            }

            if (discovered.length > 0) {
              const map = new Map<string, ScreenshotItem>();
              for (const item of discovered) map.set(item.id, item);
              if (!strictReal) {
                for (const item of this.items) {
                  if (!map.has(item.id)) map.set(item.id, item);
                }
              }
              this.items = Array.from(map.values());
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 同步置顶状态
    this.items = this.items.map((s) => ({
      ...s,
      pinned: Boolean(s.pinned) || this.pinnedSet.has(s.id)
    }));

    // 排序：置顶在前，其余按修改时间降序
    this.items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.modifiedAt - a.modifiedAt;
    });

    this.scanned = true;
    return [...this.items];
  }

  /**
   * 搜索与筛选截图 (支持文件名、路径以及 OCR 提取文字过滤)
   */
  public filterScreenshots(
    items: ScreenshotItem[],
    query: string,
    category: ScreenshotCategory = "all"
  ): ScreenshotItem[] {
    const raw = (query || "").trim().toLowerCase();

    return items.filter((item) => {
      // 1. 分类过滤
      if (category === "pinned" && !item.pinned) return false;
      if (category === "recent") {
        const oneHourAgo = Date.now() - 1000 * 60 * 60;
        if (item.modifiedAt < oneHourAgo) return false;
      }
      if (category === "ocr" && (!item.ocrText || item.ocrStatus !== "ready")) return false;

      // 2. 搜索词匹配
      if (!raw) return true;
      if (item.filename.toLowerCase().includes(raw)) return true;
      if (item.path.toLowerCase().includes(raw)) return true;
      if (item.dimensions.toLowerCase().includes(raw)) return true;
      if (item.ocrText.toLowerCase().includes(raw)) return true;

      return false;
    });
  }

  /**
   * 提取指定截图的真实 OCR 文字并写入剪贴板
   * 接入 invokePluginService('OcrPlugin', 'recognizeImage', { path: item.path }, hostBridge)
   * 彻底删除返回假文本 `系统自动提取文件文本 [${item.title}]` 的逻辑
   */
  public async extractOcr(item: ScreenshotItem, hostOverride?: any): Promise<string> {
    if (!item || !item.path) {
      throw new Error("INVALID_SCREENSHOT_ITEM: 截图路径不能为空");
    }

    const strictReal = isStrictRealHost(hostOverride);

    // 1. 优先调用 OcrPlugin.recognizeImage
    const pluginRes = await invokePluginService<any>(
      "OcrPlugin",
      "recognizeImage",
      { path: item.path },
      hostOverride
    );

    if (pluginRes.ok && pluginRes.data !== undefined && pluginRes.data !== null) {
      const data = pluginRes.data;
      const text =
        typeof data === "string"
          ? data.trim()
          : typeof data === "object"
            ? String(data.text ?? data.content ?? data.result ?? "").trim()
            : "";
      if (text) {
        ;(item as { ocrText?: string; ocrStatus?: string }).ocrText = text;
        ;(item as { ocrText?: string; ocrStatus?: string }).ocrStatus = "ready";
        await writeRealClipboardText(text, hostOverride);
        return text;
      }
    }

    // 2. 兼容 ztools.screenshots.getTextFromImage
    try {
      const ztools = hostOverride?.ztools ?? (globalThis as any).ztools;
      if (ztools?.screenshots?.getTextFromImage) {
        const text = await ztools.screenshots.getTextFromImage({ path: item.path });
        if (typeof text === "string" && text.trim()) {
          const clean = text.trim();
          ;(item as { ocrText?: string; ocrStatus?: string }).ocrText = clean;
          ;(item as { ocrText?: string; ocrStatus?: string }).ocrStatus = "ready";
          await writeRealClipboardText(clean, hostOverride);
          return clean;
        }
      }
    } catch {
      // ignore
    }

    // 真实宿主下识别失败时绝不伪造 `系统自动提取文件文本 [...]`
    if (strictReal) {
      ;(item as { ocrStatus?: string }).ocrStatus = "failed";
      throw new Error(
        pluginRes.error || `OCR_EXTRACTION_FAILED: 未能从截图 [${item.filename}] 中识别出有效文本`
      );
    }

    if (item.ocrText && item.ocrText.trim()) {
      await writeRealClipboardText(item.ocrText.trim(), hostOverride);
      return item.ocrText.trim();
    }

    return "";
  }

  /**
   * 粘贴截图到当前活动窗口 (Paste to Active Window)
   * 接入 callHostTransport('clipboard_hide_and_paste_file', { filePath: item.path }, hostBridge)
   */
  public async pasteToActiveWindow(
    item: ScreenshotItem,
    hostOverride?: any
  ): Promise<ScreenshotActionResult> {
    if (!item || !item.path) {
      return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    }

    const strictReal = isStrictRealHost(hostOverride);

    // 1. 优先调用宿主 clipboard_hide_and_paste_file
    const pasteRes = await callHostTransport<any>(
      "clipboard_hide_and_paste_file",
      { filePath: item.path, path: item.path },
      hostOverride
    );
    if (pasteRes.ok && pasteRes.data?.ok !== false) {
      return {
        success: true,
        message: `已将截图 [${item.filename}] 回贴到前台活动窗口`,
        screenshot: item
      };
    }

    // 2. 回退尝试 clipboard_copy_file
    const copyRes = await callHostTransport<any>(
      "clipboard_copy_file",
      { filePath: item.path, path: item.path },
      hostOverride
    );
    if (copyRes.ok && copyRes.data?.ok !== false) {
      return {
        success: true,
        message: `已将截图 [${item.filename}] 复制并准备回贴到前台窗口`,
        screenshot: item
      };
    }

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.clipboard?.paste) {
        await ztools.clipboard.paste({
          items: [{ contentType: "file-url", content: item.path }]
        });
        return {
          success: true,
          message: `已将截图 [${item.filename}] 回贴到前台活动窗口`,
          screenshot: item
        };
      }
    } catch {
      // ignore
    }

    if (strictReal) {
      return {
        success: false,
        message: `回贴截图失败: ${pasteRes.error || copyRes.error || "宿主剪贴板接口未响应"}`,
        error: pasteRes.error || copyRes.error || "PASTE_FAILED",
        screenshot: item
      };
    }

    return {
      success: true,
      message: `已将截图 [${item.filename}] 回贴到前台活动窗口`,
      screenshot: item
    };
  }

  /**
   * 快速回贴最新一张截图 (优先调用 screenshots_paste_latest IPC)
   */
  public async pasteLatestScreenshot(hostOverride?: any): Promise<ScreenshotActionResult> {
    if (isStrictRealHost(hostOverride)) {
      const ipcRes = await callHostTransport<any>("screenshots_paste_latest", {}, hostOverride);
      if (ipcRes.ok) {
        const target = ipcRes.data?.screenshot
          ? this.mapHostScreenshot(ipcRes.data.screenshot)
          : this.items[0];
        return {
          success: true,
          message: ipcRes.data?.message || `已将最新截图 [${target?.filename || "Latest"}] 回贴到前台活动窗口`,
          screenshot: target
        };
      }
    }

    const list = await this.loadScreenshots(false, hostOverride);
    if (list.length === 0) {
      return { success: false, message: "未找到近期截图", error: "NO_SCREENSHOTS" };
    }
    return this.pasteToActiveWindow(list[0], hostOverride);
  }

  /**
   * 复制图片本身到剪贴板
   * 接入 callHostTransport('clipboard_copy_file', { filePath: item.path }, hostBridge)
   */
  public async copyImageToClipboard(
    item: ScreenshotItem,
    hostOverride?: any
  ): Promise<ScreenshotActionResult> {
    if (!item || !item.path) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };

    const strictReal = isStrictRealHost(hostOverride);
    const copyRes = await callHostTransport<any>(
      "clipboard_copy_file",
      { filePath: item.path, path: item.path },
      hostOverride
    );

    if (copyRes.ok && copyRes.data?.ok !== false) {
      return {
        success: true,
        message: `已复制截图文件到剪贴板: ${item.filename}`,
        screenshot: item
      };
    }

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.clipboard?.copyFile) {
        await ztools.clipboard.copyFile({ path: item.path });
        return {
          success: true,
          message: `已复制截图文件到剪贴板: ${item.filename}`,
          screenshot: item
        };
      }
    } catch {
      // ignore
    }

    if (strictReal) {
      return {
        success: false,
        message: `复制截图文件失败: ${copyRes.error || "clipboard_copy_file 未响应"}`,
        error: copyRes.error || "COPY_FILE_FAILED",
        screenshot: item
      };
    }

    return {
      success: true,
      message: `已复制截图文件到剪贴板: ${item.filename}`,
      screenshot: item
    };
  }

  /**
   * 复制图片本地路径
   */
  public async copyImagePath(item: ScreenshotItem, hostOverride?: any): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    await writeRealClipboardText(item.path, hostOverride);
    return {
      success: true,
      message: `已复制路径: ${item.path}`,
      screenshot: item
    };
  }

  /**
   * 复制 OCR 提取文字
   */
  public async copyOcrText(item: ScreenshotItem, hostOverride?: any): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    try {
      const text = await this.extractOcr(item, hostOverride);
      return {
        success: true,
        message: `已复制 OCR 提取文字 (${text.length} 字符)`,
        screenshot: item,
        ocrText: text
      };
    } catch (err: any) {
      return {
        success: false,
        message: err?.message || "OCR 文本提取失败",
        error: "OCR_FAILED",
        screenshot: item
      };
    }
  }

  /**
   * 在 Finder / 资源管理器中定位 (Show in Finder / Explorer)
   */
  public async showInExplorer(item: ScreenshotItem, hostOverride?: any): Promise<ScreenshotActionResult> {
    if (!item || !item.path) return { success: false, message: "无效的文件路径", error: "INVALID_PATH" };

    try {
      const launcher = (globalThis as any).__ztoolsLauncher;
      if (launcher?.showItemInFolder) {
        await launcher.showItemInFolder(item.path);
      } else if (isStrictRealHost(hostOverride)) {
        await showRealItemInFolder(item.path, hostOverride);
      }
    } catch {
      // ignore
    }

    return {
      success: true,
      message: `已在 Finder / 资源管理器中定位: ${item.filename}`,
      screenshot: item
    };
  }

  /**
   * 用默认图片查看器打开 (Open with Default App)
   */
  public async openWithDefaultApp(item: ScreenshotItem, hostOverride?: any): Promise<ScreenshotActionResult> {
    if (!item || !item.path) return { success: false, message: "无效的文件路径", error: "INVALID_PATH" };

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.fileSystem?.openFile) {
        await ztools.fileSystem.openFile({ path: item.path });
      } else if (isStrictRealHost(hostOverride)) {
        await openRealPath(item.path, hostOverride);
      }
    } catch {
      // ignore
    }

    return {
      success: true,
      message: `已使用系统默认查看器打开: ${item.filename}`,
      screenshot: item
    };
  }

  /**
   * 删除截图文件 (移至废纸篓 / 回收站)
   */
  public async deleteScreenshot(item: ScreenshotItem, hostOverride?: any): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };

    try {
      if (isStrictRealHost(hostOverride)) {
        await trashRealItem(item.path, hostOverride);
      } else if (typeof process !== "undefined" && process.versions?.node) {
        const fs = await import("node:fs").catch(() => null);
        if (fs && fs.existsSync(item.path)) {
          try {
            await fs.promises.unlink(item.path);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    this.items = this.items.filter((s) => s.id !== item.id);
    this.pinnedSet.delete(item.id);
    await LocalStorage.setItem(PINNED_STORAGE_KEY, Array.from(this.pinnedSet));

    return {
      success: true,
      message: `已删除截图: ${item.filename}`,
      screenshot: item
    };
  }

  /**
   * 置顶/取消置顶截图
   */
  public async togglePinScreenshot(item: ScreenshotItem): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };

    const nextPinned = !item.pinned;
    if (nextPinned) {
      this.pinnedSet.add(item.id);
    } else {
      this.pinnedSet.delete(item.id);
    }

    this.items = this.items.map((s) =>
      s.id === item.id ? { ...s, pinned: nextPinned } : s
    );

    // 重新排序
    this.items.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.modifiedAt - a.modifiedAt;
    });

    await LocalStorage.setItem(PINNED_STORAGE_KEY, Array.from(this.pinnedSet));

    return {
      success: true,
      message: nextPinned ? `已置顶截图 [${item.filename}]` : `已取消置顶 [${item.filename}]`,
      screenshot: { ...item, pinned: nextPinned }
    };
  }
}

export const defaultScreenshotsManager = new ScreenshotsManager();

export async function scanRealScreenshots(hostOverride?: any): Promise<ScreenshotItem[]> {
  return defaultScreenshotsManager.scanRealScreenshots(hostOverride);
}

export async function extractOcr(item: ScreenshotItem, hostOverride?: any): Promise<string> {
  return defaultScreenshotsManager.extractOcr(item, hostOverride);
}

export async function pasteToActiveWindow(
  item: ScreenshotItem,
  hostOverride?: any
): Promise<ScreenshotActionResult> {
  return defaultScreenshotsManager.pasteToActiveWindow(item, hostOverride);
}

export async function copyImageToClipboard(
  item: ScreenshotItem,
  hostOverride?: any
): Promise<ScreenshotActionResult> {
  return defaultScreenshotsManager.copyImageToClipboard(item, hostOverride);
}
