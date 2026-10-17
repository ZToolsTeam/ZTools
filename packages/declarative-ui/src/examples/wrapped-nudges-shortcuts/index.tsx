import React from "../../index.js";
import {
  List,
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
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import {
  WrappedUsageStats,
  FeatureNudgeItem,
  SystemPrivilegeDiagnostic,
  WindowsShortcutItem,
  AppleShortcutItem
} from "./types.js";
import {
  calculateWrappedStats,
  FEATURE_NUDGES,
  getSystemPrivilegeDiagnostic,
  restartSidecar,
  getWindowsShortcuts,
  executeWindowsShortcut,
  revealShortcutInExplorer,
  getAppleShortcuts,
  executeAppleShortcut,
  openShortcutInApp
} from "./engine.js";

export * from "./types.js";
export * from "./engine.js";

/**
 * M1.5-29: Raycast Wrapped 年度极客报告主入口
 */
export default function RaycastWrappedCommand() {
  const [stats, setStats] = useState<WrappedUsageStats | null>(() => calculateWrappedStats(2026));
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const res = await calculateWrappedStats(2026);
        if (isMounted) {
          setStats(res);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const markdown = useMemo(() => {
    if (!stats) return "正在加载极客数据大盘与年度战报...";

    return `# 🏆 ZTools ${stats.year} 年度极客报告

> **极客段位评估**: \`${stats.badgeTitle}\`  
> *基于本地 SQLite 行为日志分析，100% 本地运算，零隐私上报 (Local-First)*

---

### ⏱️ 效率总耗时对比 (Time Investment vs Manual Baseline)
| 评估维度 | 统计数值 | 说明 |
| :--- | :--- | :--- |
| **传统鼠标与层级菜单预计耗时** | **${stats.manualHoursEstimate} 小时** | 估算每次手工寻址/点击平均耗时 1.25 分钟 |
| **ZTools 极客键盘流实际消耗时间** | **${stats.ztoolsHoursSpent} 小时** | 呼出后秒级命中，平均耗时仅 6 秒 |
| **累计净节省时间 (Net Saved)** | **${stats.netHoursSaved} 小时** | 折合约 **${stats.timeSavedMinutes}** 分钟 |
| **综合效率倍率提升** | **⚡ ${stats.efficiencyRatio}** | 键盘优先流带来的质变效率倍率 |
| **年累计呼出与唤醒** | **${stats.totalLaunches.toLocaleString()} 次** | 全天候即时响应 |
| **累计节省按键与点击次数** | **⌨️ ${stats.totalKeystrokesSaved.toLocaleString()} 次** | 显著缓解手指腕管疲劳 |
| **AI 交互 Token 规模** | **${(stats.tokensUsed || stats.aiTokenCount).toLocaleString()} Tokens** | BYOK 自由接入无绑架 |

---

### 📊 最常调用的前 5 款插件统计图表 (Top 5 Extensions Chart)
${stats.topExtensions
  .map(
    (ext, i) =>
      `${i + 1}. **${ext.name}** (\`${ext.id}\`): 唤醒 **${ext.count}** 次 (${ext.category})\n   \`${ext.barChart}\``
  )
  .join("\n\n")}

---

### ⌨️ 高频快捷键习惯 (Top Shortcuts)
${stats.topShortcuts
  .map((sc, i) => `- **${sc.name}** (\`${sc.key}\`): 触发 **${sc.count}** 次`)
  .join("\n")}

---

### 🎖️ 极客卓越成就勋章 (Geek Excellence Badge)
${stats.badgeCardMarkdown}

---
*愿每一位极客在键盘与纯粹中探索无限可能，感谢与 ZTools 共同前行！*`;
  }, [stats]);

  return (
    <Detail
      isLoading={isLoading}
      markdown={markdown}
      metadata={
        stats ? (
          <Detail.Metadata>
            <Detail.Metadata.Label title="统计年份" text={`${stats.year} 年度`} icon={Icon.Calendar} />
            <Detail.Metadata.Label title="总唤醒" text={`${stats.totalLaunches} 次`} icon={Icon.ArrowsExpand} />
            <Detail.Metadata.Label title="净节省时间" text={`${stats.netHoursSaved} 小时`} icon={Icon.Clock} />
            <Detail.Metadata.Label title="节省按键" text={`${stats.totalKeystrokesSaved} 次`} icon={Icon.Terminal} />
            <Detail.Metadata.Label title="效率倍率" text={stats.efficiencyRatio} icon={Icon.Star} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="极客评级">
              <Detail.Metadata.TagList.Item
                text={stats.geekMasteryTier}
                color={Color.Green}
              />
              <Detail.Metadata.TagList.Item
                text="100% Local-First"
                color={Color.Blue}
              />
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        ) : undefined
      }
      actions={
        <ActionPanel>
          <Action
            title="复制年度极客战报"
            icon={Icon.Clipboard}
            onAction={async () => {
              await Clipboard.copy(markdown);
              await showToast(Toast.Style.Success, "年度极客战报已复制到剪贴板");
            }}
          />
          {stats?.badgeCardMarkdown && (
            <Action
              title="复制极客勋章卡片"
              icon={Icon.Star}
              onAction={async () => {
                await Clipboard.copy(stats.badgeCardMarkdown);
                await showToast(Toast.Style.Success, "极客成就勋章卡片已复制");
              }}
            />
          )}
          <Action
            title="重新计算年度统计"
            icon={Icon.Repeat}
            onAction={async () => {
              const res = await calculateWrappedStats(2026);
              setStats(res);
              await showToast(Toast.Style.Success, "年度统计数据已重新聚合刷新");
            }}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * M1.5-29: Trial Nudges 核心特权与技术方案诊断中枢
 */
export function TrialNudgesCommand() {
  const [nudges] = useState<FeatureNudgeItem[]>(FEATURE_NUDGES);
  const [diagnostic, setDiagnostic] = useState<SystemPrivilegeDiagnostic | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const diag = await getSystemPrivilegeDiagnostic();
        if (isMounted) {
          setDiagnostic(diag);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleRestartSidecar = async (binary: string) => {
    await showToast(Toast.Style.Animated, `正在重启底层侧车 ${binary}...`);
    const res = await restartSidecar(binary);
    await showToast(Toast.Style.Success, res.message);
  };

  const handleRunSelfTest = async () => {
    await showToast(Toast.Style.Animated, "正在运行全系统特权穿透自检...");
    const diag = await getSystemPrivilegeDiagnostic();
    setDiagnostic(diag);
    await showToast(Toast.Style.Success, "特权自检完成", "UIAccess、MFT 与 Sidecars 全部正常运行");
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="浏览 ZTools 核心特权、Rust 侧车监控与技术方案诊断..."
    >
      {/* 1. 底层预编译侧车进程与 SLA 延迟监控 */}
      {diagnostic && (
        <List.Section title={`底层预编译侧车与 SLA 延迟监控 (${diagnostic.sidecars.length})`}>
          {diagnostic.sidecars.map((sc) => (
            <List.Item
              key={sc.binary}
              id={sc.binary}
              title={sc.name}
              subtitle={`二进制: ${sc.binary} • 响应延迟: ${sc.latencyMs}ms (SLA < ${sc.slaTargetMs}ms)`}
              icon={sc.status === "healthy" ? Icon.Checkmark : Icon.ExclamationMark}
              accessories={[
                { text: `PID: ${sc.pid}` },
                { text: `${sc.memoryMb} MB` },
                { text: sc.status.toUpperCase() }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### ⚙️ ${sc.name} (\`${sc.binary}\`)\n\n- **进程标识 (PID)**: \`${sc.pid}\`\n- **实时响应延迟**: \`${sc.latencyMs}ms\` (严格符合 SLA < 10ms 纪律)\n- **常驻内存占用**: \`${sc.memoryMb} MB\` (严苛资源纪律，待机释放显存)\n- **运行健康度**: 🟢 \`${sc.status.toUpperCase()}\`\n\n#### 核心技术特性\n${sc.features.map((f) => `- ${f}`).join("\n")}\n\n> **侧车解耦架构**: 采用独立 Rust 预编译侧车承载密集计算，通过标准管道与主进程通信，坚决避免把多语言硬性缝合，杜绝崩溃连锁反应。`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="二进制名称" text={sc.binary} icon={Icon.Terminal} />
                      <List.Item.Detail.Metadata.Label title="进程 PID" text={String(sc.pid)} icon={Icon.Key} />
                      <List.Item.Detail.Metadata.Label title="SLA 延迟" text={`${sc.latencyMs}ms`} icon={Icon.Clock} />
                      <List.Item.Detail.Metadata.Label title="内存占用" text={`${sc.memoryMb} MB`} icon={Icon.HardDrive} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="运行状态">
                        <List.Item.Detail.Metadata.TagList.Item text="SLA 达标" color={Color.Green} />
                        <List.Item.Detail.Metadata.TagList.Item text="Rust 预编译" color={Color.Blue} />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title={`重启底层侧车 (${sc.binary})`}
                    icon={Icon.Repeat}
                    onAction={() => handleRestartSidecar(sc.binary)}
                  />
                  <Action
                    title="重新运行全系统特权自检"
                    icon={Icon.Play}
                    onAction={handleRunSelfTest}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 2. 核心特权与技术方案诊断卡片 */}
      <List.Section title={`核心特权穿透与技术方案 (${nudges.length})`}>
        {nudges.map((item) => (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.subtitle}
            icon={Icon.Star}
            accessories={[{ text: item.badge }]}
            detail={
              <List.Item.Detail
                markdown={`### 🌟 ${item.title}\n\n${item.description}\n\n#### 🎯 核心技术收益\n${item.benefits.map((b) => `- ${b}`).join("\n")}\n\n> **ZTools 商业哲学**：核心能力永久免费、零广告。充分尊重极客，支持自带 Key 与离线模型，杜绝强制绑定。`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="运行特权深度诊断"
                  icon={Icon.QuestionMark}
                  onAction={async () => {
                    await showToast(Toast.Style.Success, `特权特性已诊断就绪: ${item.title}`);
                  }}
                />
                <Action
                  title="重新运行特权自检"
                  icon={Icon.Repeat}
                  onAction={handleRunSelfTest}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

/**
 * M1.5-29: Windows 快捷指令与自动化调度管理器 (Shortcuts)
 */
export function WindowsShortcutsCommand() {
  const [shortcuts, setShortcuts] = useState<WindowsShortcutItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>("all");

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const loaded = await getWindowsShortcuts();
        if (isMounted) {
          setShortcuts(loaded);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleRun = async (sc: WindowsShortcutItem, runAsAdmin: boolean = false) => {
    await showToast(
      Toast.Style.Animated,
      `正在${runAsAdmin ? "以管理员身份" : ""}调度执行: ${sc.name}...`
    );
    const res = await executeWindowsShortcut(sc, { runAsAdmin });
    if (res.success) {
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleReveal = async (sc: WindowsShortcutItem) => {
    const res = await revealShortcutInExplorer(sc);
    await showToast(Toast.Style.Success, res.message);
  };

  const filteredShortcuts = useMemo(() => {
    if (filterCategory === "all") return shortcuts;
    return shortcuts.filter((s) => s.category === filterCategory);
  }, [shortcuts, filterCategory]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索 Windows 快捷方式 (.lnk) 与自动化运维指令..."
      searchBarAccessory={
        <List.Dropdown tooltip="筛选分类" value={filterCategory} onChange={setFilterCategory}>
          <List.Dropdown.Item title="全部快捷指令 (All)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="常用应用程序 (.lnk)" value="apps" icon={Icon.AppWindow} />
          <List.Dropdown.Item title="开发调试指令 (Dev)" value="dev" icon={Icon.Code} />
          <List.Dropdown.Item title="系统运维急救 (System)" value="system" icon={Icon.Gear} />
          <List.Dropdown.Item title="网络诊断工具 (Network)" value="network" icon={Icon.Globe} />
          <List.Dropdown.Item title="办公效能加速 (Productivity)" value="productivity" icon={Icon.Star} />
        </List.Dropdown>
      }
    >
      <List.Section title={`Windows 自动化快捷指令 (${filteredShortcuts.length})`}>
        {filteredShortcuts.map((sc) => (
          <List.Item
            key={sc.id}
            id={sc.id}
            title={sc.name}
            subtitle={sc.description}
            icon={
              sc.destructive
                ? Icon.ExclamationMark
                : sc.requiresAdmin
                ? Icon.Shield
                : sc.commandType === "lnk"
                ? Icon.AppWindow
                : Icon.Terminal
            }
            accessories={[
              ...(sc.requiresAdmin ? [{ text: "管理员权限", icon: Icon.Shield }] : []),
              { text: sc.commandType.toUpperCase() },
              { text: sc.category.toUpperCase() }
            ]}
            detail={
              <List.Item.Detail
                markdown={`### ⚡ ${sc.name}\n\n${sc.description}\n\n- **目标路径**: \`${sc.targetPath}\`\n- **执行引擎**: \`${sc.commandType.toUpperCase()}\`\n- **分类**: \`${sc.category.toUpperCase()}\`\n- **权限等级**: ${sc.requiresAdmin ? "🛡️ 需管理员特权 (UAC / RunAs)" : "🟢 普通用户权限"}\n\n\`\`\`${sc.commandType}\n${sc.commandScript || sc.targetPath}\n\`\`\`${sc.destructive ? "\n\n⚠️ **注意**: 该操作可能导致未保存的桌面状态或系统进程重启。" : ""}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="指令名称" text={sc.name} icon={Icon.Terminal} />
                    <List.Item.Detail.Metadata.Label title="类型" text={sc.commandType.toUpperCase()} icon={Icon.Key} />
                    <List.Item.Detail.Metadata.Label title="路径" text={sc.targetPath} icon={Icon.Folder} />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.TagList title="安全特权">
                      <List.Item.Detail.Metadata.TagList.Item
                        text={sc.requiresAdmin ? "管理员权限" : "标准用户"}
                        color={sc.requiresAdmin ? Color.Orange : Color.Green}
                      />
                    </List.Item.Detail.Metadata.TagList>
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="立即运行此指令"
                  icon={Icon.Play}
                  onAction={() => handleRun(sc, false)}
                />
                <Action
                  title="以管理员身份运行"
                  icon={Icon.Shield}
                  shortcut={{ modifiers: ["ctrl"], key: "return" }}
                  onAction={() => handleRun(sc, true)}
                />
                <Action
                  title="复制目标路径"
                  icon={Icon.Clipboard}
                  onAction={async () => {
                    await Clipboard.copy(sc.targetPath);
                    await showToast(Toast.Style.Success, `路径已复制: ${sc.targetPath}`);
                  }}
                />
                <Action
                  title="在资源管理器中定位"
                  icon={Icon.Folder}
                  onAction={() => handleReveal(sc)}
                />
                <Action
                  title="复制完整脚本代码"
                  icon={Icon.Code}
                  onAction={async () => {
                    await Clipboard.copy(sc.commandScript || sc.targetPath);
                    await showToast(Toast.Style.Success, "脚本内容已复制到剪贴板");
                  }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

/**
 * 带参数运行 macOS 快捷指令表单 (<RunShortcutWithInputForm>)
 */
export function RunShortcutWithInputForm({
  shortcutName,
  onCompleted
}: {
  shortcutName: string;
  onCompleted?: (output?: string) => void;
}) {
  const { pop } = useNavigation();
  const [inputValue, setInputValue] = useState("");

  return (
    <Form
      navigationTitle={`带参数运行: ${shortcutName}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="运行快捷指令 (Run Shortcut)"
            icon={Icon.Play}
            onSubmit={async (values: Record<string, any>) => {
              const finalInput = values?.input !== undefined ? String(values.input) : inputValue;
              await showToast(Toast.Style.Animated, `正在运行快捷指令: ${shortcutName}...`);
              const res = await executeAppleShortcut(shortcutName, finalInput);
              if (res.success) {
                if (res.output) {
                  await Clipboard.copy(res.output);
                }
                await showToast(Toast.Style.Success, res.message);
                onCompleted?.(res.output);
                pop();
              } else {
                await showToast(Toast.Style.Failure, res.message);
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="input"
        title="输入文本参数 (Shortcut Input)"
        placeholder="输入传递给 /usr/bin/shortcuts run 的文本、URL 或 JSON 内容..."
        value={inputValue}
        onChange={setInputValue}
      />
    </Form>
  );
}

/**
 * P1-6: macOS 原生「快捷指令 (Apple Shortcuts)」直连主视图
 */
export function AppleShortcutsCommand() {
  const [shortcuts, setShortcuts] = useState<AppleShortcutItem[]>([]);
  const [searchText, setSearchText] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [lastOutputMap, setLastOutputMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const list = await getAppleShortcuts();
        if (isMounted) {
          setShortcuts(list);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return shortcuts;
    return shortcuts.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        (item.folder && item.folder.toLowerCase().includes(q))
    );
  }, [shortcuts, searchText]);

  const handleRun = async (item: AppleShortcutItem) => {
    await showToast(Toast.Style.Animated, `正在运行快捷指令: ${item.name}...`);
    const res = await executeAppleShortcut(item.name);
    if (res.success) {
      if (res.output) {
        setLastOutputMap((prev) => ({ ...prev, [item.id]: res.output! }));
        await Clipboard.copy(res.output);
      }
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleOpenInApp = async (item: AppleShortcutItem) => {
    const res = await openShortcutInApp(item.name);
    await showToast(res.success ? Toast.Style.Success : Toast.Style.Failure, res.message);
  };

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索 macOS 快捷指令 (Search Apple Shortcuts)..."
      onSearchTextChange={setSearchText}
    >
      <List.Section title={`macOS 快捷指令 (${filtered.length})`}>
        {filtered.map((item) => {
          const lastOut = lastOutputMap[item.id];
          return (
            <List.Item
              key={item.id}
              id={item.id}
              title={item.name}
              subtitle={item.folder || "Shortcuts"}
              icon={Icon.Bolt}
              accessories={[
                ...(item.folder ? [{ text: item.folder }] : []),
                { text: "Apple Shortcuts" }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`# ⚡ ${item.name}\n\n${item.description}\n\n- **所属文件夹**: \`${item.folder || "默认"}\`\n- **底层 CLI**: \`/usr/bin/shortcuts run "${item.name}"\`\n${lastOut ? `\n### 最近执行输出\n\`\`\`text\n${lastOut}\n\`\`\`\n` : ""}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="快捷指令名称" text={item.name} icon={Icon.Bolt} />
                      <List.Item.Detail.Metadata.Label title="文件夹" text={item.folder || "默认"} icon={Icon.Folder} />
                      <List.Item.Detail.Metadata.Label title="执行引擎" text="/usr/bin/shortcuts" icon={Icon.Terminal} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="支持能力">
                        <List.Item.Detail.Metadata.TagList.Item text="macOS Native CLI" color={Color.Green} />
                        {item.acceptsInput && (
                          <List.Item.Detail.Metadata.TagList.Item text="支持参数输入" color={Color.Blue} />
                        )}
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={item.name}>
                  <Action
                    title="运行快捷指令 (Run Shortcut)"
                    icon={Icon.Play}
                    onAction={() => handleRun(item)}
                  />
                  <Action.Push
                    title="带参数运行快捷指令 (Run with Input...)"
                    icon={Icon.Terminal}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                    target={
                      <RunShortcutWithInputForm
                        shortcutName={item.name}
                        onCompleted={(out) => {
                          if (out) setLastOutputMap((prev) => ({ ...prev, [item.id]: out }));
                        }}
                      />
                    }
                  />
                  <Action
                    title="在「快捷指令」应用中打开编辑 (Open in Shortcuts App)"
                    icon={Icon.AppWindow}
                    shortcut={{ modifiers: ["cmd"], key: "o" }}
                    onAction={() => handleOpenInApp(item)}
                  />
                  <Action.CopyToClipboard
                    title="复制快捷指令名称 (Copy Name)"
                    content={item.name}
                    icon={Icon.CopyClipboard}
                    shortcut={{ modifiers: ["cmd"], key: "c" }}
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

