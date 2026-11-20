/**
 * 计算器汇率模块 - 纯逻辑层（无界面、无宿主强耦合，便于单元测试）
 *
 * 数据源：
 * - 法币汇率：open.er-api.com（以 USD 为基准的每日汇率表）
 * - 比特币 / 黄金：api.coingecko.com（bitcoin、tether-gold 的美元价格）
 * 拿不到真实数据时一律抛出 ExchangeRateError，绝不生成任何估算或演示假数据。
 */
import { t, getCurrencyName } from "./i18n.js";
export const LATEST_RATES_URL = "https://open.er-api.com/v6/latest/USD";
export const RATES_URL = LATEST_RATES_URL;
export const ASSET_QUOTES_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether-gold&vs_currencies=usd";
export const NETWORK_POLICY = Object.freeze({
    latestRatesTimeoutMs: 12_000,
    assetQuotesTimeoutMs: 5_000,
    latestRatesMaxBytes: 128 * 1024,
    assetQuotesMaxBytes: 4 * 1024,
    /** 缓存 30 分钟内视为新鲜，直接使用不联网 */
    cacheTtlMs: 30 * 60 * 1000,
    /** 联网失败时最多回退展示 7 天内的真实缓存（界面明确标注刷新失败与汇率时间） */
    staleMaxAgeMs: 7 * 24 * 60 * 60 * 1000
});
export const RATE_CACHE_KEY = "ztools-calculator-rate-cache-v2";
export const SETTINGS_KEY = "ztools-calculator-currency-settings-v1";
/** 支持的货币与资产列表（15 种主流法币 + 黄金 + 比特币，顺序即默认展示顺序） */
export const CURRENCIES = Object.freeze([
    { code: "CNY", name: "人民币", symbol: "¥", keywords: ["rmb", "yuan", "元", "中国"], exprAliases: ["rmb", "yuan", "人民币"] },
    { code: "USD", name: "美元", symbol: "$", keywords: ["美金", "dollar", "美国"], exprAliases: ["dollar", "dollars", "美元", "美金"] },
    { code: "EUR", name: "欧元", symbol: "€", keywords: ["euro", "欧洲"], exprAliases: ["euro", "euros", "欧元"] },
    { code: "JPY", name: "日元", symbol: "¥", keywords: ["yen", "日本", "日币"], exprAliases: ["yen", "日元", "日币"] },
    { code: "GBP", name: "英镑", symbol: "£", keywords: ["pound", "英国"], exprAliases: ["pound", "pounds", "英镑"] },
    { code: "KRW", name: "韩元", symbol: "₩", keywords: ["won", "韩国", "韩币"], exprAliases: ["won", "韩元", "韩币"] },
    { code: "HKD", name: "港币", symbol: "HK$", keywords: ["港元", "香港"], exprAliases: ["港币", "港元"] },
    { code: "TWD", name: "新台币", symbol: "NT$", keywords: ["台币", "台湾"], exprAliases: ["新台币", "台币"] },
    { code: "SGD", name: "新加坡元", symbol: "S$", keywords: ["新币", "新加坡"], exprAliases: ["新加坡元", "新币"] },
    { code: "AUD", name: "澳元", symbol: "A$", keywords: ["澳币", "澳大利亚"], exprAliases: ["澳元", "澳币"] },
    { code: "CAD", name: "加元", symbol: "C$", keywords: ["加币", "加拿大"], exprAliases: ["加元", "加币"] },
    { code: "CHF", name: "瑞士法郎", symbol: "Fr", keywords: ["franc", "瑞士"], exprAliases: ["franc", "瑞郎", "瑞士法郎"] },
    { code: "THB", name: "泰铢", symbol: "฿", keywords: ["baht", "泰国"], exprAliases: ["baht", "泰铢"] },
    { code: "RUB", name: "卢布", symbol: "₽", keywords: ["ruble", "俄罗斯"], exprAliases: ["ruble", "卢布"] },
    { code: "INR", name: "印度卢比", symbol: "₹", keywords: ["rupee", "印度"], exprAliases: ["rupee", "卢比", "印度卢比"] },
    { code: "XAU", name: "黄金（盎司）", symbol: "oz", keywords: ["gold", "黄金", "金价"], exprAliases: ["gold", "黄金"] },
    { code: "BTC", name: "比特币", symbol: "₿", keywords: ["bitcoin", "比特币"], exprAliases: ["bitcoin", "比特币"] }
]);
const SUPPORTED_CODES = new Set(CURRENCIES.map((c) => c.code));
/** 算式内可识别的币种代码与精确别名映射表（全部转小写匹配） */
const ALIAS_TO_CODE = (() => {
    const map = new Map();
    for (const info of CURRENCIES) {
        map.set(info.code.toLowerCase(), info.code);
        for (const alias of info.exprAliases) {
            map.set(alias.toLowerCase(), info.code);
        }
    }
    return map;
})();
/** 由 CoinGecko 提供报价的资产（er-api 不提供或口径不同） */
export const ASSET_CODES = Object.freeze(["BTC", "XAU"]);
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveFinite(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export function isSupportedCurrency(code) {
    return typeof code === "string" && SUPPORTED_CODES.has(code);
}
export function getCurrency(code) {
    return CURRENCIES.find((c) => c.code === code);
}
/** 将代码或别名（如 "usd"、"rmb"、"美元"、"gold"）解析为标准三位币种代码 */
export function resolveCurrencyToken(token) {
    return ALIAS_TO_CODE.get(token.trim().toLowerCase());
}
/* ============================== 换算 ============================== */
/** 根据货币类型决定小数位数：JPY/KRW 0 位，BTC 8 位，XAU 4 位，其余 2 位 */
export function getDecimals(code) {
    if (code === "JPY" || code === "KRW")
        return 0;
    if (code === "BTC")
        return 8;
    if (code === "XAU")
        return 4;
    return 2;
}
/** 格式化单位汇率；无效值返回 "--" */
export function formatRate(rate) {
    if (rate === null || !Number.isFinite(rate) || rate <= 0)
        return "--";
    if (rate >= 1000)
        return rate.toFixed(0);
    if (rate >= 100)
        return rate.toFixed(2);
    if (rate >= 1)
        return rate.toFixed(4);
    return rate.toFixed(6);
}
/** 从 USD 基准汇率表计算 from → to 的汇率；任一侧缺失或无效返回 null */
export function calcRate(rates, from, to) {
    const fromRate = rates[from];
    const toRate = rates[to];
    if (!isPositiveFinite(fromRate) || !isPositiveFinite(toRate))
        return null;
    const rate = toRate / fromRate;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}
/** 解析非负十进制金额，允许正确分组的千分位逗号；"0" 是合法金额，返回 0 而不是 null */
export function parseAmount(amount) {
    const value = amount.trim();
    if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)$/.test(value))
        return null;
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
/** 按目标币种小数位换算金额，返回不带千分位的定点字符串；无法计算返回 null */
export function convertAmount(amount, rate, targetCode) {
    if (!Number.isFinite(amount) || amount < 0 || !isPositiveFinite(rate))
        return null;
    const converted = amount * rate;
    if (!Number.isFinite(converted) || converted >= 1e21)
        return null;
    return converted.toFixed(getDecimals(targetCode));
}
/** 给定点数字符串加千分位：1234567.89 → 1,234,567.89 */
export function groupDigits(fixed) {
    const match = fixed.match(/^(\d+)(\.\d+)?$/);
    if (!match)
        return fixed;
    return match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (match[2] ?? "");
}
/** 去掉千分位与多余尾随零，用于把换算结果回填为新的输入金额 */
export function toInputAmount(fixed) {
    if (!/^\d+(\.\d+)?$/.test(fixed))
        return fixed;
    return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
const BOARD_QUERY_PATTERN = /^([\d.,]+)(?:\s*([a-z\u4e00-\u9fa5]{2,10}))?(?:\s*(?:to|in|到|转|换|=|->)\s*([a-z\u4e00-\u9fa5]{2,10})|\s+([a-z]{3}))?$/i;
/**
 * 解析汇率看板搜索框：
 * - 空 → 金额 1
 * - "100" / "100 usd" / "100 usd to cny" / "100usd=cny" / "100 美元 转 人民币" → 金额（可选源/目标币种）
 * - 以数字或正负号开头但无法识别 → 错误
 * - 其他文本 → 按币种代码、名称、别名筛选（金额 1）
 */
export function parseQuery(input) {
    const text = input.trim();
    if (text === "")
        return { kind: "amount", amount: 1, amountText: "1" };
    const match = text.match(BOARD_QUERY_PATTERN);
    if (match) {
        const amountText = match[1];
        const amount = parseAmount(amountText);
        if (amount === null)
            return { kind: "error", message: t("errInvalidAmount", { amount: amountText }) };
        const rawFrom = match[2];
        const rawTo = match[3] ?? match[4];
        const from = rawFrom === undefined ? undefined : resolveCurrencyToken(rawFrom);
        if (rawFrom !== undefined && from === undefined) {
            return { kind: "error", message: t("errUnsupportedCurrency", { code: rawFrom.toUpperCase() }) };
        }
        const to = rawTo === undefined ? undefined : resolveCurrencyToken(rawTo);
        if (rawTo !== undefined && to === undefined) {
            return { kind: "error", message: t("errUnsupportedCurrency", { code: rawTo.toUpperCase() }) };
        }
        return {
            kind: "amount",
            amount,
            amountText: amountText.replace(/,/g, ""),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to })
        };
    }
    if (/^[\d.,+-]/.test(text))
        return { kind: "error", message: t("errUnrecognizedQuery") };
    return { kind: "filter", amount: 1, amountText: "1", text };
}
const INLINE_CURRENCY_PATTERN = /^([+-]?[\d.,]+)\s*([a-z\u4e00-\u9fa5]{2,10})\s*(?:to|in|到|转|换|=|->)\s*([a-z\u4e00-\u9fa5]{2,10})$/i;
/**
 * 解析计算器主输入框中的显式汇率换算算式（如 "100 usd to cny"、"5000 日元 转 人民币"）：
 * - 两侧都不是已知货币时返回 null（交由其他计算分支处理）；
 * - 至少一侧命中支持货币时进入汇率分支，校验另一侧币种与非负金额。
 */
export function parseInlineCurrencyQuery(input) {
    const text = input.trim();
    if (!text)
        return null;
    const match = text.match(INLINE_CURRENCY_PATTERN);
    if (!match)
        return null;
    const rawAmount = match[1];
    const rawFrom = match[2];
    const rawTo = match[3];
    const from = resolveCurrencyToken(rawFrom);
    const to = resolveCurrencyToken(rawTo);
    if (!from && !to)
        return null;
    if (!from) {
        return { kind: "error", expression: text, message: t("errUnsupportedFromCurrency", { code: rawFrom.toUpperCase() }) };
    }
    if (!to) {
        return { kind: "error", expression: text, message: t("errUnsupportedToCurrency", { code: rawTo.toUpperCase() }) };
    }
    if (rawAmount.startsWith("-")) {
        return { kind: "error", expression: text, message: t("errNegativeCurrencyAmount") };
    }
    const normalizedAmount = rawAmount.startsWith("+") ? rawAmount.slice(1) : rawAmount;
    const amount = parseAmount(normalizedAmount);
    if (amount === null) {
        return { kind: "error", expression: text, message: t("errMalformedAmount", { amount: rawAmount }) };
    }
    return {
        kind: "convert",
        expression: text,
        amount,
        amountText: normalizedAmount.replace(/,/g, ""),
        from,
        to
    };
}
/** 基于真实汇率快照计算主输入框的内联汇率结果 */
export function evaluateInlineCurrency(query, snapshot, origin = "network") {
    const rate = calcRate(snapshot.rates, query.from, query.to);
    if (rate === null) {
        const missing = calcRate(snapshot.rates, query.from, "USD") === null ? query.from : query.to;
        const name = getCurrencyName(missing, getCurrency(missing)?.name ?? missing);
        return { formattedAnswer: "", error: t("errMissingLiveQuote", { name, code: missing }) };
    }
    const fixed = convertAmount(query.amount, rate, query.to);
    if (fixed === null) {
        return { formattedAnswer: "", error: t("errConversionOverflow") };
    }
    const formattedAnswer = `${groupDigits(fixed)} ${query.to}`;
    const timeText = formatTime(snapshot.sourceUpdatedAt ?? snapshot.timestamp);
    const originNote = origin === "stale"
        ? t("inlineOriginStale", { time: formatTime(snapshot.timestamp) })
        : origin === "cache"
            ? t("inlineOriginCache")
            : "";
    return {
        formattedAnswer,
        fillText: toInputAmount(fixed),
        details: t("inlineDetails", {
            from: query.from,
            rate: formatRate(rate),
            to: query.to,
            time: timeText,
            origin: originNote
        })
    };
}
/** 币种是否匹配筛选文本（代码、名称、别名，忽略大小写） */
export function matchCurrency(info, text) {
    const needle = text.trim().toLowerCase();
    if (needle === "")
        return true;
    const localizedName = getCurrencyName(info.code, info.name);
    return [info.code, info.name, localizedName, ...info.keywords].some((v) => v.toLowerCase().includes(needle));
}
/** 稳定、可展示的错误：不包含原始响应体或请求头 */
export class ExchangeRateError extends Error {
    code;
    statusCode;
    constructor(code, statusCode, detail) {
        const messages = {
            HOST_UNSUPPORTED: t("errHostUnsupported"),
            TIMEOUT: t("errRateTimeout"),
            TRANSPORT_ERROR: t("errRateTransport"),
            HTTP_ERROR: t("errRateHttp", { status: statusCode ?? t("errRateHttpFallback") }),
            INVALID_RESPONSE: t("errRateInvalidResponse")
        };
        super(detail ? t("errDetailWrap", { base: messages[code], detail }) : messages[code]);
        this.name = "ExchangeRateError";
        this.code = code;
        if (statusCode !== undefined)
            this.statusCode = statusCode;
    }
}
/** 解析宿主响应：兼容最多两层 { success: true, data } 包装；超出字节上限视为无效 */
export function parseHostResponse(raw, maxBytes) {
    let value = raw;
    for (let depth = 0; depth < 2 && isRecord(value) && value.success === true && isRecord(value.data); depth++) {
        value = value.data;
    }
    if (!isRecord(value) || !Number.isInteger(value.statusCode) || typeof value.body !== "string") {
        throw new ExchangeRateError("INVALID_RESPONSE");
    }
    if (value.body.length > maxBytes || new TextEncoder().encode(value.body).byteLength > maxBytes) {
        throw new ExchangeRateError("INVALID_RESPONSE", undefined, t("errResponseTooLarge"));
    }
    return { statusCode: value.statusCode, body: value.body };
}
function hostErrorCode(error) {
    if (isRecord(error) && typeof error.code === "string")
        return error.code;
    return "";
}
/** 调用宿主并把结果解析成 JSON 对象；所有失败统一映射为 ExchangeRateError */
export async function requestJson(request, url, timeoutMs, maxBytes) {
    let raw;
    try {
        raw = await request(url, timeoutMs);
    }
    catch (error) {
        if (error instanceof ExchangeRateError)
            throw error;
        const code = hostErrorCode(error);
        if (/TIMEOUT/i.test(code))
            throw new ExchangeRateError("TIMEOUT");
        throw new ExchangeRateError("TRANSPORT_ERROR", undefined, code || undefined);
    }
    const response = parseHostResponse(raw, maxBytes);
    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ExchangeRateError("HTTP_ERROR", response.statusCode);
    }
    let payload;
    try {
        payload = JSON.parse(response.body);
    }
    catch (error) {
        throw new ExchangeRateError("INVALID_RESPONSE", undefined, error instanceof SyntaxError ? t("errInvalidJson") : undefined);
    }
    if (!isRecord(payload))
        throw new ExchangeRateError("INVALID_RESPONSE");
    return payload;
}
/** 只保留支持的币种；任一支持币种的值无效、USD 不为 1 或缺少 CNY 时整体判为无效 */
export function normalizeRates(value) {
    if (!isRecord(value))
        return undefined;
    const rates = {};
    for (const [code, rate] of Object.entries(value)) {
        if (!SUPPORTED_CODES.has(code))
            continue;
        if (!isPositiveFinite(rate))
            return undefined;
        rates[code] = rate;
    }
    if (rates.USD !== 1 || !rates.CNY)
        return undefined;
    return rates;
}
/** 校验 er-api 响应；BTC / XAU 一律以 CoinGecko 报价为准，这里剔除 */
export function validateLatestRates(payload) {
    if (!isRecord(payload) || payload.result !== "success" || payload.base_code !== "USD") {
        throw new ExchangeRateError("INVALID_RESPONSE");
    }
    const rates = normalizeRates(payload.rates);
    if (!rates)
        throw new ExchangeRateError("INVALID_RESPONSE", undefined, t("errMissingCoreRates"));
    for (const code of ASSET_CODES)
        delete rates[code];
    const unix = payload.time_last_update_unix;
    const sourceUpdatedAt = isPositiveFinite(unix) ? unix * 1000 : undefined;
    return sourceUpdatedAt === undefined ? { rates } : { rates, sourceUpdatedAt };
}
/** 把 CoinGecko 美元价格换算成「每 1 USD 可换多少单位」；缺失或无效的报价跳过，不估算 */
export function applyAssetQuotes(rates, payload) {
    if (!isRecord(payload))
        return;
    const candidates = [
        ["BTC", "bitcoin"],
        ["XAU", "tether-gold"]
    ];
    for (const [code, key] of candidates) {
        const item = payload[key];
        const price = isRecord(item) ? item.usd : undefined;
        if (!isPositiveFinite(price))
            continue;
        const rate = 1 / price;
        if (Number.isFinite(rate) && rate > 0)
            rates[code] = rate;
    }
}
/**
 * 并发请求法币汇率与资产报价并合成快照。
 * 法币汇率失败 → 抛错（不返回任何数据）；资产报价失败 → 快照标记 partial，对应币种显示「暂无报价」。
 */
export async function fetchRateSnapshot(request, now = Date.now) {
    const [latest, assets] = await Promise.allSettled([
        requestJson(request, LATEST_RATES_URL, NETWORK_POLICY.latestRatesTimeoutMs, NETWORK_POLICY.latestRatesMaxBytes),
        requestJson(request, ASSET_QUOTES_URL, NETWORK_POLICY.assetQuotesTimeoutMs, NETWORK_POLICY.assetQuotesMaxBytes)
    ]);
    if (latest.status === "rejected") {
        throw latest.reason instanceof ExchangeRateError ? latest.reason : new ExchangeRateError("TRANSPORT_ERROR");
    }
    const { rates, sourceUpdatedAt } = validateLatestRates(latest.value);
    if (assets.status === "fulfilled")
        applyAssetQuotes(rates, assets.value);
    const assetsStatus = ASSET_CODES.every((code) => isPositiveFinite(rates[code]))
        ? "complete"
        : "partial";
    return {
        base: "USD",
        rates: Object.freeze({ ...rates }),
        timestamp: now(),
        ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
        assetsStatus
    };
}
/** 校验本地缓存；超过 maxAgeMs、时间戳在未来或数据损坏都返回 undefined */
export function parseCachedSnapshot(value, now, maxAgeMs) {
    if (!isRecord(value) || value.base !== "USD" || !isPositiveFinite(value.timestamp))
        return undefined;
    const timestamp = value.timestamp;
    if (timestamp > now || now - timestamp >= maxAgeMs)
        return undefined;
    if (!isRecord(value.rates))
        return undefined;
    const rates = normalizeRates(value.rates);
    if (!rates)
        return undefined;
    const sourceUpdatedAt = isPositiveFinite(value.sourceUpdatedAt) ? value.sourceUpdatedAt : undefined;
    const assetsStatus = ASSET_CODES.every((code) => isPositiveFinite(rates[code]))
        ? "complete"
        : "partial";
    return {
        base: "USD",
        rates: Object.freeze(rates),
        timestamp,
        ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
        assetsStatus
    };
}
export const DEFAULT_SETTINGS = Object.freeze({
    base: "CNY",
    favorites: Object.freeze([])
});
/**
 * 解析已保存的设置：不存在返回默认值；格式损坏抛错（调用方据此禁止写回，避免覆盖用户数据）。
 * 未知币种会被过滤，收藏去重。
 */
export function parseSettings(raw) {
    if (raw === undefined || raw === null)
        return DEFAULT_SETTINGS;
    if (!isRecord(raw))
        throw new Error(t("errInvalidSavedSettings"));
    const base = isSupportedCurrency(raw.base) ? raw.base : DEFAULT_SETTINGS.base;
    const favorites = Array.isArray(raw.favorites)
        ? [...new Set(raw.favorites.filter((code) => isSupportedCurrency(code)))]
        : [];
    return { base, favorites };
}
export function toggleFavorite(favorites, code) {
    return favorites.includes(code) ? favorites.filter((c) => c !== code) : [...favorites, code];
}
/* ============================== 展示 ============================== */
function pad2(n) {
    return String(n).padStart(2, "0");
}
/** 本地时间 YYYY-MM-DD HH:mm */
export function formatTime(ms) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime()))
        return "--";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/**
 * 生成换算结果行：排除源币种，收藏优先，其余按币种表顺序；
 * 可选只保留指定目标币种或按文本筛选。
 */
export function buildRows(snapshot, base, amount, favorites, options = {}) {
    const rows = [];
    for (const info of CURRENCIES) {
        if (info.code === base)
            continue;
        if (options.to !== undefined && info.code !== options.to)
            continue;
        if (options.filter !== undefined && !matchCurrency(info, options.filter))
            continue;
        const rate = calcRate(snapshot.rates, base, info.code);
        const reverse = calcRate(snapshot.rates, info.code, base);
        rows.push({
            code: info.code,
            info,
            favorite: favorites.includes(info.code),
            value: rate === null ? null : convertAmount(amount, rate, info.code),
            reverseRate: reverse
        });
    }
    const favoriteRank = (code) => {
        const i = favorites.indexOf(code);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rows.sort((a, b) => favoriteRank(a.code) - favoriteRank(b.code));
}
