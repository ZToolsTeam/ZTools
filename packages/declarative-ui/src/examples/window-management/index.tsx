import React from "../../index.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showHUD,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  WindowActionDefinition,
  WindowManagementPreferences
} from "./types.js";
import {
  WINDOW_ACTIONS,
  DEFAULT_WINDOW_PREFERENCES,
  filterWindowActions,
  getWindowPreferences,
  saveWindowPreferences,
  executeWindowAction
} from "./window-actions.js";

export * from "./types.js";
export * from "./window-actions.js";

function getActionIcon(item: WindowActionDefinition): any {
  switch (item.id) {
    case "left-half": return Icon.SidebarLeft;
    case "right-half": return Icon.SidebarRight;
    case "top-half": return Icon.ArrowUp;
    case "bottom-half": return Icon.ArrowDown;
    case "center-half": return Icon.Columns;

    case "first-third": return Icon.SidebarLeft;
    case "center-third": return Icon.Columns;
    case "last-third": return Icon.SidebarRight;
    case "first-two-thirds":
    case "center-two-thirds":
    case "last-two-thirds": return Icon.Layout;
    case "top-third": return Icon.ArrowUp;
    case "middle-third": return Icon.ArrowsExpand;
    case "bottom-third": return Icon.ArrowDown;

    case "top-left-quarter": return Icon.ArrowUp;
    case "top-right-quarter": return Icon.ArrowUp;
    case "bottom-left-quarter": return Icon.ArrowDown;
    case "bottom-right-quarter": return Icon.ArrowDown;

    case "top-left-sixth":
    case "top-center-sixth":
    case "top-right-sixth":
    case "bottom-left-sixth":
    case "bottom-center-sixth":
    case "bottom-right-sixth": return Icon.Layout;

    case "maximize": return Icon.Maximize;
    case "restore": return Icon.Window;
    case "almost-maximize":
    case "almost-maximize-80":
    case "almost-maximize-70":
    case "almost-maximize-60": return Icon.ArrowsExpand;
    case "reasonable-size": return Icon.AppWindow;
    case "center": return Icon.AppWindow;
    case "maximize-height": return Icon.ArrowsExpand;
    case "maximize-width": return Icon.ArrowsExpand;
    case "minimize": return Icon.Minus;

    case "next-display":
    case "previous-display": return Icon.Monitor;
    case "minimize-on-display": return Icon.Monitor;

    case "make-larger": return Icon.Plus;
    case "make-smaller": return Icon.Minus;
    default: return Icon.ArrowsExpand;
  }
}

function getActionMarkdown(action: WindowActionDefinition, prefs?: WindowManagementPreferences): string {
  const innerGap = prefs ? prefs.innerGap : 0;
  const outerGap = prefs ? prefs.outerGap : 0;

  return `
# 窗口管理动作: ${action.name}

> **分类**: \`${action.category.toUpperCase()}\` | **全局快捷键**: \`${action.shortcut ?? "未指定"}\`

---

### 功能说明
${action.description}

### 当前边距偏好配置
- **内边距 (innerGap)**: \`${innerGap} px\`
- **外边距 (outerGap)**: \`${outerGap} px\`
- **吸附模式**: \`macOS Menu Bar / Dock WorkArea 自动避让 & Win32 rcWork 栅格计算\`

---

### 原生下沉执行说明 (macOS AXUIElement & Win32 UIAccess)
该动作直接通过双端原生特权管道执行：
- **macOS 端 (\`Accessibility / AXUIElement\`)**:
  - 基于 \`System Events\` / \`AXUIElement\` 定位当前前台活动应用主窗口并读写 \`position\` 与 \`size\`
  - 基于 \`visibleFrame\` / \`workArea\` 实现 **Menu Bar / Dock WorkArea 自动避让**，确保分屏绝不遮挡顶部菜单栏与底部程序坞
- **Windows 端 (\`Win32 & ztools-uiaccess\`)**:
  - 基于 Win32 \`GetForegroundWindow\` 捕获活动窗口句柄，通过 \`MonitorFromWindow\` 与 \`GetMonitorInfoW\` 读取 \`rcWork\`（主动避让系统任务栏）
  - 自动处理最大化窗口还原（\`ShowWindow(SW_RESTORE)\`）与极速重定位（\`SetWindowPos\`）
  - 携带 \`SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED\` 杜绝窗口闪烁，耗时严格控制在 **< 1ms** 内
  `;
}

/**
 * 窗口偏好配置表单
 */
export function WindowPreferencesForm({
  onSaved
}: {
  onSaved?: (prefs: WindowManagementPreferences) => void;
} = {}) {
  const { pop } = useNavigation();
  const [innerGap, setInnerGap] = useState<string>("0");
  const [outerGap, setOuterGap] = useState<string>("0");
  const [cycleMode, setCycleMode] = useState<string>("sizes");
  const [percentage, setPercentage] = useState<string>("0.9");

  useEffect(() => {
    void getWindowPreferences().then(prefs => {
      setInnerGap(String(prefs.innerGap));
      setOuterGap(String(prefs.outerGap));
      setCycleMode(prefs.cycleMode);
      setPercentage(String(prefs.percentage));
    });
  }, []);

  const handleSave = async () => {
    const updated = await saveWindowPreferences({
      innerGap: parseInt(innerGap, 10) || 0,
      outerGap: parseInt(outerGap, 10) || 0,
      cycleMode: cycleMode === "disabled" ? "disabled" : "sizes",
      percentage: parseFloat(percentage) || 0.9
    });
    if (onSaved) onSaved(updated);
    await showHUD("窗口调度偏好设置已更新");
    pop();
  };

  return (
    <Form
      navigationTitle="窗口管理偏好设置 (Window Preferences)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存偏好设置" onSubmit={handleSave} icon={Icon.Checkmark} />
          <Action
            title="恢复默认设置"
            icon={Icon.Repeat}
            onAction={async () => {
              await saveWindowPreferences(DEFAULT_WINDOW_PREFERENCES);
              setInnerGap("0");
              setOuterGap("0");
              setCycleMode("sizes");
              setPercentage("0.9");
              await showHUD("已恢复默认偏好设置");
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="innerGap" title="分屏内边距 (Inner Gap)" value={innerGap} onChange={setInnerGap}>
        <Form.Dropdown.Item value="0" title="0 像素 (紧贴无缝)" />
        <Form.Dropdown.Item value="4" title="4 像素 (微小间隙)" />
        <Form.Dropdown.Item value="8" title="8 像素 (标准间隙)" />
        <Form.Dropdown.Item value="12" title="12 像素 (舒适留白)" />
        <Form.Dropdown.Item value="16" title="16 像素 (极客宽松)" />
      </Form.Dropdown>

      <Form.Dropdown id="outerGap" title="屏幕外边距 (Outer Gap)" value={outerGap} onChange={setOuterGap}>
        <Form.Dropdown.Item value="0" title="0 像素 (紧贴屏幕边框)" />
        <Form.Dropdown.Item value="4" title="4 像素 (微边距)" />
        <Form.Dropdown.Item value="8" title="8 像素 (标准边距)" />
        <Form.Dropdown.Item value="16" title="16 像素 (亚克力大留白)" />
      </Form.Dropdown>

      <Form.Dropdown id="percentage" title="几乎最大化占比 (Percentage)" value={percentage} onChange={setPercentage}>
        <Form.Dropdown.Item value="0.9" title="90% 屏幕面积 (推荐)" />
        <Form.Dropdown.Item value="0.8" title="80% 屏幕面积" />
        <Form.Dropdown.Item value="0.7" title="70% 屏幕面积" />
        <Form.Dropdown.Item value="0.6" title="60% 屏幕面积" />
      </Form.Dropdown>

      <Form.Dropdown id="cycleMode" title="循环模式 (Cycle Mode)" value={cycleMode} onChange={setCycleMode}>
        <Form.Dropdown.Item value="sizes" title="尺寸循环 (Sizes: 1/2 -> 2/3 -> 1/3)" />
        <Form.Dropdown.Item value="disabled" title="禁用循环 (单次吸附)" />
      </Form.Dropdown>
    </Form>
  );
}

/**
 * 窗口动作详情视图
 */
export function WindowActionDetailView({
  action = WINDOW_ACTIONS[0],
  preferences
}: {
  action?: WindowActionDefinition;
  preferences?: WindowManagementPreferences;
} = {}) {
  const markdown = getActionMarkdown(action, preferences);

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`动作: ${action.name}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="动作标识" text={action.id} icon={Icon.Key} />
          <Detail.Metadata.Label title="分类" text={action.category.toUpperCase()} icon={Icon.List} />
          {action.shortcut && (
            <Detail.Metadata.Label title="推荐热键" text={action.shortcut} icon={Icon.Terminal} />
          )}
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="底层管道">
            <Detail.Metadata.TagList.Item
              text="Accessibility (AXUIElement)"
              color={Color.SecondaryText}
            />
            <Detail.Metadata.TagList.Item
              text="Menu Bar / Dock WorkArea 自动避让"
              color={Color.SecondaryText}
            />
            <Detail.Metadata.TagList.Item
              text="UIAccess UIPI Bypass"
              color={Color.SecondaryText}
            />
            <Detail.Metadata.TagList.Item
              text="Win32 SetWindowPos"
              color={Color.SecondaryText}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="窗口动作">
          <Action
            title={`立即执行: ${action.name}`}
            icon={Icon.Checkmark}
            onAction={async () => {
              await executeWindowAction(action.id);
            }}
          />
          {action.shortcut && (
            <Action.CopyToClipboard
              title="复制快捷键组合"
              content={action.shortcut}
              icon={Icon.CopyClipboard}
            />
          )}
        </ActionPanel>
      }
    />
  );
}

/**
 * 官方内置核心能力: Window Management (窗口调度器)
 * 布局一：100% 全宽极简列表，一目了然展示分屏比例、描述与全局快捷键
 */
export default function WindowManagementCommand() {
  const [searchText, setSearchText] = useState<string>("");
  const [category, setCategory] = useState<string>("all");
  const [isShowingDetail, setIsShowingDetail] = useState<boolean>(false);
  const [preferences, setPreferences] = useState<WindowManagementPreferences>(DEFAULT_WINDOW_PREFERENCES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    void getWindowPreferences().then(setPreferences);
  }, []);

  const filtered = filterWindowActions(WINDOW_ACTIONS, {
    category: category as any,
    query: searchText
  });

  const halves = filtered.filter(a => a.category === "halves");
  const thirds = filtered.filter(a => a.category === "thirds");
  const quarters = filtered.filter(a => a.category === "quarters");
  const sixths = filtered.filter(a => a.category === "sixths");
  const centerMax = filtered.filter(a => a.category === "center-max");
  const displays = filtered.filter(a => a.category === "displays");
  const resize = filtered.filter(a => a.category === "resize");

  const handleExecute = async (item: WindowActionDefinition) => {
    await executeWindowAction(item.id, { preferences });
  };

  const renderActionItem = (item: WindowActionDefinition) => (
    <List.Item
      key={item.id}
      id={item.id}
      title={item.name}
      subtitle={item.description}
      icon={getActionIcon(item)}
      accessories={[
        { tag: { value: item.category.toUpperCase() } },
        ...(item.shortcut ? [{ text: item.shortcut }] : [])
      ]}
      detail={
        <List.Item.Detail
          markdown={getActionMarkdown(item, preferences)}
        />
      }
      actions={
        <ActionPanel title="窗口动作">
          <Action
            title={`执行 ${item.name}`}
            icon={Icon.Checkmark}
            onAction={() => handleExecute(item)}
          />
          <Action.Push
            title="偏好设置与边距微调"
            target={<WindowPreferencesForm onSaved={setPreferences} />}
            icon={Icon.Gear}
            shortcut={{ modifiers: ["ctrl"], key: "return" }}
          />
          <Action.Push
            title="全屏查看动作详情与底层说明"
            target={<WindowActionDetailView action={item} preferences={preferences} />}
            icon={Icon.Eye}
            shortcut={{ modifiers: ["ctrl"], key: "d" }}
          />
          <Action
            title={isShowingDetail ? "关闭右侧详情分栏" : "展开右侧详情分栏"}
            icon={Icon.SidebarRight}
            shortcut={{ modifiers: ["ctrl"], key: "b" }}
            onAction={() => setIsShowingDetail(!isShowingDetail)}
          />
          {item.shortcut && (
            <Action.CopyToClipboard
              title="复制推荐快捷键"
              content={item.shortcut}
              icon={Icon.CopyClipboard}
              shortcut={{ modifiers: ["ctrl"], key: "c" }}
            />
          )}
        </ActionPanel>
      }
    />
  );

  return (
    <List
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索窗口管理动作 (如: 左半屏, 最大化, 居中, 60%, 快捷键)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `窗口栅格调度动作 ${filtered.length} 项 · 分屏边距 ${preferences.innerGap}px / ${preferences.outerGap}px · Win32 WorkArea 自动避让`,
        actions: [
          {
            id: "prefs",
            label: "边距偏好设置",
            title: "边距偏好设置",
            style: "secondary",
            onAction: () => {
              push(<WindowPreferencesForm onSaved={setPreferences} />);
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按分类筛选"
          value={category}
          onChange={setCategory}
        >
          <List.Dropdown.Item title="全部动作 (All)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="半屏对齐 (Halves)" value="halves" icon={Icon.SidebarLeft} />
          <List.Dropdown.Item title="三分屏与比例 (Thirds)" value="thirds" icon={Icon.Columns} />
          <List.Dropdown.Item title="四分屏与角落 (Quarters)" value="quarters" icon={Icon.ArrowUp} />
          <List.Dropdown.Item title="六分屏栅格 (Sixths)" value="sixths" icon={Icon.Layout} />
          <List.Dropdown.Item title="居中与铺满 (Center & Max)" value="center-max" icon={Icon.Maximize} />
          <List.Dropdown.Item title="显示器切换 (Displays)" value="displays" icon={Icon.Monitor} />
          <List.Dropdown.Item title="微调缩放 (Resize)" value="resize" icon={Icon.ArrowsExpand} />
        </List.Dropdown>
      }
    >
      {halves.length > 0 && (
        <List.Section title="半屏对齐 (Halves)">
          {halves.map(renderActionItem)}
        </List.Section>
      )}

      {thirds.length > 0 && (
        <List.Section title="三分屏与主工作流 (Thirds & Two-Thirds)">
          {thirds.map(renderActionItem)}
        </List.Section>
      )}

      {quarters.length > 0 && (
        <List.Section title="四分屏与角落吸附 (Quarters & Corners)">
          {quarters.map(renderActionItem)}
        </List.Section>
      )}

      {sixths.length > 0 && (
        <List.Section title="六分屏栅格排版 (Sixths Grid)">
          {sixths.map(renderActionItem)}
        </List.Section>
      )}

      {centerMax.length > 0 && (
        <List.Section title="居中与铺满 (Center & Maximize)">
          {centerMax.map(renderActionItem)}
        </List.Section>
      )}

      {displays.length > 0 && (
        <List.Section title="跨显示器调度 (Multi-Display Scheduling)">
          {displays.map(renderActionItem)}
        </List.Section>
      )}

      {resize.length > 0 && (
        <List.Section title="视窗微调缩放 (Resize Step by Step)">
          {resize.map(renderActionItem)}
        </List.Section>
      )}
    </List>
  );
}
