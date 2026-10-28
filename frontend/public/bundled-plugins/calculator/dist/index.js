import React from "@ztools/declarative-ui";
import { confirmAlert } from "@ztools/declarative-ui";
import { List, ActionPanel, Action, Icon, showToast, Toast, Clipboard } from "@ztools/declarative-ui";
import { useState, useEffect, useMemo, useNavigation } from "@ztools/declarative-ui";
import RmbCommand from "./rmb.js";
import CurrencyCommand from "./currency.js";
export { default as calcRmb } from "./rmb.js";
export { default as calcCurrency } from "./currency.js";
import { evaluateCalculatorQuery, getCalculatorHistory, addCalculatorHistory, togglePinCalculatorHistory, deleteCalculatorHistory, clearCalculatorHistory } from "./calculator-engine.js";
import { usePopoutValue } from "./popout-state.js";
export * from "./calculator-engine.js";
const DEFAULT_CALC_EXAMPLES = [
    { expr: "1024 * 768", desc: "分辨率像素点四则运算", category: "数学" },
    { expr: "sqrt(65536)", desc: "平方根函数计算", category: "数学" },
    { expr: "2 ^ 16", desc: "指数幂运算", category: "数学" },
    { expr: "sin(pi / 2)", desc: "三角函数与常数", category: "数学" },
    { expr: "32px to rem", desc: "前端 CSS px 与 rem 极客换算", category: "换算" },
    { expr: "2.5rem to px", desc: "CSS rem 转像素 (基于 16px)", category: "换算" },
    { expr: "10km to miles", desc: "公制与英制度量衡换算", category: "换算" },
    { expr: "5kg to lbs", desc: "重量单位千克转磅", category: "换算" },
    { expr: "100c to f", desc: "摄氏度与华氏度互转", category: "换算" },
    { expr: "1024mb to gb", desc: "计算机存储容量二进制换算", category: "换算" },
    { expr: "0xFF to dec", desc: "十六进制转十进制", category: "进制" },
    { expr: "255 to hex", desc: "十进制转十六进制 (0xFF)", category: "进制" },
    { expr: "255 to bin", desc: "十进制转二进制 (0b11111111)", category: "进制" },
    { expr: "now + 2 weeks", desc: "未来相对日期与时间推算", category: "日期" },
    { expr: "#3B82F6", desc: "HEX 颜色预览、互转与 WCAG 对比度", category: "色彩" },
    { expr: "rgb(59, 130, 246)", desc: "RGB 格式色彩即时检测", category: "色彩" }
];
/** 结果区第一行的 id：填入输入框后选中它；没有结果时返回 undefined（交给渲染器默认选第一项） */
function getResultItemId(result) {
    if (result.type === "none")
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
export default function CalculatorCommand() {
    const { push } = useNavigation();
    // 当前算式与历史随独立窗口带走：新窗口首帧就能显示，不闪空列表
    const [searchText, setSearchText] = usePopoutValue("searchText", () => "", isText);
    // 填入输入框后要选中的结果行 id（受控 selectedItemId）；用户自己输入或移动选中项后清空
    const [selectedItemId, setSelectedItemId] = useState(undefined);
    const [history, setHistory] = usePopoutValue("history", () => [], isHistory);
    // 历史以插件存储为准：带来的那份只用于首帧，读到存储后覆盖
    useEffect(() => {
        let active = true;
        void getCalculatorHistory().then(items => { if (active)
            setHistory(items); }).catch(error => {
            if (active)
                void showToast(Toast.Style.Failure, "读取计算历史失败，原数据保留", error instanceof Error ? error.message : String(error));
        });
        return () => { active = false; };
    }, []);
    const queryResult = useMemo(() => {
        return evaluateCalculatorQuery(searchText);
    }, [searchText]);
    // 用户在输入框里打字：只更新文字，选中项由渲染器重置到第一项
    const handleSearchTextChange = (text) => {
        setSearchText(text);
        setSelectedItemId(undefined);
    };
    // 「填入搜索框」类动作：写回受控输入框，并选中新算出的结果行，按 Enter 即可复制新结果。
    // 填入的文字算不出结果时（如旧版本存下、现已不支持的历史算式）选中来源条目本身，
    // 不能交给渲染器默认选第一行，否则 Enter 会作用于不相关的历史项。
    const fillSearch = (text, sourceItemId) => {
        setSearchText(text);
        setSelectedItemId(getResultItemId(evaluateCalculatorQuery(text)) ?? sourceItemId);
    };
    // 修改历史记录：存储读写失败时提示，界面保持原样，不能当作成功
    const updateHistory = async (task) => {
        try {
            setHistory(await task());
            return true;
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "历史记录保存失败", err instanceof Error ? err.message : String(err));
            return false;
        }
    };
    const recordCurrentQuery = async () => {
        if (queryResult.type !== "none" && !queryResult.error) {
            const type = queryResult.type;
            await updateHistory(() => addCalculatorHistory(queryResult.expression, queryResult.formattedAnswer, type));
        }
    };
    const handleCopy = async (text, label) => {
        await Clipboard.copy(text);
        await showToast(Toast.Style.Success, `已复制 ${label}`, text);
        await recordCurrentQuery();
    };
    const handlePaste = async (text) => {
        await Clipboard.paste(text);
        await showToast(Toast.Style.Success, "已粘贴到前台应用", text);
        await recordCurrentQuery();
    };
    const handleTogglePin = async (id) => {
        await updateHistory(() => togglePinCalculatorHistory(id));
    };
    const handleDeleteHistory = async (id) => {
        if (await updateHistory(() => deleteCalculatorHistory(id))) {
            await showToast(Toast.Style.Success, "已删除历史记录");
        }
    };
    const handleClearHistory = async () => {
        const confirmed = await confirmAlert({
            title: "清空全部计算历史？",
            message: `将删除全部 ${history.length} 条记录（含已固定的），且无法恢复。`,
            primaryAction: { title: "清空", style: "destructive" },
            dismissAction: { title: "取消" }
        });
        if (!confirmed)
            return;
        if (await updateHistory(async () => { await clearCalculatorHistory(); return []; })) {
            await showToast(Toast.Style.Success, "已清空所有历史计算记录");
        }
    };
    const pinnedItems = history.filter(item => item.pinned);
    const recentItems = history.filter(item => !item.pinned);
    return (React.createElement(List, { actions: ActionPanel({}, [Action({ title: "人民币大写…", icon: Icon.Text, onAction: () => push(RmbCommand) }), Action({ title: "汇率换算…", icon: Icon.Globe, onAction: () => push(CurrencyCommand) })]), searchBarPlaceholder: "\u8F93\u5165\u7B97\u5F0F\uFF0C\u5982 128*1024\u300132px to rem\u30010xFF to dec\u3001now + 2 weeks", searchText: searchText, onSearchTextChange: handleSearchTextChange, selectedItemId: selectedItemId, onSelectionChange: () => setSelectedItemId(undefined) },
        queryResult.type === "color" && queryResult.colorResult && (React.createElement(List.Section, { title: "\u8272\u5F69\u8BC6\u522B\u4E0E\u5373\u65F6\u8F6C\u6362" },
            React.createElement(List.Item, { id: "color-hex", title: queryResult.colorResult.hex, subtitle: `HEX 色彩代码 | 对比度 白:${queryResult.colorResult.contrastWhite}:1 黑:${queryResult.colorResult.contrastBlack}:1`, icon: Icon.Eye, accessories: [{ text: "HEX" }], actions: React.createElement(ActionPanel, { title: "\u8272\u5F69\u52A8\u4F5C" },
                    React.createElement(Action, { title: "\u590D\u5236 HEX", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hex, "HEX") }),
                    React.createElement(Action, { title: "\u590D\u5236 RGB", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.rgb, "RGB") }),
                    React.createElement(Action, { title: "\u590D\u5236 HSL", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hsl, "HSL") }),
                    React.createElement(Action, { title: "\u590D\u5236 CMYK", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.cmyk, "CMYK") }),
                    React.createElement(Action, { title: "\u7C98\u8D34\u5230\u524D\u53F0\u5E94\u7528", icon: Icon.Checkmark, onAction: () => handlePaste(queryResult.colorResult.hex) })) }),
            React.createElement(List.Item, { id: "color-rgb", title: queryResult.colorResult.rgb, subtitle: "RGB \u683C\u5F0F", icon: Icon.Document, accessories: [{ text: "RGB" }], actions: React.createElement(ActionPanel, { title: "\u8272\u5F69\u52A8\u4F5C" },
                    React.createElement(Action, { title: "\u590D\u5236 RGB", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.rgb, "RGB") })) }),
            React.createElement(List.Item, { id: "color-hsl", title: queryResult.colorResult.hsl, subtitle: "HSL \u683C\u5F0F", icon: Icon.Document, accessories: [{ text: "HSL" }], actions: React.createElement(ActionPanel, { title: "\u8272\u5F69\u52A8\u4F5C" },
                    React.createElement(Action, { title: "\u590D\u5236 HSL", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.hsl, "HSL") })) }),
            React.createElement(List.Item, { id: "color-cmyk", title: queryResult.colorResult.cmyk, subtitle: "\u5370\u5237 CMYK \u683C\u5F0F", icon: Icon.Document, accessories: [{ text: "CMYK" }], actions: React.createElement(ActionPanel, { title: "\u8272\u5F69\u52A8\u4F5C" },
                    React.createElement(Action, { title: "\u590D\u5236 CMYK", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.colorResult.cmyk, "CMYK") })) }))),
        queryResult.type !== "none" && queryResult.type !== "color" && (React.createElement(List.Section, { title: "\u8BA1\u7B97\u4E0E\u6362\u7B97\u7ED3\u679C" }, queryResult.error ? (React.createElement(List.Item, { id: "calc-error", title: "\u8F93\u5165\u7B97\u5F0F\u6709\u8BEF", subtitle: queryResult.error, icon: Icon.ExclamationMark })) : (React.createElement(List.Item, { id: "calc-success", title: `= ${queryResult.formattedAnswer}`, subtitle: queryResult.details ? `${queryResult.expression} (${queryResult.details})` : queryResult.expression, icon: Icon.Terminal, accessories: [{ text: "回车复制结果" }], actions: React.createElement(ActionPanel, { title: "\u8BA1\u7B97\u5668\u64CD\u4F5C" },
                React.createElement(Action, { title: "\u590D\u5236\u8BA1\u7B97\u7ED3\u679C", icon: Icon.CopyClipboard, onAction: () => handleCopy(queryResult.formattedAnswer, "计算结果") }),
                React.createElement(Action, { title: "\u56DE\u8F66\u7C98\u8D34\u5230\u524D\u53F0\u5E94\u7528", icon: Icon.Checkmark, shortcut: { modifiers: ["ctrl", "shift"], key: "v" }, onAction: () => handlePaste(queryResult.formattedAnswer) }),
                React.createElement(Action, { title: "\u590D\u5236\u5B8C\u6574\u7B97\u5F0F\u4E0E\u7ED3\u679C", icon: Icon.CopyClipboard, shortcut: { modifiers: ["ctrl", "alt"], key: "c" }, onAction: () => handleCopy(`${queryResult.expression} = ${queryResult.formattedAnswer}`, "完整算式") }),
                queryResult.fillText !== undefined && (React.createElement(Action, { title: "\u5C06\u7ED3\u679C\u586B\u5165\u8F93\u5165\u6846", icon: Icon.Pencil, shortcut: { modifiers: ["ctrl"], key: "e" }, onAction: () => fillSearch(queryResult.fillText) })),
                React.createElement(Action, { title: "\u4FDD\u5B58\u5230\u5386\u53F2\u7B97\u5F0F", icon: Icon.Pin, shortcut: { modifiers: ["ctrl"], key: "p" }, onAction: async () => {
                        const saved = await updateHistory(() => addCalculatorHistory(queryResult.expression, queryResult.formattedAnswer, (queryResult.type === "none" ? "math" : queryResult.type)));
                        if (saved)
                            await showToast(Toast.Style.Success, "已保存到历史记录");
                    } })) })))),
        pinnedItems.length > 0 && (React.createElement(List.Section, { title: "\u5DF2\u7F6E\u9876\u5E38\u7528\u6570\u5B57\u4E0E\u7B97\u5F0F (Pinned)" }, pinnedItems.map(item => (React.createElement(List.Item, { key: item.id, id: item.id, title: `= ${item.answer}`, subtitle: item.expression, icon: Icon.Pin, accessories: [{ text: "置顶" }], actions: React.createElement(ActionPanel, { title: "\u7F6E\u9876\u9879\u64CD\u4F5C" },
                React.createElement(Action, { title: "\u590D\u5236\u7ED3\u679C", icon: Icon.CopyClipboard, onAction: () => handleCopy(item.answer, "置顶结果") }),
                React.createElement(Action, { title: "\u7C98\u8D34\u5230\u524D\u53F0", icon: Icon.Checkmark, onAction: () => handlePaste(item.answer) }),
                React.createElement(Action, { title: "\u53D6\u6D88\u7F6E\u9876", icon: Icon.Pin, onAction: () => handleTogglePin(item.id) }),
                React.createElement(Action, { title: "\u586B\u5165\u641C\u7D22\u6846", icon: Icon.Pencil, onAction: () => fillSearch(item.expression, item.id) }),
                React.createElement(Action, { title: "\u5220\u9664\u6B64\u9879", icon: Icon.Trash, onAction: () => handleDeleteHistory(item.id) })) }))))),
        recentItems.length > 0 && (React.createElement(List.Section, { title: "\u8FD1\u671F\u8BA1\u7B97\u5386\u53F2 (Recent History)" }, recentItems.slice(0, 15).map(item => (React.createElement(List.Item, { key: item.id, id: item.id, title: `= ${item.answer}`, subtitle: item.expression, icon: Icon.Clock, accessories: [{ text: item.type.toUpperCase() }], actions: React.createElement(ActionPanel, { title: "\u5386\u53F2\u9879\u64CD\u4F5C" },
                React.createElement(Action, { title: "\u590D\u5236\u7ED3\u679C", icon: Icon.CopyClipboard, onAction: () => handleCopy(item.answer, "历史结果") }),
                React.createElement(Action, { title: "\u7C98\u8D34\u5230\u524D\u53F0", icon: Icon.Checkmark, onAction: () => handlePaste(item.answer) }),
                React.createElement(Action, { title: "\u7F6E\u9876\u6B64\u7B97\u5F0F", icon: Icon.Pin, shortcut: { modifiers: ["ctrl"], key: "p" }, onAction: () => handleTogglePin(item.id) }),
                React.createElement(Action, { title: "\u586B\u5165\u641C\u7D22\u6846", icon: Icon.Pencil, onAction: () => fillSearch(item.expression, item.id) }),
                React.createElement(Action, { title: "\u5220\u9664\u6B64\u9879", icon: Icon.Trash, shortcut: { modifiers: ["ctrl"], key: "x" }, onAction: () => handleDeleteHistory(item.id) }),
                React.createElement(Action, { title: "\u6E05\u7A7A\u5168\u90E8\u5386\u53F2\u8BB0\u5F55", icon: Icon.Trash, onAction: handleClearHistory })) }))))),
        React.createElement(List.Section, { title: "\u6781\u5BA2\u8BA1\u7B97\u3001\u5355\u4F4D\u6362\u7B97\u4E0E\u8BED\u6CD5\u793A\u4F8B (Examples)" }, DEFAULT_CALC_EXAMPLES.map((eg, idx) => (React.createElement(List.Item, { key: idx, id: `eg-${idx}`, title: eg.expr, subtitle: eg.desc, icon: Icon.Terminal, accessories: [{ text: eg.category }], actions: React.createElement(ActionPanel, { title: "\u5FEB\u901F\u793A\u4F8B" },
                React.createElement(Action, { title: "\u586B\u5165\u641C\u7D22\u6846\u5E76\u8BA1\u7B97", icon: Icon.Pencil, onAction: () => fillSearch(eg.expr, `eg-${idx}`) }),
                React.createElement(Action, { title: "\u590D\u5236\u8868\u8FBE\u5F0F", icon: Icon.CopyClipboard, onAction: () => handleCopy(eg.expr, "表达式") })) }))))));
}
