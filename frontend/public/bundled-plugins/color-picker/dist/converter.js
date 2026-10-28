import { LocalStorage } from "@ztools/declarative-ui";
const PALETTE_STORAGE_KEY = "color_picker_palette";
const NAMED_COLORS = {
    black: "#000000",
    white: "#FFFFFF",
    red: "#FF0000",
    green: "#00FF00",
    blue: "#0000FF",
    yellow: "#FFFF00",
    cyan: "#00FFFF",
    magenta: "#FF00FF",
    gray: "#808080",
    grey: "#808080",
    orange: "#FFA500",
    purple: "#800080",
    pink: "#FFC0CB",
    indigo: "#4B0082",
    gold: "#FFD700"
};
/**
 * 规范化 Hex 字符串 (支持 3 位、4 位、6 位、8 位)
 */
export function normalizeHex(hex) {
    let clean = hex.trim().replace(/^#/, "");
    if (clean.length === 3) {
        clean = clean.split("").map((c) => c + c).join("");
    }
    else if (clean.length === 4) {
        clean = clean.split("").map((c) => c + c).join("");
    }
    if (clean.length === 8 && /^[0-9a-fA-F]{8}$/.test(clean)) {
        return `#${clean.toUpperCase()}`;
    }
    if (!/^[0-9a-fA-F]{6}$/.test(clean.slice(0, 6))) {
        return "#000000";
    }
    return `#${clean.slice(0, 6).toUpperCase()}`;
}
export function hexToRgb(hex) {
    const norm = normalizeHex(hex).slice(1);
    const r = parseInt(norm.substring(0, 2), 16) || 0;
    const g = parseInt(norm.substring(2, 4), 16) || 0;
    const b = parseInt(norm.substring(4, 6), 16) || 0;
    if (norm.length === 8) {
        const a = parseInt(norm.substring(6, 8), 16) / 255;
        return { r, g, b, a };
    }
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
export function rgbToHsv(rgb) {
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const v = max;
    const d = max - min;
    const s = max === 0 ? 0 : d / max;
    let h = 0;
    if (max !== min) {
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
        v: Math.round(v * 100)
    };
}
export function hsvToRgb(hsv) {
    const h = (hsv.h % 360) / 60;
    const s = hsv.s / 100;
    const v = hsv.v / 100;
    const c = v * s;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h >= 0 && h < 1) {
        r = c;
        g = x;
        b = 0;
    }
    else if (h >= 1 && h < 2) {
        r = x;
        g = c;
        b = 0;
    }
    else if (h >= 2 && h < 3) {
        r = 0;
        g = c;
        b = x;
    }
    else if (h >= 3 && h < 4) {
        r = 0;
        g = x;
        b = c;
    }
    else if (h >= 4 && h < 5) {
        r = x;
        g = 0;
        b = c;
    }
    else if (h >= 5 && h < 6) {
        r = c;
        g = 0;
        b = x;
    }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
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
        const s = Math.max(0, Math.min(255, val)) / 255;
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
 * 产生专业配色方案 (互补色、类似色、三色、分裂互补色、单色阶梯)
 */
export function generateHarmonies(rgb) {
    const hsl = rgbToHsl(rgb);
    const wrap = (deg) => (deg + 360) % 360;
    const toHexFromHue = (hue, s = hsl.s, l = hsl.l) => rgbToHex(hslToRgb({ h: wrap(hue), s, l }));
    return {
        complementary: toHexFromHue(hsl.h + 180),
        analogous: [toHexFromHue(hsl.h - 30), toHexFromHue(hsl.h + 30)],
        triadic: [toHexFromHue(hsl.h + 120), toHexFromHue(hsl.h + 240)],
        splitComplementary: [toHexFromHue(hsl.h + 150), toHexFromHue(hsl.h + 210)],
        tetradic: [toHexFromHue(hsl.h + 90), toHexFromHue(hsl.h + 180), toHexFromHue(hsl.h + 270)],
        monochromatic: [
            toHexFromHue(hsl.h, hsl.s, Math.max(10, hsl.l - 25)),
            toHexFromHue(hsl.h, hsl.s, Math.max(15, hsl.l - 12)),
            toHexFromHue(hsl.h, hsl.s, Math.min(85, hsl.l + 12)),
            toHexFromHue(hsl.h, hsl.s, Math.min(95, hsl.l + 25))
        ]
    };
}
/** 外部输入的透明度：非有限数按不透明处理，其余裁剪到 0..1 */
function clampAlpha(a) {
    return typeof a === "number" && Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
}
/** 透明度 → 8 位字节（00..FF） */
function alphaToByte(a) {
    return Math.round(clampAlpha(a) * 255);
}
/** 8 位透明度字节 → 0..1，取能还原同一字节的最短小数（0x80 → 0.5，0x81 → 0.506） */
function alphaFromByte(byte) {
    for (const digits of [2, 3]) {
        const v = Number((byte / 255).toFixed(digits));
        if (Math.round(v * 255) === byte)
            return v;
    }
    return byte / 255;
}
/** CSS 写法里的透明度数值，最多 3 位小数 */
function formatAlpha(a) {
    return String(Number(clampAlpha(a).toFixed(3)));
}
/**
 * 由 sRGB（含透明度）统一生成全部写法。
 * hsl / hsv 传入时沿用用户输入的值（避免取整后再反算出偏差），否则从 rgb 计算。
 */
function buildResult(rgbIn, opts = {}) {
    const rgb = { r: rgbIn.r, g: rgbIn.g, b: rgbIn.b, a: clampAlpha(rgbIn.a) };
    const alphaByte = alphaToByte(rgb.a);
    const hasAlpha = alphaByte < 255;
    const hex = rgbToHex(rgb);
    const hex8 = `${hex}${alphaByte.toString(16).padStart(2, "0").toUpperCase()}`;
    const hsl = opts.hsl ?? rgbToHsl(rgb);
    const hsv = opts.hsv ?? rgbToHsv(rgb);
    const cmyk = rgbToCmyk(rgb);
    const a = formatAlpha(rgb.a);
    return {
        hex,
        hex8,
        alpha: rgb.a,
        hasAlpha,
        outOfGamut: Boolean(opts.outOfGamut),
        rgb,
        hsl,
        hsv,
        cmyk,
        cssRgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
        cssRgba: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`,
        cssHsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
        cssHsla: `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${a})`,
        cssHsv: `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`,
        cssCmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
        cssVar: `--color-primary: ${hasAlpha ? hex8 : hex};`,
        wcag: calculateWcag(rgb),
        harmonies: generateHarmonies(rgb),
        isValid: opts.isValid !== false
    };
}
/**
 * OKLCH → sRGB（Björn Ottosson 的 OKLab 逆变换，与 rgbToOklch 互逆）
 * l: 0..1，c: ≥0，h: 角度。超出 sRGB 色域时逐通道裁剪，并以 outOfGamut 标出（误差超过半个 8 位色阶才算超出）。
 */
export function oklchToRgb(l, c, h) {
    const hr = (h * Math.PI) / 180;
    const A = c * Math.cos(hr);
    const B = c * Math.sin(hr);
    const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
    const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
    const s_ = l - 0.0894841775 * A - 1.291485548 * B;
    const L3 = l_ * l_ * l_, M3 = m_ * m_ * m_, S3 = s_ * s_ * s_;
    const linear = [
        4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3,
        -1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3,
        -0.0041960863 * L3 - 0.7034186147 * M3 + 1.707614701 * S3
    ];
    let outOfGamut = false;
    const [r, g, b] = linear.map((x) => {
        const enc = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
        const v = enc * 255;
        if (!Number.isFinite(v) || v < -0.5 || v > 255.5)
            outOfGamut = true;
        return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
    });
    return { rgb: { r, g, b }, outOfGamut };
}
const NUM = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
const SEP = "(?:\\s*,\\s*|\\s+)";
const OKLCH_RE = new RegExp(`^oklch\\(\\s*(${NUM})(%?)${SEP}(${NUM})(%?)${SEP}(?:(${NUM})(?:deg)?|none)(?:\\s*\\/\\s*(${NUM})(%?))?\\s*\\)$`, "i");
const CMYK_RE = new RegExp(`^cmyk\\(\\s*(${NUM})%?${SEP}(${NUM})%?${SEP}(${NUM})%?${SEP}(${NUM})%?\\s*\\)$`, "i");
/**
 * 智能色彩解析器 (支持 HEX, RGB, RGBA, HSL, HSLA, HSV, OKLCH, CMYK 以及常用命名色彩)
 */
export function parseColor(input) {
    const trimmed = input.trim();
    const lower = trimmed.toLowerCase();
    // 0. 命名颜色支持
    if (Object.prototype.hasOwnProperty.call(NAMED_COLORS, lower)) {
        return parseColor(NAMED_COLORS[lower]);
    }
    // 1. HEX 匹配 (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)
    if (/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
        const hex = normalizeHex(trimmed);
        const rgb = hexToRgb(hex);
        if (hex.length === 9)
            rgb.a = alphaFromByte(parseInt(hex.slice(7, 9), 16));
        return buildResult(rgb);
    }
    // 2. RGB 匹配 (rgb(r, g, b) 或 rgba(r, g, b, a))
    const rgbMatch = trimmed.match(/^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (rgbMatch) {
        return buildResult({
            r: Math.max(0, Math.min(255, parseInt(rgbMatch[1], 10))),
            g: Math.max(0, Math.min(255, parseInt(rgbMatch[2], 10))),
            b: Math.max(0, Math.min(255, parseInt(rgbMatch[3], 10))),
            a: rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1
        });
    }
    // 3. HSL 匹配 (hsl(h, s%, l%) 或 hsla(h, s%, l%, a))
    const hslMatch = trimmed.match(/^hsla?\(\s*(-?\d+)\s*,\s*(-?\d+)%?\s*,\s*(-?\d+)%?(?:\s*,\s*([\d.]+))?\s*\)$/i);
    if (hslMatch) {
        const hsl = {
            h: ((parseInt(hslMatch[1], 10) % 360) + 360) % 360,
            s: Math.max(0, Math.min(100, parseInt(hslMatch[2], 10))),
            l: Math.max(0, Math.min(100, parseInt(hslMatch[3], 10)))
        };
        const rgb = hslToRgb(hsl);
        rgb.a = hslMatch[4] !== undefined ? parseFloat(hslMatch[4]) : 1;
        return buildResult(rgb, { hsl });
    }
    // 4. HSV 匹配 (hsv(h, s%, v%))
    const hsvMatch = trimmed.match(/^hsv\(?\s*(-?\d+)\s*,\s*(-?\d+)%?\s*,\s*(-?\d+)%?\)?/i);
    if (hsvMatch) {
        const hsv = {
            h: ((parseInt(hsvMatch[1], 10) % 360) + 360) % 360,
            s: Math.max(0, Math.min(100, parseInt(hsvMatch[2], 10))),
            v: Math.max(0, Math.min(100, parseInt(hsvMatch[3], 10)))
        };
        return buildResult(hsvToRgb(hsv));
    }
    // 5. OKLCH 匹配（CSS Color 4：oklch(L C H [/ A])，L 为 0..1 或百分比，C 的 100% = 0.4，H 可为 none）
    const oklchMatch = trimmed.match(OKLCH_RE);
    if (oklchMatch) {
        const lRaw = parseFloat(oklchMatch[1]);
        const cRaw = parseFloat(oklchMatch[3]);
        const l = Math.max(0, Math.min(1, oklchMatch[2] ? lRaw / 100 : lRaw));
        const c = Math.max(0, oklchMatch[4] ? (cRaw / 100) * 0.4 : cRaw);
        const h = oklchMatch[5] !== undefined ? ((parseFloat(oklchMatch[5]) % 360) + 360) % 360 : 0;
        const { rgb, outOfGamut } = oklchToRgb(l, c, h);
        if (oklchMatch[6] !== undefined) {
            const aRaw = parseFloat(oklchMatch[6]);
            rgb.a = oklchMatch[7] ? aRaw / 100 : aRaw;
        }
        return buildResult(rgb, { outOfGamut });
    }
    // 6. CMYK 匹配（cmyk(c%, m%, y%, k%)，数值按 0..100 计）
    const cmykMatch = trimmed.match(CMYK_RE);
    if (cmykMatch) {
        const pct = (v) => Math.max(0, Math.min(100, parseFloat(v)));
        return buildResult(cmykToRgb({ c: pct(cmykMatch[1]), m: pct(cmykMatch[2]), y: pct(cmykMatch[3]), k: pct(cmykMatch[4]) }));
    }
    // 默认 Fallback
    return buildResult(hexToRgb("#0A84FF"), { isValid: false });
}
/**
 * 产生一个包含色块的 SVG Data URL 用于在虚拟 Detail Markdown 中渲染
 */
export function generateColorSwatchSvg(hex, width = 360, height = 120) {
    const norm = normalizeHex(hex);
    const solid = norm.slice(0, 7);
    const alphaByte = norm.length === 9 ? parseInt(norm.slice(7, 9), 16) : 255;
    const alpha = alphaByte / 255;
    const label = alphaByte < 255 ? norm : solid;
    const rgb = hexToRgb(solid);
    // 半透明色按叠在浅色棋盘格上的效果选文字颜色
    const shown = {
        r: rgb.r * alpha + 238 * (1 - alpha),
        g: rgb.g * alpha + 238 * (1 - alpha),
        b: rgb.b * alpha + 238 * (1 - alpha)
    };
    const textColor = calculateWcag(shown).recommendedText === "white" ? "#FFFFFF" : "#000000";
    // 半透明时在色块下面垫一层灰白棋盘格，透明度一眼可见
    const checker = alphaByte < 255
        ? `<defs><pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#FFFFFF"/><rect width="8" height="8" fill="#DDDDDD"/><rect x="8" y="8" width="8" height="8" fill="#DDDDDD"/></pattern></defs>
    <rect width="${width}" height="${height}" rx="12" fill="url(#checker)"/>`
        : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${checker}<rect width="${width}" height="${height}" rx="12" fill="${solid}" fill-opacity="${Number(alpha.toFixed(3))}"/>
    <text x="${width / 2}" y="${height / 2 + 7}" fill="${textColor}" font-size="22" font-family="monospace" text-anchor="middle" font-weight="bold">${label}</text>
  </svg>`;
    // 括号也要编码：url(#checker) 里的「)」会提前结束 Markdown 图片链接
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
}
/**
 * sRGB → OKLCH（Björn Ottosson 的 OKLab 定义，CSS Color 4 同款）
 * 返回 CSS 写法，例如 oklch(62.8% 0.2577 29.23)
 */
export function rgbToOklch(rgb) {
    const lin = (v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    const r = lin(rgb.r), g = lin(rgb.g), b = lin(rgb.b);
    const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
    const c = Math.sqrt(A * A + B * B);
    let h = (Math.atan2(B, A) * 180) / Math.PI;
    if (h < 0)
        h += 360;
    const lp = Math.round(L * 10000) / 100;
    const cr = Math.round(c * 10000) / 10000;
    // 无彩色（灰阶）时色相没有意义，按 CSS 规范写 none
    const hr = cr < 0.0002 ? "none" : String(Math.round(h * 100) / 100);
    // 半透明时按 CSS Color 4 写法追加「/ 透明度」
    const alpha = alphaToByte(rgb.a) < 255 ? ` / ${formatAlpha(rgb.a)}` : "";
    return { l: lp, c: cr, h: cr < 0.0002 ? 0 : Math.round(h * 100) / 100, css: `oklch(${lp}% ${cr} ${hr}${alpha})` };
}
/**
 * 调色板 LocalStorage 持久化操作
 */
function sanitizePalette(list) {
    if (list === undefined)
        return [];
    if (!Array.isArray(list) || list.some(c => !c || typeof c.id !== "string" || !c.id || typeof c.name !== "string" ||
        typeof c.savedAt !== "string" || typeof c.hex !== "string" || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(c.hex)) ||
        new Set(list.map(c => c.id)).size !== list.length)
        throw new Error("调色板数据损坏，原数据已保留，请先恢复数据后重试");
    return list;
}
async function changePalette(update) {
    if (typeof LocalStorage.updateItem !== "function")
        throw new Error("请升级 ZTools 以安全保存调色板");
    return LocalStorage.updateItem(PALETTE_STORAGE_KEY, raw => update(sanitizePalette(raw)));
}
/** 读取调色板；存储读失败时抛错（写入前必须用这个，避免读失败后把空列表覆盖回去） */
async function loadPaletteStrict() {
    return sanitizePalette(await LocalStorage.getItem(PALETTE_STORAGE_KEY));
}
export async function getSavedPalette() {
    return loadPaletteStrict();
}
/** 调色板里的颜色：不透明存 6 位 HEX，半透明存 8 位 HEX（保留透明度） */
function paletteHex(hex) {
    const norm = normalizeHex(hex);
    return norm.length === 9 && !norm.endsWith("FF") ? norm : norm.slice(0, 7);
}
export async function saveColorToPalette(name, hex) {
    const newItem = {
        id: `color_${globalThis.crypto.randomUUID()}`,
        name: name || hex,
        hex: paletteHex(hex),
        savedAt: new Date().toLocaleString()
    };
    return changePalette(current => {
        const rest = current.filter(c => c.hex !== newItem.hex);
        if (rest.length >= 100)
            throw new Error("调色板最多保存 100 个颜色，请先删除一些");
        return [newItem, ...rest];
    });
}
export async function clearPalette() {
    await changePalette(() => []);
}
export async function removeFromPalette(id) {
    return changePalette(current => current.filter(c => c.id !== id));
}
export const convertColor = parseColor;
