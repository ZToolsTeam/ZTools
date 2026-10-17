import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast
} from "../../index.js";
import { useState, useMemo } from "../../runtime/hooks.js";
import {
  SYSTEM_ACTIONS,
  SystemActionItem,
  SystemCategory,
  filterSystemActions,
  executeSystemAction
} from "./system-actions.js";

export * from "./system-actions.js";

function getCategoryTitle(category: string): string {
  switch (category) {
    case "power": return "⚡ 电源与会话 (Power & Session)";
    case "apps": return "🪟 进程与桌面治理 (Apps & Windows)";
    case "audio": return "🔊 音频与硬件控制 (Audio & Hardware)";
    case "maintenance": return "🛠️ 系统维护与通知 (Maintenance)";
    case "desktop": return "🖥️ 桌面环境治理 (Desktop)";
    case "process": return "⚡ 进程治理急救 (Process)";
    default: return "原生系统指令";
  }
}

export default function SystemCommand() {
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState("all");
  const [isShowingDetail, setIsShowingDetail] = useState(false);

  const filtered = useMemo(() => {
    return filterSystemActions(searchText, category);
  }, [searchText, category]);

  const handleExecute = async (item: SystemActionItem, options?: { force?: boolean; confirmBypass?: boolean }) => {
    await executeSystemAction(item, options);
  };

  // 分组数据计算
  const groupedSections = useMemo(() => {
    if (category !== "all") {
      return [{ title: `${getCategoryTitle(category)} (${filtered.length})`, items: filtered }];
    }

    const categories: SystemCategory[] = ["power", "apps", "audio", "maintenance"];
    return categories
      .map(cat => {
        const items = filtered.filter(item => {
          if (item.category === cat) return true;
          if (cat === "apps" && item.category === "desktop") return true;
          return false;
        });
        return {
          title: `${getCategoryTitle(cat)} (${items.length})`,
          items
        };
      })
      .filter(section => section.items.length > 0);
  }, [filtered, category]);

  return (
    <List
      isShowingDetail={isShowingDetail}
      searchBarPlaceholder="搜索 macOS / Windows 系统控制指令 (如 深色模式, 隐藏文件, 咖啡因防休眠, 锁屏, 清空废纸篓)..."
      onSearchTextChange={setSearchText}
      searchBarAccessory={
        <List.Dropdown tooltip="按类别筛选" value={category} onChange={setCategory}>
          <List.Dropdown.Item title="全部动作 (All Actions)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="电源与防休眠 (Power & Session)" value="power" icon={Icon.Power} />
          <List.Dropdown.Item title="桌面与外观治理 (Apps & Desktop)" value="apps" icon={Icon.AppWindow} />
          <List.Dropdown.Item title="音频与蓝牙控制 (Audio & Hardware)" value="audio" icon={Icon.Play} />
          <List.Dropdown.Item title="系统维护与废纸篓 (Maintenance)" value="maintenance" icon={Icon.Gear} />
        </List.Dropdown>
      }
    >
      {groupedSections.map((section, idx) => (
        <List.Section key={`section-${idx}`} title={section.title}>
          {section.items.map(item => (
            <List.Item
              key={item.id}
              id={item.id}
              title={item.title}
              subtitle={isShowingDetail ? undefined : item.subtitle}
              icon={item.icon}
              accessories={[
                ...(item.destructive ? [{ icon: Icon.ExclamationMark, tooltip: "破坏性系统操作" }] : []),
                ...(item.shortcut ? [{ text: item.shortcut }] : []),
                { text: item.category.toUpperCase() }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### ${item.title}\n\n${item.description}\n\n> **底层调用契约**: \`${item.subtitle}\`\n\n${item.technicalDetails ? `**技术实现细节**:\n${item.technicalDetails}\n\n` : ''}${item.destructive ? '⚠️ **破坏性操作警告**：该操作会重置系统运行状态或导致正在运行的未保存数据丢失，执行前请务必确认关键工作已妥善存储。' : '✅ **安全运维指令**：该操作执行平稳无损，可在任意工作阶段直接调度。'}`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="动作名称" text={item.title} icon={Icon.Gear} />
                      <List.Item.Detail.Metadata.Label title="指令分类" text={item.category.toUpperCase()} icon={Icon.Document} />
                      <List.Item.Detail.Metadata.Label title="底层协议" text={item.actionKey} icon={Icon.Code} />
                      {item.shortcut && (
                        <List.Item.Detail.Metadata.Label title="全局快捷键" text={item.shortcut} icon={Icon.Key} />
                      )}
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="安全级别">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={item.destructive ? "DESTRUCTIVE (高危)" : "SAFE (安全)"}
                          color={item.destructive ? Color.Red : Color.Green}
                        />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel title={`系统动作: ${item.title}`}>
                  <Action
                    title={`立即执行: ${item.title}`}
                    icon={item.destructive ? Icon.ExclamationMark : Icon.Checkmark}
                    onAction={() => handleExecute(item)}
                  />
                  {item.destructive && (
                    <Action
                      title="强制直接执行 (跳过二次确认)"
                      icon={Icon.ExclamationMark}
                      shortcut={{ modifiers: ["ctrl", "shift"], key: "enter" }}
                      onAction={() => handleExecute(item, { force: true, confirmBypass: true })}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="复制底层调用契约"
                    content={item.actionKey}
                    shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  />
                  {item.technicalDetails && (
                    <Action.CopyToClipboard
                      title="复制技术实现细节"
                      content={item.technicalDetails}
                      shortcut={{ modifiers: ["ctrl", "shift"], key: "c" }}
                    />
                  )}
                  <Action
                    title={isShowingDetail ? "关闭双栏详情" : "展开双栏详情"}
                    icon={Icon.SidebarRight}
                    shortcut={{ modifiers: ["ctrl"], key: "b" }}
                    onAction={() => setIsShowingDetail(!isShowingDetail)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
