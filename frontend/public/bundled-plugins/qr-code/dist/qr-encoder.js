/**
 * 标准二维码编码器（ISO/IEC 18004，字节模式，版本 1–40，纠错等级 L/M/Q/H）
 *
 * 算法结构参照 Project Nayuki 的 QR Code generator（MIT 许可）：
 * 选最小可用版本 → 拼数据位流 → 按块计算 Reed-Solomon 纠错码并交织 → 放置功能图形与数据 →
 * 8 种掩码逐一评分取最优 → 写入格式信息与版本信息。
 */
const ECC_ORDINAL = { L: 0, M: 1, Q: 2, H: 3 };
/** 格式信息里的纠错等级编码（与序号不同） */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
// 每块纠错码字数 [纠错等级][版本]，下标 0 不用
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
// 纠错块数 [纠错等级][版本]
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];
/** 版本 v 中可放数据的总模块数（含纠错，不含功能图形） */
function getNumRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7)
            result -= 36;
    }
    return result;
}
function getNumDataCodewords(ver, ecl) {
    const o = ECC_ORDINAL[ecl];
    return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[o][ver] * NUM_ERROR_CORRECTION_BLOCKS[o][ver];
}
// ---------- GF(256) Reed-Solomon ----------
function rsMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}
function rsComputeDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = rsMultiply(result[j], root);
            if (j + 1 < result.length)
                result[j] ^= result[j + 1];
        }
        root = rsMultiply(root, 0x02);
    }
    return result;
}
function rsComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= rsMultiply(coef, factor); });
    }
    return result;
}
function getAlignmentPatternPositions(ver, size) {
    if (ver === 1)
        return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step)
        result.splice(1, 0, pos);
    return result;
}
/**
 * 把 UTF-8 文本编码为二维码矩阵。内容超过版本 40 的容量时抛错。
 */
export function encodeQr(text, ecl = "M") {
    const data = Array.from(new TextEncoder().encode(text));
    // 1. 选最小可容纳的版本（字节模式：4 位模式指示 + 8/16 位长度）
    let version = 1;
    let dataCapacityBits = 0;
    for (;; version++) {
        if (version > 40)
            throw new Error(`内容太长（${data.length} 字节），超出二维码最大容量`);
        dataCapacityBits = getNumDataCodewords(version, ecl) * 8;
        const ccBits = version < 10 ? 8 : 16;
        if (4 + ccBits + data.length * 8 <= dataCapacityBits)
            break;
    }
    // 2. 数据位流：模式 0100 + 长度 + 数据 + 终止符 + 字节对齐 + 交替填充
    const bits = [];
    const append = (val, len) => { for (let i = len - 1; i >= 0; i--)
        bits.push((val >>> i) & 1); };
    append(0b0100, 4);
    append(data.length, version < 10 ? 8 : 16);
    for (const b of data)
        append(b, 8);
    append(0, Math.min(4, dataCapacityBits - bits.length));
    append(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < dataCapacityBits; pad ^= 0xec ^ 0x11)
        append(pad, 8);
    const dataCodewords = new Array(bits.length / 8).fill(0);
    bits.forEach((b, i) => { dataCodewords[i >>> 3] |= b << (7 - (i & 7)); });
    // 3. 分块计算纠错码并交织
    const o = ECC_ORDINAL[ecl];
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][version];
    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks = [];
    const divisor = rsComputeDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = rsComputeRemainder(dat, divisor);
        if (i < numShortBlocks)
            dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const allCodewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks)
                allCodewords.push(block[i]);
        });
    }
    // 4. 放置功能图形
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
    for (let i = 0; i < size; i++) {
        setFunction(6, i, i % 2 === 0);
        setFunction(i, 6, i % 2 === 0);
    }
    const drawFinder = (x, y) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && xx < size && yy >= 0 && yy < size)
                    setFunction(xx, yy, dist !== 2 && dist !== 4);
            }
        }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);
    const alignPos = getAlignmentPatternPositions(version, size);
    const numAlign = alignPos.length;
    for (let i = 0; i < numAlign; i++) {
        for (let j = 0; j < numAlign; j++) {
            if ((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))
                continue;
            for (let dy = -2; dy <= 2; dy++)
                for (let dx = -2; dx <= 2; dx++)
                    setFunction(alignPos[i] + dx, alignPos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }
    const drawFormatBits = (mask) => {
        const fdata = (ECC_FORMAT_BITS[ecl] << 3) | mask;
        let rem = fdata;
        for (let i = 0; i < 10; i++)
            rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const fbits = ((fdata << 10) | rem) ^ 0x5412;
        const bit = (i) => ((fbits >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++)
            setFunction(8, i, bit(i));
        setFunction(8, 7, bit(6));
        setFunction(8, 8, bit(7));
        setFunction(7, 8, bit(8));
        for (let i = 9; i < 15; i++)
            setFunction(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++)
            setFunction(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++)
            setFunction(8, size - 15 + i, bit(i));
        setFunction(8, size - 8, true);
    };
    drawFormatBits(0); // 先占位，标记为功能区
    if (version >= 7) {
        let rem = version;
        for (let i = 0; i < 12; i++)
            rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const vbits = (version << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((vbits >>> i) & 1) !== 0;
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            setFunction(a, b, dark);
            setFunction(b, a, dark);
        }
    }
    // 5. 之字形放置数据位
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6)
            right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && bi < allCodewords.length * 8) {
                    modules[y][x] = ((allCodewords[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
                    bi++;
                }
            }
        }
    }
    // 6. 选择罚分最低的掩码
    const applyMask = (mask) => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let invert;
                switch (mask) {
                    case 0:
                        invert = (x + y) % 2 === 0;
                        break;
                    case 1:
                        invert = y % 2 === 0;
                        break;
                    case 2:
                        invert = x % 3 === 0;
                        break;
                    case 3:
                        invert = (x + y) % 3 === 0;
                        break;
                    case 4:
                        invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
                        break;
                    case 5:
                        invert = ((x * y) % 2) + ((x * y) % 3) === 0;
                        break;
                    case 6:
                        invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                    default:
                        invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
                        break;
                }
                if (!isFunction[y][x] && invert)
                    modules[y][x] = !modules[y][x];
            }
        }
    };
    let bestMask = 0;
    let minPenalty = Infinity;
    for (let m = 0; m < 8; m++) {
        applyMask(m);
        drawFormatBits(m);
        const p = penaltyScore(modules, size);
        if (p < minPenalty) {
            bestMask = m;
            minPenalty = p;
        }
        applyMask(m); // 异或两次复原
    }
    applyMask(bestMask);
    drawFormatBits(bestMask);
    return { version, size, ecc: ecl, mask: bestMask, modules };
}
function penaltyScore(modules, size) {
    const N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    let result = 0;
    const finderPenaltyCountPatterns = (runHistory) => {
        const n = runHistory[1];
        const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
        return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
    };
    const finderPenaltyAddHistory = (currentRunLength, runHistory) => {
        if (runHistory[0] === 0)
            currentRunLength += size;
        runHistory.pop();
        runHistory.unshift(currentRunLength);
    };
    const finderPenaltyTerminateAndCount = (currentRunColor, currentRunLength, runHistory) => {
        if (currentRunColor) {
            finderPenaltyAddHistory(currentRunLength, runHistory);
            currentRunLength = 0;
        }
        currentRunLength += size;
        finderPenaltyAddHistory(currentRunLength, runHistory);
        return finderPenaltyCountPatterns(runHistory);
    };
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            let runColor = false;
            let run = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let b = 0; b < size; b++) {
                const color = pass === 0 ? modules[a][b] : modules[b][a];
                if (color === runColor) {
                    run++;
                    if (run === 5)
                        result += N1;
                    else if (run > 5)
                        result++;
                }
                else {
                    finderPenaltyAddHistory(run, runHistory);
                    if (!runColor)
                        result += finderPenaltyCountPatterns(runHistory) * N3;
                    runColor = color;
                    run = 1;
                }
            }
            result += finderPenaltyTerminateAndCount(runColor, run, runHistory) * N3;
        }
    }
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = modules[y][x];
            if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1])
                result += N2;
        }
    }
    let dark = 0;
    for (const row of modules)
        for (const c of row)
            if (c)
                dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * N4;
    return result;
}
