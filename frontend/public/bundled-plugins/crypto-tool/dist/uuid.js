import { List, ActionPanel, Action, Icon, useState, showToast, Toast } from "@ztools/declarative-ui";
import { generateUuids } from "./codecs.js";
import { valueMarkdown } from "./logic.js";
export default function GenUuidCommand() {
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
            await showToast(Toast.Style.Failure, "生成失败", message);
        }
    };
    const action = Action({ title: "生成 UUID", icon: Icon.Repeat, onAction: generate });
    return List({ navigationTitle: "UUID 批量生成", searchText: count, onSearchTextChange: value => { setCount(value); setResult(""); setError(""); }, searchBarPlaceholder: "输入数量：1 到 1000，留空生成 1 个", isShowingDetail: Boolean(result) }, [List.Item({ id: "uuid-result", title: result ? `已生成 ${result.split("\n").length} 个 UUID` : error || "生成 UUID v4", subtitle: "使用系统安全随机数，每行一个", icon: error ? Icon.ExclamationMark : Icon.Key, detail: result ? List.Item.Detail({ markdown: valueMarkdown(result) }) : undefined, actions: ActionPanel({}, [...(result ? [Action.CopyToClipboard({ title: "复制全部 UUID", content: result })] : []), action]) })]);
}
