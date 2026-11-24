import { List, ActionPanel, Action, Icon, LocalStorage, showToast, Toast, getHostTransport, useState, useEffect, useRef, useLocale } from "@ztools/declarative-ui";
import { t, getCurrencyName } from "./i18n.js";
import { CURRENCIES, DEFAULT_SETTINGS, NETWORK_POLICY, RATE_CACHE_KEY, SETTINGS_KEY, ExchangeRateError, buildRows, calcRate, fetchRateSnapshot, formatRate, formatTime, getCurrency, groupDigits, isSupportedCurrency, parseCachedSnapshot, parseQuery, parseSettings, toInputAmount, toggleFavorite } from "./currency-rates.js";
import { resolveErrorMessage } from './error-i18n.js';
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
            const err = new Error(resolveErrorMessage(envelope.error, t("currencyNetworkFailed")));
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
            await notifyFailure(isCurrent, t("currencyCacheReadFailed"), errorMessage(error));
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
                await notifyFailure(isCurrent, t("currencyCacheSaveFailed"), errorMessage(error));
            }
            if (next.assetsStatus === "partial") {
                await notifyFailure(isCurrent, t("currencyAssetsPartialTitle"), t("currencyAssetsPartialMessage"));
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
            await notifyFailure(isCurrent, t("currencyFetchFailedTitle"), message);
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
                await showToast(Toast.Style.Failure, t("currencyBaseSaveFailed"), errorMessage(error));
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
            await showToast(Toast.Style.Failure, t("currencySettingsLoadFailed"), errorMessage(error));
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
            throw new Error(failed ? t("currencySettingsCannotSave") : t("currencySettingsNotReady"));
        const current = settingsRef.current;
        const wasFavorite = current.favorites.includes(code);
        const next = { ...current, favorites: toggleFavorite(current.favorites, code) };
        await LocalStorage.setItem(SETTINGS_KEY, next);
        if (!mounted.current)
            return;
        apply(next);
        await showToast(Toast.Style.Success, wasFavorite ? t("currencyUnfavoritedToast") : t("currencyFavoritedToast"));
    };
    return { settings, changeBase, toggle };
}
/** 单行状态条：金额与源币种、汇率时间、缓存 / 刷新失败 / 报价缺失标注 */
function buildSummary(snapshot, origin, loading, amountText, base) {
    if (!snapshot)
        return loading ? t("currencySummaryLoading") : t("currencySummaryFailed");
    const baseName = getCurrencyName(base, getCurrency(base)?.name ?? "");
    const parts = [`${groupDigits(amountText)} ${base} ${baseName}`.trim()];
    parts.push(t("currencySummaryRateTime", { time: formatTime(snapshot.sourceUpdatedAt ?? snapshot.timestamp) }));
    if (origin === "stale")
        parts.push(t("currencySummaryStale", { time: formatTime(snapshot.timestamp) }));
    else if (origin === "cache")
        parts.push(t("currencySummaryCached", { time: formatTime(snapshot.timestamp) }));
    if (snapshot.assetsStatus === "partial")
        parts.push(t("currencySummaryPartial"));
    return parts.join(" · ");
}
function errorItem(id, title, subtitle, actions) {
    return List.Item({ id, title, subtitle, icon: Icon.ExclamationMark, actions: ActionPanel({}, actions) });
}
export default function CurrencyCommand(props) {
    useLocale();
    const [searchText, setSearchText] = useState(props?.initialQuery ?? "");
    const { snapshot, origin, rateError, loading, loadRates } = useRates();
    const { settings, changeBase, toggle } = useCurrencySettings();
    const query = parseQuery(searchText);
    const base = query.kind === "amount" && query.from !== undefined ? query.from : settings.base;
    const amount = query.kind === "error" ? 1 : query.amount;
    const amountText = query.kind === "error" ? "1" : query.amountText;
    const refreshAction = Action({
        title: t("currencyActionRefresh"),
        icon: Icon.ArrowClockwise,
        shortcut: { modifiers: ["ctrl"], key: "r" },
        onAction: () => loadRates(true)
    });
    const openSourceAction = Action.OpenInBrowser({
        title: t("currencyActionOpenSource"),
        url: "https://www.exchangerate-api.com"
    });
    const rowItem = (row) => {
        const localizedName = getCurrencyName(row.code, row.info.name);
        const favoriteAction = Action({
            title: row.favorite ? t("currencyActionUnfavorite") : t("currencyActionFavorite"),
            icon: row.favorite ? Icon.StarDisabled : Icon.Star,
            shortcut: { modifiers: ["ctrl"], key: "d" },
            onAction: () => toggle(row.code)
        });
        const value = row.value;
        if (value === null) {
            return List.Item({
                id: `rate-${row.code}`,
                title: t("currencyUnavailableTitle", { code: row.code }),
                subtitle: localizedName,
                icon: Icon.ExclamationMark,
                accessories: [{ text: t("currencyUnavailableAccessory") }],
                actions: ActionPanel({}, [refreshAction, favoriteAction, openSourceAction])
            });
        }
        return List.Item({
            id: `rate-${row.code}`,
            title: `${groupDigits(value)} ${row.code}`,
            subtitle: localizedName,
            icon: row.favorite ? Icon.Star : Icon.Circle,
            keywords: [row.code, row.info.name, localizedName, ...row.info.keywords],
            accessories: [{ text: `1 ${row.code} = ${formatRate(row.reverseRate)} ${base}` }],
            actions: ActionPanel({}, [
                Action.CopyToClipboard({ title: t("currencyActionCopyValue"), content: value }),
                Action.CopyToClipboard({ title: t("currencyActionCopyEquation"), content: `${amountText} ${base} = ${value} ${row.code}` }),
                Action({
                    title: t("currencyActionSetBase", { code: row.code }),
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
        const clear = Action({ title: t("currencyActionClearInput"), icon: Icon.Repeat, onAction: () => setSearchText("") });
        items.push(errorItem("query-error", query.message, t("currencyQueryExampleHint"), [
            clear,
            openSourceAction
        ]));
    }
    else if (!snapshot) {
        if (rateError) {
            items.push(errorItem("rate-error", rateError, t("currencyRateErrorHint"), [
                refreshAction,
                openSourceAction
            ]));
        }
    }
    else if (calcRate(snapshot.rates, base, "USD") === null) {
        const name = getCurrencyName(base, getCurrency(base)?.name ?? base);
        items.push(errorItem("base-unavailable", t("currencyBaseUnavailableTitle", { name }), t("currencyBaseUnavailableHint"), [
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
            items.push(List.Section({ title: t("currencySectionFavorites") }, favorites.map(rowItem)));
        if (others.length > 0) {
            items.push(List.Section({ title: favorites.length > 0 ? t("currencySectionOthers") : t("currencySectionResults") }, others.map(rowItem)));
        }
    }
    return List({
        navigationTitle: t("currencyNavTitle"),
        searchBarPlaceholder: t("currencySearchPlaceholder", { base }),
        searchText,
        onSearchTextChange: setSearchText,
        isLoading: loading,
        isShowingDetail: false,
        searchBarAccessory: List.Dropdown({ tooltip: t("currencyBaseTooltip"), value: settings.base, onChange: (value) => void changeBase(value) }, CURRENCIES.map((c) => List.Dropdown.Item({ key: c.code, title: `${c.code} ${getCurrencyName(c.code, c.name)}`, value: c.code }))),
        filterBar: {
            summaryText: buildSummary(snapshot, origin, loading, amountText, base),
            actions: [{ id: "refresh", title: t("currencyActionRefresh"), icon: Icon.ArrowClockwise, onAction: () => loadRates(true) }]
        },
        actions: ActionPanel({}, [refreshAction, openSourceAction])
    }, items);
}
