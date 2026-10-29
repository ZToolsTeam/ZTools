/**
 * 文本行级差异对比（线性空间 Myers O(ND) 算法）
 *
 * 纯函数，无宿主依赖：输入两段文本，输出逐行差异、按上下文合并的差异块与统一格式（unified diff）报告。
 */
/** 单侧最多比较的行数 */
export const MAX_DIFF_LINES = 20000;
/**
 * 单次对比允许的最大搜索步数（约 100ms）。超过后剩余部分改用「两侧都只出现一次的行」做锚点的近似对比，
 * 结果仍然正确（打补丁可还原），只是不保证改动行数最少
 */
export const MAX_DIFF_COST = 10_000_000;
/** 近似对比的最大递归层数，防止病态输入导致栈溢出 */
const MAX_ANCHOR_DEPTH = 64;
export function splitLines(text) {
    if (!text)
        return [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    // 末尾换行不算作额外的一行
    if (lines.length > 0 && lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}
function normalize(line, options) {
    let s = line;
    if (options.ignoreWhitespace)
        s = s.replace(/\s+/g, " ").trim();
    if (options.ignoreCase)
        s = s.toLowerCase();
    return s;
}
/**
 * 线性空间的 Myers 差异（中间蛇分治）
 *
 * - 行先映射成整数编号，比较只做整数比较；
 * - 只在一侧出现的行不可能配对，先剔除再求最长公共子序列（结果仍是最少差异，完全不同的两个文件直接得出结果）；
 * - 每层递归只分配 O(N+M) 的两条前沿数组，内存与差异大小无关；
 * - 总搜索步数超过 maxCost 时，剩余子段改用唯一行锚点（patience）近似对比，并标记 approximate。
 *
 * 返回 matchA：matchA[i] 为左侧第 i 行配对到的右侧行号（从 0 开始），未配对为 -1。
 */
function lcsMatch(a, b, maxCost) {
    const ids = new Map();
    const toId = (s) => {
        let id = ids.get(s);
        if (id === undefined) {
            id = ids.size;
            ids.set(s, id);
        }
        return id;
    };
    const ia = a.map(toId);
    const ib = b.map(toId);
    const inA = new Uint8Array(ids.size);
    const inB = new Uint8Array(ids.size);
    for (const id of ia)
        inA[id] = 1;
    for (const id of ib)
        inB[id] = 1;
    // 剔除只在一侧出现的行，记录剩余行在原文中的位置
    const posA = [];
    const posB = [];
    for (let i = 0; i < ia.length; i++)
        if (inB[ia[i]])
            posA.push(i);
    for (let j = 0; j < ib.length; j++)
        if (inA[ib[j]])
            posB.push(j);
    const A = Int32Array.from(posA, (i) => ia[i]);
    const B = Int32Array.from(posB, (j) => ib[j]);
    const matchA = new Int32Array(a.length).fill(-1);
    let cost = 0;
    let approximate = false;
    const match = (x, y) => { matchA[posA[x]] = posB[y]; };
    /** 在 A[aLo,aHi) 与 B[bLo,bHi) 上求中间蛇，返回分割点；超出预算返回 null */
    const bisect = (aLo, aHi, bLo, bHi) => {
        const n = aHi - aLo;
        const m = bHi - bLo;
        const maxD = Math.ceil((n + m) / 2);
        const vOffset = maxD;
        const vLength = 2 * maxD + 2;
        cost += vLength;
        const v1 = new Int32Array(vLength).fill(-1);
        const v2 = new Int32Array(vLength).fill(-1);
        v1[vOffset + 1] = 0;
        v2[vOffset + 1] = 0;
        const delta = n - m;
        const front = (delta & 1) !== 0;
        let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
        for (let d = 0; d < maxD; d++) {
            cost += 2 * d + 2;
            if (cost > maxCost)
                return null;
            for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
                const k1Offset = vOffset + k1;
                let x1 = k1 === -d || (k1 !== d && v1[k1Offset - 1] < v1[k1Offset + 1]) ? v1[k1Offset + 1] : v1[k1Offset - 1] + 1;
                let y1 = x1 - k1;
                const s1 = x1;
                while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
                    x1++;
                    y1++;
                }
                cost += x1 - s1;
                v1[k1Offset] = x1;
                if (x1 > n)
                    k1end += 2;
                else if (y1 > m)
                    k1start += 2;
                else if (front) {
                    const k2Offset = vOffset + delta - k1;
                    if (k2Offset >= 0 && k2Offset < vLength && v2[k2Offset] !== -1 && x1 >= n - v2[k2Offset])
                        return [aLo + x1, bLo + y1];
                }
            }
            for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
                const k2Offset = vOffset + k2;
                let x2 = k2 === -d || (k2 !== d && v2[k2Offset - 1] < v2[k2Offset + 1]) ? v2[k2Offset + 1] : v2[k2Offset - 1] + 1;
                let y2 = x2 - k2;
                const s2 = x2;
                while (x2 < n && y2 < m && A[aHi - x2 - 1] === B[bHi - y2 - 1]) {
                    x2++;
                    y2++;
                }
                cost += x2 - s2;
                v2[k2Offset] = x2;
                if (x2 > n)
                    k2end += 2;
                else if (y2 > m)
                    k2start += 2;
                else if (!front) {
                    const k1Offset = vOffset + delta - k2;
                    if (k1Offset >= 0 && k1Offset < vLength && v1[k1Offset] !== -1) {
                        const x1 = v1[k1Offset];
                        const y1 = vOffset + x1 - k1Offset;
                        if (x1 >= n - x2)
                            return [aLo + x1, bLo + y1];
                    }
                }
            }
        }
        // 没有任何公共行
        return [aHi, bLo];
    };
    /** 近似对比：以两侧都只出现一次的行为锚点，取最长递增链配对，锚点之间递归处理 */
    const anchor = (aLo, aHi, bLo, bHi, depth) => {
        while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
            match(aLo, bLo);
            aLo++;
            bLo++;
        }
        while (aLo < aHi && bLo < bHi && A[aHi - 1] === B[bHi - 1]) {
            aHi--;
            bHi--;
            match(aHi, bHi);
        }
        if (aLo === aHi || bLo === bHi || depth > MAX_ANCHOR_DEPTH)
            return;
        const countA = new Map();
        const countB = new Map();
        const lastB = new Map();
        for (let i = aLo; i < aHi; i++)
            countA.set(A[i], (countA.get(A[i]) || 0) + 1);
        for (let j = bLo; j < bHi; j++) {
            countB.set(B[j], (countB.get(B[j]) || 0) + 1);
            lastB.set(B[j], j);
        }
        const pairs = [];
        for (let i = aLo; i < aHi; i++)
            if (countA.get(A[i]) === 1 && countB.get(A[i]) === 1)
                pairs.push([i, lastB.get(A[i])]);
        if (pairs.length === 0)
            return;
        // 按右侧位置求最长递增子序列（耐心排序，O(k log k)）
        const tails = [];
        const prev = new Int32Array(pairs.length).fill(-1);
        for (let p = 0; p < pairs.length; p++) {
            let lo = 0, hi = tails.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (pairs[tails[mid]][1] < pairs[p][1])
                    lo = mid + 1;
                else
                    hi = mid;
            }
            if (lo > 0)
                prev[p] = tails[lo - 1];
            tails[lo] = p;
        }
        const chain = [];
        for (let p = tails[tails.length - 1]; p >= 0; p = prev[p])
            chain.push(p);
        chain.reverse();
        let x = aLo, y = bLo;
        for (const p of chain) {
            const [i, j] = pairs[p];
            anchor(x, i, y, j, depth + 1);
            match(i, j);
            x = i + 1;
            y = j + 1;
        }
        anchor(x, aHi, y, bHi, depth + 1);
    };
    const compare = (aLo, aHi, bLo, bHi) => {
        while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
            match(aLo, bLo);
            aLo++;
            bLo++;
        }
        while (aLo < aHi && bLo < bHi && A[aHi - 1] === B[bHi - 1]) {
            aHi--;
            bHi--;
            match(aHi, bHi);
        }
        if (aLo === aHi || bLo === bHi)
            return;
        // 之前的中间蛇搜索成功但已用完预算：剩余子段只能近似对比，必须如实标记（不能只在搜索失败时标记）
        if (cost > maxCost) {
            approximate = true;
            anchor(aLo, aHi, bLo, bHi, 0);
            return;
        }
        const split = bisect(aLo, aHi, bLo, bHi);
        if (!split) {
            approximate = true;
            anchor(aLo, aHi, bLo, bHi, 0);
            return;
        }
        const [x, y] = split;
        if ((x === aLo && y === bLo) || (x === aHi && y === bHi))
            return; // 无公共行，整段删除 + 新增
        compare(aLo, x, bLo, y);
        compare(x, aHi, y, bHi);
    };
    compare(0, A.length, 0, B.length);
    return { matchA, approximate };
}
export function diffText(left, right, options = {}) {
    const a = splitLines(left);
    const b = splitLines(right);
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
        throw new Error(`文本超过 ${MAX_DIFF_LINES} 行，暂不支持对比`);
    }
    const na = a.map((l) => normalize(l, options));
    const nb = b.map((l) => normalize(l, options));
    const { matchA, approximate } = lcsMatch(na, nb, options.maxCost ?? MAX_DIFF_COST);
    const lines = [];
    let j = 0;
    let added = 0;
    let removed = 0;
    // 两个配对行之间：先列出左侧删除的行，再列出右侧新增的行
    for (let i = 0; i <= a.length; i++) {
        const target = i < a.length ? matchA[i] : b.length;
        if (i < a.length && target < 0) {
            lines.push({ op: "remove", text: a[i], leftNo: i + 1 });
            removed++;
            continue;
        }
        while (j < target) {
            lines.push({ op: "add", text: b[j], rightNo: j + 1 });
            j++;
            added++;
        }
        if (i < a.length) {
            lines.push({ op: "equal", text: b[j], leftNo: i + 1, rightNo: j + 1 });
            j++;
        }
    }
    const context = options.context ?? 3;
    const hunks = [];
    let idx = 0;
    while (idx < lines.length) {
        if (lines[idx].op === "equal") {
            idx++;
            continue;
        }
        const start = Math.max(0, idx - context);
        let end = idx;
        // 向后扩展：两个改动之间相隔不超过 2*context 行时合并为一个差异块
        while (end < lines.length) {
            if (lines[end].op !== "equal") {
                end++;
                continue;
            }
            let run = 0;
            while (end + run < lines.length && lines[end + run].op === "equal")
                run++;
            if (end + run >= lines.length || run > context * 2) {
                end = Math.min(lines.length, end + context);
                break;
            }
            end += run;
        }
        const slice = lines.slice(start, end);
        const firstLeft = slice.find((l) => l.leftNo !== undefined)?.leftNo;
        const firstRight = slice.find((l) => l.rightNo !== undefined)?.rightNo;
        const leftCount = slice.filter((l) => l.op !== "add").length;
        const rightCount = slice.filter((l) => l.op !== "remove").length;
        hunks.push({
            leftStart: firstLeft ?? (slice.find((l) => l.rightNo !== undefined)?.rightNo ?? 1) - 1,
            leftCount,
            rightStart: firstRight ?? (firstLeft ?? 1) - 1,
            rightCount,
            lines: slice,
            added: slice.filter((l) => l.op === "add").length,
            removed: slice.filter((l) => l.op === "remove").length
        });
        idx = end;
    }
    return { identical: added === 0 && removed === 0, approximate, added, removed, leftLines: a.length, rightLines: b.length, hunks, lines };
}
function hunkHeader(h) {
    return `@@ -${h.leftStart},${h.leftCount} +${h.rightStart},${h.rightCount} @@`;
}
export function formatHunk(h) {
    const body = h.lines.map((l) => (l.op === "add" ? "+" : l.op === "remove" ? "-" : " ") + l.text).join("\n");
    return `${hunkHeader(h)}\n${body}`;
}
/**
 * 把一段差异包成 Markdown 围栏代码块：围栏比内容里最长的连续反引号多一个（至少 3 个），
 * 对比的内容本身含 ``` 时（如 Markdown 文件）代码块也不会被提前截断
 */
export function fencedDiffMarkdown(text) {
    let longest = 0;
    for (const run of text.match(/`+/g) || [])
        longest = Math.max(longest, run.length);
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}diff\n${text}\n${fence}`;
}
/** 右侧预览单处差异最多显示的行数：整篇改写时一处差异可达数万行，全部渲染会拖慢界面；完整内容用复制动作取得 */
export const MAX_PREVIEW_LINES = 500;
export function hunkPreviewMarkdown(h) {
    if (h.lines.length <= MAX_PREVIEW_LINES)
        return fencedDiffMarkdown(formatHunk(h));
    const shown = { ...h, lines: h.lines.slice(0, MAX_PREVIEW_LINES) };
    const body = formatHunk(shown).split("\n").slice(1).join("\n");
    return `${fencedDiffMarkdown(`${hunkHeader(h)}\n${body}`)}\n\n这一处共 ${h.lines.length} 行，预览只显示前 ${MAX_PREVIEW_LINES} 行；完整内容请复制这一处差异或差异报告。`;
}
/** 统一格式（unified diff）报告，可直接粘贴到代码评审或 git apply */
export function formatUnifiedDiff(result, leftName = "左侧", rightName = "右侧") {
    if (result.identical)
        return "";
    return [`--- ${leftName}`, `+++ ${rightName}`, ...result.hunks.map(formatHunk)].join("\n");
}
export function describeHunk(h) {
    const parts = [];
    if (h.removed)
        parts.push(`删除 ${h.removed} 行`);
    if (h.added)
        parts.push(`新增 ${h.added} 行`);
    return parts.join("，");
}
