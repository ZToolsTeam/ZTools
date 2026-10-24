/**
 * JSON 格式化、校验与 TypeScript / Rust / Go 类型推导
 *
 * 校验用 JSON.parse 判定合法性；错误定位、类型推导、JSONPath 与统计都基于自带的无损解析器（parseJsonAst），
 * 数字保留原文写法，因此超过 2^53 的长整数、1.0 这类小数写法不会在推导和展示中丢失。
 */
export class JsonSyntaxError extends Error {
    offset;
    constructor(message, offset) {
        super(message);
        this.offset = offset;
        this.name = "JsonSyntaxError";
    }
}
/* ------------------------------------------------------------------ */
/* 无损解析器                                                          */
/* ------------------------------------------------------------------ */
const NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
/** 解析 JSON 文本为语法树；语法错误抛出带偏移量的 JsonSyntaxError */
export function parseJsonAst(text) {
    let i = 0;
    const n = text.length;
    const fail = (message, at = i) => {
        throw new JsonSyntaxError(message, at);
    };
    const describe = (at) => {
        if (at >= n)
            return "输入结尾";
        const ch = String.fromCodePoint(text.codePointAt(at));
        if (ch === "﻿")
            return "不可见的 BOM 字符";
        if (/[\s\p{Cc}\p{Cf}]/u.test(ch))
            return `不可见字符 U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
        return `'${ch}'`;
    };
    /** 从 at 开始匹配（re 必须以 ^ 开头） */
    const matchAt = (re, at) => text.slice(at).match(re)?.[0];
    const wordAt = (at) => {
        const w = matchAt(/^[A-Za-z0-9_$]+/, at) || text[at] || "";
        return w.length > 20 ? w.slice(0, 20) + "..." : w;
    };
    const skipWs = () => {
        while (i < n) {
            const c = text.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13)
                i++;
            else
                break;
        }
    };
    const parseString = () => {
        const quote = i;
        i++;
        let out = "";
        let start = i;
        for (;;) {
            if (i >= n)
                fail("字符串缺少结束的双引号", quote);
            const c = text.charCodeAt(i);
            if (c === 34) {
                out += text.slice(start, i);
                i++;
                return out;
            }
            if (c === 92) {
                out += text.slice(start, i);
                const e = text[i + 1];
                if (e === undefined)
                    fail("字符串缺少结束的双引号", quote);
                const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
                if (e in simple) {
                    out += simple[e];
                    i += 2;
                }
                else if (e === "u") {
                    const hex = text.slice(i + 2, i + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex))
                        fail("无效的 \\u 转义，需要 4 位十六进制数字");
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                }
                else {
                    fail(`无效的转义序列 '\\${e}'`);
                }
                start = i;
                continue;
            }
            if (c < 0x20)
                fail(c === 10 || c === 13 ? "字符串中不能直接换行，请写成 \\n" : "字符串中包含未转义的控制字符");
            i++;
        }
    };
    const parseNumber = () => {
        const raw = matchAt(NUMBER_RE, i);
        const next = raw ? text[i + raw.length] : undefined;
        if (!raw || (next !== undefined && /[0-9.eE+\-]/.test(next))) {
            fail(`数字格式不合法 '${matchAt(/^[-+0-9.eE]+/, i) ?? text[i]}'`);
        }
        i += raw.length;
        return { kind: "number", raw: raw };
    };
    const parseValue = () => {
        skipWs();
        if (i >= n)
            fail("JSON 意外结束，此处缺少值");
        const c = text[i];
        if (c === "{")
            return parseObject();
        if (c === "[")
            return parseArray();
        if (c === '"')
            return { kind: "string", value: parseString() };
        if (c === "-" || (c >= "0" && c <= "9"))
            return parseNumber();
        if (c === "'")
            fail("字符串必须使用双引号，不能使用单引号");
        if (/[A-Za-z_$]/.test(c)) {
            const w = wordAt(i);
            if (w === "true" || w === "false") {
                i += w.length;
                return { kind: "boolean", value: w === "true" };
            }
            if (w === "null") {
                i += 4;
                return { kind: "null" };
            }
            fail(`无法识别的值 '${w}'（字符串需要用双引号包裹，字面量只能是 true / false / null）`);
        }
        return fail(`此处应为值，却遇到 ${describe(i)}`);
    };
    const parseObject = () => {
        i++;
        const entries = [];
        skipWs();
        if (text[i] === "}") {
            i++;
            return { kind: "object", entries };
        }
        for (;;) {
            skipWs();
            const c = text[i];
            if (c !== '"') {
                if (i >= n)
                    fail("JSON 意外结束，对象缺少 '}'");
                if (c === "}" && entries.length > 0)
                    fail("对象末尾多了一个逗号");
                if (c === "'")
                    fail("键名必须使用双引号，不能使用单引号");
                if (/[A-Za-z_$]/.test(c))
                    fail(`键名 '${wordAt(i)}' 必须用双引号包裹`);
                fail(`此处应为用双引号包裹的键名，却遇到 ${describe(i)}`);
            }
            const key = parseString();
            skipWs();
            if (text[i] !== ":")
                fail(i >= n ? "JSON 意外结束，键名后缺少 ':'" : `键名后应为 ':'，却遇到 ${describe(i)}`);
            i++;
            entries.push([key, parseValue()]);
            skipWs();
            if (text[i] === ",") {
                i++;
                continue;
            }
            if (text[i] === "}") {
                i++;
                return { kind: "object", entries };
            }
            fail(i >= n ? "JSON 意外结束，对象缺少 '}'" : `此处应为 ',' 或 '}'，却遇到 ${describe(i)}`);
        }
    };
    const parseArray = () => {
        i++;
        const items = [];
        skipWs();
        if (text[i] === "]") {
            i++;
            return { kind: "array", items };
        }
        for (;;) {
            skipWs();
            if (text[i] === "]" && items.length > 0)
                fail("数组末尾多了一个逗号");
            items.push(parseValue());
            skipWs();
            if (text[i] === ",") {
                i++;
                continue;
            }
            if (text[i] === "]") {
                i++;
                return { kind: "array", items };
            }
            fail(i >= n ? "JSON 意外结束，数组缺少 ']'" : `此处应为 ',' 或 ']'，却遇到 ${describe(i)}`);
        }
    };
    skipWs();
    if (i >= n)
        fail("内容为空");
    const root = parseValue();
    skipWs();
    if (i < n)
        fail(`JSON 已经结束，后面还有多余内容 ${describe(i)}`);
    return root;
}
/** 单条缓存：同一段文本在一次渲染里会被多处使用，只解析一次 */
let astCache = null;
function astOfText(raw) {
    if (astCache && astCache.raw === raw)
        return astCache.ast;
    const ast = parseJsonAst(raw);
    astCache = { raw, ast };
    return ast;
}
/** 已解析的 JS 值转语法树（兼容旧调用方传对象） */
function valueToAst(v) {
    if (v === null || v === undefined)
        return { kind: "null" };
    if (typeof v === "boolean")
        return { kind: "boolean", value: v };
    if (typeof v === "number")
        return Number.isFinite(v) ? { kind: "number", raw: String(v) } : { kind: "null" };
    if (typeof v === "bigint")
        return { kind: "number", raw: v.toString() };
    if (typeof v === "string")
        return { kind: "string", value: v };
    if (Array.isArray(v))
        return { kind: "array", items: v.map(valueToAst) };
    if (typeof v === "object") {
        return {
            kind: "object",
            entries: Object.entries(v)
                .filter(([, x]) => x !== undefined && typeof x !== "function")
                .map(([k, x]) => [k, valueToAst(x)])
        };
    }
    return { kind: "null" };
}
function toAst(input) {
    return typeof input === "string" ? astOfText(input) : valueToAst(input);
}
/** 对象的有效键值对：重复键取最后一个值、保留首次出现的位置（与 JSON.parse 一致） */
function entriesOf(node) {
    const map = new Map();
    for (const [k, v] of node.entries)
        map.set(k, v);
    return [...map.entries()];
}
/* ------------------------------------------------------------------ */
/* 校验与错误定位                                                      */
/* ------------------------------------------------------------------ */
function buildErrorInfo(raw, offset, message) {
    const safeOffset = Math.max(0, Math.min(raw.length, offset));
    const beforeLines = raw.slice(0, safeOffset).split(/\r?\n/);
    const line = beforeLines.length;
    const column = beforeLines[beforeLines.length - 1].length + 1;
    const lines = raw.split(/\r?\n/);
    const snippetLines = [];
    for (let l = Math.max(1, line - 1); l <= Math.min(lines.length, line + 1); l++) {
        snippetLines.push(`${l === line ? "> " : "  "}${String(l).padStart(4, " ")} | ${lines[l - 1] ?? ""}`);
        if (l === line)
            snippetLines.push(`${" ".repeat(9 + column - 1)}^`);
    }
    return { line, column, offset: safeOffset, snippet: snippetLines.join("\n"), message };
}
/**
 * 校验 JSON 语法并返回行号/列号定位与统计指标
 */
export function validateJson(raw) {
    if (!raw || !raw.trim()) {
        return {
            valid: false,
            error: "内容为空",
            errorInfo: buildErrorInfo("", 0, "内容为空")
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        let offset = 0;
        let message = err instanceof Error ? err.message : "JSON 语法错误";
        try {
            astOfText(raw);
        }
        catch (e) {
            if (e instanceof JsonSyntaxError) {
                offset = e.offset;
                message = e.message;
            }
            else {
                // 嵌套过深等解析器自身失败：退回 V8 报错里的位置
                const pos = message.match(/position (\d+)/i);
                if (pos)
                    offset = Number(pos[1]);
            }
        }
        const errorInfo = buildErrorInfo(raw, offset, message);
        return { valid: false, error: `第 ${errorInfo.line} 行第 ${errorInfo.column} 列：${message}`, errorInfo };
    }
    let ast;
    try {
        ast = astOfText(raw);
    }
    catch {
        ast = undefined; // 嵌套过深：统计只给体积
    }
    return { valid: true, parsed, stats: calculateStats(raw, ast) };
}
/* ------------------------------------------------------------------ */
/* 格式化与压缩                                                        */
/* ------------------------------------------------------------------ */
/**
 * 按原文逐个记号重排缩进：数字、字符串照抄原文，不经过 JSON.parse/stringify，
 * 因此超过 2^53 的长整数（订单号、雪花 ID）、1.0 这类写法、转义序列和重复键都原样保留。
 * 调用前必须先确认 raw 是合法 JSON。
 */
function reformatJsonText(raw, indentUnit) {
    let out = "";
    let depth = 0;
    let i = 0;
    const n = raw.length;
    const newline = () => (indentUnit === null ? "" : "\n" + indentUnit.repeat(depth));
    while (i < n) {
        const ch = raw[i];
        if (ch === '"') {
            let j = i + 1;
            while (j < n && raw[j] !== '"')
                j += raw[j] === "\\" ? 2 : 1;
            out += raw.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            i++;
            continue;
        }
        if (ch === "{" || ch === "[") {
            // 空对象 / 空数组保持紧凑
            let k = i + 1;
            while (k < n && /\s/.test(raw[k]))
                k++;
            if (raw[k] === (ch === "{" ? "}" : "]")) {
                out += ch + raw[k];
                i = k + 1;
                continue;
            }
            depth++;
            out += ch + newline();
            i++;
            continue;
        }
        if (ch === "}" || ch === "]") {
            depth--;
            out += newline() + ch;
            i++;
            continue;
        }
        if (ch === ",") {
            out += "," + newline();
            i++;
            continue;
        }
        if (ch === ":") {
            out += indentUnit === null ? ":" : ": ";
            i++;
            continue;
        }
        // 数字、true、false、null：原样照抄到下一个分隔符
        let j = i;
        while (j < n && !/[\s,\]}:]/.test(raw[j]))
            j++;
        out += raw.slice(i, j);
        i = j;
    }
    return out;
}
/**
 * JSON 格式化与美化 (支持 2 空格、4 空格、Tab 制表符)；非法 JSON 原样返回
 */
export function formatJson(raw, indent = 2) {
    const unit = indent === "tab" || indent === "\t" ? "\t" : " ".repeat(Number(indent) || 2);
    if (typeof raw !== "string")
        return JSON.stringify(raw, null, unit);
    try {
        JSON.parse(raw);
    }
    catch {
        return raw;
    }
    return reformatJsonText(raw, unit);
}
/**
 * 压缩 JSON 为单行；非法 JSON 原样返回
 */
export function minifyJson(raw) {
    if (typeof raw !== "string")
        return JSON.stringify(raw);
    try {
        JSON.parse(raw);
    }
    catch {
        return raw;
    }
    return reformatJsonText(raw, null);
}
/**
 * 统计 JSON 深度、键数量、体积与压缩指标；压缩体积取本插件真实的压缩结果
 */
function calculateStats(raw, ast) {
    let keyCount = 0;
    let maxDepth = 0;
    let arraysCount = 0;
    let objectsCount = 0;
    let primitivesCount = 0;
    const traverse = (node, depth) => {
        if (depth > maxDepth)
            maxDepth = depth;
        if (node.kind === "array") {
            arraysCount++;
            for (const item of node.items)
                traverse(item, depth + 1);
        }
        else if (node.kind === "object") {
            objectsCount++;
            const entries = entriesOf(node);
            keyCount += entries.length;
            for (const [, v] of entries)
                traverse(v, depth + 1);
        }
        else {
            primitivesCount++;
        }
    };
    if (ast) {
        try {
            traverse(ast, 1);
        }
        catch {
            // 嵌套过深：只统计体积
        }
    }
    const encoder = new TextEncoder();
    const byteSize = encoder.encode(raw).length;
    const minifiedSize = encoder.encode(minifyJson(raw)).length;
    const saved = byteSize > minifiedSize ? ((byteSize - minifiedSize) / byteSize) * 100 : 0;
    return {
        keys: keyCount,
        depth: maxDepth,
        byteSize,
        minifiedSize,
        compressionRatio: Number(saved.toFixed(1)),
        arraysCount,
        objectsCount,
        primitivesCount
    };
}
const NUM_RANK = { int: 0, uint: 1, float: 2, big: 3 };
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const U64_MAX = 2n ** 64n - 1n;
function numberKind(raw) {
    if (/[.eE]/.test(raw))
        return "float";
    const v = BigInt(raw);
    if (v >= I64_MIN && v <= I64_MAX)
        return "int";
    if (v > 0n && v <= U64_MAX)
        return "uint";
    return "big";
}
function isUnsafeInteger(raw) {
    if (/[.eE]/.test(raw))
        return false;
    const v = BigInt(raw);
    return v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER);
}
/**
 * 仅合并能由同一结构无损表示的样本；不兼容时返回空，由目标语言使用通用 JSON 类型。
 * null 与具体类型合并为可空；对象按字段并集合并，部分元素缺失的字段记为可选。
 */
function representative(items) {
    let nullable = false;
    const concrete = [];
    for (const item of items) {
        if (item.kind === "null")
            nullable = true;
        else if (item.kind === "nullable") {
            nullable = true;
            concrete.push(item.inner);
        }
        else
            concrete.push(item);
    }
    if (concrete.length === 0)
        return items.length ? { kind: "null" } : undefined;
    const merged = mergeConcrete(concrete);
    if (!merged)
        return undefined;
    return nullable ? { kind: "nullable", inner: merged } : merged;
}
function mergeConcrete(items) {
    const first = items[0];
    if (items.some(item => item.kind !== first.kind))
        return undefined;
    if (first.kind === "number") {
        const numbers = items.filter((item) => item.kind === "number");
        // 负整数和大于 i64 的正整数没有共同的 64 位整数类型。
        if (numbers.some(item => numberKind(item.raw) === "uint") && numbers.some(item => item.raw.startsWith("-")))
            return undefined;
        return numbers.reduce((best, item) => NUM_RANK[numberKind(item.raw)] > NUM_RANK[numberKind(best.raw)] ? item : best);
    }
    if (first.kind === "array") {
        const nested = items.flatMap(item => item.kind === "array" ? item.items : []);
        if (nested.length === 0)
            return first;
        const element = representative(nested);
        return element ? { kind: "array", items: [element] } : undefined;
    }
    if (first.kind === "object") {
        const objects = items.map(item => new Map(item.kind === "object" ? entriesOf(item) : []));
        // 字段顺序按首次出现的位置
        const keys = [...new Set(objects.flatMap(fields => [...fields.keys()]))];
        const merged = [];
        const optional = new Set();
        for (const key of keys) {
            const samples = objects.flatMap(fields => fields.has(key) ? [fields.get(key)] : []);
            if (samples.length < objects.length)
                optional.add(key);
            const sample = representative(samples);
            if (!sample)
                return undefined;
            merged.push([key, sample]);
        }
        return optional.size ? { kind: "object", entries: merged, optional } : { kind: "object", entries: merged };
    }
    return first;
}
/** 键名转 PascalCase：只保留 ASCII 字母数字片段；返回空串表示键名里没有可用字符 */
function pascalCase(key) {
    return key
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");
}
/** 由键名得到类型名：无可用字符时用 fallback，数字开头加 T 前缀 */
function typeNameOf(key, fallback = "Item") {
    const p = pascalCase(key);
    if (!p)
        return fallback;
    return /^\d/.test(p) ? "T" + p : p;
}
function singular(key) {
    if (/ies$/i.test(key) && key.length > 3)
        return key.slice(0, -3) + "y";
    if (/[^s]s$/i.test(key))
        return key.slice(0, -1);
    return key;
}
function uniqueName(base, used, join) {
    let name = base;
    for (let k = 2; used.has(name); k++)
        name = join(base, k);
    used.add(name);
    return name;
}
/**
 * 类型表：同名且结构完全相同才复用；同名不同结构时依次尝试「父类型名 + 名称」、「名称 + 序号」。
 * 子类型要先确定名字才能得到父类型的结构，所以定义是后序生成的；每个类型在开始推导时领一个序号，
 * 输出按序号排序，结果是根类型在前、其余按键在原文中出现的顺序排列。
 */
class TypeTable {
    bodies = new Map();
    defs = [];
    seq = 0;
    constructor(rootName) {
        this.bodies.set(rootName, null); // 根类型名预留
    }
    ticket() {
        return this.seq++;
    }
    claim(order, base, parentBase, body, render) {
        const take = (name) => {
            if (!this.bodies.has(name)) {
                this.bodies.set(name, body);
                this.defs.push({ order, text: render(name) });
                return name;
            }
            return this.bodies.get(name) === body ? name : null;
        };
        const first = take(base) ?? (parentBase && !base.startsWith(parentBase) ? take(parentBase + base) : null);
        if (first)
            return first;
        for (let k = 2;; k++) {
            const name = take(base + k);
            if (name)
                return name;
        }
    }
    root(order, name, body, render) {
        this.bodies.set(name, body);
        this.defs.push({ order, text: render(name) });
    }
    addRaw(order, text) {
        this.defs.push({ order, text });
    }
    output() {
        return [...this.defs].sort((a, b) => a.order - b.order).map((d) => d.text);
    }
}
/* ------------------------------------------------------------------ */
/* TypeScript                                                          */
/* ------------------------------------------------------------------ */
/**
 * 递归将 JSON 结构推导为 TypeScript Interface
 */
export function jsonToTsInterface(raw, rootName = "RootObject") {
    try {
        const root = toAst(raw);
        const table = new TypeTable(rootName);
        const tsObjectBody = (node, selfBase) => entriesOf(node)
            .map(([key, val]) => {
            const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
            const mark = node.optional?.has(key) ? "?" : "";
            const note = val.kind === "number" && isUnsafeInteger(val.raw) ? " // 超出 JS 安全整数范围，JSON.parse 会丢精度" : "";
            return `  ${safeKey}${mark}: ${tsType(val, key, selfBase)};${note}`;
        })
            .join("\n");
        const renderInterface = (body) => (name) => body ? `export interface ${name} {\n${body}\n}` : `export interface ${name} {}`;
        const tsType = (node, key, parentBase) => {
            switch (node.kind) {
                case "null":
                    return "null";
                case "nullable":
                    return `${tsType(node.inner, key, parentBase)} | null`;
                case "string":
                    return "string";
                case "boolean":
                    return "boolean";
                case "number":
                    return "number";
                case "array": {
                    if (node.items.length === 0)
                        return "any[]";
                    const elem = representative(node.items);
                    if (!elem) {
                        const types = [...new Set(node.items.map(item => tsType(item, singular(key) + "Item", parentBase)))];
                        return `(${types.join(" | ")})[]`;
                    }
                    const inner = elem.kind === "nullable" ? elem.inner : elem;
                    let t;
                    if (inner.kind === "object") {
                        const base = typeNameOf(singular(key), "") + "Item";
                        const order = table.ticket();
                        const body = tsObjectBody(inner, base);
                        t = table.claim(order, base, parentBase, body, renderInterface(body));
                    }
                    else {
                        t = tsType(inner, key, parentBase);
                    }
                    return elem.kind === "nullable" ? `(${t} | null)[]` : `${t}[]`;
                }
                case "object": {
                    const base = typeNameOf(key);
                    const order = table.ticket();
                    const body = tsObjectBody(node, base);
                    return table.claim(order, base, parentBase, body, renderInterface(body));
                }
            }
        };
        if (root.kind === "object") {
            const order = table.ticket();
            const body = tsObjectBody(root, rootName);
            table.root(order, rootName, body, renderInterface(body));
        }
        else {
            const order = table.ticket();
            const t = tsType(root, rootName, "");
            table.addRaw(order, `export type ${rootName} = ${t};`);
        }
        return table.output().join("\n\n");
    }
    catch (err) {
        return `// 无法生成 TypeScript Interface：${err instanceof Error ? err.message : "JSON 无效"}`;
    }
}
/* ------------------------------------------------------------------ */
/* Rust                                                                */
/* ------------------------------------------------------------------ */
const RUST_KEYWORDS = new Set([
    "as", "break", "const", "continue", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
    "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "trait", "true",
    "type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box", "do",
    "final", "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "gen"
]);
/** 不能写成 r#xxx 的关键字 */
const RUST_NO_RAW = new Set(["self", "super", "crate"]);
function rustStringLiteral(s) {
    return ('"' +
        s
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            .replace(/[\u0000-\u001f]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`) +
        '"');
}
function rustFieldName(key, used) {
    let s = key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
    if (!s)
        s = "field";
    if (/^\d/.test(s))
        s = "field_" + s;
    if (RUST_NO_RAW.has(s))
        s += "_";
    const name = uniqueName(s, used, (b, k) => `${b}_${k}`);
    return RUST_KEYWORDS.has(name) ? `r#${name}` : name;
}
/**
 * 递归将 JSON 结构推导为 Rust Struct (serde)
 */
export function jsonToRustStruct(raw, rootName = "RootObject") {
    try {
        const root = toAst(raw);
        const table = new TypeTable(rootName);
        const rustTypeName = (key, fallback = "Item") => {
            const n = typeNameOf(key, fallback);
            return n === "Self" ? "SelfObject" : n;
        };
        const structBody = (node, selfBase) => {
            const used = new Set();
            const lines = [];
            for (const [key, val] of entriesOf(node)) {
                const field = rustFieldName(key, used);
                if (field.replace(/^r#/, "") !== key)
                    lines.push(`    #[serde(rename = ${rustStringLiteral(key)})]`);
                let type = rustType(val, key, selfBase);
                if (type.includes("serde_json::Value") && hasBigNumber(val)) {
                    lines.push("    // 数值超出 64 位整数范围：需启用 serde_json 的 arbitrary_precision 特性才能保留原值");
                }
                if (node.optional?.has(key)) {
                    // 部分样本缺这个字段：缺失时反序列化为 None，序列化时省略
                    if (!type.startsWith("Option<"))
                        type = `Option<${type}>`;
                    lines.push(`    #[serde(default, skip_serializing_if = "Option::is_none")]`);
                }
                lines.push(`    pub ${field}: ${type},`);
            }
            return lines.join("\n");
        };
        const renderStruct = (body) => (name) => `#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]\npub struct ${name} {${body ? `\n${body}\n` : ""}}`;
        const rustType = (node, key, parentBase) => {
            switch (node.kind) {
                case "null":
                    return "Option<serde_json::Value>";
                case "nullable":
                    return `Option<${rustType(node.inner, key, parentBase)}>`;
                case "boolean":
                    return "bool";
                case "string":
                    return "String";
                case "number":
                    return { int: "i64", uint: "u64", float: "f64", big: "serde_json::Value" }[numberKind(node.raw)];
                case "array": {
                    if (node.items.length === 0)
                        return "Vec<serde_json::Value>";
                    const elem = representative(node.items);
                    if (!elem)
                        return "Vec<serde_json::Value>";
                    const inner = elem.kind === "nullable" ? elem.inner : elem;
                    let t;
                    if (inner.kind === "object") {
                        const base = rustTypeName(singular(key), "") + "Item";
                        const order = table.ticket();
                        const body = structBody(inner, base);
                        t = table.claim(order, base, parentBase, body, renderStruct(body));
                    }
                    else {
                        t = rustType(inner, key, parentBase);
                    }
                    return elem.kind === "nullable" ? `Vec<Option<${t}>>` : `Vec<${t}>`;
                }
                case "object": {
                    const base = rustTypeName(key);
                    const order = table.ticket();
                    const body = structBody(node, base);
                    return table.claim(order, base, parentBase, body, renderStruct(body));
                }
            }
        };
        if (root.kind === "object") {
            const order = table.ticket();
            const body = structBody(root, rootName);
            table.root(order, rootName, body, renderStruct(body));
        }
        else {
            const order = table.ticket();
            table.addRaw(order, `pub type ${rootName} = ${rustType(root, rootName, "")};`);
        }
        return "use serde::{Deserialize, Serialize};\n\n" + table.output().join("\n\n");
    }
    catch (err) {
        return `// 无法生成 Rust Struct：${err instanceof Error ? err.message : "JSON 无效"}`;
    }
}
function hasBigNumber(node) {
    if (node.kind === "number")
        return numberKind(node.raw) === "big";
    if (node.kind === "nullable")
        return hasBigNumber(node.inner);
    if (node.kind === "array")
        return node.items.some(hasBigNumber);
    return false;
}
/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */
/** Go struct tag 中 json 名允许的字符（与 encoding/json isValidTag 一致） */
function isValidGoTagName(key) {
    return key !== "" && [...key].every((c) => /[\p{L}\p{N}]/u.test(c) || "!#$%&()*+-./:;<=>?@[]^_{|}~ ".includes(c));
}
/**
 * 递归将 JSON 结构推导为 Go Struct
 */
export function jsonToGoStruct(raw, rootName = "RootObject") {
    try {
        const root = toAst(raw);
        const table = new TypeTable(rootName);
        let usesJsonNumber = false;
        let usesRawMessage = false;
        // 可空 / 可选用指针区分「null 或不存在」与零值；interface{}、json.RawMessage 本身就能表示 nil
        const goNilable = (t) => (t === "interface{}" || t === "json.RawMessage" || t.startsWith("*") ? t : `*${t}`);
        const structBody = (node, selfBase) => {
            const used = new Set();
            return entriesOf(node)
                .map(([key, val]) => {
                const p = pascalCase(key);
                const field = uniqueName(!p ? "Field" : /^\d/.test(p) ? "Field" + p : p, used, (b, k) => `${b}${k}`);
                const optional = node.optional?.has(key) ?? false;
                const type = optional ? goNilable(goType(val, key, selfBase)) : goType(val, key, selfBase);
                if (!isValidGoTagName(key)) {
                    return `\t${field}\t${type}\t// 原始键 ${JSON.stringify(key)} 含 struct tag 不支持的字符，需要自定义 UnmarshalJSON`;
                }
                const tagName = (key === "-" ? "-," : key) + (optional ? (key === "-" ? "omitempty" : ",omitempty") : "");
                return `\t${field}\t${type}\t\`json:"${tagName}"\``;
            })
                .join("\n");
        };
        const renderStruct = (body) => (name) => body ? `type ${name} struct {\n${body}\n}` : `type ${name} struct{}`;
        const goType = (node, key, parentBase) => {
            switch (node.kind) {
                case "null":
                    return "interface{}";
                case "nullable":
                    return goNilable(goType(node.inner, key, parentBase));
                case "boolean":
                    return "bool";
                case "string":
                    return "string";
                case "number": {
                    const kind = numberKind(node.raw);
                    if (kind === "big")
                        usesJsonNumber = true;
                    return { int: "int64", uint: "uint64", float: "float64", big: "json.Number" }[kind];
                }
                case "array": {
                    if (node.items.length === 0)
                        return "[]interface{}";
                    const elem = representative(node.items);
                    if (!elem) {
                        usesRawMessage = true;
                        return "[]json.RawMessage";
                    }
                    const inner = elem.kind === "nullable" ? elem.inner : elem;
                    let t;
                    if (inner.kind === "object") {
                        const base = typeNameOf(singular(key), "") + "Item";
                        const order = table.ticket();
                        const body = structBody(inner, base);
                        t = table.claim(order, base, parentBase, body, renderStruct(body));
                    }
                    else {
                        t = goType(inner, key, parentBase);
                    }
                    return `[]${elem.kind === "nullable" ? goNilable(t) : t}`;
                }
                case "object": {
                    const base = typeNameOf(key);
                    const order = table.ticket();
                    const body = structBody(node, base);
                    return table.claim(order, base, parentBase, body, renderStruct(body));
                }
            }
        };
        if (root.kind === "object") {
            const order = table.ticket();
            const body = structBody(root, rootName);
            table.root(order, rootName, body, renderStruct(body));
        }
        else {
            const order = table.ticket();
            table.addRaw(order, `type ${rootName} ${goType(root, rootName, "")}`);
        }
        const code = table.output().join("\n\n");
        return usesJsonNumber || usesRawMessage ? `import "encoding/json"\n\n${code}` : code;
    }
    catch (err) {
        return `// 无法生成 Go Struct：${err instanceof Error ? err.message : "JSON 无效"}`;
    }
}
/* ------------------------------------------------------------------ */
/* JSONPath 与 Markdown 辅助                                           */
/* ------------------------------------------------------------------ */
/**
 * 抽取扁平化的 JSONPath 路径列表（如 $.data.users[0].id）；传入文本时数字按原文展示
 */
export function extractJsonPaths(input, prefix = "$", maxItems = 150) {
    const items = [];
    let root;
    try {
        root = toAst(input);
    }
    catch {
        return items;
    }
    const walk = (node, path) => {
        if (items.length >= maxItems)
            return;
        switch (node.kind) {
            case "null":
                items.push({ path, value: null, displayValue: "null", type: "null" });
                return;
            case "string":
                items.push({ path, value: node.value, displayValue: JSON.stringify(node.value), type: "string" });
                return;
            case "number":
                items.push({ path, value: Number(node.raw), displayValue: node.raw, type: "number" });
                return;
            case "boolean":
                items.push({ path, value: node.value, displayValue: String(node.value), type: "boolean" });
                return;
            case "array":
                items.push({ path, value: node.items.length, displayValue: `Array(${node.items.length})`, type: "array" });
                node.items.forEach((item, i) => walk(item, `${path}[${i}]`));
                return;
            case "object": {
                const entries = entriesOf(node);
                items.push({ path, value: entries.length, displayValue: `Object{${entries.length}}`, type: "object" });
                for (const [key, val] of entries) {
                    walk(val, path + (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`));
                }
            }
        }
    };
    walk(root, prefix);
    return items;
}
/** 生成 Markdown 代码块：围栏比内容里最长的连续反引号多一个，内容里的 ``` 不会提前结束代码块 */
export function fencedCode(content, lang = "") {
    const longest = Math.max(0, ...(content.match(/`+/g) || []).map((s) => s.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `${fence}${lang}\n${content}\n${fence}`;
}
