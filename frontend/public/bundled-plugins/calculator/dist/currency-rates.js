import { LocalStorage, showToast, Toast } from "@ztools/declarative-ui";
export const RATES_URL = "https://open.er-api.com/v6/latest/USD";
export const RATES_CACHE_KEY = "calculator-rates-v1";
const MAX_SOURCE_AGE_MS = 48 * 3600000;
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** maxAgeMs：网络数据要求 48 小时内更新；读本地缓存时传 Infinity，旧汇率照样可用，由调用方标注为过期 */
export function parseRates(value, now = Date.now(), maxAgeMs = MAX_SOURCE_AGE_MS) {
    if (!record(value) || value.result !== "success" || value.base_code !== "USD" || !record(value.rates))
        throw new Error("汇率服务返回了无效的数据");
    const updatedAt = Number(value.time_last_update_unix) * 1000;
    const nextUpdateAt = Number(value.time_next_update_unix) * 1000;
    if (!Number.isFinite(updatedAt) || !Number.isFinite(nextUpdateAt) || updatedAt > now + 300000 || updatedAt < now - maxAgeMs || nextUpdateAt <= updatedAt || nextUpdateAt > updatedAt + MAX_SOURCE_AGE_MS)
        throw new Error("汇率数据的更新时间无效或已过期");
    const rates = {};
    for (const [code, rate] of Object.entries(value.rates)) {
        if (!/^[A-Z]{3}$/.test(code) || typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0)
            throw new Error("汇率服务返回了无效的币种或比率");
        rates[code] = rate;
    }
    if (rates.USD !== 1 || !rates.CNY)
        throw new Error("汇率数据缺少 USD 或 CNY");
    return { updatedAt, nextUpdateAt, rates };
}
let seq = 0;
async function requestRates() {
    const root = globalThis;
    const request = root.window?.__ztoolsElectron?.transport?.methods?.network_http_request;
    if (!request)
        throw new Error("当前宿主不支持汇率网络请求");
    const envelope = await request({ messageId: `currency_${++seq}`, timeoutMs: 12000, params: { method: "GET", url: RATES_URL, timeout: 10000 } });
    if (!envelope.success)
        throw new Error(envelope.error?.message || "请求汇率失败");
    const response = envelope.data;
    if (!record(response) || response.success !== true || !record(response.data) || typeof response.data.body !== "string" || response.data.body.length > 128 * 1024)
        throw new Error("汇率请求响应格式无效");
    if (response.data.statusCode !== 200)
        throw new Error(`汇率服务返回 HTTP ${response.data.statusCode}`);
    try {
        return JSON.parse(response.data.body);
    }
    catch {
        throw new Error("汇率服务返回的内容不是有效的 JSON");
    }
}
/** 读本地缓存；读取失败或缓存损坏都按「没有缓存」处理，继续请求网络，不提示错误 */
async function readCachedRates() {
    try {
        const cached = await LocalStorage.getItem(RATES_CACHE_KEY);
        return cached === undefined ? undefined : parseRates(cached, Date.now(), Infinity);
    }
    catch {
        return undefined;
    }
}
let fetching;
/** 请求网络并写入缓存；并发调用共用同一个请求 */
function fetchRates() {
    fetching ??= (async () => {
        const raw = await requestRates();
        const parsed = parseRates(raw);
        try {
            await LocalStorage.setItem(RATES_CACHE_KEY, raw);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "汇率已获取，但未能保存缓存", err instanceof Error ? err.message : String(err));
        }
        return parsed;
    })().finally(() => { fetching = undefined; });
    return fetching;
}
/**
 * 取汇率：缓存未过更新时间直接用；缓存已过期时先返回旧汇率（stale）并在后台刷新，
 * 刷新成功通过 onRefreshed 交回新汇率，失败则静默保留旧汇率；没有可用缓存时等待网络结果，网络失败才报错
 */
export async function getRates(onRefreshed) {
    const cached = await readCachedRates();
    if (cached && Date.now() < cached.nextUpdateAt)
        return cached;
    if (cached) {
        fetchRates().then((table) => onRefreshed?.(table), () => { });
        return { ...cached, stale: true };
    }
    return fetchRates();
}
export function convertCurrency(input, table) {
    const match = input.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]{3})\s+(?:to|到|转)\s*([a-z]{3})$/i);
    if (!match)
        throw new Error("格式：100 USD to CNY（使用三位币种代码）");
    const amount = Number(match[1]);
    const from = match[2].toUpperCase();
    const to = match[3].toUpperCase();
    if (!table.rates[from] || !table.rates[to])
        throw new Error("汇率来源不支持这个币种");
    const value = amount / table.rates[from] * table.rates[to];
    if (!Number.isFinite(value))
        throw new Error("金额超出可计算范围");
    return `${Number(value.toPrecision(15)).toLocaleString("en-US", { maximumSignificantDigits: 15 })} ${to}`;
}
