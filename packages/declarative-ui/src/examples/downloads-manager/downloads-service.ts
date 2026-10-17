/**
 * 下载文件夹管家核心服务 (downloads-service.ts)
 *
 * 借鉴 Raycast 官方 `extensions/downloads-manager` 源码改造：
 * - 完整保留原版 `getDownloads`, `getLatestDownload`, `openLatestDownload`, `copyLatestDownload`, `deleteLatestDownload`
 * - 新增 6 大办公文件分类识别 (installer / archive / document / image / media / other)
 * - 新增一键按分类自动归档整理 (`organizeByCategory`) 与过期大文件清理 (`cleanExpiredDownloads`)
 * - 内置路径安全防穿越校验 (`validateSafeDownloadPath`)
 */

import {
  CleanExpiredResult,
  DownloadActionResult,
  DownloadFileCategory,
  DownloadFileItem,
  DownloadFilterCategory,
  DownloadOrder,
  DownloadsStorageAdapter,
  OrganizeByCategoryResult,
  OrganizeSummaryItem,
  SafePathValidationResult
} from "./types.js";

export const CATEGORY_LABELS: Readonly<Record<DownloadFileCategory, string>> = Object.freeze({
  installer: "安装包与程序",
  archive: "压缩归档包",
  document: "办公文档与表格",
  image: "图片与设计稿",
  media: "音视频媒体",
  other: "其他文件"
});

export const CATEGORY_SUBFOLDERS: Readonly<Record<DownloadFileCategory, string>> = Object.freeze({
  installer: "01_安装包(Installers)",
  archive: "02_压缩包(Archives)",
  document: "03_办公文档(Documents)",
  image: "04_图片设计(Images)",
  media: "05_音视频(Media)",
  other: "06_其他文件(Others)"
});

const EXT_CATEGORY_MAP: Readonly<Record<string, DownloadFileCategory>> = Object.freeze({
  ".exe": "installer",
  ".msi": "installer",
  ".dmg": "installer",
  ".pkg": "installer",
  ".deb": "installer",
  ".apk": "installer",
  ".zip": "archive",
  ".rar": "archive",
  ".7z": "archive",
  ".tar": "archive",
  ".gz": "archive",
  ".tgz": "archive",
  ".pdf": "document",
  ".doc": "document",
  ".docx": "document",
  ".xls": "document",
  ".xlsx": "document",
  ".ppt": "document",
  ".pptx": "document",
  ".csv": "document",
  ".txt": "document",
  ".md": "document",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".ico": "image",
  ".mp4": "media",
  ".mkv": "media",
  ".mov": "media",
  ".mp3": "media",
  ".flac": "media",
  ".wav": "media"
});

export function formatFileSize(bytes: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
}

export function detectDownloadCategory(filename: string): DownloadFileCategory {
  if (typeof filename !== "string" || !filename.trim()) return "other";
  const lower = filename.trim().toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx === -1) return "other";
  const ext = lower.slice(dotIdx);
  return EXT_CATEGORY_MAP[ext] || "other";
}

export function validateSafeDownloadPath(
  filePath: string,
  baseFolder = "C:\\Users\\User\\Downloads"
): SafePathValidationResult {
  if (typeof filePath !== "string" || !filePath.trim()) {
    return {
      valid: false,
      normalizedPath: "",
      reason: "文件路径不能为空",
      errorCode: "EMPTY_PATH"
    };
  }
  const raw = filePath.trim();
  if (raw.includes("\0") || raw.includes("..") || raw.startsWith("\\\\")) {
    return {
      valid: false,
      normalizedPath: raw,
      reason: "检测到疑似路径穿越或非法字符 (Path Traversal Blocked)",
      errorCode: "PATH_TRAVERSAL"
    };
  }
  const normFile = raw.replace(/\//g, "\\");
  const normBase = (baseFolder || "").trim().replace(/\//g, "\\").replace(/\\+$/, "");
  if (normBase && !normFile.toLowerCase().startsWith(normBase.toLowerCase())) {
    return {
      valid: false,
      normalizedPath: normFile,
      reason: "目标文件不在受信任的下载目录范围内",
      errorCode: "OUTSIDE_BASE_DIR"
    };
  }
  return {
    valid: true,
    normalizedPath: normFile
  };
}

const NOW_TS = 1713000000000;
const DAY_MS = 86_400_000;

export const INITIAL_DOWNLOAD_FILES: readonly DownloadFileItem[] = Object.freeze([
  {
    id: "dl-1",
    filename: "2026Q3_财务报销明细与发票汇总.pdf",
    file: "2026Q3_财务报销明细与发票汇总.pdf",
    path: "C:\\Users\\User\\Downloads\\2026Q3_财务报销明细与发票汇总.pdf",
    extension: ".pdf",
    category: "document",
    categoryLabel: CATEGORY_LABELS.document,
    sizeBytes: 4_823_450,
    size: 4_823_450,
    formattedSize: formatFileSize(4_823_450),
    isDirectory: false,
    createdAt: NOW_TS - 120_000,
    modifiedAt: NOW_TS - 120_000,
    addedAt: NOW_TS - 120_000,
    birthAt: NOW_TS - 120_000,
    formattedDate: "刚刚 (2 分钟前)",
    pinned: true,
    summary: "微信接收的最新报销 PDF 凭证，可直接一键复制粘贴至飞书/企业微信"
  },
  {
    id: "dl-2",
    filename: "ZTools-Setup-2.4.0-x64.exe",
    file: "ZTools-Setup-2.4.0-x64.exe",
    path: "C:\\Users\\User\\Downloads\\ZTools-Setup-2.4.0-x64.exe",
    extension: ".exe",
    category: "installer",
    categoryLabel: CATEGORY_LABELS.installer,
    sizeBytes: 158_334_976,
    size: 158_334_976,
    formattedSize: formatFileSize(158_334_976),
    isDirectory: false,
    createdAt: NOW_TS - 3_600_000,
    modifiedAt: NOW_TS - 3_600_000,
    addedAt: NOW_TS - 3_600_000,
    birthAt: NOW_TS - 3_600_000,
    formattedDate: "1 小时前",
    pinned: false,
    summary: "Windows 64 位客户端安装包"
  },
  {
    id: "dl-3",
    filename: "产品发布会视觉海报终版_v3.png",
    file: "产品发布会视觉海报终版_v3.png",
    path: "C:\\Users\\User\\Downloads\\产品发布会视觉海报终版_v3.png",
    extension: ".png",
    category: "image",
    categoryLabel: CATEGORY_LABELS.image,
    sizeBytes: 12_582_912,
    size: 12_582_912,
    formattedSize: formatFileSize(12_582_912),
    isDirectory: false,
    createdAt: NOW_TS - DAY_MS * 2,
    modifiedAt: NOW_TS - DAY_MS * 2,
    addedAt: NOW_TS - DAY_MS * 2,
    birthAt: NOW_TS - DAY_MS * 2,
    formattedDate: "2 天前",
    pinned: false,
    summary: "设计团队交付的 4K 高清无损 PNG 主视觉海报"
  },
  {
    id: "dl-4",
    filename: "客户合同附件备份_2025.zip",
    file: "客户合同附件备份_2025.zip",
    path: "C:\\Users\\User\\Downloads\\客户合同附件备份_2025.zip",
    extension: ".zip",
    category: "archive",
    categoryLabel: CATEGORY_LABELS.archive,
    sizeBytes: 245_366_784,
    size: 245_366_784,
    formattedSize: formatFileSize(245_366_784),
    isDirectory: false,
    createdAt: NOW_TS - DAY_MS * 45,
    modifiedAt: NOW_TS - DAY_MS * 45,
    addedAt: NOW_TS - DAY_MS * 45,
    birthAt: NOW_TS - DAY_MS * 45,
    formattedDate: "45 天前",
    pinned: false,
    summary: "超过 30 天的历史大体积压缩归档包"
  },
  {
    id: "dl-5",
    filename: "Bilibili_1080P_技术分享录屏.mp4",
    file: "Bilibili_1080P_技术分享录屏.mp4",
    path: "C:\\Users\\User\\Downloads\\Bilibili_1080P_技术分享录屏.mp4",
    extension: ".mp4",
    category: "media",
    categoryLabel: CATEGORY_LABELS.media,
    sizeBytes: 512_753_664,
    size: 512_753_664,
    formattedSize: formatFileSize(512_753_664),
    isDirectory: false,
    createdAt: NOW_TS - DAY_MS * 60,
    modifiedAt: NOW_TS - DAY_MS * 60,
    addedAt: NOW_TS - DAY_MS * 60,
    birthAt: NOW_TS - DAY_MS * 60,
    formattedDate: "60 天前",
    pinned: false,
    summary: "高清视频文件，占用超过 500MB 空间"
  }
]);

export class DownloadsManagerService {
  private files: DownloadFileItem[];
  private baseFolder: string;
  private adapter?: DownloadsStorageAdapter;

  constructor(adapter?: DownloadsStorageAdapter) {
    this.adapter = adapter;
    this.baseFolder = adapter?.baseDownloadsFolder || "C:\\Users\\User\\Downloads";
    const source = adapter?.initialFiles ?? INITIAL_DOWNLOAD_FILES;
    this.files = source.map((f) => ({ ...f }));
  }

  public getDownloads(
    options: {
      query?: string;
      category?: DownloadFilterCategory;
      orderBy?: DownloadOrder;
      largeThresholdBytes?: number;
      expiredDays?: number;
    } = {}
  ): DownloadFileItem[] {
    const q = (options.query || "").trim().toLowerCase();
    const cat = options.category || "all";
    const orderBy = options.orderBy || "modifiedTime";
    const largeBytes = options.largeThresholdBytes ?? 100 * 1024 * 1024; // 100MB
    const expiredCutoff = NOW_TS - (options.expiredDays ?? 30) * DAY_MS;

    const filtered = this.files.filter((f) => {
      if (cat === "pinned" && !f.pinned) return false;
      if (cat === "large" && f.sizeBytes < largeBytes) return false;
      if (cat === "expired" && f.modifiedAt > expiredCutoff) return false;
      if (
        cat !== "all" &&
        cat !== "pinned" &&
        cat !== "large" &&
        cat !== "expired" &&
        f.category !== cat
      ) {
        return false;
      }

      if (!q) return true;
      return `${f.filename} ${f.categoryLabel} ${f.extension} ${f.summary || ""}`
        .toLowerCase()
        .includes(q);
    });

    return [...filtered].sort((a, b) => {
      if (orderBy === "sizeDesc") return b.sizeBytes - a.sizeBytes;
      if (orderBy === "nameAsc") return a.filename.localeCompare(b.filename, "zh-CN");
      if (orderBy === "createTime") return b.createdAt - a.createdAt;
      if (orderBy === "addTime") return b.addedAt - a.addedAt;
      if (orderBy === "birthTime") return b.birthAt - a.birthAt;
      return b.modifiedAt - a.modifiedAt;
    });
  }

  public getLatestDownload(): DownloadFileItem | undefined {
    const sorted = this.getDownloads({ orderBy: "modifiedTime" });
    return sorted[0] ? { ...sorted[0] } : undefined;
  }

  public async openDownload(idOrPath: string): Promise<DownloadActionResult> {
    const target = this.files.find((f) => f.id === idOrPath || f.path === idOrPath);
    if (!target) {
      return {
        success: false,
        message: "未找到指定的下载文件",
        error: "File not found",
        errorCode: "NOT_FOUND"
      };
    }
    const check = validateSafeDownloadPath(target.path, this.baseFolder);
    if (!check.valid) {
      return {
        success: false,
        message: check.reason || "路径不安全",
        error: check.reason,
        errorCode: check.errorCode
      };
    }
    await this.adapter?.openFile?.(target.path);
    return {
      success: true,
      message: `已打开文件: ${target.filename}`,
      file: { ...target }
    };
  }

  public async openLatestDownload(): Promise<DownloadActionResult> {
    const latest = this.getLatestDownload();
    if (!latest) {
      return {
        success: false,
        message: "下载文件夹为空",
        error: "No downloads found",
        errorCode: "EMPTY_DOWNLOADS"
      };
    }
    return this.openDownload(latest.id);
  }

  public async copyLatestDownload(): Promise<DownloadActionResult> {
    const latest = this.getLatestDownload();
    if (!latest) {
      return {
        success: false,
        message: "下载文件夹为空",
        error: "No downloads found",
        errorCode: "EMPTY_DOWNLOADS"
      };
    }
    await this.adapter?.copyFile?.(latest.path);
    return {
      success: true,
      message: `已复制最新下载文件 "${latest.filename}"，可直接粘贴发送`,
      file: { ...latest }
    };
  }

  public async deleteDownload(idOrPath: string): Promise<DownloadActionResult> {
    const idx = this.files.findIndex((f) => f.id === idOrPath || f.path === idOrPath);
    if (idx === -1) {
      return {
        success: false,
        message: "未找到要删除的文件",
        error: "File not found",
        errorCode: "NOT_FOUND"
      };
    }
    const target = this.files[idx];
    if (target.pinned) {
      return {
        success: false,
        message: `文件 "${target.filename}" 已置顶锁定，请先取消置顶再删除`,
        error: "Cannot delete pinned file",
        errorCode: "FILE_PINNED"
      };
    }
    await this.adapter?.deleteFile?.(target.path);
    this.files.splice(idx, 1);
    return {
      success: true,
      message: `已将 "${target.filename}" 移至回收站`,
      file: { ...target }
    };
  }

  public async deleteLatestDownload(): Promise<DownloadActionResult> {
    const latest = this.getLatestDownload();
    if (!latest) {
      return {
        success: false,
        message: "下载文件夹为空",
        error: "No downloads found",
        errorCode: "EMPTY_DOWNLOADS"
      };
    }
    return this.deleteDownload(latest.id);
  }

  public togglePin(id: string): DownloadFileItem | undefined {
    const idx = this.files.findIndex((f) => f.id === id);
    if (idx === -1) return undefined;
    const updated: DownloadFileItem = {
      ...this.files[idx],
      pinned: !this.files[idx].pinned
    };
    this.files[idx] = updated;
    return { ...updated };
  }

  /**
   * 一键按文件类型分类归档整理 (Organize by Category)
   */
  public async organizeByCategory(dryRun = false): Promise<OrganizeByCategoryResult> {
    const groups = new Map<DownloadFileCategory, DownloadFileItem[]>();
    let movedCount = 0;
    let totalBytes = 0;

    for (const file of this.files) {
      if (file.isDirectory) continue;
      const list = groups.get(file.category) || [];
      list.push(file);
      groups.set(file.category, list);
      movedCount++;
      totalBytes += file.sizeBytes;
    }

    const summary: OrganizeSummaryItem[] = [];
    for (const [cat, items] of groups.entries()) {
      const catBytes = items.reduce((acc, item) => acc + item.sizeBytes, 0);
      summary.push({
        category: cat,
        categoryLabel: CATEGORY_LABELS[cat],
        targetSubfolder: CATEGORY_SUBFOLDERS[cat],
        count: items.length,
        totalBytes: catBytes,
        formattedTotalSize: formatFileSize(catBytes),
        files: items.map((i) => i.filename)
      });
    }

    if (!dryRun) {
      this.files = this.files.map((f) => {
        if (f.isDirectory) return f;
        const sub = CATEGORY_SUBFOLDERS[f.category];
        return {
          ...f,
          archivedTo: sub,
          path: `${this.baseFolder}\\${sub}\\${f.filename}`
        };
      });
    }

    return {
      success: true,
      dryRun,
      message: `${dryRun ? "[预览] " : ""}已按 ${summary.length} 个分类归档整理 ${movedCount} 个文件 (${formatFileSize(totalBytes)})`,
      movedCount,
      totalBytes,
      formattedTotalSize: formatFileSize(totalBytes),
      summary,
      updatedFiles: this.files.map((f) => ({ ...f }))
    };
  }

  /**
   * 清理超过指定天数的过期未置顶文件
   */
  public async cleanExpiredDownloads(
    olderThanDays = 30,
    dryRun = false
  ): Promise<CleanExpiredResult> {
    if (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays <= 0) {
      return {
        success: false,
        dryRun,
        olderThanDays,
        deletedCount: 0,
        freedBytes: 0,
        formattedFreedSize: "0 B",
        deletedFiles: [],
        remainingFiles: this.files.map((f) => ({ ...f })),
        message: "清理天数参数必须为大于 0 的数字",
        error: "Invalid olderThanDays",
        errorCode: "INVALID_DAYS"
      };
    }

    const cutoff = NOW_TS - olderThanDays * DAY_MS;
    const toDelete = this.files.filter((f) => !f.pinned && f.modifiedAt <= cutoff);
    const remaining = this.files.filter((f) => f.pinned || f.modifiedAt > cutoff);
    const freedBytes = toDelete.reduce((acc, f) => acc + f.sizeBytes, 0);

    if (!dryRun) {
      this.files = remaining;
    }

    return {
      success: true,
      dryRun,
      olderThanDays,
      deletedCount: toDelete.length,
      freedBytes,
      formattedFreedSize: formatFileSize(freedBytes),
      deletedFiles: toDelete.map((f) => ({ ...f })),
      remainingFiles: remaining.map((f) => ({ ...f })),
      message: `已清理 ${toDelete.length} 个超过 ${olderThanDays} 天的过期文件，释放 ${formatFileSize(freedBytes)} 空间`
    };
  }

  public resetToDefaults(): void {
    this.files = INITIAL_DOWNLOAD_FILES.map((f) => ({ ...f }));
  }
}

export const defaultDownloadsManager = new DownloadsManagerService();
