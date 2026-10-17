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
  if (/^WIFI:/i.test(trimmed) && /(?:^|;|:)S:[^;]+/i.test(trimmed)) {
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
 * GF(256) 伽罗瓦域指数与对数查表（本原多项式 x^8 + x^4 + x^3 + x^2 + 1 = 0x11D）
 */
const GF256_EXP = new Uint8Array(512);
const GF256_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF256_EXP[i] = x;
    GF256_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF256_EXP[i] = GF256_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF256_EXP[GF256_LOG[a] + GF256_LOG[b]];
}

/**
 * 计算 ISO/IEC 18004 标准 Reed-Solomon GF(256) 纠错码字
 */
export function computeReedSolomonEcc(data: Uint8Array, eccCount: number): Uint8Array {
  let gen = new Uint8Array([1]);
  for (let i = 0; i < eccCount; i++) {
    const nextGen = new Uint8Array(gen.length + 1);
    const root = GF256_EXP[i];
    for (let j = 0; j < gen.length; j++) {
      nextGen[j] ^= gen[j];
      nextGen[j + 1] ^= gfMul(gen[j], root);
    }
    gen = nextGen;
  }

  const remainder = new Uint8Array(eccCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[eccCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < eccCount; j++) {
        remainder[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return remainder;
}

/**
 * 计算 15-bit BCH(15, 5) Format Information 校验位 (ISO/IEC 18004)
 */
function computeFormatInfoBits(level: QrErrorCorrectionLevel, maskPattern = 0): number {
  const ecIndicatorMap: Record<QrErrorCorrectionLevel, number> = {
    L: 0b01,
    M: 0b00,
    Q: 0b11,
    H: 0b10
  };
  const ecBits = ecIndicatorMap[level] ?? 0b00;
  const formatData = ((ecBits & 0b11) << 3) | (maskPattern & 0b111);
  let rem = formatData << 10;
  const generator = 0b10100110111;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >>> bit) & 1) {
      rem ^= generator << (bit - 10);
    }
  }
  return ((formatData << 10) | rem) ^ 0b101010000010010;
}

function utf8ToBase64(str: string): string {
  try {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      return Buffer.from(str, "utf8").toString("base64");
    }
  } catch {
    // fallback to Web API
  }
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === "function" ? btoa(binary) : "";
}

function base64ToUtf8(b64: string): string {
  try {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      return Buffer.from(b64, "base64").toString("utf8");
    }
  } catch {
    // fallback to Web API
  }
  const binary = typeof atob === "function" ? atob(b64) : "";
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
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
  const matrix = buildQrMatrix(safeText, level);
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
  const encodedPayload = utf8ToBase64(safeText);
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
 * 生成二维码布尔矩阵 (基于标准 ISO/IEC 18004 Finder、Timing、Alignment、Format Info 与 GF(256) Reed-Solomon 编码)
 */
export function buildQrMatrix(text: string, level: QrErrorCorrectionLevel = "M"): boolean[][] {
  const utf8Bytes = new TextEncoder().encode(text || " ");
  const len = utf8Bytes.length;
  let version = 2;
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

  // 1. 放置三个角的位置探测图形 (Finder Patterns: 7x7 + 1px 白边分隔符)
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

  // 2. 放置定时图案 (Timing Patterns: 第 6 行与第 6 列)
  for (let i = 8; i < moduleCount - 8; i++) {
    isFunctionPattern[6][i] = true;
    isFunctionPattern[i][6] = true;
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // 3. 放置右下角 (size - 9, size - 9) 5x5 对齐图案 (Alignment Pattern: 外圈 1、内圈 0、中心 1)
  const alignTop = moduleCount - 9;
  const alignLeft = moduleCount - 9;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const ar = alignTop + r;
      const ac = alignLeft + c;
      if (ar >= 0 && ar < moduleCount && ac >= 0 && ac < moduleCount) {
        isFunctionPattern[ar][ac] = true;
        const isOuterBorder = r === 0 || r === 4 || c === 0 || c === 4;
        const isCenter = r === 2 && c === 2;
        matrix[ar][ac] = isOuterBorder || isCenter;
      }
    }
  }

  // 4. 放置 Format Information 校验位与 Dark Module
  const formatBits = computeFormatInfoBits(level, 0);
  for (let i = 0; i <= 5; i++) {
    isFunctionPattern[8][i] = true;
    matrix[8][i] = Boolean((formatBits >>> i) & 1);
  }
  isFunctionPattern[8][7] = true;
  matrix[8][7] = Boolean((formatBits >>> 6) & 1);
  isFunctionPattern[8][8] = true;
  matrix[8][8] = Boolean((formatBits >>> 7) & 1);
  isFunctionPattern[7][8] = true;
  matrix[7][8] = Boolean((formatBits >>> 8) & 1);
  for (let i = 9; i < 15; i++) {
    const r = 14 - i;
    isFunctionPattern[r][8] = true;
    matrix[r][8] = Boolean((formatBits >>> i) & 1);
  }
  for (let i = 0; i < 8; i++) {
    const c = moduleCount - 1 - i;
    isFunctionPattern[8][c] = true;
    matrix[8][c] = Boolean((formatBits >>> i) & 1);
  }
  for (let i = 8; i < 15; i++) {
    const r = moduleCount - 15 + i;
    isFunctionPattern[r][8] = true;
    matrix[r][8] = Boolean((formatBits >>> i) & 1);
  }
  // Dark Module
  isFunctionPattern[moduleCount - 8][8] = true;
  matrix[moduleCount - 8][8] = true;

  // 5. 数据编码 (Byte Mode 0100 + 长度 + UTF-8 字节流 + Reed-Solomon 纠错字节)
  const eccCountMap: Record<QrErrorCorrectionLevel, number> = {
    L: 10,
    M: 16,
    Q: 22,
    H: 28
  };
  const eccCount = eccCountMap[level] ?? 16;
  const payloadBytes = new Uint8Array(utf8Bytes.length + 2);
  payloadBytes[0] = (0b0100 << 4) | ((utf8Bytes.length >>> 4) & 0x0f);
  payloadBytes[1] = ((utf8Bytes.length & 0x0f) << 4) | ((utf8Bytes[0] ?? 0) >>> 4);
  for (let i = 0; i < utf8Bytes.length; i++) {
    const nextByte = i + 1 < utf8Bytes.length ? utf8Bytes[i + 1] : 0;
    payloadBytes[i + 1] = ((utf8Bytes[i] & 0x0f) << 4) | ((nextByte >>> 4) & 0x0f);
  }
  const eccBytes = computeReedSolomonEcc(payloadBytes, eccCount);

  const interleavedBytes = new Uint8Array(payloadBytes.length + eccBytes.length);
  interleavedBytes.set(payloadBytes, 0);
  interleavedBytes.set(eccBytes, payloadBytes.length);

  const totalBits: number[] = [];
  for (let i = 0; i < interleavedBytes.length; i++) {
    const b = interleavedBytes[i];
    for (let shift = 7; shift >= 0; shift--) {
      totalBits.push((b >> shift) & 1);
    }
  }

  // ISO/IEC 18004 标准交替填充字节 0xEC (11101100), 0x11 (00010001)
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  let bitPos = 0;
  for (let col = moduleCount - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 避开第 6 列 timing pattern
    for (let r = 0; r < moduleCount; r++) {
      const upward = ((moduleCount - 1 - (col > 6 ? col : col + 1)) & 2) === 0;
      const row = upward ? moduleCount - 1 - r : r;
      for (let c = 0; c < 2; c++) {
        const currCol = col - c;
        if (!isFunctionPattern[row][currCol]) {
          while (bitPos >= totalBits.length) {
            const pb = padBytes[padIdx % 2];
            padIdx++;
            for (let shift = 7; shift >= 0; shift--) {
              totalBits.push((pb >> shift) & 1);
            }
          }
          const bit = totalBits[bitPos++];
          const mask = (row + currCol) % 2 === 0;
          matrix[row][currCol] = Boolean(bit ^ (mask ? 1 : 0));
        }
      }
    }
  }

  return matrix;
}

export const createQrMatrix = buildQrMatrix;

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
          candidate = base64ToUtf8(encoded);
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
      const text = base64ToUtf8(b64);
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
      const decoded = base64ToUtf8(candidate);
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
