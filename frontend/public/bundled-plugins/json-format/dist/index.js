import React from "@ztools/declarative-ui";
import { Detail, Form, ActionPanel, Action, Icon, Color, showToast, Toast, Clipboard, useNavigation, useLocale } from "@ztools/declarative-ui";
import { useMemo } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { validateJson, formatJson, minifyJson, jsonToTsInterface, jsonToRustStruct, jsonToGoStruct, extractJsonPaths, fencedCode } from "./logic.js";
import { usePopoutValue } from "./popout-state.js";
import { createCompatFileInputProps } from "./host-compat.js";
let jsonFileSeq = 0;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readTextFileFromHost(filePath) {
    const g = globalThis;
    const methods = g.window?.__ztoolsElectron?.transport?.methods ?? g.__ztoolsElectron?.transport?.methods;
    const fn = methods?.filesystem_read_file;
    if (typeof fn !== "function") {
        throw new Error(t("hostNoReadFile"));
    }
    jsonFileSeq = (jsonFileSeq + 1) % 1_000_000;
    const raw = await fn({
        messageId: `json_file_${Date.now()}_${jsonFileSeq}`,
        params: { path: filePath, encoding: "utf8" }
    });
    if (isRecord(raw) && raw.success === false) {
        const err = raw.error;
        const msg = isRecord(err) ? String(err.message || err.code || t("readFileFailed")) : String(err || t("readFileFailed"));
        throw new Error(msg);
    }
    const data = isRecord(raw) && "data" in raw ? raw.data : raw;
    if (typeof data === "string")
        return data;
    if (isRecord(data) && typeof data.content === "string")
        return data.content;
    throw new Error(t("readFileInvalid"));
}
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
    return `${t("pathIndexHeading", { count: shown.length })}\n${fencedCode(lines.join("\n"), "text")}`;
}
/**
 * 查看转换结果的二级详情页 (展示 JSON、TypeScript、Rust、Go 及 JSONPath)
 */
export function JsonDetailView({ formatted, tsInterface, rustStruct, goStruct, stats, jsonPaths, indentLabel }) {
    useLocale();
    const resolvedIndentLabel = indentLabel ?? t("indentSpaces", { n: 2 });
    const rustCode = rustStruct || jsonToRustStruct(formatted);
    const goCode = goStruct || jsonToGoStruct(formatted);
    const paths = jsonPaths || extractJsonPaths(formatted);
    // 用户数据可能含 ```（如大模型返回的代码片段），围栏长度按内容动态选择，避免代码块被提前截断
    const markdown = [
        t("detailHeading"),
        t("detailFormatted"),
        fencedCode(formatted, "json"),
        t("detailTs"),
        fencedCode(tsInterface, "typescript"),
        t("detailRust"),
        fencedCode(rustCode, "rust"),
        t("detailGo"),
        fencedCode(goCode, "go"),
        ...(paths.length > 0 ? [pathIndexBlock(paths)] : [])
    ].join("\n\n");
    return (React.createElement(Detail, { markdown: markdown, navigationTitle: t("detailNavTitle"), metadata: stats ? (React.createElement(Detail.Metadata, null,
            React.createElement(Detail.Metadata.Label, { title: t("metaKeys"), text: t("metaKeysVal", { count: stats.keys }), icon: Icon.Key }),
            React.createElement(Detail.Metadata.Label, { title: t("metaDepth"), text: t("metaDepthVal", { depth: stats.depth }), icon: Icon.Pin }),
            React.createElement(Detail.Metadata.Label, { title: t("metaRawSize"), text: `${stats.byteSize} Bytes`, icon: Icon.Document }),
            React.createElement(Detail.Metadata.Label, { title: t("metaMinSize"), text: `${stats.minifiedSize} Bytes`, icon: Icon.Minus }),
            React.createElement(Detail.Metadata.Label, { title: t("metaSaved"), text: `${stats.compressionRatio}%`, icon: Icon.Checkmark }),
            React.createElement(Detail.Metadata.Separator, null),
            React.createElement(Detail.Metadata.TagList, { title: t("metaSyntax") },
                React.createElement(Detail.Metadata.TagList.Item, { text: t("metaSyntaxValid"), color: Color.Green, icon: Icon.Check })))) : undefined, actions: React.createElement(ActionPanel, { title: t("actionsTitle") },
            React.createElement(Action.CopyToClipboard, { title: t("copyFormatted", { indent: resolvedIndentLabel }), content: formatted, icon: Icon.CopyClipboard }),
            React.createElement(Action.CopyToClipboard, { title: t("copyTs"), content: tsInterface, icon: Icon.Code }),
            React.createElement(Action.CopyToClipboard, { title: t("copyRust"), content: rustCode, icon: Icon.Terminal }),
            React.createElement(Action.CopyToClipboard, { title: t("copyGo"), content: goCode, icon: Icon.Globe }),
            React.createElement(Action.CopyToClipboard, { title: t("copyMinified"), content: minifyJson(formatted), icon: Icon.Document }),
            paths.length > 0 && (React.createElement(Action.CopyToClipboard, { title: t("copyJsonPaths"), content: paths.map((p) => `${p.path} = ${p.displayValue}`).join("\n"), icon: Icon.List }))) }));
}
/**
 * json-codegen 命令的结果页：只放类型代码，不再重复格式化 JSON
 */
export function JsonCodegenView({ tsInterface, rustStruct, goStruct }) {
    useLocale();
    const markdown = [
        "## TypeScript",
        fencedCode(tsInterface, "typescript"),
        "## Go",
        fencedCode(goStruct, "go"),
        "## Rust (serde)",
        fencedCode(rustStruct, "rust")
    ].join("\n\n");
    return (React.createElement(Detail, { markdown: markdown, navigationTitle: t("codegenNavTitle"), actions: React.createElement(ActionPanel, null,
            React.createElement(Action.CopyToClipboard, { title: t("copyTs"), content: tsInterface, icon: Icon.Code }),
            React.createElement(Action.CopyToClipboard, { title: t("copyGo"), content: goStruct, icon: Icon.Globe }),
            React.createElement(Action.CopyToClipboard, { title: t("copyRust"), content: rustStruct, icon: Icon.Terminal })) }));
}
function describeOutputError(err) {
    if (err instanceof RangeError)
        return t("rangeError");
    return err instanceof Error ? err.message : String(err);
}
const isText = (v) => typeof v === "string";
const isIndentStyle = (v) => v === 2 || v === 4 || v === "tab";
/**
 * JSON 格式化与校验主命令组件
 */
export default function JsonFormatCommand(props = {}) {
    useLocale();
    // json-codegen 命令：主动作直接生成类型代码并进入代码视图；其余入口是格式化
    const codegen = props?.featureCode === "json-codegen";
    // 输入与缩进风格随「独立窗口」一起带走；带来的值不合法（如旧版本存下的形状）时用默认值
    const [jsonText, setJsonText] = usePopoutValue("jsonText", () => "", isText);
    const [indent, setIndent] = usePopoutValue("indent", () => 2, isIndentStyle);
    const { push } = useNavigation();
    // 只在输入变化时重新校验与推导，避免切换缩进等重渲染时重复解析大段 JSON
    const derived = useMemo(() => {
        const validation = validateJson(jsonText);
        if (!validation.valid)
            return { validation, outputs: null, outputError: undefined };
        try {
            return {
                validation,
                outputError: undefined,
                outputs: {
                    indent2: formatJson(jsonText, 2),
                    indent4: formatJson(jsonText, 4),
                    minified: minifyJson(jsonText),
                    ts: jsonToTsInterface(jsonText),
                    rust: jsonToRustStruct(jsonText),
                    go: jsonToGoStruct(jsonText)
                }
            };
        }
        catch (err) {
            // 极深嵌套时缩进后的文本可能超过字符串上限（RangeError），如实提示而不是让整个页面崩溃
            return { validation, outputs: null, outputError: describeOutputError(err) };
        }
    }, [jsonText]);
    const { validation, outputs, outputError } = derived;
    const handleSubmit = async (values) => {
        const text = typeof values.jsonInput === "string" ? values.jsonInput : jsonText;
        const res = validateJson(text);
        if (!res.valid) {
            await showToast(Toast.Style.Failure, t("syntaxErrorToast"), res.error);
            return;
        }
        let fmt, ts, rust, go, paths;
        try {
            fmt = formatJson(text, indent);
            ts = jsonToTsInterface(text);
            rust = jsonToRustStruct(text);
            go = jsonToGoStruct(text);
            paths = extractJsonPaths(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("formatErrorToast"), describeOutputError(err));
            return;
        }
        if (codegen) {
            push(() => React.createElement(JsonCodegenView, { tsInterface: ts, rustStruct: rust, goStruct: go }));
            return;
        }
        await showToast(Toast.Style.Success, t("formatDoneToast"));
        push(() => (React.createElement(JsonDetailView, { formatted: fmt, tsInterface: ts, rustStruct: rust, goStruct: go, stats: res.stats, jsonPaths: paths, indentLabel: indent === "tab" ? "Tab" : t("indentSpaces", { n: indent }) })));
    };
    const handleLoadClipboard = async () => {
        let text = "";
        try {
            text = await Clipboard.readText();
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("readClipboardFailed"), err instanceof Error ? err.message : String(err));
            return;
        }
        if (!text || !text.trim()) {
            await showToast(Toast.Style.Failure, t("clipboardEmpty"));
            return;
        }
        const res = validateJson(text);
        // 已有输入时只用合法 JSON 覆盖，避免误触把正在编辑的内容换成剪贴板里的无关文字
        if (!res.valid && jsonText.trim() && text !== jsonText) {
            await showToast(Toast.Style.Failure, t("clipboardInvalidKeep"), res.error);
            return;
        }
        setJsonText(text);
        if (res.valid) {
            await showToast(Toast.Style.Success, t("clipboardLoadedValid"));
        }
        else {
            await showToast(Toast.Style.Failure, t("clipboardLoadedInvalid"), res.error);
        }
    };
    const fileInputProps = createCompatFileInputProps(async (files) => {
        const targetPath = files[0]?.trim();
        if (!targetPath)
            return;
        try {
            const content = await readTextFileFromHost(targetPath);
            setJsonText(content);
            const res = validateJson(content);
            if (res.valid) {
                await showToast(Toast.Style.Success, t("fileLoadedValid"));
            }
            else {
                await showToast(Toast.Style.Failure, t("fileLoadedInvalid"), res.error);
            }
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("readFileFailed"), err instanceof Error ? err.message : String(err));
        }
    }, {
        extensions: [".json", ".jsonl", ".txt"],
        onTextPaste: (text) => {
            if (text && text.trim()) {
                setJsonText(text);
            }
        }
    });
    return (React.createElement(Form, { ...fileInputProps, navigationTitle: codegen ? t("navTitleCodegen") : t("navTitleMain"), actions: React.createElement(ActionPanel, { title: t("quickActions") },
            React.createElement(Action.SubmitForm, { title: codegen ? t("submitCodegen") : t("submitFormat"), icon: codegen ? Icon.Code : Icon.Eye, onSubmit: handleSubmit }),
            codegen && outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyTs"), content: outputs.ts, icon: Icon.Code })),
            !codegen && outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyIndent2"), content: outputs.indent2, icon: Icon.CopyClipboard })),
            !codegen && outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyIndent4"), content: outputs.indent4, icon: Icon.CopyClipboard })),
            !codegen && outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyMinifiedShort"), content: outputs.minified, icon: Icon.Minus })),
            !codegen && outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyTs"), content: outputs.ts, icon: Icon.Code })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyRust"), content: outputs.rust, icon: Icon.Terminal })),
            outputs && (React.createElement(Action.CopyToClipboard, { title: t("copyGo"), content: outputs.go, icon: Icon.Globe })),
            React.createElement(Action, { title: t("pasteClipboard"), icon: Icon.Clipboard, onAction: handleLoadClipboard })) },
        React.createElement(Form.TextArea, { id: "jsonInput", title: t("inputTitle"), placeholder: codegen ? t("inputPlaceholderCodegen") : t("inputPlaceholderMain"), value: jsonText, onChange: (val) => setJsonText(val), error: outputError
                ? outputError
                : validation.valid || !jsonText.trim()
                    ? undefined
                    : validation.errorInfo
                        ? t("errorPosition", { line: validation.errorInfo.line, column: validation.errorInfo.column, message: validation.errorInfo.message })
                        : validation.error }),
        !codegen && React.createElement(Form.Dropdown, { id: "indentType", title: t("indentStyleTitle"), value: String(indent), onChange: (v) => setIndent(v === "tab" ? "tab" : v === "4" ? 4 : 2) },
            React.createElement(Form.Dropdown.Item, { title: t("indent2Item"), value: "2" }),
            React.createElement(Form.Dropdown.Item, { title: t("indent4Item"), value: "4" }),
            React.createElement(Form.Dropdown.Item, { title: t("indentTabItem"), value: "tab" }))));
}
export const commands = {
    "json-beautify": () => JsonFormatCommand(),
    "json-codegen": () => JsonFormatCommand({ featureCode: "json-codegen" })
};
