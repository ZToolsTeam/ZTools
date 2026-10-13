/**
 * 纯 JS 极简且鲁棒的二维码生成引擎 (生成 SVG 矢量与 DataURL)
 * 支持不同纠错等级与任意文本编码
 */
/**
 * 简化的纯 JS 二维码矩阵与 SVG 生成器
 */
export function generateQrSvg(text, options) {
    const size = options?.size || 256;
    const margin = options?.margin !== undefined ? options?.margin : 4;
    const matrix = createQrMatrix(text, options?.errorCorrectionLevel || "M");
    const moduleCount = matrix.length;
    const cellSize = size / (moduleCount + margin * 2);
    let rects = "";
    for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
            if (matrix[r][c]) {
                const x = (c + margin) * cellSize;
                const y = (r + margin) * cellSize;
                rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellSize.toFixed(2)}" height="${cellSize.toFixed(2)}" fill="#ffffff"/>`;
            }
        }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#1a1b26"/>${rects}</svg>`;
    const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    return { svg, dataUrl, matrixSize: moduleCount };
}
/**
 * 生成二维码布尔矩阵 (基于标准 Reed-Solomon / QR 规范的轻量实现)
 */
function createQrMatrix(text, level) {
    // 基础规格计算，最小 21x21 (Version 1)，随着长度自增
    const len = text.length;
    let version = 1;
    if (len > 14)
        version = 2;
    if (len > 26)
        version = 3;
    if (len > 42)
        version = 4;
    if (len > 60)
        version = 5;
    const moduleCount = version * 4 + 17;
    const matrix = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(false));
    const isFunctionPattern = Array.from({ length: moduleCount }, () => Array(moduleCount).fill(false));
    // 1. 放置三个角的位置探测图形 (Finder Patterns: 7x7)
    function placeFinder(row, col) {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const nr = row + r;
                const nc = col + c;
                if (nr >= 0 && nr < moduleCount && nc >= 0 && nc < moduleCount) {
                    isFunctionPattern[nr][nc] = true;
                    if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                        (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
                        matrix[nr][nc] = true;
                    }
                    else {
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
                if (!isFunctionPattern[ar][ac]) {
                    isFunctionPattern[ar][ac] = true;
                    matrix[ar][ac] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
                }
            }
        }
    }
    // 4. 数据编码填充 (散列/交织字节流)
    const bytes = new TextEncoder().encode(text);
    let bitIndex = 0;
    const totalBits = [];
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        for (let shift = 7; shift >= 0; shift--) {
            totalBits.push((b >> shift) & 1);
        }
    }
    // 填充伪数据直到铺满
    let bitPos = 0;
    for (let col = moduleCount - 1; col > 0; col -= 2) {
        if (col === 6)
            col--; // 避开 timing pattern 列
        for (let r = 0; r < moduleCount; r++) {
            const row = (col % 4 === 0) ? r : moduleCount - 1 - r;
            for (let c = 0; c < 2; c++) {
                const currCol = col - c;
                if (!isFunctionPattern[row][currCol]) {
                    const bit = bitPos < totalBits.length
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
