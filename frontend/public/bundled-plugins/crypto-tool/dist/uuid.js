import { List, ActionPanel, Action, Icon, useState, useLocale, showToast, Toast } from "@ztools/declarative-ui";
import { generateUuids } from "./codecs.js";
import { valueMarkdown } from "./logic.js";
import { t } from "./i18n.js";
export default function GenUuidCommand() {
    useLocale();
    // 搜索框默认留空，显示占位提示；留空按 1 个生成
    const [count, setCount] = useState("");
    const [result, setResult] = useState("");
    const [error, setError] = useState("");
    const generate = async () => {
        try {
            setResult(generateUuids(count.trim() || "1").join("\n"));
            setError("");
        }
        catch (err) {
            setResult("");
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            await showToast(Toast.Style.Failure, t("uuidGenFailed"), message);
        }
    };
    const action = Action({ title: t("uuidGenAction"), icon: Icon.Repeat, onAction: generate });
    return List({ navigationTitle: t("uuidNavTitle"), searchText: count, onSearchTextChange: value => { setCount(value); setResult(""); setError(""); }, searchBarPlaceholder: t("uuidPlaceholder"), isShowingDetail: Boolean(result) }, [List.Item({ id: "uuid-result", title: result ? t("uuidGeneratedTitle", { count: result.split("\n").length }) : error || t("uuidDefaultTitle"), subtitle: t("uuidSubtitle"), icon: error ? Icon.ExclamationMark : Icon.Key, detail: result ? List.Item.Detail({ markdown: valueMarkdown(result) }) : undefined, actions: ActionPanel({}, [...(result ? [Action.CopyToClipboard({ title: t("uuidCopyAll"), content: result })] : []), action]) })]);
}
