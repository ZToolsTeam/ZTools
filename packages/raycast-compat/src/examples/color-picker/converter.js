import { LocalStorage } from "../../api/storage.js";
const PALETTE_STORAGE_KEY = "color_picker_palette";
// 规范化 Hex 字符串
export function normalizeHex(hex) {
    let clean = hex.trim().replace(/^#/, "");
    if (clean.length === 3) {
        clean = clean
            .split("")
            .map((c) => c + c)
            .join("");
    }
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
        return "#000000";
    }
    return `#${clean.toUpperCase()}`;
}
export function hexToRgb(hex) {
    const norm = normalizeHex(hex).slice(1);
    const r = parseInt(norm.substring(0, 2), 16);
    const g = parseInt(norm.substring(2, 4), 16);
    const b = parseInt(norm.substring(4, 6), 16);
    return { r, g, b };
}
export function rgbToHex(rgb) {
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const toHex = (n) => clamp(n).toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}
export function rgbToHsl(rgb) {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }
    return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        l: Math.round(l * 100)
    };
}
export function hslToRgb(hsl) {
    const h = hsl.h / 360;
    const s = hsl.s / 100;
    const l = hsl.l / 100;
    let r = l;
    let g = l;
    let b = l;
    if (s !== 0) {
        const hue2rgb = (p, q, t) => {
            let v = t;
            if (v < 0)
                v += 1;
            if (v > 1)
                v -= 1;
            if (v < 1 / 6)
                return p + (q - p) * 6 * v;
            if (v < 1 / 2)
                return q;
            if (v < 2 / 3)
                return p + (q - p) * (2 / 3 - v) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255)
    };
}
export function rgbToCmyk(rgb) {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const k = 1 - Math.max(r, g, b);
    if (k === 1) {
        return { c: 0, m: 0, y: 0, k: 100 };
    }
    const c = (1 - r - k) / (1 - k);
    const m = (1 - g - k) / (1 - k);
    const y = (1 - b - k) / (1 - k);
    return {
        c: Math.round(c * 100),
        m: Math.round(m * 100),
        y: Math.round(y * 100),
        k: Math.round(k * 100)
    };
}
export function cmykToRgb(cmyk) {
    const c = cmyk.c / 100;
    const m = cmyk.m / 100;
    const y = cmyk.y / 100;
    const k = cmyk.k / 100;
    const r = Math.round(255 * (1 - c) * (1 - k));
    const g = Math.round(255 * (1 - m) * (1 - k));
    const b = Math.round(255 * (1 - y) * (1 - k));
    return { r, g, b };
}
// WCAG 2.1 对比度与相对亮度计算
function getLuminance(rgb) {
    const sRgb = [rgb.r, rgb.g, rgb.b].map((val) => {
        const s = val / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * sRgb[0] + 0.7152 * sRgb[1] + 0.0722 * sRgb[2];
}
export function calculateContrast(rgb1, rgb2) {
    const l1 = getLuminance(rgb1);
    const l2 = getLuminance(rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}
function evaluateRating(ratio) {
    if (ratio >= 7.0)
        return "AAA";
    if (ratio >= 4.5)
        return "AA";
    if (ratio >= 3.0)
        return "AA Large";
    return "Fail";
}
export function calculateWcag(rgb) {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    const contrastOnWhite = calculateContrast(rgb, white);
    const contrastOnBlack = calculateContrast(rgb, black);
    return {
        contrastOnWhite,
        contrastOnBlack,
        whiteRating: evaluateRating(contrastOnWhite),
        blackRating: evaluateRating(contrastOnBlack),
        recommendedText: contrastOnBlack >= contrastOnWhite ? "black" : "white"
    };
}
/**
 * 智能颜色解析器 (支持 Hex, RGB, HSL, CMYK)
 */
export function parseColor(input) {
    const trimmed = input.trim();
    // 1. HEX 匹配
    if (/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
        const hex = normalizeHex(trimmed);
        const rgb = hexToRgb(hex);
        const hsl = rgbToHsl(rgb);
        const cmyk = rgbToCmyk(rgb);
        return {
            hex,
            rgb,
            hsl,
            cmyk,
            cssRgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
            cssHsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
            cssCmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
            wcag: calculateWcag(rgb),
            isValid: true
        };
    }
    // 2. RGB 匹配 (rgb(r, g, b))
    const rgbMatch = trimmed.match(/^rgba?\(?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgbMatch) {
        const rgb = {
            r: Math.min(255, parseInt(rgbMatch[1], 10)),
            g: Math.min(255, parseInt(rgbMatch[2], 10)),
            b: Math.min(255, parseInt(rgbMatch[3], 10))
        };
        const hex = rgbToHex(rgb);
        const hsl = rgbToHsl(rgb);
        const cmyk = rgbToCmyk(rgb);
        return {
            hex,
            rgb,
            hsl,
            cmyk,
            cssRgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
            cssHsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
            cssCmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
            wcag: calculateWcag(rgb),
            isValid: true
        };
    }
    // 3. HSL 匹配 (hsl(h, s%, l%))
    const hslMatch = trimmed.match(/^hsla?\(?\s*(\d{1,3})\s*,\s*(\d{1,3})%?\s*,\s*(\d{1,3})%?/i);
    if (hslMatch) {
        const hsl = {
            h: parseInt(hslMatch[1], 10) % 360,
            s: Math.min(100, parseInt(hslMatch[2], 10)),
            l: Math.min(100, parseInt(hslMatch[3], 10))
        };
        const rgb = hslToRgb(hsl);
        const hex = rgbToHex(rgb);
        const cmyk = rgbToCmyk(rgb);
        return {
            hex,
            rgb,
            hsl,
            cmyk,
            cssRgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
            cssHsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
            cssCmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
            wcag: calculateWcag(rgb),
            isValid: true
        };
    }
    // 默认 Fallback
    const fallbackHex = "#0A84FF";
    const fallbackRgb = hexToRgb(fallbackHex);
    const fallbackHsl = rgbToHsl(fallbackRgb);
    const fallbackCmyk = rgbToCmyk(fallbackRgb);
    return {
        hex: fallbackHex,
        rgb: fallbackRgb,
        hsl: fallbackHsl,
        cmyk: fallbackCmyk,
        cssRgb: `rgb(${fallbackRgb.r}, ${fallbackRgb.g}, ${fallbackRgb.b})`,
        cssHsl: `hsl(${fallbackHsl.h}, ${fallbackHsl.s}%, ${fallbackHsl.l}%)`,
        cssCmyk: `cmyk(${fallbackCmyk.c}%, ${fallbackCmyk.m}%, ${fallbackCmyk.y}%, ${fallbackCmyk.k}%)`,
        wcag: calculateWcag(fallbackRgb),
        isValid: false
    };
}
/**
 * 产生一个包含色块的 SVG Data URL 用于在虚拟 Detail Markdown 中渲染
 */
export function generateColorSwatchSvg(hex, width = 360, height = 120) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" rx="12" fill="${hex}"/>
    <text x="${width / 2}" y="${height / 2 + 7}" fill="#ffffff" font-size="20" font-family="monospace" text-anchor="middle" font-weight="bold">${hex}</text>
  </svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
/**
 * 调色板 LocalStorage 持久化操作
 */
export async function getSavedPalette() {
    try {
        const list = await LocalStorage.getItem(PALETTE_STORAGE_KEY);
        return list || [];
    }
    catch {
        return [];
    }
}
export async function saveColorToPalette(name, hex) {
    const current = await getSavedPalette();
    const newItem = {
        id: `color_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: name || hex,
        hex: normalizeHex(hex),
        savedAt: new Date().toLocaleTimeString()
    };
    const updated = [newItem, ...current.filter((c) => c.hex !== newItem.hex)].slice(0, 30);
    await LocalStorage.setItem(PALETTE_STORAGE_KEY, updated);
    return updated;
}
export async function clearPalette() {
    await LocalStorage.removeItem(PALETTE_STORAGE_KEY);
}
export async function removeFromPalette(id) {
    const current = await getSavedPalette();
    const updated = current.filter((c) => c.id !== id);
    await LocalStorage.setItem(PALETTE_STORAGE_KEY, updated);
    return updated;
}
