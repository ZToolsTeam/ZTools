/**
 * Raycast Focus (极客心流专注时钟与分心应用/站点屏蔽工作台)
 *
 * 深度对齐 Raycast 官方 `raycast-focus` 套件：
 * - 支持开启专注会话 (Start Focus Session)、暂停/恢复、完成结算与中途取消
 * - 支持专注分类管理 (Deep Coding / Writing / Design / Reading) 与屏蔽应用/域名规则配置
 * - 对接主进程 `focus_start`, `focus_toggle`, `focus_pause`, `focus_resume`, `focus_complete`,
 *   `focus_cancel`, `focus_get_current`, `focus_list_categories`, `focus_create_category`, `focus_get_stats` IPC
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
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export type FocusSessionState = "idle" | "active" | "paused" | "completed";

export interface FocusCategory {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly defaultDurationMinutes: number;
  readonly blockedApps: readonly string[];
  readonly blockedSites: readonly string[];
}

export interface FocusSession {
  readonly id: string;
  readonly goal: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly durationMinutes: number;
  readonly remainingSeconds: number;
  readonly status: FocusSessionState;
  readonly startedAt: number;
  readonly blockedApps: readonly string[];
  readonly blockedSites: readonly string[];
}

export interface FocusStatsSummary {
  readonly completedSessions: number;
  readonly totalFocusedMinutes: number;
  readonly currentStreakDays: number;
  readonly blockedDistractionsCount: number;
}

export const DEFAULT_FOCUS_CATEGORIES: readonly FocusCategory[] = Object.freeze([
  {
    id: "cat-deep-coding",
    name: "深度编码 (Deep Coding)",
    icon: "💻",
    defaultDurationMinutes: 50,
    blockedApps: ["WeChat", "Telegram", "Discord", "Music"],
    blockedSites: ["weibo.com", "bilibili.com", "twitter.com", "reddit.com"]
  },
  {
    id: "cat-architecture",
    name: "架构设计与文档 (Architecture & RFC)",
    icon: "📐",
    defaultDurationMinutes: 45,
    blockedApps: ["Slack", "WeChat", "Mail"],
    blockedSites: ["youtube.com", "bilibili.com", "news.ycombinator.com"]
  },
  {
    id: "cat-pomodoro",
    name: "标准番茄钟 (25m Pomodoro)",
    icon: "🍅",
    defaultDurationMinutes: 25,
    blockedApps: ["WeChat", "Discord"],
    blockedSites: ["bilibili.com", "zhihu.com", "tiktok.com"]
  },
  {
    id: "cat-bug-hunt",
    name: "极限排障冲刺 (Bug Triage Sprint)",
    icon: "🔥",
    defaultDurationMinutes: 90,
    blockedApps: ["WeChat", "Feishu", "DingTalk", "Steam"],
    blockedSites: ["weibo.com", "bilibili.com", "v2ex.com"]
  }
]);

const DEFAULT_FOCUS_STATS: FocusStatsSummary = {
  completedSessions: 12,
  totalFocusedMinutes: 540,
  currentStreakDays: 5,
  blockedDistractionsCount: 38
};

let memoryCurrentSession: FocusSession | null = null;
let memoryCategories: FocusCategory[] = [...DEFAULT_FOCUS_CATEGORIES];
let memoryStats: FocusStatsSummary = { ...DEFAULT_FOCUS_STATS };

export async function getFocusCurrentSession(hostOverride?: any): Promise<FocusSession | null> {
  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>("focus_get_current", {}, hostOverride);
    if (res.ok && res.data) {
      const s = res.data.session !== undefined ? res.data.session : res.data;
      if (!s || !s.id || s.status === "idle") return null;
      return {
        id: String(s.id),
        goal: String(s.goal || s.title || "专注冲刺"),
        categoryId: String(s.categoryId || "cat-deep-coding"),
        categoryName: String(s.categoryName || "深度编码"),
        durationMinutes: Number(s.durationMinutes || 25),
        remainingSeconds: Number(s.remainingSeconds ?? (Number(s.durationMinutes || 25) * 60)),
        status: (s.status || "active") as FocusSessionState,
        startedAt: Number(s.startedAt || Date.now()),
        blockedApps: Array.isArray(s.blockedApps) ? s.blockedApps.map(String) : [],
        blockedSites: Array.isArray(s.blockedSites) ? s.blockedSites.map(String) : []
      };
    }
  }
  return memoryCurrentSession ? { ...memoryCurrentSession } : null;
}

const FOCUS_ICON_MAP: Record<string, string> = {
  briefcase: "💼",
  code: "💻",
  book: "📖",
  "academic-cap": "🎓",
  target: "🎯",
  flame: "🔥",
  clock: "⏱️"
};

function normalizeFocusIcon(rawIcon: unknown): string {
  const str = String(rawIcon || "").trim();
  if (!str) return "🎯";
  return FOCUS_ICON_MAP[str.toLowerCase()] || str;
}

export async function listFocusCategories(hostOverride?: any): Promise<FocusCategory[]> {
  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>("focus_list_categories", {}, hostOverride);
    const list = Array.isArray(res.data)
      ? res.data
      : Array.isArray(res.data?.categories)
        ? res.data.categories
        : null;
    if (res.ok && list && list.length > 0) {
      return list.map((c: any, idx: number) => ({
        id: String(c.id || `cat-${idx}`),
        name: String(c.name || "Focus Category"),
        icon: normalizeFocusIcon(c.icon),
        defaultDurationMinutes: Number(c.defaultDurationMinutes || c.durationMinutes || 25),
        blockedApps: Array.isArray(c.blockedApps) ? c.blockedApps.map(String) : [],
        blockedSites: Array.isArray(c.blockedSites) ? c.blockedSites.map(String) : []
      }));
    }
  }
  return [...memoryCategories];
}

export async function getFocusStats(hostOverride?: any): Promise<FocusStatsSummary> {
  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>("focus_get_stats", {}, hostOverride);
    if (res.ok && res.data) {
      const d = res.data;
      return {
        completedSessions: Number(d.completedSessions ?? d.totalSessions ?? memoryStats.completedSessions),
        totalFocusedMinutes: Number(d.totalFocusedMinutes ?? d.totalMinutes ?? memoryStats.totalFocusedMinutes),
        currentStreakDays: Number(d.currentStreakDays ?? d.streakDays ?? memoryStats.currentStreakDays),
        blockedDistractionsCount: Number(d.blockedDistractionsCount ?? memoryStats.blockedDistractionsCount)
      };
    }
  }
  return { ...memoryStats };
}

export async function startFocusSession(
  params: {
    goal: string;
    categoryId?: string;
    durationMinutes?: number;
  },
  hostOverride?: any
): Promise<FocusSession> {
  const duration = Math.max(1, Math.min(480, Math.floor(Number(params.durationMinutes || 25))));
  const goal = (params.goal || "").trim() || "深度心流专注";
  const cat =
    memoryCategories.find((c) => c.id === params.categoryId) || memoryCategories[0];

  if (hostOverride || isRealElectronHost()) {
    const res = await callHostTransport<any>(
      "focus_start",
      {
        goal,
        categoryId: cat.id,
        durationMinutes: duration,
        blockedApps: [...cat.blockedApps],
        blockedSites: [...cat.blockedSites]
      },
      hostOverride
    );
    if (res.ok && res.data) {
      const s = res.data.session || res.data;
      if (s && s.id) {
        memoryCurrentSession = {
          id: String(s.id),
          goal: String(s.goal || goal),
          categoryId: String(s.categoryId || cat.id),
          categoryName: String(s.categoryName || cat.name),
          durationMinutes: Number(s.durationMinutes || duration),
          remainingSeconds: Number(s.remainingSeconds ?? duration * 60),
          status: "active",
          startedAt: Date.now(),
          blockedApps: [...cat.blockedApps],
          blockedSites: [...cat.blockedSites]
        };
        return { ...memoryCurrentSession };
      }
    }
  }

  memoryCurrentSession = {
    id: `focus-${Date.now()}`,
    goal,
    categoryId: cat.id,
    categoryName: cat.name,
    durationMinutes: duration,
    remainingSeconds: duration * 60,
    status: "active",
    startedAt: Date.now(),
    blockedApps: [...cat.blockedApps],
    blockedSites: [...cat.blockedSites]
  };
  return { ...memoryCurrentSession };
}

export async function controlFocusSession(
  action: "toggle" | "pause" | "resume" | "complete" | "cancel",
  hostOverride?: any
): Promise<{ ok: boolean; session: FocusSession | null; message: string }> {
  const methodMap = {
    toggle: "focus_toggle",
    pause: "focus_pause",
    resume: "focus_resume",
    complete: "focus_complete",
    cancel: "focus_cancel"
  } as const;

  if (hostOverride || isRealElectronHost()) {
    await callHostTransport<any>(methodMap[action], {}, hostOverride);
  }

  if (action === "pause" && memoryCurrentSession) {
    memoryCurrentSession = { ...memoryCurrentSession, status: "paused" };
    return { ok: true, session: { ...memoryCurrentSession }, message: "专注时钟已暂停" };
  }
  if (action === "resume" && memoryCurrentSession) {
    memoryCurrentSession = { ...memoryCurrentSession, status: "active" };
    return { ok: true, session: { ...memoryCurrentSession }, message: "专注时钟已继续" };
  }
  if (action === "toggle") {
    if (!memoryCurrentSession) {
      const started = await startFocusSession({ goal: "快速番茄钟专注", durationMinutes: 25 });
      return { ok: true, session: started, message: "已开启 25 分钟快速专注" };
    }
    const nextStatus = memoryCurrentSession.status === "paused" ? "active" : "paused";
    memoryCurrentSession = { ...memoryCurrentSession, status: nextStatus };
    return {
      ok: true,
      session: { ...memoryCurrentSession },
      message: nextStatus === "active" ? "专注已恢复" : "专注已暂停"
    };
  }
  if (action === "complete") {
    if (memoryCurrentSession) {
      memoryStats = {
        ...memoryStats,
        completedSessions: memoryStats.completedSessions + 1,
        totalFocusedMinutes:
          memoryStats.totalFocusedMinutes + memoryCurrentSession.durationMinutes
      };
    }
    memoryCurrentSession = null;
    return { ok: true, session: null, message: "🎉 恭喜完成本次心流专注会话！" };
  }
  memoryCurrentSession = null;
  return { ok: true, session: null, message: "已结束当前专注会话" };
}

export async function createFocusCategory(
  input: {
    name: string;
    defaultDurationMinutes: number;
    blockedApps?: string[];
    blockedSites?: string[];
  },
  hostOverride?: any
): Promise<FocusCategory> {
  const cleanName = (input.name || "").trim();
  if (!cleanName) {
    throw new Error("CATEGORY_NAME_REQUIRED: 专注分类名称不能为空");
  }
  const duration = Math.max(5, Math.min(240, Number(input.defaultDurationMinutes || 25)));
  const category: FocusCategory = {
    id: `cat-${Date.now()}`,
    name: cleanName,
    icon: "🚀",
    defaultDurationMinutes: duration,
    blockedApps: input.blockedApps || ["WeChat"],
    blockedSites: input.blockedSites || ["weibo.com", "bilibili.com"]
  };

  if (hostOverride || isRealElectronHost()) {
    await callHostTransport("focus_create_category", category as any, hostOverride);
  }
  memoryCategories = [category, ...memoryCategories];
  return category;
}

export function formatRemainingTime(remainingSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number(remainingSeconds || 0)));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export const getFocusStatus = getFocusCurrentSession;
export const pauseFocusSession = (hostOverride?: any) => controlFocusSession("pause", hostOverride);
export const resumeFocusSession = (hostOverride?: any) => controlFocusSession("resume", hostOverride);
export const completeFocusSession = (hostOverride?: any) => controlFocusSession("complete", hostOverride);

export function CreateFocusCategoryForm({
  onCreated
}: {
  onCreated?: (cat: FocusCategory) => void;
}) {
  const [name, setName] = useState("");
  const [durationStr, setDurationStr] = useState("45");
  const [appsStr, setAppsStr] = useState("WeChat, Discord, Music");
  const [sitesStr, setSitesStr] = useState("weibo.com, bilibili.com, twitter.com");
  const { pop } = useNavigation();

  const handleSubmit = async (values?: Record<string, any>) => {
    try {
      const rawName = values?.name ?? name;
      const rawDur = values?.duration ?? durationStr;
      const rawApps = values?.apps ?? appsStr;
      const rawSites = values?.sites ?? sitesStr;

      const created = await createFocusCategory({
        name: rawName,
        defaultDurationMinutes: Number(rawDur) || 45,
        blockedApps: String(rawApps)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        blockedSites: String(rawSites)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      });
      onCreated?.(created);
      await showToast(Toast.Style.Success, `已创建专注分类: ${created.name}`);
      pop();
    } catch (err: any) {
      await showToast(Toast.Style.Failure, "创建失败", err?.message || String(err));
    }
  };

  return (
    <Form
      navigationTitle="新建专注屏蔽分类 (Create Focus Category)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存专注分类" icon={Icon.Check} onSubmit={handleSubmit} />
          <Action title="保存专注分类" icon={Icon.Check} onAction={() => handleSubmit()} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="分类名称"
        placeholder="例如: 深度论文阅读 / 核心代码重构"
        value={name}
        onChange={setName}
      />
      <Form.TextField
        id="duration"
        title="默认时长 (分钟)"
        placeholder="45"
        value={durationStr}
        onChange={setDurationStr}
      />
      <Form.TextField
        id="apps"
        title="屏蔽干扰应用 (逗号分隔)"
        placeholder="WeChat, Slack, Discord"
        value={appsStr}
        onChange={setAppsStr}
      />
      <Form.TextField
        id="sites"
        title="屏蔽干扰网站 (逗号分隔)"
        placeholder="bilibili.com, weibo.com, youtube.com"
        value={sitesStr}
        onChange={setSitesStr}
      />
    </Form>
  );
}

export function RaycastFocusCommand() {
  const realHost = isRealElectronHost();
  const [session, setSession] = useState<FocusSession | null>(null);
  const [categories, setCategories] = useState<FocusCategory[]>(() =>
    realHost ? [] : [...DEFAULT_FOCUS_CATEGORIES]
  );
  const [stats, setStats] = useState<FocusStatsSummary>({ ...DEFAULT_FOCUS_STATS });
  const [searchText, setSearchText] = useState("");
  const [durationPreset, setDurationPreset] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    let active = true;
    Promise.all([
      getFocusCurrentSession(),
      listFocusCategories(),
      getFocusStats()
    ]).then(([cur, cats, st]) => {
      if (!active) return;
      setSession(cur);
      setCategories(cats.length > 0 ? cats : [...DEFAULT_FOCUS_CATEGORIES]);
      setStats(st);
    });
    return () => {
      active = false;
    };
  }, []);

  // 当存在活动专注会话时，启动真实的 1000ms setInterval 倒计时刷新与主进程同步
  const isSessionRunning = Boolean(
    session && (session.status === "active" || (session.status as string) === "running")
  );
  useEffect(() => {
    if (!isSessionRunning) return;
    let tickCount = 0;
    const timer = setInterval(() => {
      tickCount += 1;
      setSession((prev) => {
        if (!prev || (prev.status !== "active" && (prev.status as string) !== "running")) {
          return prev;
        }
        const nextRem = Math.max(0, prev.remainingSeconds - 1);
        if (memoryCurrentSession && memoryCurrentSession.id === prev.id) {
          memoryCurrentSession = { ...memoryCurrentSession, remainingSeconds: nextRem };
        }
        return {
          ...prev,
          remainingSeconds: nextRem
        };
      });

      if (tickCount % 10 === 0 && isRealElectronHost()) {
        getFocusCurrentSession().then((remote) => {
          if (remote) setSession(remote);
        });
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [isSessionRunning]);

  const filteredCategories = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return categories.filter((c) => {
      if (durationPreset === "short" && c.defaultDurationMinutes > 30) return false;
      if (durationPreset === "long" && c.defaultDurationMinutes <= 30) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.blockedApps.join(" ").toLowerCase().includes(q) ||
        c.blockedSites.join(" ").toLowerCase().includes(q)
      );
    });
  }, [categories, searchText, durationPreset]);

  const handleStartCategory = async (cat: FocusCategory) => {
    const goal = searchText.trim() || cat.name;
    const started = await startFocusSession({
      goal,
      categoryId: cat.id,
      durationMinutes: cat.defaultDurationMinutes
    });
    setSession(started);
    await showToast(
      Toast.Style.Success,
      `🎯 已开启专注: ${started.goal}`,
      `${started.durationMinutes} 分钟 • 已启用 ${cat.blockedApps.length} 款应用与 ${cat.blockedSites.length} 个站点防打扰拦截`
    );
  };

  const handleControl = async (action: "toggle" | "pause" | "resume" | "complete" | "cancel") => {
    const res = await controlFocusSession(action);
    setSession(res.session);
    const latestStats = await getFocusStats();
    setStats(latestStats);
    await showToast(Toast.Style.Success, res.message);
  };

  const renderSessionProgressBar = (s: FocusSession) => {
    const totalSecs = Math.max(1, s.durationMinutes * 60);
    const elapsedSecs = Math.max(0, totalSecs - s.remainingSeconds);
    const ratio = Math.min(1, Math.max(0, elapsedSecs / totalSecs));
    const filled = Math.round(ratio * 20);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    const pct = Math.round(ratio * 100);
    return `[${bar}] ${pct}% (剩余 ${formatRemainingTime(s.remainingSeconds)})`;
  };

  const activeCategory = useMemo(
    () => filteredCategories.find((c) => c.id === selectedId) || filteredCategories[0] || null,
    [filteredCategories, selectedId]
  );

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder="输入今日专注目标或搜索专注模式 (如 Deep Coding, 25m Pomodoro)..."
      onSearchTextChange={setSearchText}
      onSelectionChange={setSelectedId}
      filterBar={{
        summaryText: session
          ? `🎯 正在专注: ${session.goal} (${session.status === "paused" ? "已暂停" : `剩余 ${formatRemainingTime(session.remainingSeconds)}`}) | 累计完成 ${stats.completedSessions} 次 (${stats.totalFocusedMinutes} 分钟)`
          : `🧘 当前空闲 • 累计完成 ${stats.completedSessions} 次专注 (${stats.totalFocusedMinutes} 分钟) | 连续打卡 ${stats.currentStreakDays} 天`,
        groups: [
          {
            id: "duration-preset",
            value: durationPreset,
            onChange: setDurationPreset,
            options: [
              { title: "全部场景", value: "all", count: categories.length },
              {
                title: "短冲刺 (≤30m)",
                value: "short",
                count: categories.filter((c) => c.defaultDurationMinutes <= 30).length
              },
              {
                title: "深度心流 (>30m)",
                value: "long",
                count: categories.filter((c) => c.defaultDurationMinutes > 30).length
              }
            ]
          }
        ],
        actions: session
          ? [
              {
                id: "toggle-focus-session",
                label: session.status === "paused" ? "▶️ 继续专注" : "⏸️ 暂停/继续专注",
                title: session.status === "paused" ? "▶️ 继续专注" : "⏸️ 暂停/继续专注",
                style: "primary",
                onAction: () => handleControl("toggle")
              },
              {
                id: "complete-focus-session",
                label: "✅ 完成并结算专注",
                title: "✅ 完成并结算专注",
                style: "primary",
                onAction: () => handleControl("complete")
              },
              {
                id: "cancel-focus-session",
                label: "✖️ 取消本次专注",
                title: "✖️ 取消本次专注",
                style: "danger",
                onAction: () => handleControl("cancel")
              },
              {
                id: "create-focus-category",
                label: "➕ 新建专注屏蔽分类",
                title: "➕ 新建专注屏蔽分类",
                style: "secondary",
                onAction: () => {
                  push(
                    <CreateFocusCategoryForm
                      onCreated={(created) => setCategories((prev) => [created, ...prev])}
                    />
                  );
                }
              }
            ]
          : [
              {
                id: "start-focus-now",
                label: "🎯 立即开始专注",
                title: "🎯 立即开始专注",
                style: "primary",
                onAction: async () => {
                  if (activeCategory) {
                    await handleStartCategory(activeCategory);
                  }
                }
              },
              {
                id: "quick-pomodoro-25",
                label: "🍅 25分钟番茄钟",
                title: "🍅 25分钟番茄钟",
                style: "secondary",
                onAction: async () => {
                  const cat = activeCategory || categories[0];
                  if (!cat) return;
                  const started = await startFocusSession({
                    goal: searchText.trim() || "25m 极速番茄钟",
                    categoryId: cat.id,
                    durationMinutes: 25
                  });
                  setSession(started);
                  await showToast(Toast.Style.Success, `🍅 已开启 25 分钟番茄钟: ${started.goal}`);
                }
              },
              {
                id: "create-focus-category",
                label: "➕ 新建专注屏蔽分类",
                title: "➕ 新建专注屏蔽分类",
                style: "secondary",
                onAction: () => {
                  push(
                    <CreateFocusCategoryForm
                      onCreated={(created) => setCategories((prev) => [created, ...prev])}
                    />
                  );
                }
              }
            ]
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="按专注时长筛选"
          value={durationPreset}
          onChange={setDurationPreset}
        >
          <List.Dropdown.Item title="全部专注场景 (All)" value="all" icon={Icon.Clock} />
          <List.Dropdown.Item title="短冲刺 (≤ 30 分钟)" value="short" icon={Icon.Bolt} />
          <List.Dropdown.Item title="深度心流 (> 30 分钟)" value="long" icon={Icon.Shield} />
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="专注管理">
          <Action.Push
            title="新建专注屏蔽分类 (Create Focus Category)"
            icon={Icon.Plus}
            target={
              <CreateFocusCategoryForm
                onCreated={(created) => setCategories((prev) => [created, ...prev])}
              />
            }
          />
        </ActionPanel>
      }
    >
      {session && (
        <List.Section title="正在进行的专注会话 (Active Focus Session)">
          <List.Item
            key="active-focus-session"
            id="active-focus-session"
            title={`🎯 ${session.goal} (${session.categoryName})`}
            subtitle={`状态: ${session.status === "active" ? "专注计时中" : "已暂停"} • 剩余 ${formatRemainingTime(session.remainingSeconds)} / ${session.durationMinutes}:00`}
            icon={session.status === "active" ? Icon.Clock : Icon.Pause}
            accessories={[
              {
                text: `${formatRemainingTime(session.remainingSeconds)} left`,
                icon: Icon.Bolt
              }
            ]}
            detail={
              <List.Item.Detail
                markdown={[
                  `# 🎯 ${session.goal}`,
                  `> **当前状态**: \`${session.status.toUpperCase()}\` &nbsp;|&nbsp; **分类**: \`${session.categoryName}\``,
                  `---`,
                  `### ⏱️ 实时倒计时进度 (1s 刷新)`,
                  `\`\`\`text\n${renderSessionProgressBar(session)}\n\`\`\``,
                  `---`,
                  `### 🛡️ 正在生效的防分心屏蔽列表`,
                  `- **已拦截应用**: ${session.blockedApps.map((a) => `\`${a}\``).join(" • ") || "无"}`,
                  `- **已拦截网站**: ${session.blockedSites.map((s) => `\`${s}\``).join(" • ") || "无"}`
                ].join("\n\n")}
              />
            }
            actions={
              <ActionPanel title="当前专注控制">
                {session.status === "active" ? (
                  <Action
                    title="暂停专注 (Pause Focus)"
                    icon={Icon.Pause}
                    onAction={() => handleControl("pause")}
                  />
                ) : (
                  <Action
                    title="继续专注 (Resume Focus)"
                    icon={Icon.Play}
                    onAction={() => handleControl("resume")}
                  />
                )}
                <Action
                  title="完成并结算专注 (Complete Focus)"
                  icon={Icon.CheckCircle}
                  onAction={() => handleControl("complete")}
                />
                <Action.Push
                  title="新建专注屏蔽分类 (Create Focus Category)"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={
                    <CreateFocusCategoryForm
                      onCreated={(created) =>
                        setCategories((prev) => [created, ...prev])
                      }
                    />
                  }
                />
                <Action
                  title="取消本次专注 (Cancel Focus)"
                  icon={Icon.XMarkCircle}
                  style={Action.Style.Destructive}
                  onAction={() => handleControl("cancel")}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      <List.Section title={`启动专注模式 (Focus Categories · ${filteredCategories.length})`}>
        {filteredCategories.map((cat) => (
          <List.Item
            key={cat.id}
            id={cat.id}
            title={`${cat.icon} ${cat.name}`}
            subtitle={`默认 ${cat.defaultDurationMinutes} 分钟 • 屏蔽 ${cat.blockedApps.slice(0, 3).join(", ")}`}
            icon={Icon.Clock}
            accessories={[{ text: `${cat.defaultDurationMinutes} min` }]}
            detail={
              <List.Item.Detail
                markdown={[
                  `# ${cat.icon} ${cat.name}`,
                  `**标准时长**: \`${cat.defaultDurationMinutes} 分钟\``,
                  `---`,
                  `### 🚫 屏蔽干扰应用 (Blocked Applications)`,
                  cat.blockedApps.map((a) => `- \`${a}\``).join("\n"),
                  `### 🌐 屏蔽干扰网站 (Blocked Websites)`,
                  cat.blockedSites.map((s) => `- \`${s}\``).join("\n"),
                  `---`,
                  `### 📊 历史心流专注统计`,
                  `- **累计完成专注**: \`${stats.completedSessions} 次\` (\`${stats.totalFocusedMinutes} 分钟\`)`,
                  `- **连续专注天数**: \`${stats.currentStreakDays} 天 🔥\``,
                  `- **已拦截分心次数**: \`${stats.blockedDistractionsCount} 次\``
                ].join("\n\n")}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="模式名称"
                      text={cat.name}
                      icon={Icon.Rocket}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="设定时长"
                      text={`${cat.defaultDurationMinutes} 分钟`}
                      icon={Icon.Clock}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="累计专注时长"
                      text={`${stats.totalFocusedMinutes} 分钟`}
                      icon={Icon.BarChart}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="连续打卡"
                      text={`${stats.currentStreakDays} 天`}
                      icon={Icon.Star}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel title={cat.name}>
                <Action
                  title={`开始 ${cat.defaultDurationMinutes} 分钟专注 (Start Focus)`}
                  icon={Icon.Play}
                  onAction={() => handleStartCategory(cat)}
                />
                <Action
                  title="快速切换专注状态 (Toggle Focus)"
                  icon={Icon.Bolt}
                  onAction={() => handleControl("toggle")}
                />
                <Action.Push
                  title="新建专注屏蔽分类 (Create Focus Category)"
                  icon={Icon.Plus}
                  shortcut={{ modifiers: ["ctrl"], key: "n" }}
                  target={
                    <CreateFocusCategoryForm
                      onCreated={(created) =>
                        setCategories((prev) => [created, ...prev])
                      }
                    />
                  }
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

export default RaycastFocusCommand;
