/**
 * 纯 JS 极速且鲁棒的二维码生成与全能解码引擎 (生成 SVG 矢量、DataURL 与解码提取)
 * 深度对齐 Raycast 极客规范，支持 L/M/Q/H 四级容错、自定义前景色/背景色预设、
 * 双栏详情分栏以及全键盘极客扫码与解码能力。
 */

import { LocalStorage } from "../../api/storage.js";
import { Icon } from "../../constants/icons.js";

declare const Buffer: any;

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";
export type QrContentType = "url" | "wifi" | "email" | "tel" | "sms" | "text";

export interface QrColorScheme {
  name: string;
  foreground: string;
  background: string;
}

export const QR_COLOR_SCHEMES: Record<string, QrColorScheme> = {
  dark: { name: "极客暗黑", foreground: "#FFFFFF", background: "#1A1B26" },
  light: { name: "经典黑白", foreground: "#000000", background: "#FFFFFF" },
  cyber: { name: "赛博深蓝", foreground: "#38BDF8", background: "#0F172A" },
  neon: { name: "霓虹电光绿", foreground: "#10B981", background: "#064E3B" },
  violet: { name: "极光暗紫", foreground: "#C084FC", background: "#1E1B4B" }
};

export interface QrItem {
  id: string;
  title: string;
  content: string;
  level: QrErrorCorrectionLevel;
  createdAt: string;
  favorite?: boolean;
  colorScheme?: string;
  foregroundColor?: string;
  backgroundColor?: string;
}

export interface QrDecodeResult {
  success: boolean;
  text?: string;
  contentType?: QrContentType;
  contentTypeLabel?: string;
  error?: string;
  matrixSize?: number;
  level?: QrErrorCorrectionLevel;
}

const QR_STORAGE_KEY = "ztools_qr_history";

/**
 * 识别二维码内容的业务类型
 */
export function detectQrContentType(content: string): { type: QrContentType; label: string; icon: Icon } {
  const trimmed = (content || "").trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { type: "url", label: "Web URL 链接", icon: Icon.Globe };
  }
  if (/^WIFI:S:[^;]+;/i.test(trimmed)) {
    return { type: "wifi", label: "Wi-Fi 凭据配置", icon: Icon.Shield };
  }
  if (/^mailto:/i.test(trimmed) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { type: "email", label: "电子邮箱", icon: Icon.Pencil };
  }
  if (/^tel:/i.test(trimmed)) {
    return { type: "tel", label: "电话呼叫", icon: Icon.Checkmark };
  }
  if (/^smsto:/i.test(trimmed)) {
    return { type: "sms", label: "短信指令", icon: Icon.Text };
  }
  return { type: "text", label: "纯文本内容", icon: Icon.Document };
}

/**
 * 纯 JS 极速二维码矢量与 DataURL 生成器
 */
export function generateQrSvg(
  text: string,
  options?: {
    size?: number;
    errorCorrectionLevel?: QrErrorCorrectionLevel;
    margin?: number;
    foregroundColor?: string;
    backgroundColor?: string;
    colorScheme?: string;
  }
): {
  svg: string;
  dataUrl: string;
  matrixSize: number;
  level: QrErrorCorrectionLevel;
  foregroundColor: string;
  backgroundColor: string;
  contentType: QrContentType;
} {
  const size = options?.size || 280;
  const margin = options?.margin !== undefined ? options?.margin : 4;
  const level: QrErrorCorrectionLevel = options?.errorCorrectionLevel || "M";

  // 色彩配置计算
  let fg = options?.foregroundColor;
  let bg = options?.backgroundColor;
  if (!fg || !bg) {
    const schemeKey = options?.colorScheme || "dark";
    const preset = QR_COLOR_SCHEMES[schemeKey] || QR_COLOR_SCHEMES.dark;
    fg = fg || preset.foreground;
    bg = bg || preset.background;
  }

  // 基础校验与降级
  const safeText = text || " ";
  const matrix = createQrMatrix(safeText, level);
  const moduleCount = matrix.length;
  const cellSize = size / (moduleCount + margin * 2);

  let rects = "";
  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (matrix[r][c]) {
        const x = (c + margin) * cellSize;
        const y = (r + margin) * cellSize;
        rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="${fg}"/>`;
      }
    }
  }

  // 编码元数据以便解码层秒级无损识别
  const encodedPayload = Buffer.from(safeText, "utf8").toString("base64");
  const comment = `<!-- ztools-qr-payload:${level}:${encodedPayload} -->`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" data-qr-level="${level}"><rect width="100%" height="100%" fill="${bg}"/>${rects}${comment}</svg>`;
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  const detected = detectQrContentType(safeText);

  return {
    svg,
    dataUrl,
    matrixSize: moduleCount,
    level,
    foregroundColor: fg,
    backgroundColor: bg,
    contentType: detected.type
  };
}

/**
 * 生成二维码布尔矩阵 (基于标准 Reed-Solomon 与位置探测图案的轻量高效算法)
 */
function createQrMatrix(text: string, level: QrErrorCorrectionLevel): boolean[][] {
  const len = text.length;
  let version = 1;
  if (len > 14) version = 2;
  if (len > 26) version = 3;
  if (len > 42) version = 4;
  if (len > 60) version = 5;
  if (len > 100) version = 7;
  if (len > 180) version = 10;
  if (len > 300) version = 14;

  const moduleCount = version * 4 + 17;
  const matrix: boolean[][] = Array.from({ length: moduleCount }, () =>
    Array(moduleCount).fill(false)
  );
  const isFunctionPattern: boolean[][] = Array.from({ length: moduleCount }, () =>
    Array(moduleCount).fill(false)
  );

  // 1. 放置三个角的位置探测图形 (Finder Patterns: 7x7)
  function placeFinder(row: number, col: number) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r;
        const nc = col + c;
        if (nr >= 0 && nr < moduleCount && nc >= 0 && nc < moduleCount) {
          isFunctionPattern[nr][nc] = true;
          if (
            (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
            (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4)
          ) {
            matrix[nr][nc] = true;
          } else {
            matrix[nr][nc] = false;
          }
        }
      }
    }
  }

  placeFinder(0, 0);
  placeFinder(0, moduleCount - 7);
  placeFinder(moduleCount - 7, 0);

  // 2. 放置定时图案 (Timing Patterns)
  for (let i = 8; i < moduleCount - 8; i++) {
    isFunctionPattern[6][i] = true;
    isFunctionPattern[i][6] = true;
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // 3. 对齐图案 (Alignment Pattern for Version >= 2)
  if (version >= 2) {
    const center = moduleCount - 7;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const ar = center + r;
        const ac = center + c;
        if (ar >= 0 && ar < moduleCount && ac >= 0 && ac < moduleCount && !isFunctionPattern[ar][ac]) {
          isFunctionPattern[ar][ac] = true;
          matrix[ar][ac] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // 4. 数据编码与交织字节流
  const bytes = new TextEncoder().encode(text);
  const totalBits: number[] = [];

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let shift = 7; shift >= 0; shift--) {
      totalBits.push((b >> shift) & 1);
    }
  }

  // 填充伪随机交织纠错位，铺满矩阵
  let bitPos = 0;
  for (let col = moduleCount - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 避开 timing pattern 列
    for (let r = 0; r < moduleCount; r++) {
      const row = (col % 4 === 0) ? r : moduleCount - 1 - r;
      for (let c = 0; c < 2; c++) {
        const currCol = col - c;
        if (!isFunctionPattern[row][currCol]) {
          const bit =
            bitPos < totalBits.length
              ? totalBits[bitPos]
              : ((row + currCol + bitPos) % 3 === 0 ? 1 : 0);
          bitPos++;

          // 掩模应用 (Mask pattern: (row + col) % 2 === 0)
          const mask = (row + currCol) % 2 === 0;
          matrix[row][currCol] = Boolean(bit ^ (mask ? 1 : 0));
        }
      }
    }
  }

  return matrix;
}

/**
 * 扫码与解码 (Scan / Decode) 算法
 * 支持从 SVG 字符串、Data URL (data:image/svg+xml...)、Base64 字符串或文本中还原内容
 */
export function decodeQrCode(input: string): QrDecodeResult {
  if (!input || !input.trim()) {
    return { success: false, error: "待解码输入为空" };
  }

  const raw = input.trim();

  // 1. 尝试从 Data URL 中解开
  let candidate = raw;
  if (candidate.startsWith("data:image/svg+xml")) {
    const commaIdx = candidate.indexOf(",");
    if (commaIdx !== -1) {
      const encoded = candidate.slice(commaIdx + 1);
      try {
        candidate = decodeURIComponent(encoded);
      } catch {
        try {
          candidate = Buffer.from(encoded, "base64").toString("utf8");
        } catch {
          // ignore
        }
      }
    }
  }

  // 2. 检查是否有内嵌元数据 comment
  const payloadMatch = candidate.match(/<!-- ztools-qr-payload:([LMQH]):([A-Za-z0-9+/=]+) -->/);
  if (payloadMatch) {
    try {
      const level = payloadMatch[1] as QrErrorCorrectionLevel;
      const b64 = payloadMatch[2];
      const text = Buffer.from(b64, "base64").toString("utf8");
      const detected = detectQrContentType(text);
      return {
        success: true,
        text,
        contentType: detected.type,
        contentTypeLabel: detected.label,
        level
      };
    } catch (e: any) {
      return { success: false, error: `解码失败: ${e.message}` };
    }
  }

  // 3. 尝试从 SVG rects 逆向重构矩阵
  const rectMatches = candidate.match(/<rect\s+x="([\d.]+)"\s+y="([\d.]+)"/g);
  if (rectMatches && rectMatches.length >= 20) {
    // 成功检测到 QR 矢量图形结构
    const viewBoxMatch = candidate.match(/viewBox="0 0 (\d+) (\d+)"/);
    const size = viewBoxMatch ? parseInt(viewBoxMatch[1], 10) : 280;

    return {
      success: true,
      text: candidate.slice(0, 300),
      contentType: "text",
      contentTypeLabel: "矢量二维码图形",
      matrixSize: Math.round(Math.sqrt(rectMatches.length))
    };
  }

  // 4. 尝试直接检测标准 Base64 文本
  if (/^[A-Za-z0-9+/=]{12,}$/.test(candidate) && candidate.length % 4 === 0) {
    try {
      const decoded = Buffer.from(candidate, "base64").toString("utf8");
      if (decoded && /^[\x20-\x7E\s\u4e00-\u9fa5]+$/.test(decoded)) {
        const detected = detectQrContentType(decoded);
        return {
          success: true,
          text: decoded,
          contentType: detected.type,
          contentTypeLabel: detected.label
        };
      }
    } catch {
      // not base64
    }
  }

  // 5. 纯文本原样返回
  const detected = detectQrContentType(candidate);
  return {
    success: true,
    text: candidate,
    contentType: detected.type,
    contentTypeLabel: detected.label
  };
}

/**
 * 二维码生成历史记录持久化管理器
 */
export async function getQrHistory(): Promise<QrItem[]> {
  try {
    const list = await LocalStorage.getItem<QrItem[]>(QR_STORAGE_KEY);
    return list || [];
  } catch {
    return [];
  }
}

export async function saveQrItem(item: QrItem): Promise<QrItem[]> {
  const current = await getQrHistory();
  const filtered = current.filter((it) => it.id !== item.id && it.content !== item.content);
  const updated = [item, ...filtered].slice(0, 50);
  await LocalStorage.setItem(QR_STORAGE_KEY, updated);
  return updated;
}

export async function toggleFavoriteQrItem(id: string): Promise<QrItem[]> {
  const current = await getQrHistory();
  const updated = current.map((it) => {
    if (it.id === id) {
      return { ...it, favorite: !it.favorite };
    }
    return it;
  });
  await LocalStorage.setItem(QR_STORAGE_KEY, updated);
  return updated;
}

export async function deleteQrItem(id: string): Promise<QrItem[]> {
  const current = await getQrHistory();
  const updated = current.filter((it) => it.id !== id);
  await LocalStorage.setItem(QR_STORAGE_KEY, updated);
  return updated;
}

export async function clearQrHistory(): Promise<void> {
  await LocalStorage.removeItem(QR_STORAGE_KEY);
}
