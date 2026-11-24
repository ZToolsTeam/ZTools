import { List, ActionPanel, Action, Icon, useState, useLocale } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { RMB_DIGITS, RMB_UNITS, RMB_SECTION_UNITS, RMB_ZERO, RMB_NEGATIVE, RMB_YUAN, RMB_ZHENG, RMB_JIAO, RMB_FEN } from "./rmb.zh-data.js";
function groupText(group) {
    let text = "";
    let zero = false;
    for (let i = 0; i < group.length; i++) {
        const digit = Number(group[i]);
        if (digit === 0) {
            if (text)
                zero = true;
            continue;
        }
        if (zero)
            text += RMB_ZERO;
        text += RMB_DIGITS[digit] + RMB_UNITS[group.length - i - 1];
        zero = false;
    }
    return text;
}
/** 按十进制原文转换到分，不经浮点运算或静默四舍五入。 */
export function toChineseAmount(input) {
    const text = input.trim();
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))
        throw new Error(t("rmbErrInvalidFormat"));
    const [rawInteger, rawFraction = ""] = text.replace(/^-/, "").replace(/,/g, "").split(".");
    const integer = rawInteger.replace(/^0+(?=\d)/, "");
    if (integer.length > 12)
        throw new Error(t("rmbErrTooLarge"));
    const groups = [];
    for (let end = integer.length; end > 0; end -= 4)
        groups.unshift(integer.slice(Math.max(0, end - 4), end));
    let result = "";
    let gap = false;
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (Number(group) === 0) {
            if (result)
                gap = true;
            continue;
        }
        if (result && (gap || Number(group) < 1000))
            result += RMB_ZERO;
        result += groupText(group) + RMB_SECTION_UNITS[groups.length - i - 1];
        gap = false;
    }
    const [jiao, fen] = rawFraction.padEnd(2, "0").split("").map(Number);
    const negative = text.startsWith("-") && (integer !== "0" || jiao !== 0 || fen !== 0);
    result = (negative ? RMB_NEGATIVE : "") + (result || RMB_ZERO) + RMB_YUAN;
    if (!jiao && !fen)
        return result + RMB_ZHENG;
    if (jiao)
        result += RMB_DIGITS[jiao] + RMB_JIAO;
    else if (integer !== "0")
        result += RMB_ZERO;
    if (fen)
        result += RMB_DIGITS[fen] + RMB_FEN;
    return result;
}
export default function RmbCommand() {
    useLocale();
    const [text, setText] = useState("");
    let result = "";
    let error = "";
    if (text.trim()) {
        try {
            result = toChineseAmount(text);
        }
        catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
    }
    return List({
        navigationTitle: t("rmbNavTitle"),
        searchText: text,
        onSearchTextChange: setText,
        searchBarPlaceholder: t("rmbSearchPlaceholder")
    }, [
        List.Item({
            id: result ? "rmb-result" : "rmb-input",
            title: result || error || t("rmbIdleTitle"),
            subtitle: result ? t("rmbResultSubtitle", { amount: text.trim() }) : t("rmbIdleSubtitle"),
            icon: error ? Icon.ExclamationMark : Icon.Text,
            actions: result ? ActionPanel({}, [Action.CopyToClipboard({ title: t("rmbActionCopy"), content: result })]) : undefined
        })
    ]);
}
