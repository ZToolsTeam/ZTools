import React from "../../index.js";
import {
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard,
  useNavigation
} from "../../index.js";
import { useState } from "../../runtime/hooks.js";
import {
  validateJson,
  formatJson,
  minifyJson,
  jsonToTsInterface,
  jsonToRustStruct,
  jsonToGoStruct,
  extractJsonPaths,
  JsonStats,
  JsonPathItem
} from "./logic.js";

const DEFAULT_SAMPLE_JSON = JSON.stringify(
  {
    name: "ZTools Platform",
    version: "1.0.0",
    features: ["Declarative UI", "Local-First", "Fluent Styling"],
    author: {
      team: "ZTools Core",
      verified: true
    }
  },
  null,
  2
);

/**
 * 查看转换结果的二级详情页 (展示 JSON、TypeScript、Rust、Go 及 JSONPath)
 */
export function JsonDetailView({
  formatted,
  tsInterface,
  rustStruct,
  goStruct,
  stats,
  jsonPaths
}: {
  formatted: string;
  tsInterface: string;
  rustStruct?: string;
  goStruct?: string;
  stats?: JsonStats;
  jsonPaths?: JsonPathItem[];
}) {
  const rustCode = rustStruct || jsonToRustStruct(formatted);
  const goCode = goStruct || jsonToGoStruct(formatted);
  const paths = jsonPaths || extractJsonPaths(JSON.parse(formatted || "{}"), "$", 15);

  const pathsTable = paths.length > 0
    ? `\n### 常用 JSONPath 路径索引 (前 ${paths.length} 项)\n| JSONPath | 数据类型 | 示例取值 |\n| :--- | :--- | :--- |\n` +
      paths.slice(0, 15).map((p) => `| \`${p.path}\` | \`${p.type}\` | \`${p.displayValue}\` |`).join("\n")
    : "";

  const markdown = `
# JSON 瑞士军刀与全栈类型推导

## 格式化 JSON
\`\`\`json
${formatted}
\`\`\`

## 自动生成的 TypeScript Interface
\`\`\`typescript
${tsInterface}
\`\`\`

## 自动生成的 Rust Struct (serde)
\`\`\`rust
${rustCode}
\`\`\`

## 自动生成的 Go Struct
\`\`\`go
${goCode}
\`\`\`
${pathsTable}
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle="JSON 格式化详情"
      metadata={
        stats ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="键数量" text={`${stats.keys} 个`} icon={Icon.Key} />
            <Detail.Metadata.Label title="最大层级" text={`${stats.depth} 层`} icon={Icon.Pin} />
            <Detail.Metadata.Label title="原始字节" text={`${stats.byteSize} Bytes`} icon={Icon.Document} />
            <Detail.Metadata.Label title="压缩体积" text={`${stats.minifiedSize} Bytes`} icon={Icon.Minus} />
            <Detail.Metadata.Label title="空间节省" text={`${stats.compressionRatio}%`} icon={Icon.Checkmark} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="语法校验">
              <Detail.Metadata.TagList.Item text="语法合法" color={Color.Green} icon={Icon.Check} />
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        <ActionPanel title="操作面板">
          <Action.CopyToClipboard
            title="复制格式化 JSON (2 格)"
            content={formatted}
            icon={Icon.CopyClipboard}
          />
          <Action.CopyToClipboard
            title="复制 TypeScript Interface"
            content={tsInterface}
            icon={Icon.Code}
          />
          <Action.CopyToClipboard
            title="复制 Rust Struct"
            content={rustCode}
            icon={Icon.Terminal}
          />
          <Action.CopyToClipboard
            title="复制 Go Struct"
            content={goCode}
            icon={Icon.Globe}
          />
          <Action.CopyToClipboard
            title="复制压缩单行 JSON"
            content={minifyJson(formatted)}
            icon={Icon.Document}
          />
          {paths.length > 0 && (
            <Action.CopyToClipboard
              title="复制全部 JSONPath 列表"
              content={paths.map((p) => `${p.path} = ${p.displayValue}`).join("\n")}
              icon={Icon.List}
            />
          )}
        </ActionPanel>
      }
    />
  );
}

/**
 * JSON 格式化与校验主命令组件
 */
export default function JsonFormatCommand() {
  const [jsonText, setJsonText] = useState(DEFAULT_SAMPLE_JSON);
  const [indent, setIndent] = useState<number | string>(2);
  const { push } = useNavigation();

  const validation = validateJson(jsonText);
  const formatted = validation.valid ? formatJson(jsonText, indent) : "";
  const tsInterface = validation.valid ? jsonToTsInterface(jsonText) : "";
  const rustStruct = validation.valid ? jsonToRustStruct(jsonText) : "";
  const goStruct = validation.valid ? jsonToGoStruct(jsonText) : "";

  const handleSubmit = async (values: Record<string, any>) => {
    const text = values.jsonInput || jsonText;
    const res = validateJson(text);
    if (!res.valid) {
      await showToast(Toast.Style.Failure, "JSON 语法错误", res.errorInfo?.snippet || res.error);
      return;
    }

    const fmt = formatJson(text, indent);
    const ts = jsonToTsInterface(text);
    const rust = jsonToRustStruct(text);
    const go = jsonToGoStruct(text);
    const paths = extractJsonPaths(res.parsed);

    await showToast(Toast.Style.Success, "格式化与类型推导完成");
    push(() => (
      <JsonDetailView
        formatted={fmt}
        tsInterface={ts}
        rustStruct={rust}
        goStruct={go}
        stats={res.stats}
        jsonPaths={paths}
      />
    ));
  };

  const handleLoadClipboard = async () => {
    const text = await Clipboard.readText();
    if (text) {
      setJsonText(text);
      const res = validateJson(text);
      if (res.valid) {
        await showToast(Toast.Style.Success, "已从剪贴板读取并成功校验");
      } else {
        await showToast(Toast.Style.Failure, "剪贴板内容存在语法错误", res.error);
      }
    } else {
      await showToast(Toast.Style.Failure, "剪贴板为空");
    }
  };

  const handleExportJson = async () => {
    if (!validation.valid) {
      await showToast(Toast.Style.Failure, "无法导出无效的 JSON");
      return;
    }
    const fmt = formatJson(jsonText, indent);
    await Clipboard.copy(fmt);
    await showToast(Toast.Style.Success, "已导出并复制 .json 内容到剪贴板");
  };

  return (
    <Form
      navigationTitle="JSON 格式化与类型转换"
      actions={
        <ActionPanel title="快捷动作">
          <Action.SubmitForm
            title="格式化并查看详情"
            icon={Icon.Eye}
            onSubmit={handleSubmit}
          />
          <Action
            title="从剪贴板粘贴并校验"
            icon={Icon.Clipboard}
            onAction={handleLoadClipboard}
          />
          <Action.CopyToClipboard
            title="复制 2 格格式化结果"
            content={validation.valid ? formatJson(jsonText, 2) : jsonText}
            icon={Icon.CopyClipboard}
          />
          <Action.CopyToClipboard
            title="复制 4 格格式化结果"
            content={validation.valid ? formatJson(jsonText, 4) : jsonText}
            icon={Icon.CopyClipboard}
          />
          <Action.CopyToClipboard
            title="复制压缩单行 (Minify)"
            content={validation.valid ? minifyJson(jsonText) : jsonText}
            icon={Icon.Minus}
          />
          <Action.CopyToClipboard
            title="复制 TypeScript Interface"
            content={tsInterface}
            icon={Icon.Code}
          />
          <Action.CopyToClipboard
            title="复制 Rust Struct"
            content={rustStruct}
            icon={Icon.Terminal}
          />
          <Action.CopyToClipboard
            title="复制 Go Struct"
            content={goStruct}
            icon={Icon.Globe}
          />
          <Action
            title="导出为 .json 文件"
            icon={Icon.Download}
            onAction={handleExportJson}
          />
          <Action
            title={indent === 2 ? "切换为 4 格缩进" : "切换为 2 格缩进"}
            icon={Icon.Repeat}
            onAction={() => setIndent(indent === 2 ? 4 : 2)}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="jsonInput"
        title="JSON 输入"
        placeholder="在此粘贴或输入待校验/格式化的 JSON 内容..."
        value={jsonText}
        onChange={(val) => setJsonText(val)}
        error={
          validation.valid
            ? undefined
            : validation.errorInfo
            ? `[第 ${validation.errorInfo.line} 行, 列 ${validation.errorInfo.column}] ${validation.errorInfo.message}`
            : validation.error
        }
      />
      <Form.Dropdown
        id="indentType"
        title="缩进风格"
        value={String(indent)}
        onChange={(v) => setIndent(v === "tab" ? "tab" : Number(v))}
      >
        <Form.Dropdown.Item title="2 空格缩进" value="2" />
        <Form.Dropdown.Item title="4 空格缩进" value="4" />
        <Form.Dropdown.Item title="Tab 制表符缩进" value="tab" />
      </Form.Dropdown>
    </Form>
  );
}
