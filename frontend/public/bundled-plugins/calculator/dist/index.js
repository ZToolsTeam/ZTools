import React from "@ztools/declarative-ui";
import { confirmAlert } from "@ztools/declarative-ui";
import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard } from "@ztools/declarative-ui";
import { useState, useEffect, useMemo, useNavigation, useLocale } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import RmbCommand from "./rmb.js";
import CurrencyCommand, { useRates } from "./currency.js";
export { default as calcRmb } from "./rmb.js";
export { default as calcCurrency } from "./currency.js";
import { parseInlineCurrencyQuery, evaluateInlineCurrency } from "./currency-rates.js";
import { evaluateCalculatorQuery, getCalculatorHistory, addCalculatorHistory, togglePinCalculatorHistory, deleteCalculatorHistory, clearCalculatorHistory } from "./calculator-engine.js";
import { usePopoutValue } from "./popout-state.js";
export * from "./calculator-engine.js";
const DEFAULT_CALC_EXAMPLES = [
    { expr: "1024 * 768", descKey: "eg0Desc", categoryKey: "catMath" },
    { expr: "sqrt(65536)", descKey: "eg1Desc", categoryKey: "catMath" },
    { expr: "2 ^ 16", descKey: "eg2Desc", categoryKey: "catMath" },
    { expr: "sin(pi / 2)", descKey: "eg3Desc", categoryKey: "catMath" },
    { expr: "32px to rem", descKey: "eg4Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "2.5rem to px", descKey: "eg5Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "10km to miles", descKey: "eg6Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "5kg to lbs", descKey: "eg7Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "100c to f", descKey: "eg8Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "1024mb to gb", descKey: "eg9Desc", categoryKey: "catUnit", isUnit: true },
    { expr: "0xFF to dec", descKey: "eg10Desc", categoryKey: "catRadix" },
    { expr: "255 to hex", descKey: "eg11Desc", categoryKey: "catRadix" },
    { expr: "255 to bin", descKey: "eg12Desc", categoryKey: "catRadix" },
    { expr: "now + 2 weeks", descKey: "eg13Desc", categoryKey: "catDate" },
    { expr: "#3B82F6", descKey: "eg14Desc", categoryKey: "catColor" },
    { expr: "rgb(59, 130, 246)", descKey: "eg15Desc", categoryKey: "catColor" },
    { expr: "100 usd to cny", descKey: "eg16Desc", categoryKey: "catCurrency" }
];
const HISTORY_TYPE_KEYS = {
    math: "historyTypeMath",
    unit: "historyTypeUnit",
    currency: "historyTypeCurrency",
    date: "historyTypeDate",
    color: "historyTypeColor"
};
/** 融合本地同步计算与按需实时汇率结果；无真实汇率时绝不返回估算值 */
function resolveQueryWithCurrency(input, snapshot, origin, loading, rateError, locale) {
    const syncResult = evaluateCalculatorQuery(input, { locale });
    if (syncResult.type !== "none" && !(syncResult.type === "math" && Boolean(syncResult.error))) {
        return syncResult;
    }
    const inlineCurrency = parseInlineCurrencyQuery(input);
    if (!inlineCurrency) {
        return syncResult;
    }
    if (inlineCurrency.kind === "error") {
        return {
            type: "currency",
            expression: inlineCurrency.expression,
            formattedAnswer: "",
            error: inlineCurrency.message
        };
    }
    if (!snapshot) {
        if (rateError) {
            return {
                type: "currency",
                expression: inlineCurrency.expression,
                formattedAnswer: "",
                error: t("currencyNoEstimateError", { error: rateError })
            };
        }
        return {
            type: "currency",
            expression: inlineCurrency.expression,
            formattedAnswer: "",
            loadingCurrency: loading || true
        };
    }
    const evaluated = evaluateInlineCurrency(inlineCurrency, snapshot, origin);
    if (evaluated.error) {
        return {
            type: "currency",
            expression: inlineCurrency.expression,
            formattedAnswer: "",
            error: evaluated.error
        };
    }
    return {
        type: "currency",
        expression: inlineCurrency.expression,
        formattedAnswer: evaluated.formattedAnswer,
        fillText: evaluated.fillText,
        details: evaluated.details
    };
}
/** 结果区第一行的 id：填入输入框后选中它；没有稳定结果时返回 undefined */
function getResultItemId(result) {
    if (result.type === "none" || result.loadingCurrency)
        return undefined;
    if (result.type === "color" && result.colorResult)
        return "color-hex";
    return result.error ? "calc-error" : "calc-success";
}
const HISTORY_TYPES = ["math", "unit", "currency", "date", "color"];
const isText = (v) => typeof v === "string";
const isHistoryItem = (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v))
        return false;
    const item = v;
    return (isText(item.id) &&
        isText(item.expression) &&
        isText(item.answer) &&
        HISTORY_TYPES.includes(item.type) &&
        (item.pinned === undefined || typeof item.pinned === "boolean") &&
        typeof item.timestamp === "number" &&
        Number.isFinite(item.timestamp));
};
// 独立窗口带来的历史里有一项不合法（旧版本形状、篡改）就整份不用，等存储读取结果
const isHistory = (v) => Array.isArray(v) && v.every(isHistoryItem);
/** calc-unit 命令：同一个计算器，只列单位换算示例 */
export function calcUnit() {
    return CalculatorCommand({ unitOnly: true });
}
export default function CalculatorCommand(props) {
    const locale = useLocale();
    const unitOnly = props?.unitOnly === true;
    const examples = DEFAULT_CALC_EXAMPLES
        .map((eg, idx) => ({ ...eg, idx }))
        .filter((eg) => !unitOnly || eg.isUnit === true);
    const { push } = useNavigation();
    // 当前算式与历史随独立窗口带走：新窗口首帧就能显示，不闪空列表
    const [searchText, setSearchText] = usePopoutValue("searchText", () => "", isText);
    // 填入输入框后要选中的结果行 id（受控 selectedItemId）；用户自己输入或移动选中项后清空
    const [selectedItemId, setSelectedItemId] = useState(undefined);
    const [history, setHistory] = usePopoutValue("history", () => [], isHistory);
    // 仅当用户输入匹配汇率换算算式时才按需加载实时汇率；普通四则运算与单位换算零网络开销
    const inlineCurrencyCandidate = useMemo(() => {
        const sync = evaluateCalculatorQuery(searchText, { locale });
        if (sync.type === "none" || (sync.type === "math" && Boolean(sync.error))) {
            return parseInlineCurrencyQuery(searchText);
        }
        return null;
    }, [searchText, locale]);
    const { snapshot: rateSnapshot, origin: rateOrigin, rateError, loading: rateLoading, loadRates } = useRates({
        enabled: inlineCurrencyCandidate?.kind === "convert",
        silentToast: true
    });
    // 历史以插件存储为准：带来的那份只用于首帧，读到存储后覆盖
    useEffect(() => {
        let active = true;
        void getCalculatorHistory()
            .then((items) => {
            if (active)
                setHistory(items);
        })
            .catch((error) => {
            if (active) {
                void showToast(Toast.Style.Failure, t("historyLoadFailedTitle"), error instanceof Error ? error.message : String(error));
            }
        });
        return () => {
            active = false;
        };
    }, []);
    const queryResult = useMemo(() => resolveQueryWithCurrency(searchText, rateSnapshot, rateOrigin, rateLoading, rateError, locale), [searchText, rateSnapshot, rateOrigin, rateLoading, rateError, locale]);
    // 用户在输入框里打字：只更新文字，选中项由渲染器重置到第一项
    const handleSearchTextChange = (text) => {
        setSearchText(text);
        setSelectedItemId(undefined);
    };
    // 「填入搜索框」类动作：写回受控输入框，并选中新算出的结果行，按 Enter 即可复制新结果。
    // 填入的文字当前算不出结果时（如离线状态下的历史汇率项）保留选中来源条目本身，
    // 避免渲染器默认落到第一条不相关的历史记录。
    const fillSearch = (text, sourceItemId) => {
        setSearchText(text);
        const immediate = resolveQueryWithCurrency(text, rateSnapshot, rateOrigin, rateLoading, rateError, locale);
        // 若来自历史条目且当前因缺少汇率报错，优先选中来源历史项本身以支持直接回车复制原值
        if (sourceItemId && immediate.type === "currency" && (immediate.error || immediate.loadingCurrency)) {
            setSelectedItemId(sourceItemId);
            return;
        }
        setSelectedItemId(getResultItemId(immediate) ?? sourceItemId);
    };
    // 修改历史记录：存储读写失败时提示，界面保持原样，不能当作成功
    const updateHistory = async (task) => {
        try {
            setHistory(await task());
            return true;
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("historySaveFailedTitle"), err instanceof Error ? err.message : String(err));
            return false;
        }
    };
    const recordCurrentQuery = async () => {
        if (queryResult.type !== "none" && !queryResult.error && !queryResult.loadingCurrency) {
            const type = queryResult.type;
            await updateHistory(() => addCalculatorHistory(queryResult.expression, queryResult.formattedAnswer, type));
        }
    };
    // record：只有复制 / 粘贴「当前输入的计算结果」才记入历史；
    // 复制历史项、置顶项或示例时不能把输入框里另一条无关算式顺带写进历史
    const handleCopy = async (text, label, record = true) => {
        await Clipboard.copy(text);
        await showToast(Toast.Style.Success, t("copiedToastTitle", { label }), text);
        if (record)
            await recordCurrentQuery();
    };
    const handlePaste = async (text, record = true) => {
        await Clipboard.paste(text);
        await showToast(Toast.Style.Success, t("pastedToastTitle"), text);
        if (record)
            await recordCurrentQuery();
    };
    const handleTogglePin = async (id) => {
        await updateHistory(() => togglePinCalculatorHistory(id));
    };
    const handleDeleteHistory = async (id) => {
        if (await updateHistory(() => deleteCalculatorHistory(id))) {
            await showToast(Toast.Style.Success, t("deletedHistoryToast"));
        }
    };
    const handleClearHistory = async () => {
        const confirmed = await confirmAlert({
            title: t("clearHistoryConfirmTitle"),
            message: t("clearHistoryConfirmMessage", { count: history.length }),
            primaryAction: { title: t("clearHistoryConfirmPrimary"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!confirmed)
            return;
        if (await updateHistory(async () => {
            await clearCalculatorHistory();
            return [];
        })) {
            await showToast(Toast.Style.Success, t("clearedHistoryToast"));
        }
    };
    const openCurrencyBoard = (initialQuery) => {
        push(() => CurrencyCommand(initialQuery ? { initialQuery } : undefined));
    };
    const pinnedItems = history.filter((item) => item.pinned);
    const recentItems = history.filter((item) => !item.pinned);
    return (React.createElement(List, { isLoading: Boolean(queryResult.loadingCurrency), actions: ActionPanel({}, [
            Action({ title: t("actionOpenRmb"), icon: Icon.Text, onAction: () => push(RmbCommand) }),
            Action({ title: t("actionOpenCurrency"), icon: Icon.Globe, onAction: () => openCurrencyBoard() })
        ]), searchBarPlaceholder: unitOnly
            ? t("placeholderUnitOnly")
            : t("placeholderDefault"), searchText: searchText, onSearchTextChange: handleSearchTextChange, selectedItemId: selectedItemId, onSelectionChange: () => setSelectedItemId(undefined) },
        queryResult.type === "color" && queryResult.colorResult && (React.createElement(List.Section, { title: t("sectionColor") },
            React.createElement(List.Item, { id: "color-hex", title: queryResult.colorResult.hex, subtitle: t("colorHexSubtitle", {
                    white: queryResult.colorResult.contrastWhite,
                    black: queryResult.colorResult.contrastBlack
                }), icon: Icon.Eye, accessories: [{ text: "HEX" }], actions: React.createElement(ActionPanel, { title: t("panelColorActions") },
                    React.createElement(Action, { title: t("actionCopyHex"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hex, "HEX") }),
                    React.createElement(Action, { title: t("actionCopyRgb"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.rgb, "RGB") }),
                    React.createElement(Action, { title: t("actionCopyHsl"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hsl, "HSL") }),
                    React.createElement(Action, { title: t("actionCopyCmyk"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.cmyk, "CMYK") }),
                    React.createElement(Action, { title: t("actionPasteToApp"), icon: Icon.Checkmark, onAction: () => handlePaste(queryResult.colorResult.hex) })) }),
            React.createElement(List.Item, { id: "color-rgb", title: queryResult.colorResult.rgb, subtitle: t("colorRgbSubtitle"), icon: Icon.Document, accessories: [{ text: "RGB" }], actions: React.createElement(ActionPanel, { title: t("panelColorActions") },
                    React.createElement(Action, { title: t("actionCopyRgb"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.rgb, "RGB") })) }),
            React.createElement(List.Item, { id: "color-hsl", title: queryResult.colorResult.hsl, subtitle: t("colorHslSubtitle"), icon: Icon.Document, accessories: [{ text: "HSL" }], actions: React.createElement(ActionPanel, { title: t("panelColorActions") },
                    React.createElement(Action, { title: t("actionCopyHsl"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hsl, "HSL") })) }),
            React.createElement(List.Item, { id: "color-cmyk", title: queryResult.colorResult.cmyk, subtitle: t("colorCmykSubtitle"), icon: Icon.Document, accessories: [{ text: "CMYK" }], actions: React.createElement(ActionPanel, { title: t("panelColorActions") },
                    React.createElement(Action, { title: t("actionCopyCmyk"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.cmyk, "CMYK") })) }))),
        queryResult.type !== "none" && queryResult.type !== "color" && (React.createElement(List.Section, { title: t("sectionResult") }, queryResult.loadingCurrency ? (React.createElement(List.Item, { id: "calc-loading", title: t("loadingCurrencyTitle"), subtitle: queryResult.expression, icon: Icon.Globe })) : queryResult.error ? (React.createElement(List.Item, { id: "calc-error", title: queryResult.type === "currency" ? t("currencyErrorTitle") : t("mathErrorTitle"), subtitle: queryResult.error, icon: Icon.ExclamationMark, actions: queryResult.type === "currency" ? (React.createElement(ActionPanel, { title: t("panelCurrencyActions") },
                React.createElement(Action, { title: t("actionRefreshLiveRates"), icon: Icon.ArrowClockwise, onAction: () => loadRates(true) }),
                React.createElement(Action, { title: t("actionOpenCurrencyBoard"), icon: Icon.Globe, onAction: () => openCurrencyBoard(queryResult.expression) }))) : undefined })) : (React.createElement(List.Item, { id: "calc-success", title: `= ${queryResult.formattedAnswer}`, subtitle: queryResult.details
                ? `${queryResult.expression} (${queryResult.details})`
                : queryResult.expression, icon: queryResult.type === "currency" ? Icon.Globe : Icon.Terminal, accessories: [{ text: t("accessoryEnterCopy") }], actions: React.createElement(ActionPanel, { title: t("panelCalcActions") },
                React.createElement(Action, { title: t("actionCopyResult"), icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.formattedAnswer, t("labelCalcResult")) }),
                React.createElement(Action, { title: t("actionPasteToApp"), icon: Icon.Checkmark, shortcut: { modifiers: ["ctrl", "shift"], key: "v" }, onAction: () => handlePaste(queryResult.formattedAnswer) }),
                React.createElement(Action, { title: t("actionCopyFullExpr"), icon: Icon.CopyClipboard, shortcut: { modifiers: ["ctrl", "alt"], key: "c" }, onAction: () => handleCopy(`${queryResult.expression} = ${queryResult.formattedAnswer}`, t("labelFullExpr")) }),
                queryResult.fillText !== undefined && (React.createElement(Action, { title: t("actionFillInput"), icon: Icon.Pencil, shortcut: { modifiers: ["ctrl"], key: "e" }, onAction: () => fillSearch(queryResult.fillText) })),
                React.createElement(Action, { title: t("actionSaveToHistory"), icon: Icon.Pin, shortcut: { modifiers: ["ctrl"], key: "p" }, onAction: async () => {
                        const saved = await updateHistory(() => addCalculatorHistory(queryResult.expression, queryResult.formattedAnswer, (queryResult.type === "none" ? "math" : queryResult.type)));
                        if (saved)
                            await showToast(Toast.Style.Success, t("savedToHistoryToast"));
                    } }),
                queryResult.type === "currency" && (React.createElement(Action, { title: t("actionViewAllCurrencies"), icon: Icon.Globe, shortcut: { modifiers: ["ctrl"], key: "r" }, onAction: () => openCurrencyBoard(inlineCurrencyCandidate?.kind === "convert"
                        ? `${inlineCurrencyCandidate.amountText} ${inlineCurrencyCandidate.from}`
                        : queryResult.expression) }))) })))),
        pinnedItems.length > 0 && (React.createElement(List.Section, { title: t("sectionPinned") }, pinnedItems.map((item) => (React.createElement(List.Item, { key: item.id, id: item.id, title: `= ${item.answer}`, subtitle: item.expression, icon: Icon.Pin, accessories: [{ text: t("accessoryPinned") }], actions: React.createElement(ActionPanel, { title: t("panelPinnedActions") },
                React.createElement(Action, { title: t("actionCopyShort"), icon: Icon.CopyClipboard, onAction: () => handleCopy(item.answer, t("labelPinnedResult"), false) }),
                React.createElement(Action, { title: t("actionPasteShort"), icon: Icon.Checkmark, onAction: () => handlePaste(item.answer, false) }),
                React.createElement(Action, { title: t("actionUnpin"), icon: Icon.Pin, onAction: () => handleTogglePin(item.id) }),
                React.createElement(Action, { title: t("actionFillSearch"), icon: Icon.Pencil, onAction: () => fillSearch(item.expression, item.id) }),
                React.createElement(Action, { title: t("actionDeleteItem"), icon: Icon.Trash, onAction: () => handleDeleteHistory(item.id) })) }))))),
        recentItems.length > 0 && (React.createElement(List.Section, { title: t("sectionRecent") }, recentItems.slice(0, 15).map((item) => (React.createElement(List.Item, { key: item.id, id: item.id, title: `= ${item.answer}`, subtitle: item.expression, icon: Icon.Clock, accessories: [{ text: t(HISTORY_TYPE_KEYS[item.type] ?? "historyTypeMath") }], actions: React.createElement(ActionPanel, { title: t("panelHistoryActions") },
                React.createElement(Action, { title: t("actionCopyShort"), icon: Icon.CopyClipboard, onAction: () => handleCopy(item.answer, t("labelHistoryResult"), false) }),
                React.createElement(Action, { title: t("actionPasteShort"), icon: Icon.Checkmark, onAction: () => handlePaste(item.answer, false) }),
                React.createElement(Action, { title: t("actionPinExpr"), icon: Icon.Pin, shortcut: { modifiers: ["ctrl"], key: "p" }, onAction: () => handleTogglePin(item.id) }),
                React.createElement(Action, { title: t("actionFillSearch"), icon: Icon.Pencil, onAction: () => fillSearch(item.expression, item.id) }),
                React.createElement(Action, { title: t("actionDeleteItem"), icon: Icon.Trash, shortcut: { modifiers: ["ctrl"], key: "x" }, onAction: () => handleDeleteHistory(item.id) }),
                React.createElement(Action, { title: t("actionClearAllHistory"), icon: Icon.Trash, onAction: handleClearHistory })) }))))),
        React.createElement(List.Section, { title: unitOnly ? t("sectionExamplesUnit") : t("sectionExamplesAll") }, examples.map(({ idx, ...eg }) => (React.createElement(List.Item, { key: idx, id: `eg-${idx}`, title: eg.expr, subtitle: t(eg.descKey), icon: Icon.Terminal, 
            // 单位换算入口里每一行都是“换算”，标签不提供区分信息，只在混合示例里显示分类
            accessories: unitOnly ? [] : [{ text: t(eg.categoryKey) }], actions: React.createElement(ActionPanel, { title: t("panelExamples") },
                React.createElement(Action, { title: t("actionFillAndCalc"), icon: Icon.Pencil, onAction: () => fillSearch(eg.expr, `eg-${idx}`) }),
                React.createElement(Action, { title: t("actionCopyExpr"), icon: Icon.CopyClipboard, onAction: () => handleCopy(eg.expr, t("labelExpr"), false) })) }))))));
}
