import React from "../../index.js";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color
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
    case "power": return "电源与会话 (Power & Session)";
    case "apps": return "进程与桌面治理 (Apps & Windows)";
    case "audio": return "音频与硬件控制 (Audio & Hardware)";
    case "maintenance": return "系统维护与通知 (Maintenance)";
    case "desktop": return "桌面环境治理 (Desktop)";
    case "process": return "进程治理急救 (Process)";
    default: return "全部系统指令 (All Actions)";
  }
}

export default function SystemCommand() {
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState("all");
  const [isShowingDetail, setIsShowingDetail] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return filterSystemActions(searchText, category);
  }, [searchText, category]);

  const handleExecute = async (item: SystemActionItem, options?: { force?: boolean; confirmBypass?: boolean }) => {
    await executeSystemAction(item, options);
  };

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
      searchBarPlaceholder="搜索 macOS / Windows 系统控制指令 (如 深色模式, 隐藏文件, 防休眠, 锁屏, 清空回收站)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: `系统原生控制指令共 ${filtered.length} 项 · 当前视图: ${getCategoryTitle(category)} · 支持回车直接触发`
      }}
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
              subtitle={`${item.description} · ${item.subtitle}`}
              icon={item.icon}
              accessories={[
                ...(item.destructive ? [{ tag: { value: "高危操作", color: Color.Red } }] : []),
                { tag: { value: item.category.toUpperCase() } },
                ...(item.shortcut ? [{ text: item.shortcut }] : [])
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### ${item.title}\n\n${item.description}\n\n> **底层调用契约**: \`${item.subtitle}\`\n\n${item.technicalDetails ? `**技术实现细节**:\n${item.technicalDetails}\n\n` : ''}${item.destructive ? '**破坏性操作警告**：该操作会重置系统运行状态或导致正在运行的未保存数据丢失，执行前请务必确认关键工作已妥善存储。' : '**安全运维指令**：该操作执行平稳无损，可在任意工作阶段直接调度。'}`}
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
                      shortcut={{ modifiers: ["ctrl"], key: "return" }}
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
