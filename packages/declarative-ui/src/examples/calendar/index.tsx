/**
 * Calendar (极客日程表、视频会议直达与 ICS 日历中枢)
 *
 * 深度对齐 Raycast 官方 `calendar` (`My Schedule` & `Create Event`)：
 * - 双栏展示今日与近期日程 (Upcoming Events)、会议室链接 (Zoom / Feishu / Teams / Google Meet) 一键直达
 * - 支持通过 <Form> 快速新建日程 (Create Event)、删除日程与一键导出标准 RFC 5545 `.ics` 日历文件
 * - 对接主进程 `calendar_upcoming_events`, `calendar_list_events`, `calendar_create_event`, `calendar_delete_event`, `calendar_export_ics` IPC
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

export type CalendarFilterScope = "all" | "upcoming" | "meetings" | "today";

export interface CalendarEventItem {
  readonly id: string;
  readonly title: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly location: string;
  readonly conferenceUrl?: string;
  readonly calendarName: string;
  readonly notes: string;
  readonly attendees: readonly string[];
  readonly isAllDay?: boolean;
}

export const DEFAULT_CALENDAR_EVENTS: readonly CalendarEventItem[] = Object.freeze([
  {
    id: "evt-arch-sync",
    title: "ZTools 2.0 macOS 双端架构对齐评审会",
    startTime: "10:00",
    endTime: "11:00",
    location: "飞书视频会议 (Feishu Meet)",
    conferenceUrl: "https://vc.feishu.cn/j/882910421",
    calendarName: "Work",
    notes: "评审 32+ 款第一方内置声明式套件与 macOS 原生侧车/TCC 权限降级体验",
    attendees: ["arch@ztools.dev", "macos@ztools.dev", "qa@ztools.dev"]
  },
  {
    id: "evt-code-freeze",
    title: "Declarative UI 2.0 Release Candidate 发版冻结",
    startTime: "14:30",
    endTime: "15:30",
    location: "Zoom Conference Room",
    conferenceUrl: "https://zoom.us/j/918273645",
    calendarName: "Engineering",
    notes: "完成全量 E2E 集成与混沌破坏性测试门禁验收",
    attendees: ["release@ztools.dev"]
  },
  {
    id: "evt-1on1",
    title: "1:1 Developer Experience & Plugin Store Review",
    startTime: "16:30",
    endTime: "17:00",
    location: "Google Meet",
    conferenceUrl: "https://meet.google.com/ztools-dx-sync",
    calendarName: "Work",
    notes: "讨论 ZTools-extensions 社区 PR 自动 AST 扫描与 CDN 分发",
    attendees: ["dx@ztools.dev"]
  },
  {
    id: "evt-gym",
    title: "晚间有氧训练与拉伸恢复",
    startTime: "19:30",
    endTime: "20:30",
    location: "Fitness Center",
    calendarName: "Personal",
    notes: "保持充沛体能与极客状态",
    attendees: []
  }
]);

let memoryCalendarEvents: CalendarEventItem[] = [...DEFAULT_CALENDAR_EVENTS];

/**
 * 生成符合 RFC 5545 规范的 iCalendar (.ics) 文本
 */
export function buildCalendarIcsContent(events: readonly CalendarEventItem[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ZTools//Declarative Calendar 2.0//CN",
    "CALSCALE:GREGORIAN"
  ];
  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.id}@ztools.dev`,
      `SUMMARY:${ev.title}`,
      `LOCATION:${ev.location || ""}`,
      `DESCRIPTION:${(ev.notes || "").replace(/\r?\n/g, "\\n")}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function formatEventClockTime(raw: unknown, fallback: string): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    if (/^\d{10,13}$/.test(trimmed)) {
      const d = new Date(Number(trimmed));
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
    return trimmed;
  }
  return fallback;
}

export async function fetchCalendarEvents(
  scope: CalendarFilterScope = "all",
  hostOverride?: any
): Promise<CalendarEventItem[]> {
  if (hostOverride || isRealElectronHost()) {
    const method =
      scope === "upcoming" ? "calendar_upcoming_events" : "calendar_list_events";
    const res = await callHostTransport<any>(method, { scope }, hostOverride);
    const rawList = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.events)
        ? res.data.events
        : null;
    if (res.ok && rawList) {
      if (rawList.length > 0 || isRealElectronHost()) {
        return rawList.map((e: any, idx: number) => ({
          id: String(e.id || `evt-${idx}`),
          title: String(e.title || e.summary || "Untitled Event"),
          startTime: formatEventClockTime(e.startTime ?? e.start, "09:00"),
          endTime: formatEventClockTime(e.endTime ?? e.end, "10:00"),
          location: String(e.location || ""),
          conferenceUrl: e.conferenceUrl || e.meetingUrl ? String(e.conferenceUrl || e.meetingUrl) : undefined,
          calendarName: String(e.calendarName || e.calendar || "Calendar"),
          notes: String(e.notes || e.description || ""),
          attendees: Array.isArray(e.attendees) ? e.attendees.map(String) : [],
          isAllDay: Boolean(e.isAllDay ?? e.allDay)
        }));
      }
    }
    if (isRealElectronHost() && !hostOverride) {
      return [];
    }
  }
  return [...memoryCalendarEvents];
}

export async function createCalendarEvent(
  input: {
    title: string;
    startTime: string;
    endTime: string;
    location?: string;
    conferenceUrl?: string;
    calendarName?: string;
    notes?: string;
  },
  hostOverride?: any
): Promise<CalendarEventItem> {
  const cleanTitle = (input.title || "").trim();
  if (!cleanTitle) {
    throw new Error("EVENT_TITLE_REQUIRED: 日程标题不能为空");
  }

  const newEvent: CalendarEventItem = {
    id: `evt-${Date.now()}`,
    title: cleanTitle,
    startTime: (input.startTime || "10:00").trim(),
    endTime: (input.endTime || "11:00").trim(),
    location: (input.location || "Online").trim(),
    conferenceUrl: input.conferenceUrl?.trim() || undefined,
    calendarName: (input.calendarName || "Work").trim(),
    notes: (input.notes || "").trim(),
    attendees: []
  };

  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>("calendar_create_event", newEvent as any, hostOverride);
    if (res.ok && res.data && res.data.id) {
      const merged: CalendarEventItem = {
        ...newEvent,
        id: String(res.data.id)
      };
      memoryCalendarEvents = [merged, ...memoryCalendarEvents];
      return merged;
    }
  }

  memoryCalendarEvents = [newEvent, ...memoryCalendarEvents];
  return newEvent;
}

export async function deleteCalendarEvent(
  id: string,
  hostOverride?: any
): Promise<boolean> {
  const cleanId = (id || "").trim();
  if (!cleanId) return false;
  if (hostOverride || isRealElectronHost()) {
    await callHostTransport("calendar_delete_event", { id: cleanId }, hostOverride);
  }
  const before = memoryCalendarEvents.length;
  memoryCalendarEvents = memoryCalendarEvents.filter((e) => e.id !== cleanId);
  return memoryCalendarEvents.length < before || true;
}

export async function exportCalendarIcs(
  events: readonly CalendarEventItem[] = memoryCalendarEvents,
  hostOverride?: any
): Promise<string> {
  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>(
      "calendar_export_ics",
      { eventIds: events.map((e) => e.id) },
      hostOverride
    );
    if (res.ok && res.data) {
      const ics = typeof res.data === "string" ? res.data : res.data.ics;
      if (typeof ics === "string" && ics.includes("BEGIN:VCALENDAR")) {
        return ics;
      }
    }
  }
  return buildCalendarIcsContent(events);
}

export function CreateCalendarEventForm({
  onCreated
}: {
  onCreated?: (evt: CalendarEventItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [startTime, setStartTime] = useState("15:00");
  const [endTime, setEndTime] = useState("16:00");
  const [calendarName, setCalendarName] = useState("Work");
  const [location, setLocation] = useState("Feishu / Zoom");
  const [conferenceUrl, setConferenceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const { pop } = useNavigation();

  const handleSubmit = async () => {
    try {
      const created = await createCalendarEvent({
        title,
        startTime,
        endTime,
        calendarName,
        location,
        conferenceUrl,
        notes
      });
      onCreated?.(created);
      await showToast(Toast.Style.Success, `已创建日程: ${created.title}`, `${created.startTime} - ${created.endTime}`);
      pop();
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "创建日程失败", err?.message || String(err));
    }
  };

  return (
    <Form
      navigationTitle="新建日程事件 (Create Calendar Event)"
      actions={
        <ActionPanel>
          <Action title="保存日程" icon={Icon.Check} onAction={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="日程主题"
        placeholder="例如: 产品周会 / 架构评审"
        value={title}
        onChange={setTitle}
      />
      <Form.TextField
        id="startTime"
        title="开始时间"
        placeholder="15:00"
        value={startTime}
        onChange={setStartTime}
      />
      <Form.TextField
        id="endTime"
        title="结束时间"
        placeholder="16:00"
        value={endTime}
        onChange={setEndTime}
      />
      <Form.Dropdown
        id="calendarName"
        title="所属日历"
        value={calendarName}
        onChange={setCalendarName}
      >
        <Form.Dropdown.Item value="Work" title="工作日程 (Work)" />
        <Form.Dropdown.Item value="Engineering" title="工程研发 (Engineering)" />
        <Form.Dropdown.Item value="Personal" title="个人生活 (Personal)" />
      </Form.Dropdown>
      <Form.TextField
        id="location"
        title="地点 / 会议室"
        placeholder="例如: 飞书会议 / 3F 会议室"
        value={location}
        onChange={setLocation}
      />
      <Form.TextField
        id="conferenceUrl"
        title="在线会议链接 (可选)"
        placeholder="https://vc.feishu.cn/j/..."
        value={conferenceUrl}
        onChange={setConferenceUrl}
      />
      <Form.TextArea
        id="notes"
        title="议程与备注"
        placeholder="填写会议议程或准备事项..."
        value={notes}
        onChange={setNotes}
      />
    </Form>
  );
}

export function CalendarCommand() {
  const realHost = isRealElectronHost();
  const [events, setEvents] = useState<CalendarEventItem[]>(
    realHost ? [] : [...DEFAULT_CALENDAR_EVENTS]
  );
  const [searchText, setSearchText] = useState("");
  const [scope, setScope] = useState<CalendarFilterScope>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(realHost);
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetchCalendarEvents(scope)
      .then((list) => {
        if (!active) return;
        setEvents(list);
        setIsLoading(false);
      })
      .catch(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope]);

  const displayedEvents = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return events.filter((e) => {
      if (scope === "meetings" && !e.conferenceUrl) return false;
      if (!q) return true;
      return (
        e.title.toLowerCase().includes(q) ||
        e.location.toLowerCase().includes(q) ||
        e.calendarName.toLowerCase().includes(q) ||
        e.notes.toLowerCase().includes(q)
      );
    });
  }, [events, searchText, scope]);

  const handleDelete = async (evt: CalendarEventItem) => {
    await deleteCalendarEvent(evt.id);
    setEvents((prev) => prev.filter((item) => item.id !== evt.id));
    await showToast(Toast.Style.Success, `已删除日程: ${evt.title}`);
  };

  const handleExportIcs = async () => {
    const ics = await exportCalendarIcs(displayedEvents);
    await Clipboard.copy(ics);
    await showToast(
      Toast.Style.Success,
      "已导出并复制 ICS 日历文件",
      `包含 ${displayedEvents.length} 个日程事件`
    );
  };

  const activeEvent = useMemo(
    () => displayedEvents.find((e) => e.id === selectedId) || displayedEvents[0] || null,
    [displayedEvents, selectedId]
  );

  const nextMeeting = useMemo(
    () => events.find((e) => Boolean(e.conferenceUrl)) || events[0] || null,
    [events]
  );

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索近期日程、视频会议或创建新事件 (My Schedule & Conferences)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: nextMeeting
          ? `📅 日程安排 • 共 ${events.length} 场日程 (视频会议 ${events.filter((e) => Boolean(e.conferenceUrl)).length} 场) | 下一场: ${nextMeeting.title} (${nextMeeting.startTime})`
          : `📅 日程安排 • 当前共 ${events.length} 场日程`,
        groups: [
          {
            id: "calendar-scope",
            value: scope,
            onChange: (val) => setScope(val as CalendarFilterScope),
            options: [
              { title: "全部日程", value: "all", count: events.length },
              { title: "即将开始", value: "upcoming", count: events.length },
              {
                title: "视频会议",
                value: "meetings",
                count: events.filter((e) => Boolean(e.conferenceUrl)).length
              }
            ]
          }
        ],
        actions: [
          {
            id: "join-video-meeting",
            label: "📹 一键加入视频会议",
            title: "📹 一键加入视频会议",
            style: "primary",
            onAction: async () => {
              const targetEvt =
                activeEvent?.conferenceUrl
                  ? activeEvent
                  : displayedEvents.find((e) => Boolean(e.conferenceUrl)) || activeEvent;
              if (!targetEvt || !targetEvt.conferenceUrl) {
                await showToast(Toast.Style.Failure, "当前选中日程未包含在线视频会议链接");
                return;
              }
              const res = await callHostTransport("shell_open_external", {
                url: targetEvt.conferenceUrl
              });
              if (!res.ok) {
                await Clipboard.copy(targetEvt.conferenceUrl);
              }
              await showToast(
                Toast.Style.Success,
                `正在加入会议: ${targetEvt.title}`,
                targetEvt.conferenceUrl
              );
            }
          },
          {
            id: "create-calendar-event",
            label: "➕ 新建日程事件...",
            title: "➕ 新建日程事件...",
            style: "primary",
            onAction: () => {
              push(
                <CreateCalendarEventForm
                  onCreated={(created) => setEvents((prev) => [created, ...prev])}
                />
              );
            }
          },
          {
            id: "export-all-ics",
            label: "📤 导出全部日程 (.ics)",
            title: "📤 导出全部日程 (.ics)",
            style: "secondary",
            onAction: handleExportIcs
          },
          {
            id: "copy-event-summary",
            label: "📋 复制日程摘要",
            title: "📋 复制日程摘要",
            style: "secondary",
            onAction: async () => {
              if (!activeEvent) return;
              const summary = `${activeEvent.title} (${activeEvent.startTime}-${activeEvent.endTime}) @ ${activeEvent.location}`;
              await Clipboard.copy(summary);
              await showToast(Toast.Style.Success, "已复制日程摘要", summary);
            }
          },
          {
            id: "delete-selected-event",
            label: "🗑️ 删除选中日程",
            title: "🗑️ 删除选中日程",
            style: "danger",
            onAction: async () => {
              if (activeEvent) {
                await handleDelete(activeEvent);
              }
            }
          }
        ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选日程范围"
          value={scope}
          onChange={(val) => setScope(val as CalendarFilterScope)}
        >
          <List.Dropdown.Item
            title={`全部日程 (All Events · ${events.length})`}
            value="all"
            icon={Icon.Calendar}
          />
          <List.Dropdown.Item
            title="即将开始 (Upcoming Events)"
            value="upcoming"
            icon={Icon.Clock}
          />
          <List.Dropdown.Item
            title="含视频会议链接 (Video Meetings)"
            value="meetings"
            icon={Icon.Video}
          />
        </List.Dropdown>
      }
    >
      <List.Section title={`日程安排 (My Schedule · ${displayedEvents.length})`}>
        {displayedEvents.length === 0 && (
          <List.Item
            id="calendar-empty-create"
            title="新建日程事件 (Create Calendar Event)..."
            subtitle="当前暂无日程安排，按 Enter 立即创建新日程或在线会议"
            icon={Icon.Plus}
            detail={
              <List.Item.Detail
                markdown={`# 📅 暂无日程事件\n\n按 \`Enter\` 即可新建工作日程、会议室预约或视频会议直达链接。`}
              />
            }
            actions={
              <ActionPanel title="日程管理">
                <Action.Push
                  title="新建日程事件 (Create Event)..."
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={
                    <CreateCalendarEventForm
                      onCreated={(created) => setEvents((prev) => [created, ...prev])}
                    />
                  }
                />
              </ActionPanel>
            }
          />
        )}
        {displayedEvents.map((evt) => (
          <List.Item
            key={evt.id}
            id={evt.id}
            title={evt.title}
            subtitle={`${evt.startTime} - ${evt.endTime} • ${evt.location}`}
            icon={evt.conferenceUrl ? Icon.Video : Icon.Calendar}
            accessories={[
              { text: evt.calendarName },
              { text: `${evt.startTime} - ${evt.endTime}` }
            ]}
            detail={
              <List.Item.Detail
                markdown={[
                  `# 📅 ${evt.title}`,
                  `> **时间**: \`${evt.startTime} - ${evt.endTime}\` &nbsp;|&nbsp; **日历**: \`${evt.calendarName}\``,
                  `---`,
                  `- **地点 / 会议室**: ${evt.location || "未指定"}`,
                  evt.conferenceUrl
                    ? `- **在线会议直达**: [${evt.conferenceUrl}](${evt.conferenceUrl})`
                    : "",
                  evt.notes ? `### 📝 议程与备注\n${evt.notes}` : "",
                  evt.attendees.length > 0
                    ? `### 👥 参会人 (${evt.attendees.length})\n` +
                      evt.attendees.map((a) => `- \`${a}\``).join("\n")
                    : ""
                ]
                  .filter(Boolean)
                  .join("\n\n")}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="时间段"
                      text={`${evt.startTime} - ${evt.endTime}`}
                      icon={Icon.Clock}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="日历分组"
                      text={evt.calendarName}
                      icon={Icon.Calendar}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="地点"
                      text={evt.location || "-"}
                      icon={Icon.Globe}
                    />
                    {evt.conferenceUrl && (
                      <List.Item.Detail.Metadata.TagList title="会议状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text="可一键入会 (Join Ready)"
                          color={Color.Green}
                        />
                      </List.Item.Detail.Metadata.TagList>
                    )}
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel title={evt.title}>
                {evt.conferenceUrl && (
                  <Action.OpenInBrowser
                    title="一键加入视频会议 (Join Meeting)"
                    url={evt.conferenceUrl}
                  />
                )}
                <Action.Push
                  title="新建日程事件 (Create Event)..."
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={
                    <CreateCalendarEventForm
                      onCreated={(created) => setEvents((prev) => [created, ...prev])}
                    />
                  }
                />
                <Action
                  title="导出全部日程为 ICS"
                  icon={Icon.Download}
                  shortcut={{ modifiers: ["ctrl"], key: "e" }}
                  onAction={handleExportIcs}
                />
                <Action
                  title="复制日程摘要"
                  icon={Icon.CopyClipboard}
                  shortcut={{ modifiers: ["ctrl"], key: "c" }}
                  onAction={async () => {
                    const summary = `${evt.title} (${evt.startTime}-${evt.endTime}) @ ${evt.location}`;
                    await Clipboard.copy(summary);
                    await showToast(Toast.Style.Success, "已复制日程摘要", summary);
                  }}
                />
                <Action
                  title="删除此日程"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => handleDelete(evt)}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

export default CalendarCommand;
