import { List, ActionPanel, Action, Icon, LocalStorage, showToast, Toast, getHostTransport, useState, useEffect, useRef } from "@ztools/declarative-ui";
import { CURRENCIES, DEFAULT_SETTINGS, NETWORK_POLICY, RATE_CACHE_KEY, SETTINGS_KEY, ExchangeRateError, buildRows, calcRate, fetchRateSnapshot, formatRate, formatTime, getCurrency, groupDigits, isSupportedCurrency, parseCachedSnapshot, parseQuery, parseSettings, toInputAmount, toggleFavorite } from "./currency-rates.js";
let preloadReqSeq = 0;
/**
 * 宿主网络请求通道：
 * 1. 优先使用 SDK 标准公开通道 getHostTransport()；
 * 2. 兼容仅暴露 preload IPC transport.methods.network_http_request 的宿主或测试桩。
 */
export function createHostRequester() {
    const transport = getHostTransport();
    if (transport) {
        return (url, timeoutMs) => transport.call("network_http_request", { method: "GET", url, timeout: timeoutMs }, { timeoutMs: timeoutMs + 3000 });
    }
    const root = globalThis;
    const legacyRequest = root.__ztoolsElectron?.transport?.methods?.network_http_request ??
        root.window?.__ztoolsElectron?.transport?.methods?.network_http_request;
    if (!legacyRequest)
        return null;
    return async (url, timeoutMs) => {
        const envelope = await legacyRequest({
            messageId: `calc_currency_${++preloadReqSeq}`,
            timeoutMs: timeoutMs + 3000,
            params: { method: "GET", url, timeout: timeoutMs }
        });
        if (!envelope.success) {
            if (envelope.error?.code === "NOT_SUPPORTED") {
                throw new ExchangeRateError("HOST_UNSUPPORTED");
            }
            const err = new Error(envelope.error?.message || "网络请求失败");
            if (envelope.error?.code)
                err.code = envelope.error.code;
            throw err;
        }
        return envelope.data;
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
let inflightFetch = null;
/** 并发去重的实时汇率请求 */
function fetchSharedSnapshot(requester) {
    inflightFetch ??= fetchRateSnapshot(requester).finally(() => {
        inflightFetch = null;
    });
    return inflightFetch;
}
/**
 * 汇率加载状态机：新鲜缓存（30 分钟内）→ 联网 → 失败回退 7 天内真实缓存。
 * 请求序列号保证只有最后一次加载能落盘；视图卸载后不再更新状态或弹提示。
 */
export function useRates(options) {
    const enabled = options?.enabled ?? true;
    const silentToast = options?.silentToast ?? false;
    const [snapshot, setSnapshot] = useState(null);
    const [origin, setOrigin] = useState("network");
    const [rateError, setRateError] = useState("");
    const [loading, setLoading] = useState(enabled);
    const mounted = useRef(true);
    const loadSeq = useRef(0);
    const snapshotRef = useRef(null);
    const initializedRef = useRef(false);
    const notifyFailure = async (isCurrent, title, message) => {
        if (!silentToast && isCurrent()) {
            await showToast(Toast.Style.Failure, title, message);
        }
    };
    const applySnapshot = (next, nextOrigin) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setOrigin(nextOrigin);
    };
    const readCache = async (isCurrent) => {
        try {
            return await LocalStorage.getItem(RATE_CACHE_KEY);
        }
        catch (error) {
            await notifyFailure(isCurrent, "汇率缓存读取失败", errorMessage(error));
            return undefined;
        }
    };
    const loadRates = async (force) => {
        const seq = ++loadSeq.current;
        const isCurrent = () => mounted.current && seq === loadSeq.current;
        setLoading(true);
        setRateError("");
        const cachedRaw = await readCache(isCurrent);
        if (!isCurrent())
            return;
        const now = Date.now();
        const fresh = force ? undefined : parseCachedSnapshot(cachedRaw, now, NETWORK_POLICY.cacheTtlMs);
        if (fresh) {
            applySnapshot(fresh, "cache");
            setLoading(false);
            return;
        }
        try {
            const requester = createHostRequester();
            if (!requester)
                throw new ExchangeRateError("HOST_UNSUPPORTED");
            const next = await fetchSharedSnapshot(requester);
            if (!isCurrent())
                return;
            applySnapshot(next, "network");
            try {
                await LocalStorage.setItem(RATE_CACHE_KEY, next);
            }
            catch (error) {
                await notifyFailure(isCurrent, "汇率已更新，但缓存未保存", errorMessage(error));
            }
            if (next.assetsStatus === "partial") {
                await notifyFailure(isCurrent, "黄金或比特币报价获取失败", "对应币种暂无报价，其余汇率正常");
            }
        }
        catch (error) {
            if (!isCurrent())
                return;
            const message = errorMessage(error);
            setRateError(message);
            // 已在显示的真实汇率保留；否则回退到 7 天内的真实缓存，并明确标注刷新失败
            const stale = snapshotRef.current ?? parseCachedSnapshot(cachedRaw, now, NETWORK_POLICY.staleMaxAgeMs);
            if (stale)
                applySnapshot(stale, "stale");
            await notifyFailure(isCurrent, "获取汇率失败", message);
        }
        finally {
            if (isCurrent())
                setLoading(false);
        }
    };
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        if (enabled && !initializedRef.current) {
            initializedRef.current = true;
            void loadRates(false);
        }
    }, [enabled]);
    return { snapshot, origin, rateError, loading, loadRates };
}
/** 源币种与收藏的读取 / 保存；读取失败时拒绝写回，避免覆盖用户已保存的设置 */
function useCurrencySettings() {
    const [settings, setSettings] = useState(DEFAULT_SETTINGS);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);
    const mounted = useRef(true);
    const settingsRef = useRef(DEFAULT_SETTINGS);
    const apply = (next) => {
        settingsRef.current = next;
        setSettings(next);
    };
    const persistBase = async (next) => {
        try {
            await LocalStorage.setItem(SETTINGS_KEY, next);
        }
        catch (error) {
            if (mounted.current)
                await showToast(Toast.Style.Failure, "源币种保存失败", errorMessage(error));
        }
    };
    const load = async () => {
        try {
            const parsed = parseSettings(await LocalStorage.getItem(SETTINGS_KEY));
            if (!mounted.current)
                return;
            // 加载期间用户已切换过源币种时，保留用户的新选择，只合并收藏
            const merged = settingsRef.current === DEFAULT_SETTINGS ? parsed : { ...parsed, base: settingsRef.current.base };
            apply(merged);
            setReady(true);
            if (merged.base !== parsed.base)
                await persistBase(merged);
        }
        catch (error) {
            if (!mounted.current)
                return;
            setFailed(true);
            await showToast(Toast.Style.Failure, "设置读取失败，本次修改不会保存", errorMessage(error));
        }
    };
    useEffect(() => {
        mounted.current = true;
        void load();
        return () => {
            mounted.current = false;
        };
    }, []);
    /** 切换源币种：界面立即切换；保存失败如实提示，本次会话内仍使用新币种 */
    const changeBase = async (code) => {
        if (!isSupportedCurrency(code) || code === settingsRef.current.base)
            return;
        const next = { ...settingsRef.current, base: code };
        apply(next);
        if (ready)
            await persistBase(next);
    };
    /** 收藏 / 取消收藏：先写入成功再更新界面；失败抛错，由客户端提示操作失败 */
    const toggle = async (code) => {
        if (!ready)
            throw new Error(failed ? "设置读取失败，暂不能保存修改" : "设置尚未加载完成");
        const current = settingsRef.current;
        const wasFavorite = current.favorites.includes(code);
        const next = { ...current, favorites: toggleFavorite(current.favorites, code) };
        await LocalStorage.setItem(SETTINGS_KEY, next);
        if (!mounted.current)
            return;
        apply(next);
        await showToast(Toast.Style.Success, wasFavorite ? "已取消收藏" : "已收藏，置顶显示");
    };
    return { settings, changeBase, toggle };
}
/** 单行状态条：金额与源币种、汇率时间、缓存 / 刷新失败 / 报价缺失标注 */
function buildSummary(snapshot, origin, loading, amountText, base) {
    if (!snapshot)
        return loading ? "正在获取实时汇率…" : "汇率获取失败";
    const parts = [`${groupDigits(amountText)} ${base} ${getCurrency(base)?.name ?? ""}`.trim()];
    parts.push(`汇率时间 ${formatTime(snapshot.sourceUpdatedAt ?? snapshot.timestamp)}`);
    if (origin === "stale")
        parts.push(`刷新失败，显示 ${formatTime(snapshot.timestamp)} 获取的缓存`);
    else if (origin === "cache")
        parts.push(`缓存于 ${formatTime(snapshot.timestamp)}`);
    if (snapshot.assetsStatus === "partial")
        parts.push("黄金/比特币报价暂缺");
    return parts.join(" · ");
}
function errorItem(id, title, subtitle, actions) {
    return List.Item({ id, title, subtitle, icon: Icon.ExclamationMark, actions: ActionPanel({}, actions) });
}
export default function CurrencyCommand(props) {
    const [searchText, setSearchText] = useState(props?.initialQuery ?? "");
    const { snapshot, origin, rateError, loading, loadRates } = useRates();
    const { settings, changeBase, toggle } = useCurrencySettings();
    const query = parseQuery(searchText);
    const base = query.kind === "amount" && query.from !== undefined ? query.from : settings.base;
    const amount = query.kind === "error" ? 1 : query.amount;
    const amountText = query.kind === "error" ? "1" : query.amountText;
    const refreshAction = Action({
        title: "刷新汇率",
        icon: Icon.ArrowClockwise,
        shortcut: { modifiers: ["cmd"], key: "r" },
        onAction: () => loadRates(true)
    });
    const openSourceAction = Action.OpenInBrowser({
        title: "打开汇率来源（ExchangeRate-API）",
        url: "https://www.exchangerate-api.com"
    });
    const rowItem = (row) => {
        const favoriteAction = Action({
            title: row.favorite ? "取消收藏" : "收藏（置顶）",
            icon: row.favorite ? Icon.StarDisabled : Icon.Star,
            shortcut: { modifiers: ["cmd"], key: "d" },
            onAction: () => toggle(row.code)
        });
        const value = row.value;
        if (value === null) {
            return List.Item({
                id: `rate-${row.code}`,
                title: `暂无报价 ${row.code}`,
                subtitle: row.info.name,
                icon: Icon.ExclamationMark,
                accessories: [{ text: "数据源未返回该币种报价" }],
                actions: ActionPanel({}, [refreshAction, favoriteAction, openSourceAction])
            });
        }
        return List.Item({
            id: `rate-${row.code}`,
            title: `${groupDigits(value)} ${row.code}`,
            subtitle: row.info.name,
            icon: row.favorite ? Icon.Star : Icon.Circle,
            keywords: [row.code, row.info.name, ...row.info.keywords],
            accessories: [{ text: `1 ${row.code} = ${formatRate(row.reverseRate)} ${base}` }],
            actions: ActionPanel({}, [
                Action.CopyToClipboard({ title: "复制换算结果", content: value }),
                Action.CopyToClipboard({ title: "复制换算等式", content: `${amountText} ${base} = ${value} ${row.code}` }),
                Action({
                    title: `以 ${row.code} 为源币种`,
                    icon: Icon.ArrowRight,
                    onAction: async () => {
                        setSearchText(toInputAmount(value));
                        await changeBase(row.code);
                    }
                }),
                favoriteAction,
                refreshAction,
                openSourceAction
            ])
        });
    };
    const items = [];
    if (query.kind === "error") {
        const clear = Action({ title: "清空输入", icon: Icon.Repeat, onAction: () => setSearchText("") });
        items.push(errorItem("query-error", query.message, "示例：100、100 USD、100 USD to CNY；输入币种名可筛选", [
            clear,
            openSourceAction
        ]));
    }
    else if (!snapshot) {
        if (rateError) {
            items.push(errorItem("rate-error", rateError, "未获取到真实汇率，不使用估算数据；按 Enter 重试", [
                refreshAction,
                openSourceAction
            ]));
        }
    }
    else if (calcRate(snapshot.rates, base, "USD") === null) {
        const name = getCurrency(base)?.name ?? base;
        items.push(errorItem("base-unavailable", `源币种 ${name} 暂无报价`, "数据源未返回该币种报价，请刷新或切换源币种", [
            refreshAction,
            openSourceAction
        ]));
    }
    else {
        const rows = buildRows(snapshot, base, amount, settings.favorites, {
            ...(query.kind === "amount" && query.to !== undefined ? { to: query.to } : {}),
            ...(query.kind === "filter" ? { filter: query.text } : {})
        });
        const favorites = rows.filter((r) => r.favorite);
        const others = rows.filter((r) => !r.favorite);
        if (favorites.length > 0)
            items.push(List.Section({ title: "收藏" }, favorites.map(rowItem)));
        if (others.length > 0) {
            items.push(List.Section({ title: favorites.length > 0 ? "其他币种" : "换算结果" }, others.map(rowItem)));
        }
    }
    return List({
        navigationTitle: "汇率换算",
        searchBarPlaceholder: `输入金额换算（源币种 ${base}），如 100 或 100 USD to CNY；输入币种名筛选`,
        searchText,
        onSearchTextChange: setSearchText,
        isLoading: loading,
        isShowingDetail: false,
        searchBarAccessory: List.Dropdown({ tooltip: "源币种", value: settings.base, onChange: (value) => void changeBase(value) }, CURRENCIES.map((c) => List.Dropdown.Item({ key: c.code, title: `${c.code} ${c.name}`, value: c.code }))),
        filterBar: {
            summaryText: buildSummary(snapshot, origin, loading, amountText, base),
            actions: [{ id: "refresh", title: "刷新汇率", icon: Icon.ArrowClockwise, onAction: () => loadRates(true) }]
        },
        actions: ActionPanel({}, [refreshAction, openSourceAction])
    }, items);
}
