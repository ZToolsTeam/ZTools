import { List, ActionPanel, Action, Icon, useState, useEffect, useRef } from "@ztools/declarative-ui";
import { getRates, convertCurrency } from "./currency-rates.js";
export default function CurrencyCommand() {
    const [input, setInput] = useState("1 USD to CNY");
    const [table, setTable] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const active = useRef(true);
    const busy = useRef(false);
    const load = async () => {
        if (busy.current)
            return;
        busy.current = true;
        setLoading(true);
        setError("");
        // 缓存过期时先用旧汇率（摘要标注汇率时间），后台取到新汇率后自动替换
        try {
            const value = await getRates((fresh) => { if (active.current)
                setTable(fresh); });
            if (active.current)
                setTable(value);
        }
        catch (err) {
            if (active.current) {
                setTable(null);
                setError(err instanceof Error ? err.message : String(err));
            }
        }
        finally {
            busy.current = false;
            if (active.current)
                setLoading(false);
        }
    };
    useEffect(() => { active.current = true; void load(); return () => { active.current = false; }; }, []);
    let result = "";
    let inputError = "";
    if (table) {
        try {
            result = convertCurrency(input, table);
        }
        catch (err) {
            inputError = err instanceof Error ? err.message : String(err);
        }
    }
    const refresh = Action({ title: "刷新汇率", icon: Icon.Repeat, onAction: load });
    return List({ navigationTitle: "汇率换算", searchText: input, onSearchTextChange: setInput, searchBarPlaceholder: "如 100 USD to CNY，使用三位币种代码", isLoading: loading, filterBar: { summaryText: table ? (table.stale ? `使用缓存汇率，来源更新于 ${new Date(table.updatedAt).toLocaleString()} · 已过更新时间` : `来源更新于 ${new Date(table.updatedAt).toLocaleString()} · 每日更新`) : "从 ExchangeRate-API 获取每日汇率" }, actions: ActionPanel({}, [refresh]) }, [
        List.Item({ id: result ? "currency-result" : "currency-error", title: result || error || inputError || "正在获取汇率…", subtitle: result ? input : "请求失败时不使用估算值", icon: error || inputError ? Icon.ExclamationMark : Icon.Globe, actions: ActionPanel({}, [...(result ? [Action.CopyToClipboard({ title: "复制换算结果", content: result })] : []), refresh]) }),
        List.Item({ id: "currency-source", title: "汇率来源：ExchangeRate-API", subtitle: "每日更新，可打开来源网站", icon: Icon.Globe, actions: ActionPanel({}, [Action.OpenInBrowser({ title: "打开汇率来源", url: "https://www.exchangerate-api.com" })]) })
    ]);
}
