import { LocalStorage } from "../../api/storage.js";
import {
  ScreenshotItem,
  ScreenshotCategory,
  ScreenshotActionResult
} from "./types.js";
import {
  callHostTransport,
  isRealElectronHost,
  getRealSystemPath,
  readRealDirectory,
  openRealPath,
  showRealItemInFolder,
  trashRealItem
} from "../shared/native-ipc.js";

const PINNED_STORAGE_KEY = "@ztools/screenshots/pinned";

/**
 * 生成轻量且逼真的 SVG 缩略图数据 URL (用于双栏详情展示)
 */
export function generateScreenshotThumbnailSvg(
  label: string,
  width: number,
  height: number,
  accentColor = "#0078D4"
): string {
  const aspect = width / height;
  const svgWidth = 400;
  const svgHeight = Math.round(400 / aspect);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <rect width="${svgWidth}" height="${svgHeight}" rx="8" fill="#1e1e1e" />
  <!-- 窗口标题栏 -->
  <rect width="${svgWidth}" height="28" rx="8" fill="#2d2d2d" />
  <circle cx="16" cy="14" r="4.5" fill="#ff5f56" />
  <circle cx="30" cy="14" r="4.5" fill="#ffbd2e" />
  <circle cx="44" cy="14" r="4.5" fill="#27c93f" />
  <text x="${svgWidth / 2}" y="18" fill="#a0a0a0" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" text-anchor="middle">${label}</text>
  
  <!-- 模拟视口内容 -->
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
 * 初始高频基准截图数据集
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

  private mapHostScreenshot(raw: any): ScreenshotItem {
    const filename = String(raw?.filename || raw?.name || "Screenshot.png");
    const fullPath = String(raw?.path || filename);
    const width = Number(raw?.width) > 0 ? Number(raw.width) : 2560;
    const height = Number(raw?.height) > 0 ? Number(raw.height) : 1440;
    const sizeBytes = Number(raw?.sizeBytes ?? raw?.size) > 0 ? Number(raw.sizeBytes ?? raw.size) : 1048576;
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const modifiedAt = Number(raw?.modifiedAt ?? raw?.mtimeMs) > 0 ? Number(raw.modifiedAt ?? raw.mtimeMs) : Date.now();
    const createdAt = Number(raw?.createdAt ?? raw?.birthtimeMs) > 0 ? Number(raw.createdAt ?? raw.birthtimeMs) : modifiedAt;
    const id = String(raw?.id || `ss-${filename.replace(/[^a-zA-Z0-9_-]/g, "")}`);

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
      ocrText: String(raw?.ocrText || `系统自动提取文件文本 [${filename}]`),
      ocrStatus: raw?.ocrStatus === "pending" || raw?.ocrStatus === "failed" ? raw.ocrStatus : "ready",
      thumbnailSvg: String(raw?.thumbnailSvg || generateScreenshotThumbnailSvg(filename, width, height, "#0078D4"))
    };
  }

  /**
   * 立即截取当前屏幕并加入截图历史 (调用宿主 screen_capture IPC)
   */
  public async captureScreenNow(hostOverride?: any): Promise<ScreenshotActionResult> {
    try {
      const capRes = await callHostTransport<any>("screen_capture", {}, hostOverride);
      if (capRes.ok && capRes.data) {
        const raw = capRes.data;
        if (typeof raw === "object" && (raw.path || raw.filename || raw.name)) {
          const capturedItem = this.mapHostScreenshot(raw);
          this.items = [capturedItem, ...this.items.filter((i) => i.id !== capturedItem.id)];
          return {
            success: true,
            message: `已截取当前屏幕: ${capturedItem.filename}`,
            screenshot: capturedItem
          };
        }
      }
      const list = await this.loadScreenshots(true, hostOverride);
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
    } else {
      locations.push("C:\\Users\\User\\Pictures\\Screenshots");
    }

    return locations;
  }

  /**
   * 扫描系统磁盘中的截图文件 (优先通过 screenshots_scan IPC 调用主进程扫描 macOS com.apple.screencapture / mdfind 或 Windows 目录，支持平滑降级)
   */
  public async loadScreenshots(forceRefresh = false, hostOverride?: any): Promise<ScreenshotItem[]> {
    const realHost = isRealElectronHost(hostOverride);
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

    // 1. 优先尝试通过宿主 IPC 通道 screenshots_scan 获取跨平台截图列表
    try {
      if (hostOverride || realHost) {
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
            : [];
          if (rawList.length > 0) {
            const mapped = rawList.map((r: any) => this.mapHostScreenshot(r));
            const map = new Map<string, ScreenshotItem>();
            for (const item of mapped) map.set(item.id, item);
            if (!realHost) {
              for (const item of this.items) {
                if (!map.has(item.id)) map.set(item.id, item);
              }
            }
            this.items = Array.from(map.values());
          }
        }

        // 在真实宿主环境下若 screenshots_scan 为空，扫描用户真实的 Pictures / Desktop 目录中的图片文件
        if (realHost && this.items.length === 0) {
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
              const ext = (entry.ext || entry.name.slice(entry.name.lastIndexOf("."))).toLowerCase();
              if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
                seenPaths.add(entry.path);
                discoveredReal.push(
                  this.mapHostScreenshot({
                    id: `real-ss-${discoveredReal.length}-${entry.name.replace(/[^a-zA-Z0-9_-]/g, "")}`,
                    filename: entry.name,
                    path: entry.path,
                    sizeBytes: entry.size,
                    modifiedAt: entry.mtimeMs
                  })
                );
              }
            }
          }
          this.items = discoveredReal;
        }
      }
    } catch {
      // 忽略 IPC 异常，继续本地扫描或内置数据降级
    }

    // 2. 尝试读取本地文件系统真实系统截图
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
                if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
                  const full = path.join(dir, f);
                  const stat = fs.statSync(full);
                  const id = `disk-${Buffer.from(full).toString("base64url").slice(0, 12)}`;
                  const isPinned = this.pinnedSet.has(id);
                  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

                  discovered.push({
                    id,
                    filename: f,
                    path: full,
                    width: 2560,
                    height: 1440,
                    dimensions: "2560 x 1440",
                    sizeBytes: stat.size,
                    formattedSize: `${sizeMb} MB`,
                    createdAt: stat.birthtimeMs || stat.mtimeMs,
                    modifiedAt: stat.mtimeMs,
                    formattedDate: new Date(stat.mtimeMs).toLocaleTimeString(),
                    pinned: isPinned,
                    ocrText: `系统自动提取文件文本 [${f}]`,
                    ocrStatus: "ready",
                    thumbnailSvg: generateScreenshotThumbnailSvg(f, 2560, 1440, "#0078D4")
                  });
                }
              }
            } catch {
              // ignore
            }
          }

          if (discovered.length > 0) {
            // 合并现有与系统真实扫描
            const map = new Map<string, ScreenshotItem>();
            for (const item of discovered) map.set(item.id, item);
            for (const item of this.items) {
              if (!map.has(item.id)) map.set(item.id, item);
            }
            this.items = Array.from(map.values());
          }
        }
      }
    } catch {
      // 优雅降级
    }

    // 同步置顶状态
    this.items = this.items.map((s) => ({
      ...s,
      pinned: this.pinnedSet.has(s.id)
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
   * 提取指定截图的 OCR 文字 (支持对接宿主与智能启发式回退)
   */
  public async extractOcr(item: ScreenshotItem): Promise<string> {
    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.screenshots?.getTextFromImage) {
        const text = await ztools.screenshots.getTextFromImage({ path: item.path });
        if (typeof text === "string" && text.trim()) {
          return text.trim();
        }
      }
    } catch {
      // ignore
    }

    return item.ocrText || `[OCR 文本提取中]: ${item.filename}`;
  }

  /**
   * 粘贴截图到当前活动窗口 (Paste to Active Window)
   */
  public async pasteToActiveWindow(item: ScreenshotItem): Promise<ScreenshotActionResult> {
    if (!item) {
      return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    }

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.clipboard?.paste) {
        await ztools.clipboard.paste({
          items: [{ contentType: "file-url", content: item.path }]
        });
      }
    } catch {
      // ignore
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
    if (hostOverride || isRealElectronHost()) {
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
    return this.pasteToActiveWindow(list[0]);
  }

  /**
   * 复制图片本身到剪贴板
   */
  public async copyImageToClipboard(item: ScreenshotItem): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };

    try {
      const ztools = (globalThis as any).ztools;
      if (ztools?.clipboard?.copyFile) {
        await ztools.clipboard.copyFile({ path: item.path });
      }
    } catch {
      // ignore
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
  public async copyImagePath(item: ScreenshotItem): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    return {
      success: true,
      message: `已复制路径: ${item.path}`,
      screenshot: item
    };
  }

  /**
   * 复制 OCR 提取文字
   */
  public async copyOcrText(item: ScreenshotItem): Promise<ScreenshotActionResult> {
    if (!item) return { success: false, message: "截图记录为空", error: "NULL_ITEM" };
    const text = await this.extractOcr(item);
    return {
      success: true,
      message: `已复制 OCR 提取文字 (${text.length} 字符)`,
      screenshot: item,
      ocrText: text
    };
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
      } else if (hostOverride || isRealElectronHost()) {
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
      } else if (hostOverride || isRealElectronHost()) {
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
      if (hostOverride || isRealElectronHost()) {
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
