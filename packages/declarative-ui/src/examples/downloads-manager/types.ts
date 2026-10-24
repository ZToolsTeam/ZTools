/**
 * 下载文件夹管家 (Downloads Manager) 类型定义
 *
 * 借鉴 Raycast 原版 extensions/downloads-manager 核心模型并针对中国用户办公痛点增强：
 * - 核心指令能力：Manage Downloads, Open Latest Download, Copy Latest Download, Delete Latest Download
 * - 本土化办公增强：
 *   - 自动识别 6 大文件分类：installer (安装包)、archive (压缩包)、document (办公文档)、image (图片)、media (音视频)、other (其他)
 *   - 一键按分类自动归档整理 (Organize by Category) 模拟与执行
 *   - 大文件筛选、过期文件清理、人类可读文件大小格式化 (formatFileSize)、安全路径防穿越校验
 */

/**
 * 6 大核心下载文件分类
 */
export type DownloadFileCategory =
  | "installer"
  | "archive"
  | "document"
  | "image"
  | "media"
  | "other";

/**
 * 列表筛选分类（含全部、6 大文件分类、大文件、过期文件、已置顶）
 */
export type DownloadFilterCategory =
  | "all"
  | DownloadFileCategory
  | "large"
  | "expired"
  | "pinned";

/**
 * 排序规则（兼容 Raycast 原版 DownloadOrder 并扩展大小/名称排序）
 */
export type DownloadOrder =
  | "modifiedTime"
  | "createTime"
  | "addTime"
  | "birthTime"
  | "sizeDesc"
  | "nameAsc";

/**
 * 下载文件条目数据模型（同时兼容 Raycast 原版 Download 字段）
 */
export interface DownloadFileItem {
  readonly id: string;
  readonly filename: string;
  /** Raycast 原版兼容字段：文件名 */
  readonly file: string;
  readonly path: string;
  readonly extension: string;
  readonly category: DownloadFileCategory;
  readonly categoryLabel: string;
  readonly sizeBytes: number;
  /** Raycast 原版兼容字段：字节大小 */
  readonly size: number;
  readonly formattedSize: string;
  readonly isDirectory: boolean;
  readonly itemCount?: number | undefined;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly addedAt: number;
  readonly birthAt: number;
  readonly formattedDate: string;
  readonly pinned: boolean;
  /** 若已按分类归档整理，记录归档目标子目录名称 */
  readonly archivedTo?: string | undefined;
  /** 双栏详情预览 SVG Data URL */
  readonly previewSvg?: string | undefined;
  /** 文件摘要或说明 */
  readonly summary?: string | undefined;
}

/**
 * Raycast 原版兼容类型别名
 */
export type Download = DownloadFileItem;

/**
 * 单项或批量操作返回结果
 */
export interface DownloadActionResult {
  readonly success: boolean;
  readonly message: string;
  readonly file?: DownloadFileItem | undefined;
  readonly files?: readonly DownloadFileItem[] | undefined;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * 分类归档统计项
 */
export interface OrganizeSummaryItem {
  readonly category: DownloadFileCategory;
  readonly categoryLabel: string;
  readonly targetSubfolder: string;
  readonly count: number;
  readonly totalBytes: number;
  readonly formattedTotalSize: string;
  readonly files: readonly string[];
}

/**
 * 一键按分类自动归档整理结果
 */
export interface OrganizeByCategoryResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly message: string;
  readonly movedCount: number;
  readonly totalBytes: number;
  readonly formattedTotalSize: string;
  readonly summary: readonly OrganizeSummaryItem[];
  readonly updatedFiles: readonly DownloadFileItem[];
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * 过期文件清理结果
 */
export interface CleanExpiredResult {
  readonly success: boolean;
  readonly dryRun: boolean;
  readonly olderThanDays: number;
  readonly deletedCount: number;
  readonly freedBytes: number;
  readonly formattedFreedSize: string;
  readonly deletedFiles: readonly DownloadFileItem[];
  readonly remainingFiles: readonly DownloadFileItem[];
  readonly message: string;
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * 路径安全校验结果
 */
export interface SafePathValidationResult {
  readonly valid: boolean;
  readonly normalizedPath: string;
  readonly reason?: string | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * 可注入的文件系统与宿主动作适配器（保障空目录与测试环境 100% 确定性可测）
 */
export interface DownloadsStorageAdapter {
  readonly baseDownloadsFolder?: string | undefined;
  readonly initialFiles?: readonly DownloadFileItem[] | undefined;
  readDirectory?(folderPath: string): Promise<DownloadFileItem[]> | DownloadFileItem[];
  openFile?(filePath: string): Promise<void> | void;
  copyFile?(filePath: string): Promise<void> | void;
  deleteFile?(filePath: string): Promise<void> | void;
  moveFile?(fromPath: string, toPath: string): Promise<void> | void;
  showInExplorer?(filePath: string): Promise<void> | void;
}
