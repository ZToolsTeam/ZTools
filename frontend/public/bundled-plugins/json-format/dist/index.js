import React from "@ztools/declarative-ui";
import { Detail, Form, ActionPanel, Action, Icon, Color, showToast, Toast, Clipboard, useNavigation } from "@ztools/declarative-ui";
import { useMemo } from "@ztools/declarative-ui";
import { validateJson, formatJson, minifyJson, jsonToTsInterface, jsonToRustStruct, jsonToGoStruct, extractJsonPaths, fencedCode } from "./logic.js";
import { usePopoutValue } from "./popout-state.js";
/** JSONPath 索引在详情页里只展示前 N 项，取值过长时截断（复制动作给全量） */
const PATH_PREVIEW_LIMIT = 15;
const PATH_VALUE_MAX = 60;
/** 等宽字体下的显示宽度：中日韩等全角字符占两格，用于对齐路径列 */
function displayWidth(text) {
    let w = 0;
    for (const ch of text)
        w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    return w;
}
function pathIndexBlock(paths) {
    const shown = paths.slice(0, PATH_PREVIEW_LIMIT);
    const width = Math.max(...shown.map((p) => displayWidth(p.path)));
    const lines = shown.map((p) => {
        const value = p.displayValue.length > PATH_VALUE_MAX ? p.displayValue.slice(0, PATH_VALUE_MAX) + "..." : p.displayValue;
        return `${p.path}${" ".repeat(width - displayWidth(p.path))}  ${p.type.padEnd(7)}  ${value}`;
    });
    return `## 常用 JSONPath 路径索引 (前 ${shown.length} 项)\n${fencedCode(lines.join("\n"), "text")}`;
}
/**
 * 查看转换结果的二级详情页 (展示 JSON、TypeScript、Rust、Go 及 JSONPath)
 */
export function JsonDetailView({ formatted, tsInterface, rustStruct, goStruct, stats, jsonPaths }) {
    const rustCode = rustStruct || jsonToRustStruct(formatted);
    const goCode = goStruct || jsonToGoStruct(formatted);
    const paths = jsonPaths || extractJsonPaths(formatted);
    // 用户数据可能含 ```（如大模型返回的代码片段），围栏长度按内容动态选择，避免代码块被提前截断
    const markdown = [
        "# JSON 瑞士军刀与全栈类型推导",
        "## 格式化 JSON",
        fencedCode(formatted, "json"),
        "## 自动生成的 TypeScript Interface",
        fencedCode(tsInterface, "typescript"),
        "## 自动生成的 Rust Struct (serde)",
        fencedCode(rustCode, "rust"),
        "## 自动生成的 Go Struct",
        fencedCode(goCode, "go"),
        ...(paths.length > 0 ? [pathIndexBlock(paths)] : [])
    ].join("\n\n");
    return (React.createElement(Detail, { markdown: markdown, navigationTitle: "JSON \u683C\u5F0F\u5316\u8BE6\u60C5", metadata: stats ? (React.createElement(Detail.Metadata, null,
            React.createElement(Detail.Metadata.Label, { title: "\u952E\u6570\u91CF", text: `${stats.keys} 个`, icon: Icon.Key }),
            React.createElement(Detail.Metadata.Label, { title: "\u6700\u5927\u5C42\u7EA7", text: `${stats.depth} 层`, icon: Icon.Pin }),
            React.createElement(Detail.Metadata.Label, { title: "\u539F\u59CB\u5B57\u8282", text: `${stats.byteSize} Bytes`, icon: Icon.Document }),
            React.createElement(Detail.Metadata.Label, { title: "\u538B\u7F29\u4F53\u79EF", text: `${stats.minifiedSize} Bytes`, icon: Icon.Minus }),
            React.createElement(Detail.Metadata.Label, { title: "\u7A7A\u95F4\u8282\u7701", text: `${stats.compressionRatio}%`, icon: Icon.Checkmark }),
            React.createElement(Detail.Metadata.Separator, null),
            React.createElement(Detail.Metadata.TagList, { title: "\u8BED\u6CD5\u6821\u9A8C" },
                React.createElement(Detail.Metadata.TagList.Item, { text: "\u8BED\u6CD5\u5408\u6CD5", color: Color.Green, icon: Icon.Check })))) : undefined, actions: React.createElement(ActionPanel, { title: "\u64CD\u4F5C\u9762\u677F" },
            React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236\u683C\u5F0F\u5316 JSON (2 \u683C)", content: formatted, icon: Icon.CopyClipboard }),
            React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 TypeScript Interface", content: tsInterface, icon: Icon.Code }),
            React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 Rust Struct", content: rustCode, icon: Icon.Terminal }),
            React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 Go Struct", content: goCode, icon: Icon.Globe }),
            React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236\u538B\u7F29\u5355\u884C JSON", content: minifyJson(formatted), icon: Icon.Document }),
            paths.length > 0 && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236\u5168\u90E8 JSONPath \u5217\u8868", content: paths.map((p) => `${p.path} = ${p.displayValue}`).join("\n"), icon: Icon.List }))) }));
}
const isText = (v) => typeof v === "string";
const isIndentStyle = (v) => v === 2 || v === 4 || v === "tab";
/**
 * JSON 格式化与校验主命令组件
 */
export default function JsonFormatCommand() {
    // 输入与缩进风格随「独立窗口」一起带走；带来的值不合法（如旧版本存下的形状）时用默认值
    const [jsonText, setJsonText] = usePopoutValue("jsonText", () => "", isText);
    const [indent, setIndent] = usePopoutValue("indent", () => 2, isIndentStyle);
    const { push } = useNavigation();
    // 只在输入变化时重新校验与推导，避免切换缩进等重渲染时重复解析大段 JSON
    const derived = useMemo(() => {
        const validation = validateJson(jsonText);
        if (!validation.valid)
            return { validation, outputs: null };
        return {
            validation,
            outputs: {
                indent2: formatJson(jsonText, 2),
                indent4: formatJson(jsonText, 4),
                minified: minifyJson(jsonText),
                ts: jsonToTsInterface(jsonText),
                rust: jsonToRustStruct(jsonText),
                go: jsonToGoStruct(jsonText)
            }
        };
    }, [jsonText]);
    const { validation, outputs } = derived;
    const handleSubmit = async (values) => {
        const text = typeof values.jsonInput === "string" ? values.jsonInput : jsonText;
        const res = validateJson(text);
        if (!res.valid) {
            await showToast(Toast.Style.Failure, "JSON 语法错误", res.error);
            return;
        }
        const fmt = formatJson(text, indent);
        const ts = jsonToTsInterface(text);
        const rust = jsonToRustStruct(text);
        const go = jsonToGoStruct(text);
        const paths = extractJsonPaths(text);
        await showToast(Toast.Style.Success, "格式化与类型推导完成");
        push(() => (React.createElement(JsonDetailView, { formatted: fmt, tsInterface: ts, rustStruct: rust, goStruct: go, stats: res.stats, jsonPaths: paths })));
    };
    const handleLoadClipboard = async () => {
        let text = "";
        try {
            text = await Clipboard.readText();
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "读取剪贴板失败", err?.message || String(err));
            return;
        }
        if (!text || !text.trim()) {
            await showToast(Toast.Style.Failure, "剪贴板为空");
            return;
        }
        const res = validateJson(text);
        // 已有输入时只用合法 JSON 覆盖，避免误触把正在编辑的内容换成剪贴板里的无关文字
        if (!res.valid && jsonText.trim() && text !== jsonText) {
            await showToast(Toast.Style.Failure, "剪贴板不是合法 JSON，已保留当前输入", res.error);
            return;
        }
        setJsonText(text);
        if (res.valid) {
            await showToast(Toast.Style.Success, "已从剪贴板读取并成功校验");
        }
        else {
            await showToast(Toast.Style.Failure, "剪贴板内容存在语法错误", res.error);
        }
    };
    return (React.createElement(Form, { navigationTitle: "JSON \u683C\u5F0F\u5316\u4E0E\u7C7B\u578B\u8F6C\u6362", actions: React.createElement(ActionPanel, { title: "\u5FEB\u6377\u52A8\u4F5C" },
            React.createElement(Action.SubmitForm, { title: "\u683C\u5F0F\u5316\u5E76\u67E5\u770B\u8BE6\u60C5", icon: Icon.Eye, onSubmit: handleSubmit }),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 2 \u683C\u683C\u5F0F\u5316\u7ED3\u679C", content: outputs.indent2, icon: Icon.CopyClipboard })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 4 \u683C\u683C\u5F0F\u5316\u7ED3\u679C", content: outputs.indent4, icon: Icon.CopyClipboard })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236\u538B\u7F29\u5355\u884C (Minify)", content: outputs.minified, icon: Icon.Minus })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 TypeScript Interface", content: outputs.ts, icon: Icon.Code })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 Rust Struct", content: outputs.rust, icon: Icon.Terminal })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: "\u590D\u5236 Go Struct", content: outputs.go, icon: Icon.Globe })),
            React.createElement(Action, { title: "\u4ECE\u526A\u8D34\u677F\u7C98\u8D34\u5E76\u6821\u9A8C", icon: Icon.Clipboard, onAction: handleLoadClipboard }),
            React.createElement(Action, { title: indent === 2 ? "切换为 4 格缩进" : "切换为 2 格缩进", icon: Icon.Repeat, onAction: () => setIndent(indent === 2 ? 4 : 2) })) },
        React.createElement(Form.TextArea, { id: "jsonInput", title: "JSON \u8F93\u5165", placeholder: "\u5728\u6B64\u7C98\u8D34\u6216\u8F93\u5165\u5F85\u6821\u9A8C/\u683C\u5F0F\u5316\u7684 JSON \u5185\u5BB9...", value: jsonText, onChange: (val) => setJsonText(val), error: validation.valid || !jsonText.trim()
                ? undefined
                : validation.errorInfo
                    ? `[第 ${validation.errorInfo.line} 行, 列 ${validation.errorInfo.column}] ${validation.errorInfo.message}`
                    : validation.error }),
        React.createElement(Form.Dropdown, { id: "indentType", title: "\u7F29\u8FDB\u98CE\u683C", value: String(indent), onChange: (v) => setIndent(v === "tab" ? "tab" : v === "4" ? 4 : 2) },
            React.createElement(Form.Dropdown.Item, { title: "2 \u7A7A\u683C\u7F29\u8FDB", value: "2" }),
            React.createElement(Form.Dropdown.Item, { title: "4 \u7A7A\u683C\u7F29\u8FDB", value: "4" }),
            React.createElement(Form.Dropdown.Item, { title: "Tab \u5236\u8868\u7B26\u7F29\u8FDB", value: "tab" }))));
}
