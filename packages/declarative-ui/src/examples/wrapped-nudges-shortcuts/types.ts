/**
 * Raycast Wrapped, Trial Nudges & Shortcuts 类型契约
 * 对标 Raycast 年度战报、技术特权引导与系统快捷指令管理器
 */

export interface WrappedUsageStats {
  year: number;
  totalLaunches: number;
  totalKeystrokesSaved: number; // 总按键节省次数
  timeSavedMinutes: number;
  timeSavedHours: number;
  manualHoursEstimate: number; // 效率总耗时对比: 传统手动耗时估算 (小时)
  ztoolsHoursSpent: number; // 实际使用 ZTools 耗时 (小时)
  netHoursSaved: number; // 净节省时间 (小时)
  efficiencyRatio: string; // 效率提升倍数 (如 12.8x)
  topExtensions: Array<{
    name: string;
    id: string;
    count: number;
    percentage: number;
    barChart: string; // 统计图表可视化 ASCII 条形图
    category?: string;
  }>;
  topShortcuts: Array<{ key: string; name: string; count: number }>;
  aiTokenCount: number;
  tokensUsed?: number;
  geekMasteryTier: "Apprentice" | "Specialist" | "Master" | "Grandmaster" | "Legendary";
  rankLevel?: string;
  badgeTitle: string; // 极客勋章称号
  badgeCardMarkdown: string; // 极客勋章生成卡片
  isLocalFirst?: boolean;
  generatedAt?: number;
}

export interface FeatureNudgeItem {
  id: string;
  featureKey: string;
  title: string;
  subtitle: string;
  description: string;
  iconName: string;
  badge: string;
  benefits: string[];
}

export interface NativeSidecarHealth {
  name: string;
  binary: string;
  pid: number;
  status: "running" | "healthy" | "degraded" | "stopped";
  latencyMs: number;
  slaTargetMs: number;
  memoryMb: number;
  features: string[];
}

export interface SystemPrivilegeDiagnostic {
  uiaccess: {
    status: "active" | "inactive" | "restricted";
    uipiBypassVerified: boolean;
    activeTabUrlCapture: boolean;
    elevatedWindowTextCapture: boolean;
    latencyMs: number;
  };
  mftIndexer: {
    status: "healthy" | "indexing" | "unsupported";
    indexedFilesCount: number;
    indexedDrives: string[];
    avgRecallLatencyMs: number;
    usnJournalActive: boolean;
    memoryMb: number;
  };
  sidecars: NativeSidecarHealth[];
  overallSlaMet: boolean;
  diagnosedAt: string;
}

export interface WindowsShortcutItem {
  id: string;
  name: string;
  description: string;
  targetPath: string; // .lnk 路径或可执行文件路径
  arguments?: string;
  commandType: "lnk" | "powershell" | "cmd" | "task_scheduler" | "uri" | "apple_shortcut";
  commandScript: string;
  category: "apps" | "system" | "network" | "dev" | "productivity";
  iconName: string;
  requiresAdmin?: boolean;
  destructive?: boolean;
  folder?: string;
}

export interface AppleShortcutItem {
  id: string;
  name: string;
  folder?: string;
  description: string;
  category: "apps" | "system" | "network" | "dev" | "productivity";
  iconName: string;
  acceptsInput?: boolean;
}

