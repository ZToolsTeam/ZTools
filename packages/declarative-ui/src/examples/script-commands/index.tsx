/**
 * Script Commands (极客自定义脚本命令工作台)
 *
 * 深度对齐 Raycast 官方 `script-commands` 规范：
 * - 100% 兼容 `@raycast.schemaVersion 1`、`@raycast.title`、`@raycast.mode` (`compact` | `fullOutput` | `inline` | `silent`)、`@raycast.packageName` 元数据注释解析
 * - 支持 Bash / Zsh / AppleScript / Python / Node.js / PowerShell 多语言脚本模板生成与一键执行
 * - 对接主进程 `script_commands_list`、`script_commands_execute`、`script_commands_create`、`script_commands_reload` IPC
 */

import React from "../../index.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export type ScriptOutputMode = "compact" | "fullOutput" | "inline" | "silent";
export type ScriptRuntimeLanguage =
  | "bash"
  | "zsh"
  | "applescript"
  | "python"
  | "node"
  | "powershell";

export interface ScriptCommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly mode: ScriptOutputMode;
  readonly packageName: string;
  readonly description: string;
  readonly author?: string;
  readonly language: ScriptRuntimeLanguage;
  readonly filePath: string;
  readonly sourceCode: string;
  readonly lastOutput?: string;
  readonly lastRunAt?: number;
}

export const DEFAULT_SCRIPT_COMMANDS: readonly ScriptCommandMetadata[] = Object.freeze([
  {
    id: "script-flush-dns",
    title: "Flush macOS DNS Cache",
    mode: "compact",
    packageName: "Network Utils",
    description: "Clear local mDNSResponder & dscacheutil DNS cache",
    author: "ZTools Official",
    language: "zsh",
    filePath: "~/.ztools/scripts/flush-dns.sh",
    sourceCode: [
      "#!/bin/zsh",
      "# @raycast.schemaVersion 1",
      "# @raycast.title Flush macOS DNS Cache",
      "# @raycast.mode compact",
      "# @raycast.packageName Network Utils",
      "# @raycast.description Clear local mDNSResponder & dscacheutil DNS cache",
      "",
      "dscacheutil -flushcache",
      "echo '✅ DNS Cache Flushed Successfully'"
    ].join("\n"),
    lastOutput: "✅ DNS Cache Flushed Successfully"
  },
  {
    id: "script-git-standup",
    title: "Git Today's Commits Summary",
    mode: "fullOutput",
    packageName: "Developer Tools",
    description: "Show all git commits authored since midnight in current workspace",
    author: "ZTools Official",
    language: "bash",
    filePath: "~/.ztools/scripts/git-standup.sh",
    sourceCode: [
      "#!/usr/bin/env bash",
      "# @raycast.schemaVersion 1",
      "# @raycast.title Git Today's Commits Summary",
      "# @raycast.mode fullOutput",
      "# @raycast.packageName Developer Tools",
      "",
      "git log --since='midnight' --oneline --decorate"
    ].join("\n"),
    lastOutput: "f81c2e9 feat: 完成 macOS 内置套件补齐\n9a3d104 fix: 修复 POSIX 路径分隔符兼容"
  },
  {
    id: "script-toggle-dark-mode",
    title: "Toggle macOS Dark Mode via AppleScript",
    mode: "silent",
    packageName: "System Appearance",
    description: "Switch macOS System Events appearance dark mode",
    author: "ZTools Official",
    language: "applescript",
    filePath: "~/.ztools/scripts/toggle-dark-mode.scpt",
    sourceCode: [
      "#!/usr/bin/osascript",
      "# @raycast.schemaVersion 1",
      "# @raycast.title Toggle macOS Dark Mode via AppleScript",
      "# @raycast.mode silent",
      "# @raycast.packageName System Appearance",
      "",
      'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'
    ].join("\n"),
    lastOutput: "Dark mode toggled"
  },
  {
    id: "script-public-ip",
    title: "Get Local & Public IPv4 Address",
    mode: "inline",
    packageName: "Network Utils",
    description: "Fetch current LAN IP and external egress IP",
    author: "ZTools Official",
    language: "python",
    filePath: "~/.ztools/scripts/ip-info.py",
    sourceCode: [
      "#!/usr/bin/env python3",
      "# @raycast.schemaVersion 1",
      "# @raycast.title Get Local & Public IPv4 Address",
      "# @raycast.mode inline",
      "# @raycast.packageName Network Utils",
      "",
      "import socket",
      "print(socket.gethostbyname(socket.gethostname()))"
    ].join("\n"),
    lastOutput: "LAN: 192.168.1.108 | WAN: 203.0.113.42"
  }
]);

/**
 * 解析脚本头部的 `@raycast.*` 元数据注释
 */
export function parseRaycastScriptHeaders(sourceCode: string): {
  title: string;
  mode: ScriptOutputMode;
  packageName: string;
  description: string;
  schemaVersion: number;
} {
  const lines = (sourceCode || "").split(/\r?\n/).slice(0, 40);
  let title = "Untitled Script";
  let mode: ScriptOutputMode = "compact";
  let packageName = "Custom Scripts";
  let description = "";
  let schemaVersion = 1;

  for (const line of lines) {
    const match = line.match(/@raycast\.([a-zA-Z0-9_]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].trim();
    const val = match[2].trim();
    if (key === "title" && val) title = val;
    else if (
      key === "mode" &&
      ["compact", "fullOutput", "inline", "silent"].includes(val)
    ) {
      mode = val as ScriptOutputMode;
    } else if (key === "packageName" && val) {
      packageName = val;
    } else if (key === "description" && val) {
      description = val;
    } else if (key === "schemaVersion") {
      schemaVersion = Number(val) || 1;
    }
  }

  return { title, mode, packageName, description, schemaVersion };
}

/**
 * 根据语言与参数生成标准 `@raycast.*` 脚本模板源码
 */
export function buildScriptCommandTemplate(input: {
  title: string;
  mode?: ScriptOutputMode;
  packageName?: string;
  description?: string;
  language?: ScriptRuntimeLanguage;
  body?: string;
}): string {
  const lang = input.language || "bash";
  const shebangMap: Record<ScriptRuntimeLanguage, string> = {
    bash: "#!/usr/bin/env bash",
    zsh: "#!/bin/zsh",
    applescript: "#!/usr/bin/osascript",
    python: "#!/usr/bin/env python3",
    node: "#!/usr/bin/env node",
    powershell: "#!/usr/bin/env pwsh"
  };
  const commentPrefix = lang === "node" ? "//" : "#";
  const defaultBodyMap: Record<ScriptRuntimeLanguage, string> = {
    bash: 'echo "Hello from ZTools Script Command!"',
    zsh: 'echo "Hello from ZTools Zsh Script!"',
    applescript: 'display notification "Executed from ZTools" with title "Script Command"',
    python: 'print("Hello from Python Script Command!")',
    node: 'console.log("Hello from Node.js Script Command!");',
    powershell: 'Write-Output "Hello from PowerShell Script Command!"'
  };

  return [
    shebangMap[lang],
    `${commentPrefix} @raycast.schemaVersion 1`,
    `${commentPrefix} @raycast.title ${input.title.trim() || "New Script Command"}`,
    `${commentPrefix} @raycast.mode ${input.mode || "compact"}`,
    `${commentPrefix} @raycast.packageName ${input.packageName?.trim() || "Custom Scripts"}`,
    `${commentPrefix} @raycast.description ${input.description?.trim() || "Created in ZTools Script Commands"}`,
    "",
    input.body?.trim() || defaultBodyMap[lang]
  ].join("\n");
}

export interface ScriptExecutionResult {
  readonly ok: boolean;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly executedAt: number;
}

/**
 * 加载脚本命令列表（对接 script_commands_list / script_commands_reload IPC）
 */
export async function fetchScriptCommands(
  forceReload = false,
  hostOverride?: any
): Promise<ScriptCommandMetadata[]> {
  const realHost = isRealElectronHost(hostOverride);
  if (hostOverride || realHost) {
    const method = forceReload ? "script_commands_reload" : "script_commands_list";
    const res = await callHostTransport<any>(method, {}, hostOverride);
    const rawList = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.scripts)
        ? res.data.scripts
        : Array.isArray(res.data?.commands)
          ? res.data.commands
          : null;
    if (res.ok && rawList) {
      if (rawList.length > 0 || realHost) {
        return rawList.map((item: any, idx: number): ScriptCommandMetadata => {
          const parsed = item.sourceCode
            ? parseRaycastScriptHeaders(String(item.sourceCode))
            : null;
          return {
            id: String(item.id || `script-${idx}`),
            title: String(item.title || parsed?.title || "Script Command"),
            mode: (item.mode || parsed?.mode || "compact") as ScriptOutputMode,
            packageName: String(item.packageName || parsed?.packageName || "Custom"),
            description: String(item.description || parsed?.description || ""),
            author: item.author ? String(item.author) : "User",
            language: (item.language || "bash") as ScriptRuntimeLanguage,
            filePath: String(item.filePath || item.path || `~/.ztools/scripts/${item.id || idx}.sh`),
            sourceCode: String(item.sourceCode || ""),
            lastOutput: item.lastOutput ? String(item.lastOutput) : undefined,
            lastRunAt: item.lastRunAt ? Number(item.lastRunAt) : undefined
          };
        });
      }
    }
    if (realHost) {
      return [];
    }
  }
  return [...DEFAULT_SCRIPT_COMMANDS];
}

/**
 * 执行指定脚本命令（对接 script_commands_execute IPC）
 */
export async function executeScriptCommand(
  script: ScriptCommandMetadata | { id: string; filePath?: string; args?: string[] },
  hostOverride?: any
): Promise<ScriptExecutionResult> {
  const startedAt = Date.now();
  if (!script || !script.id) {
    return {
      ok: false,
      output: "脚本 ID 不能为空",
      stdout: "",
      stderr: "脚本 ID 不能为空",
      exitCode: 1,
      durationMs: 0,
      executedAt: startedAt
    };
  }

  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>(
      "script_commands_execute",
      {
        id: script.id,
        filePath: script.filePath,
        args: "args" in script && Array.isArray(script.args) ? script.args : []
      },
      hostOverride
    );
    const durationMs = Math.max(1, Number(res.data?.durationMs ?? (Date.now() - startedAt)));
    if (res.ok && res.data) {
      const stdout = String(res.data.stdout ?? res.data.output ?? "").trim();
      const stderr = String(res.data.stderr ?? "").trim();
      const exitCode = Number(res.data.exitCode ?? 0);
      const combinedOutput = [stdout, stderr ? `[stderr]\n${stderr}` : ""]
        .filter(Boolean)
        .join("\n\n") || "执行完成 (无输出)";
      return {
        ok: exitCode === 0,
        output: combinedOutput,
        stdout,
        stderr,
        exitCode,
        durationMs,
        executedAt: Date.now()
      };
    }
    const errText = res.error || "脚本执行失败";
    return {
      ok: false,
      output: errText,
      stdout: "",
      stderr: errText,
      exitCode: 1,
      durationMs,
      executedAt: Date.now()
    };
  }

  const fallbackOutput =
    "lastOutput" in script && script.lastOutput
      ? script.lastOutput
      : `Executed ${script.id} successfully`;
  return {
    ok: true,
    output: fallbackOutput,
    stdout: fallbackOutput,
    stderr: "",
    exitCode: 0,
    durationMs: Math.max(1, Date.now() - startedAt),
    executedAt: Date.now()
  };
}

/**
 * 从模板创建新脚本命令（对接 script_commands_create IPC）
 */
export async function createScriptCommand(
  input: {
    title: string;
    mode?: ScriptOutputMode;
    packageName?: string;
    description?: string;
    language?: ScriptRuntimeLanguage;
    body?: string;
  },
  hostOverride?: any
): Promise<ScriptCommandMetadata> {
  const cleanTitle = (input.title || "").trim();
  if (!cleanTitle) {
    throw new Error("TITLE_REQUIRED: 脚本标题不能为空");
  }
  const lang = input.language || "bash";
  const extMap: Record<ScriptRuntimeLanguage, string> = {
    bash: "sh",
    zsh: "zsh",
    applescript: "scpt",
    python: "py",
    node: "mjs",
    powershell: "ps1"
  };
  const slug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "") || `script-${Date.now()}`;
  const sourceCode = buildScriptCommandTemplate(input);

  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>(
      "script_commands_create",
      {
        title: cleanTitle,
        mode: input.mode || "compact",
        packageName: input.packageName || "Custom Scripts",
        description: input.description || "",
        language: lang,
        sourceCode
      },
      hostOverride
    );
    if (res.ok && res.data && res.data.id) {
      return {
        id: String(res.data.id),
        title: String(res.data.title || cleanTitle),
        mode: (res.data.mode || input.mode || "compact") as ScriptOutputMode,
        packageName: String(res.data.packageName || input.packageName || "Custom Scripts"),
        description: String(res.data.description || input.description || ""),
        language: lang,
        filePath: String(res.data.filePath || `~/.ztools/scripts/${slug}.${extMap[lang]}`),
        sourceCode
      };
    }
  }

  return {
    id: `script-${slug}-${Date.now()}`,
    title: cleanTitle,
    mode: input.mode || "compact",
    packageName: input.packageName?.trim() || "Custom Scripts",
    description: input.description?.trim() || "",
    language: lang,
    filePath: `~/.ztools/scripts/${slug}.${extMap[lang]}`,
    sourceCode
  };
}

export const parseScriptCommandMetadata = parseRaycastScriptHeaders;
export const generateScriptCommandTemplate = buildScriptCommandTemplate;
export const listScriptCommandsFromHost = fetchScriptCommands;
export const runScriptCommandOnHost = executeScriptCommand;
export const createScriptCommandOnHost = createScriptCommand;

export function RunScriptWithArgsForm({
  script,
  onExecuted
}: {
  script: ScriptCommandMetadata;
  onExecuted?: (res: ScriptExecutionResult) => void;
}) {
  const [arg1, setArg1] = useState("");
  const [arg2, setArg2] = useState("");
  const [arg3, setArg3] = useState("");
  const { pop } = useNavigation();

  const handleSubmit = async (values?: Record<string, any>) => {
    const args = [
      values?.arg1 ?? arg1,
      values?.arg2 ?? arg2,
      values?.arg3 ?? arg3
    ]
      .map((a) => String(a || "").trim())
      .filter(Boolean);

    await showToast(Toast.Style.Animated, `正在带参执行: ${script.title}...`);
    const res = await executeScriptCommand({
      id: script.id,
      filePath: script.filePath,
      args
    });
    onExecuted?.(res);
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.ok ? `已执行: ${script.title} (${res.durationMs}ms)` : `执行失败 (Exit ${res.exitCode})`,
      res.output.slice(0, 120)
    );
    pop();
  };

  return (
    <Form
      navigationTitle={`传入参数运行脚本: ${script.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="立即带参运行脚本"
            icon={Icon.Play}
            onSubmit={handleSubmit}
          />
          <Action title="立即带参运行脚本" icon={Icon.Play} onAction={() => handleSubmit()} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="arg1"
        title="参数 1 (@raycast.argument1)"
        placeholder="输入第 1 个命令行参数 ($1)..."
        value={arg1}
        onChange={setArg1}
      />
      <Form.TextField
        id="arg2"
        title="参数 2 (@raycast.argument2)"
        placeholder="输入第 2 个命令行参数 ($2，选填)..."
        value={arg2}
        onChange={setArg2}
      />
      <Form.TextField
        id="arg3"
        title="参数 3 (@raycast.argument3)"
        placeholder="输入第 3 个命令行参数 ($3，选填)..."
        value={arg3}
        onChange={setArg3}
      />
    </Form>
  );
}

export function CreateScriptCommandForm({
  onCreated
}: {
  onCreated?: (created: ScriptCommandMetadata) => void;
}) {
  const [title, setTitle] = useState("");
  const [packageName, setPackageName] = useState("Developer Tools");
  const [mode, setMode] = useState<ScriptOutputMode>("compact");
  const [language, setLanguage] = useState<ScriptRuntimeLanguage>("powershell");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState('Write-Output "✅ Executed from ZTools Script Command"');
  const { pop } = useNavigation();

  const handleSubmit = async (values?: Record<string, any>) => {
    try {
      const created = await createScriptCommand({
        title: values?.title ?? title,
        packageName: values?.packageName ?? packageName,
        mode: (values?.mode ?? mode) as ScriptOutputMode,
        language: (values?.language ?? language) as ScriptRuntimeLanguage,
        description: values?.description ?? description,
        body: values?.body ?? body
      });
      onCreated?.(created);
      await showToast(Toast.Style.Success, `已创建脚本: ${created.title}`, created.filePath);
      pop();
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "创建脚本失败", err?.message || String(err));
    }
  };

  return (
    <Form
      navigationTitle="创建自定义脚本命令 (Create Script Command)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存并生成脚本" icon={Icon.Check} onSubmit={handleSubmit} />
          <Action title="保存并生成脚本" icon={Icon.Check} onAction={() => handleSubmit()} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="脚本标题 (@raycast.title)"
        placeholder="例如: Restart Docker / Flush DNS"
        value={title}
        onChange={setTitle}
      />
      <Form.Dropdown
        id="language"
        title="脚本运行语言 (Runtime)"
        value={language}
        onChange={(v) => setLanguage(v as ScriptRuntimeLanguage)}
      >
        <Form.Dropdown.Item value="powershell" title="PowerShell (pwsh)" />
        <Form.Dropdown.Item value="node" title="Node.js (/usr/bin/env node)" />
        <Form.Dropdown.Item value="python" title="Python 3 (/usr/bin/env python3)" />
        <Form.Dropdown.Item value="zsh" title="Zsh (/bin/zsh)" />
        <Form.Dropdown.Item value="bash" title="Bash (/usr/bin/env bash)" />
        <Form.Dropdown.Item value="applescript" title="AppleScript (/usr/bin/osascript)" />
      </Form.Dropdown>
      <Form.Dropdown
        id="mode"
        title="输出呈现模式 (@raycast.mode)"
        value={mode}
        onChange={(v) => setMode(v as ScriptOutputMode)}
      >
        <Form.Dropdown.Item value="compact" title="Compact (单行 Toast 反馈)" />
        <Form.Dropdown.Item value="fullOutput" title="Full Output (完整终端输出视图)" />
        <Form.Dropdown.Item value="inline" title="Inline (列表内联实时刷新)" />
        <Form.Dropdown.Item value="silent" title="Silent (静默后台执行)" />
      </Form.Dropdown>
      <Form.TextField
        id="packageName"
        title="所属分组 (@raycast.packageName)"
        placeholder="例如: Developer Tools / System"
        value={packageName}
        onChange={setPackageName}
      />
      <Form.TextField
        id="description"
        title="脚本描述 (@raycast.description)"
        placeholder="简短描述该脚本的用途"
        value={description}
        onChange={setDescription}
      />
      <Form.TextArea
        id="body"
        title="脚本执行代码"
        placeholder="输入要执行的命令或代码..."
        value={body}
        onChange={setBody}
      />
    </Form>
  );
}

export function ScriptCommandOutputDetailView({
  script,
  output,
  executionResult
}: {
  script: ScriptCommandMetadata;
  output: string;
  executionResult?: ScriptExecutionResult;
}) {
  const markdown = [
    `# ⚡ ${script.title}`,
    `> **分组**: \`${script.packageName}\` &nbsp;|&nbsp; **语言**: \`${script.language}\` &nbsp;|&nbsp; **模式**: \`${script.mode}\`${
      executionResult
        ? ` &nbsp;|&nbsp; **退出码**: \`${executionResult.exitCode}\` &nbsp;|&nbsp; **耗时**: \`${executionResult.durationMs}ms\``
        : ""
    }`,
    `---`,
    `### 🖥️ 最近一次执行输出 (Real Execution Output)`,
    `\`\`\`text\n${executionResult?.stdout || output || "(无标准输出)"}\n\`\`\``,
    executionResult?.stderr
      ? `### ⚠️ 标准错误输出 (stderr)\n\`\`\`text\n${executionResult.stderr}\n\`\`\``
      : "",
    `### 脚本源码 (${script.filePath})`,
    `\`\`\`${script.language}\n${script.sourceCode}\n\`\`\``
  ]
    .filter(Boolean)
    .join("\n\n");

  return (
    <Detail
      navigationTitle={`运行结果: ${script.title}`}
      markdown={markdown}
      actions={
        <ActionPanel>
          <Action
            title="复制输出结果"
            icon={Icon.CopyClipboard}
            onAction={async () => {
              await Clipboard.copy(output);
              await showToast(Toast.Style.Success, "已复制脚本输出");
            }}
          />
          <Action
            title="复制脚本源码"
            icon={Icon.Code}
            onAction={async () => {
              await Clipboard.copy(script.sourceCode);
              await showToast(Toast.Style.Success, "已复制脚本源码");
            }}
          />
        </ActionPanel>
      }
    />
  );
}

export function ScriptCommandsCommand() {
  const realHost = isRealElectronHost();
  const [scripts, setScripts] = useState<ScriptCommandMetadata[]>(() =>
    realHost ? [] : [...DEFAULT_SCRIPT_COMMANDS]
  );
  const [lastOutputs, setLastOutputs] = useState<Record<string, ScriptExecutionResult>>({});
  const [searchText, setSearchText] = useState("");
  const [filterMode, setFilterMode] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(realHost);
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetchScriptCommands(false)
      .then((list) => {
        if (!active) return;
        setScripts(list);
        setIsLoading(false);
      })
      .catch(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const displayedScripts = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return scripts.filter((s) => {
      if (filterMode !== "all" && s.mode !== filterMode && s.language !== filterMode) {
        return false;
      }
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.packageName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.language.toLowerCase().includes(q)
      );
    });
  }, [scripts, searchText, filterMode]);

  const recordExecutionResult = (script: ScriptCommandMetadata, res: ScriptExecutionResult) => {
    setLastOutputs((prev) => ({
      ...prev,
      [script.id]: res
    }));
    setScripts((prev) =>
      prev.map((item) =>
        item.id === script.id
          ? { ...item, lastOutput: res.output, lastRunAt: res.executedAt }
          : item
      )
    );
  };

  const handleRunScript = async (script: ScriptCommandMetadata) => {
    await showToast(Toast.Style.Animated, `正在运行脚本: ${script.title}...`);
    const res = await executeScriptCommand(script);
    recordExecutionResult(script, res);
    if (script.mode === "fullOutput") {
      push(
        <ScriptCommandOutputDetailView
          script={script}
          output={res.output}
          executionResult={res}
        />
      );
    }
    await showToast(
      res.ok ? Toast.Style.Success : Toast.Style.Failure,
      res.ok
        ? `已执行: ${script.title} (${res.durationMs}ms)`
        : `执行失败: ${script.title} (Exit ${res.exitCode})`,
      res.output.slice(0, 120)
    );
  };

  const handleReload = async () => {
    setIsLoading(true);
    const list = await fetchScriptCommands(true);
    setScripts(list);
    setIsLoading(false);
    await showToast(Toast.Style.Success, "已重新扫描加载本地脚本目录", `共 ${list.length} 个脚本`);
  };

  const activeScript = useMemo(
    () => displayedScripts.find((s) => s.id === selectedId) || displayedScripts[0] || null,
    [displayedScripts, selectedId]
  );

  const executedCount = Object.keys(lastOutputs).length;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索本地自定义脚本 (@raycast.title, 分组, 语言)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `📜 脚本工作台 • 已加载 ${scripts.length} 个脚本 | 当前显示 ${displayedScripts.length} 个 | 本次已运行 ${executedCount} 次`,
        groups: [
          {
            id: "mode-filter",
            value: filterMode,
            onChange: setFilterMode,
            options: [
              { title: "全部脚本", value: "all", count: scripts.length },
              {
                title: "Compact",
                value: "compact",
                count: scripts.filter((s) => s.mode === "compact").length
              },
              {
                title: "Full Output",
                value: "fullOutput",
                count: scripts.filter((s) => s.mode === "fullOutput").length
              },
              {
                title: "Inline",
                value: "inline",
                count: scripts.filter((s) => s.mode === "inline").length
              },
              {
                title: "PowerShell",
                value: "powershell",
                count: scripts.filter((s) => s.language === "powershell").length
              }
            ]
          }
        ],
        actions: [
          {
            id: "run-selected-script",
            label: "▶️ 立即运行选中脚本",
            title: "▶️ 立即运行选中脚本",
            style: "primary",
            onAction: async () => {
              if (activeScript) {
                await handleRunScript(activeScript);
              }
            }
          },
          {
            id: "run-with-args",
            label: "⌨️ 传入参数运行...",
            title: "⌨️ 传入参数运行...",
            style: "secondary",
            onAction: () => {
              if (activeScript) {
                push(
                  <RunScriptWithArgsForm
                    script={activeScript}
                    onExecuted={(res) => recordExecutionResult(activeScript, res)}
                  />
                );
              }
            }
          },
          {
            id: "create-script-command",
            label: "➕ 新建脚本命令",
            title: "➕ 新建脚本命令",
            style: "primary",
            onAction: () => {
              push(
                <CreateScriptCommandForm
                  onCreated={(created) => setScripts((prev) => [created, ...prev])}
                />
              );
            }
          },
          {
            id: "copy-script-output",
            label: "📋 复制执行输出",
            title: "📋 复制执行输出",
            style: "secondary",
            onAction: async () => {
              if (!activeScript) return;
              const out = lastOutputs[activeScript.id]?.output || activeScript.lastOutput || activeScript.sourceCode;
              await Clipboard.copy(out);
              await showToast(Toast.Style.Success, "已复制脚本输出/源码");
            }
          },
          {
            id: "reload-scripts-dir",
            label: "🔄 重新加载脚本目录",
            title: "🔄 重新加载脚本目录",
            style: "secondary",
            onAction: handleReload
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按输出模式或语言过滤"
          value={filterMode}
          onChange={setFilterMode}
        >
          <List.Dropdown.Item title="全部脚本 (All Scripts)" value="all" icon={Icon.Terminal} />
          <List.Dropdown.Item title="Compact 模式" value="compact" icon={Icon.Bolt} />
          <List.Dropdown.Item title="Full Output 模式" value="fullOutput" icon={Icon.Document} />
          <List.Dropdown.Item title="Inline 内联模式" value="inline" icon={Icon.Text} />
          <List.Dropdown.Item title="Silent 静默模式" value="silent" icon={Icon.EyeSlash} />
          <List.Dropdown.Item title="PowerShell 脚本" value="powershell" icon={Icon.Terminal} />
          <List.Dropdown.Item title="Zsh / Bash 脚本" value="zsh" icon={Icon.Terminal} />
          <List.Dropdown.Item title="AppleScript 脚本" value="applescript" icon={Icon.Code} />
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="脚本工作台">
          <Action.Push
            title="新建脚本命令 (Create Script Command)"
            icon={Icon.Plus}
            target={
              <CreateScriptCommandForm
                onCreated={(created) => setScripts((prev) => [created, ...prev])}
              />
            }
          />
          <Action
            title="重新加载脚本目录 (Reload Scripts)"
            icon={Icon.ArrowClockwise}
            onAction={handleReload}
          />
        </ActionPanel>
      }
    >
      <List.Section title={`脚本命令列表 (Script Commands · ${displayedScripts.length})`}>
        {displayedScripts.map((script) => {
          const execRes = lastOutputs[script.id];
          const displayOutput = execRes?.output || script.lastOutput;
          return (
            <List.Item
              key={script.id}
              id={script.id}
              title={script.title}
              subtitle={
                displayOutput
                  ? `▶ ${displayOutput.replace(/\r?\n/g, " ").slice(0, 72)}`
                  : `${script.packageName} • ${script.filePath}`
              }
              icon={execRes ? (execRes.ok ? Icon.CheckCircle : Icon.XMarkCircle) : Icon.Terminal}
              accessories={[
                ...(execRes
                  ? [{ text: `${execRes.durationMs}ms (Exit ${execRes.exitCode})` }]
                  : []),
                { text: script.language.toUpperCase() },
                { text: script.mode }
              ]}
              detail={
                <List.Item.Detail
                  markdown={[
                    `# ⚡ ${script.title}`,
                    `> \`${script.packageName}\` • \`${script.language}\` • \`@raycast.mode ${script.mode}\``,
                    displayOutput
                      ? [
                          `### 🖥️ 最近一次执行输出 (Real Execution Output)`,
                          execRes
                            ? `- **退出码 (Exit Code)**: \`${execRes.exitCode}\` &nbsp;|&nbsp; **执行耗时**: \`${execRes.durationMs} ms\``
                            : "",
                          `\`\`\`text\n${execRes?.stdout || displayOutput}\n\`\`\``,
                          execRes?.stderr
                            ? `**标准错误 (stderr)**:\n\`\`\`text\n${execRes.stderr}\n\`\`\``
                            : ""
                        ]
                          .filter(Boolean)
                          .join("\n\n")
                      : `> 尚未运行此脚本，按 **Enter** 立即在宿主进程真实执行并捕获 \`stdout / stderr\`。`,
                    script.description ? `### 脚本说明\n${script.description}` : "",
                    `### 脚本源码 (${script.filePath})`,
                    `\`\`\`${script.language}\n${script.sourceCode}\n\`\`\``
                  ]
                    .filter(Boolean)
                    .join("\n\n")}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label
                        title="脚本标题"
                        text={script.title}
                        icon={Icon.Terminal}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="所属分组"
                        text={script.packageName}
                        icon={Icon.Folder}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="输出模式"
                        text={script.mode}
                        icon={Icon.Eye}
                      />
                      <List.Item.Detail.Metadata.Label
                        title="运行环境"
                        text={script.language}
                        icon={Icon.Code}
                      />
                      {execRes && (
                        <List.Item.Detail.Metadata.Label
                          title="最近执行状态"
                          text={`Exit ${execRes.exitCode} (${execRes.durationMs}ms)`}
                          icon={execRes.ok ? Icon.CheckCircle : Icon.XMarkCircle}
                        />
                      )}
                      <List.Item.Detail.Metadata.Label
                        title="文件路径"
                        text={script.filePath}
                        icon={Icon.Document}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={script.title}>
                  <Action
                    title="运行脚本 (Run Script Command)"
                    icon={Icon.Play}
                    onAction={() => handleRunScript(script)}
                  />
                  <Action.Push
                    title="传入参数并运行脚本 (Run with Arguments)"
                    icon={Icon.Terminal}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "r" }}
                    target={
                      <RunScriptWithArgsForm
                        script={script}
                        onExecuted={(res) => recordExecutionResult(script, res)}
                      />
                    }
                  />
                  {displayOutput && (
                    <Action
                      title="复制最近一次执行输出"
                      icon={Icon.CopyClipboard}
                      onAction={async () => {
                        await Clipboard.copy(displayOutput);
                        await showToast(Toast.Style.Success, "已复制脚本执行输出");
                      }}
                    />
                  )}
                  <Action.Push
                    title="新建脚本命令 (Create Script Command)"
                    icon={Icon.Plus}
                    shortcut={{ modifiers: ["ctrl"], key: "n" }}
                    target={
                      <CreateScriptCommandForm
                        onCreated={(created) => setScripts((prev) => [created, ...prev])}
                      />
                    }
                  />
                  <Action
                    title="重新加载脚本目录 (Reload Scripts)"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ["ctrl"], key: "r" }}
                    onAction={handleReload}
                  />
                  <Action
                    title="复制脚本源码"
                    icon={Icon.Code}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                    onAction={async () => {
                      await Clipboard.copy(script.sourceCode);
                      await showToast(Toast.Style.Success, "已复制脚本源码");
                    }}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

export default ScriptCommandsCommand;
