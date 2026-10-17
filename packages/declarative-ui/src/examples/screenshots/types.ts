/**
 * Windows Screenshots (截图历史与文字识别 OCR 中枢) 类型定义
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows backend/index.mjs (key: screenshots)
 * - 偏好字段：columnCount, includeAllMedia, textRecognitionEnabled, storageDuration
 * - 核心动作：searchScreenshots, pasteLatestScreenshot, copyFile, copyOcrText, deleteScreenshot
 */

export interface ScreenshotItem {
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly dimensions: string;
  readonly sizeBytes: number;
  readonly formattedSize: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly formattedDate: string;
  readonly pinned: boolean;
  readonly ocrText: string;
  readonly ocrStatus: "ready" | "pending" | "empty" | "failed";
  readonly thumbnailSvg: string;
}

export type ScreenshotCategory = "all" | "pinned" | "recent" | "ocr";

export interface ScreenshotActionResult {
  readonly success: boolean;
  readonly message: string;
  readonly screenshot?: ScreenshotItem | undefined;
  readonly ocrText?: string | undefined;
  readonly error?: string | undefined;
}
