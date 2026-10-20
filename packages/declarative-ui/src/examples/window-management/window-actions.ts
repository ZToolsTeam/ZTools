import {
  WindowActionDefinition,
  WindowFilterOptions,
  WindowManagementPreferences,
  WindowRect,
  WindowActionResult
} from "./types.js";
import { LocalStorage } from "../../api/storage.js";
import { getDeclarativeBridge } from "../../api/bridge.js";
import { showHUD } from "../../api/hud.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export const DEFAULT_WINDOW_PREFERENCES: WindowManagementPreferences = {
  innerGap: 0,
  outerGap: 0,
  cycleMode: "sizes",
  percentage: 0.9
};

const PREFERENCES_STORAGE_KEY = "ztools-window-management-preferences-v1";

export async function getWindowPreferences(): Promise<WindowManagementPreferences> {
  try {
    const raw = await LocalStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (raw && typeof raw === "object") {
      return {
        innerGap: typeof raw.innerGap === "number" ? Math.max(0, raw.innerGap) : DEFAULT_WINDOW_PREFERENCES.innerGap,
        outerGap: typeof raw.outerGap === "number" ? Math.max(0, raw.outerGap) : DEFAULT_WINDOW_PREFERENCES.outerGap,
        cycleMode: raw.cycleMode === "disabled" ? "disabled" : "sizes",
        percentage: typeof raw.percentage === "number" ? raw.percentage : DEFAULT_WINDOW_PREFERENCES.percentage
      };
    }
  } catch {
    // fallback
  }
  return { ...DEFAULT_WINDOW_PREFERENCES };
}

export async function saveWindowPreferences(
  prefs: Partial<WindowManagementPreferences>
): Promise<WindowManagementPreferences> {
  const current = await getWindowPreferences();
  const updated: WindowManagementPreferences = {
    ...current,
    ...prefs
  };
  await LocalStorage.setItem(PREFERENCES_STORAGE_KEY, updated);
  return updated;
}

export const WINDOW_ACTIONS: WindowActionDefinition[] = [
  // --- 1. Halves (半屏) ---
  {
    id: "left-half",
    name: "左半屏 (Left Half)",
    category: "halves",
    description: "将活动窗口吸附至屏幕左半侧，占满垂直高度",
    shortcut: "Ctrl + Alt + Left",
    iconName: "sidebar-left",
    keywords: ["left", "50%", "half", "左", "左半"]
  },
  {
    id: "right-half",
    name: "右半屏 (Right Half)",
    category: "halves",
    description: "将活动窗口吸附至屏幕右半侧，占满垂直高度",
    shortcut: "Ctrl + Alt + Right",
    iconName: "sidebar-right",
    keywords: ["right", "50%", "half", "右", "右半"]
  },
  {
    id: "top-half",
    name: "上半屏 (Top Half)",
    category: "halves",
    description: "将活动窗口吸附至屏幕上半侧，占满水平宽度",
    shortcut: "Ctrl + Alt + Up",
    iconName: "arrow-up",
    keywords: ["top", "up", "50%", "half", "上", "上半"]
  },
  {
    id: "bottom-half",
    name: "下半屏 (Bottom Half)",
    category: "halves",
    description: "将活动窗口吸附至屏幕下半侧，占满水平宽度",
    shortcut: "Ctrl + Alt + Down",
    iconName: "arrow-down",
    keywords: ["bottom", "down", "50%", "half", "下", "下半"]
  },
  {
    id: "center-half",
    name: "居中半屏 (Center Half)",
    category: "halves",
    description: "将窗口尺寸调整为 50% 屏幕宽度并水平居中，占满垂直高度",
    shortcut: "Ctrl + Alt + Shift + C",
    iconName: "columns",
    keywords: ["center half", "middle half", "居中半屏"]
  },

  // --- 2. Thirds (三分屏与两分之三) ---
  {
    id: "first-third",
    name: "左三分之一 (First Third)",
    category: "thirds",
    description: "占据屏幕最左侧 33.3% 宽度",
    shortcut: "Ctrl + Alt + D",
    iconName: "sidebar-left",
    keywords: ["first third", "left third", "1/3", "左三分之一"]
  },
  {
    id: "center-third",
    name: "中三分之一 (Center Third)",
    category: "thirds",
    description: "居中放置并占据屏幕中间 33.3% 宽度",
    shortcut: "Ctrl + Alt + F",
    iconName: "columns",
    keywords: ["center third", "middle third", "1/3", "中三分之一"]
  },
  {
    id: "last-third",
    name: "右三分之一 (Last Third)",
    category: "thirds",
    description: "占据屏幕最右侧 33.3% 宽度",
    shortcut: "Ctrl + Alt + G",
    iconName: "sidebar-right",
    keywords: ["last third", "right third", "1/3", "右三分之一"]
  },
  {
    id: "first-two-thirds",
    name: "左三分之二 (First Two Thirds)",
    category: "thirds",
    description: "占据左侧 66.6% 宽度，适用于主工作核心窗口",
    shortcut: "Ctrl + Alt + E",
    iconName: "layout",
    keywords: ["first two thirds", "left 2/3", "2/3", "左三分之二"]
  },
  {
    id: "center-two-thirds",
    name: "居中三分之二 (Center Two Thirds)",
    category: "thirds",
    description: "占据屏幕中间 66.6% 宽度并水平居中",
    shortcut: "Ctrl + Alt + Shift + E",
    iconName: "layout",
    keywords: ["center two thirds", "2/3", "居中三分之二"]
  },
  {
    id: "last-two-thirds",
    name: "右三分之二 (Last Two Thirds)",
    category: "thirds",
    description: "占据屏幕右侧 66.6% 宽度",
    shortcut: "Ctrl + Alt + T",
    iconName: "layout",
    keywords: ["last two thirds", "right 2/3", "2/3", "右三分之二"]
  },
  {
    id: "top-third",
    name: "上三分之一 (Top Third)",
    category: "thirds",
    description: "占据屏幕最上方 33.3% 高度",
    shortcut: "Ctrl + Alt + Shift + Up",
    iconName: "arrow-up",
    keywords: ["top third", "1/3 height", "上三分之一"]
  },
  {
    id: "middle-third",
    name: "垂直居中三分之一 (Middle Third)",
    category: "thirds",
    description: "占据屏幕垂直居中 33.3% 高度",
    shortcut: "Ctrl + Alt + Shift + M",
    iconName: "arrows-vertical",
    keywords: ["middle third", "垂直三分之一"]
  },
  {
    id: "bottom-third",
    name: "下三分之一 (Bottom Third)",
    category: "thirds",
    description: "占据屏幕最下方 33.3% 高度",
    shortcut: "Ctrl + Alt + Shift + Down",
    iconName: "arrow-down",
    keywords: ["bottom third", "下三分之一"]
  },

  // --- 3. Quarters (四分屏 / 角落吸附) ---
  {
    id: "top-left-quarter",
    name: "左上角四分之一 (Top Left Quarter)",
    category: "quarters",
    description: "占据屏幕左上角 25% 区域 (50% 宽 x 50% 高)",
    shortcut: "Ctrl + Alt + U",
    iconName: "arrow-ne",
    keywords: ["top-left", "corner", "25%", "左上角"]
  },
  {
    id: "top-right-quarter",
    name: "右上角四分之一 (Top Right Quarter)",
    category: "quarters",
    description: "占据屏幕右上角 25% 区域 (50% 宽 x 50% 高)",
    shortcut: "Ctrl + Alt + I",
    iconName: "arrow-ne",
    keywords: ["top-right", "corner", "25%", "右上角"]
  },
  {
    id: "bottom-left-quarter",
    name: "左下角四分之一 (Bottom Left Quarter)",
    category: "quarters",
    description: "占据屏幕左下角 25% 区域 (50% 宽 x 50% 高)",
    shortcut: "Ctrl + Alt + J",
    iconName: "arrow-se",
    keywords: ["bottom-left", "corner", "25%", "左下角"]
  },
  {
    id: "bottom-right-quarter",
    name: "右下角四分之一 (Bottom Right Quarter)",
    category: "quarters",
    description: "占据屏幕右下角 25% 区域 (50% 宽 x 50% 高)",
    shortcut: "Ctrl + Alt + K",
    iconName: "arrow-se",
    keywords: ["bottom-right", "corner", "25%", "右下角"]
  },

  // --- 4. Sixths (六分屏) ---
  {
    id: "top-left-sixth",
    name: "左上六分之一 (Top Left Sixth)",
    category: "sixths",
    description: "占据屏幕左上方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["top left sixth", "1/6", "左上六分之一"]
  },
  {
    id: "top-center-sixth",
    name: "中上六分之一 (Top Center Sixth)",
    category: "sixths",
    description: "占据屏幕居中上方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["top center sixth", "1/6", "中上六分之一"]
  },
  {
    id: "top-right-sixth",
    name: "右上六分之一 (Top Right Sixth)",
    category: "sixths",
    description: "占据屏幕右上方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["top right sixth", "1/6", "右上六分之一"]
  },
  {
    id: "bottom-left-sixth",
    name: "左下六分之一 (Bottom Left Sixth)",
    category: "sixths",
    description: "占据屏幕左下方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["bottom left sixth", "1/6", "左下六分之一"]
  },
  {
    id: "bottom-center-sixth",
    name: "中下六分之一 (Bottom Center Sixth)",
    category: "sixths",
    description: "占据屏幕居中下方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["bottom center sixth", "1/6", "中下六分之一"]
  },
  {
    id: "bottom-right-sixth",
    name: "右下六分之一 (Bottom Right Sixth)",
    category: "sixths",
    description: "占据屏幕右下方 1/6 区域 (33.3% 宽 x 50% 高)",
    iconName: "grid",
    keywords: ["bottom right sixth", "1/6", "右下六分之一"]
  },

  // --- 5. Center & Maximize (基础、居中与铺满) ---
  {
    id: "maximize",
    name: "最大化 (Maximize)",
    category: "center-max",
    description: "将窗口最大化充满整个可用工作区（主动避让系统任务栏）",
    shortcut: "Ctrl + Alt + Return",
    iconName: "maximize",
    keywords: ["max", "fullscreen", "最大化", "满屏"]
  },
  {
    id: "restore",
    name: "还原为常规尺寸 (Restore)",
    category: "center-max",
    description: "将窗口还原并调整为 70% 居中视窗",
    shortcut: "Ctrl + Alt + R",
    iconName: "restore",
    keywords: ["restore", "unmaximize", "还原", "重置"]
  },
  {
    id: "almost-maximize",
    name: "几乎最大化 90% (Almost Maximize)",
    category: "center-max",
    description: "将窗口放大至占据屏幕 90% 并保持居中留白",
    shortcut: "Ctrl + Alt + M",
    iconName: "arrows-expand",
    keywords: ["almost maximize", "90%", "几乎最大化"]
  },
  {
    id: "almost-maximize-80",
    name: "几乎最大化 80% (Almost Maximize 80%)",
    category: "center-max",
    description: "将窗口调整至占据屏幕 80% 并居中",
    iconName: "arrows-expand",
    keywords: ["almost maximize 80", "80%"]
  },
  {
    id: "almost-maximize-70",
    name: "几乎最大化 70% (Almost Maximize 70%)",
    category: "center-max",
    description: "将窗口调整至占据屏幕 70% 并居中",
    iconName: "arrows-expand",
    keywords: ["almost maximize 70", "70%"]
  },
  {
    id: "almost-maximize-60",
    name: "几乎最大化 60% (Almost Maximize 60%)",
    category: "center-max",
    description: "将窗口调整至占据屏幕 60% 并居中",
    iconName: "arrows-expand",
    keywords: ["almost maximize 60", "60%"]
  },
  {
    id: "reasonable-size",
    name: "黄金适中尺寸 (Reasonable Size 60%)",
    category: "center-max",
    description: "调整窗口至 60% 屏幕宽度与 80% 高度（上限 1024x900）",
    shortcut: "Ctrl + Alt + S",
    iconName: "app-window",
    keywords: ["reasonable size", "default", "适中尺寸", "黄金比例"]
  },
  {
    id: "center",
    name: "屏幕居中 (Center)",
    category: "center-max",
    description: "保持当前视窗尺寸并在当前显示器屏幕正中居中",
    shortcut: "Ctrl + Alt + C",
    iconName: "center",
    keywords: ["center", "middle", "居中", "屏幕中央"]
  },
  {
    id: "maximize-height",
    name: "最大化高度 (Maximize Height)",
    category: "center-max",
    description: "拉伸窗口使其纵向占满屏幕高度，保持水平宽度不变",
    shortcut: "Ctrl + Alt + Shift + Up",
    iconName: "arrows-vertical",
    keywords: ["max height", "tall", "高度最大化"]
  },
  {
    id: "maximize-width",
    name: "最大化宽度 (Maximize Width)",
    category: "center-max",
    description: "拉伸窗口使其横向占满屏幕宽度，保持垂直高度不变",
    shortcut: "Ctrl + Alt + Shift + Right",
    iconName: "arrows-horizontal",
    keywords: ["max width", "wide", "宽度最大化"]
  },
  {
    id: "minimize",
    name: "最小化 (Minimize)",
    category: "center-max",
    description: "将前台窗口最小化至任务栏",
    shortcut: "Ctrl + Alt + H",
    iconName: "minus",
    keywords: ["minimize", "hide", "taskbar", "最小化", "隐藏"]
  },

  // --- 6. Displays (跨显示器调度) ---
  {
    id: "next-display",
    name: "移动到下一显示器 (Next Display)",
    category: "displays",
    description: "将当前窗口投递至下一物理显示器相对等比坐标",
    shortcut: "Ctrl + Alt + N",
    iconName: "monitor",
    keywords: ["next display", "screen", "monitor", "下一显示器", "多屏"]
  },
  {
    id: "previous-display",
    name: "移动到上一显示器 (Previous Display)",
    category: "displays",
    description: "将当前窗口投递至上一物理显示器相对等比坐标",
    shortcut: "Ctrl + Alt + P",
    iconName: "monitor",
    keywords: ["previous display", "screen", "monitor", "上一显示器", "多屏"]
  },
  {
    id: "minimize-on-display",
    name: "最小化此屏幕所有窗口 (Minimize on This Display)",
    category: "displays",
    description: "最小化当前屏幕上所有应用程序窗口（快速显示桌面）",
    shortcut: "Ctrl + Alt + Shift + D",
    iconName: "desktop",
    keywords: ["minimize all", "show desktop", "显示桌面"]
  },

  // --- 7. Resize (微调步长缩放) ---
  {
    id: "make-larger",
    name: "视窗放大 (Make Larger)",
    category: "resize",
    description: "窗口向四周等比外扩 10%（或指定 32px 步长）",
    shortcut: "Ctrl + Alt + Plus",
    iconName: "plus",
    keywords: ["make larger", "grow", "zoom in", "放大"]
  },
  {
    id: "make-smaller",
    name: "视窗缩小 (Make Smaller)",
    category: "resize",
    description: "窗口向中心等比收缩 10%（保留 300x200 最小限制）",
    shortcut: "Ctrl + Alt + Minus",
    iconName: "minus",
    keywords: ["make smaller", "shrink", "zoom out", "缩小"]
  }
];

// 兼容别名映射 (Aliases)
const ALIASES: Record<string, string> = {
  "top-left": "top-left-quarter",
  "top-right": "top-right-quarter",
  "bottom-left": "bottom-left-quarter",
  "bottom-right": "bottom-right-quarter",
  "maximize-almost": "almost-maximize"
};

/**
 * 过滤与搜索窗口动作
 */
export function filterWindowActions(
  actions: WindowActionDefinition[],
  options: WindowFilterOptions
): WindowActionDefinition[] {
  let result = [...actions];

  if (options.category && options.category !== "all") {
    result = result.filter(a => a.category === options.category);
  }

  if (options.query && options.query.trim()) {
    const q = options.query.trim().toLowerCase();
    result = result.filter(a => {
      const inId = a.id.toLowerCase().includes(q);
      const inName = a.name.toLowerCase().includes(q);
      const inDesc = a.description.toLowerCase().includes(q);
      const inShortcut = a.shortcut ? a.shortcut.toLowerCase().includes(q) : false;
      const inKeywords = a.keywords ? a.keywords.some(k => k.toLowerCase().includes(q)) : false;
      return inId || inName || inDesc || inShortcut || inKeywords;
    });
  }

  return result;
}

/**
 * 窗口几何运算引擎 (Pure Geometry Calculator)
 * 依照 Raycast 官方栅格划分，完全兼容 innerGap 与 outerGap 边距调整
 */
export function calculateWindowGeometry(
  actionId: string,
  curWin: WindowRect,
  monRect: WindowRect,
  prefs: Partial<WindowManagementPreferences> = {}
): WindowRect {
  const outerGap = Math.max(0, prefs.outerGap ?? DEFAULT_WINDOW_PREFERENCES.outerGap);
  const innerGap = Math.max(0, prefs.innerGap ?? DEFAULT_WINDOW_PREFERENCES.innerGap);
  const percentage = prefs.percentage ?? DEFAULT_WINDOW_PREFERENCES.percentage;

  // 有效工作区 (减去 outerGap)
  const effX = monRect.x + outerGap;
  const effY = monRect.y + outerGap;
  const effW = Math.max(100, monRect.width - 2 * outerGap);
  const effH = Math.max(100, monRect.height - 2 * outerGap);

  const resolvedId = ALIASES[actionId] || actionId;

  switch (resolvedId) {
    // --- 1. Halves ---
    case "left-half": {
      const halfW = Math.floor((effW - innerGap) / 2);
      return { x: effX, y: effY, width: halfW, height: effH };
    }
    case "right-half": {
      const halfW = Math.floor((effW - innerGap) / 2);
      const rightW = effW - halfW - innerGap;
      return { x: effX + halfW + innerGap, y: effY, width: rightW, height: effH };
    }
    case "top-half": {
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX, y: effY, width: effW, height: halfH };
    }
    case "bottom-half": {
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX, y: effY + halfH + innerGap, width: effW, height: bottomH };
    }
    case "center-half": {
      const w = Math.floor(effW * 0.5);
      const x = effX + Math.floor((effW - w) / 2);
      return { x, y: effY, width: w, height: effH };
    }

    // --- 2. Thirds ---
    case "first-third": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      return { x: effX, y: effY, width: unitW, height: effH };
    }
    case "center-third": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      return { x: effX + unitW + innerGap, y: effY, width: unitW, height: effH };
    }
    case "last-third": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const lastW = effW - 2 * unitW - 2 * innerGap;
      return { x: effX + 2 * (unitW + innerGap), y: effY, width: lastW, height: effH };
    }
    case "first-two-thirds": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const twoThirdsW = 2 * unitW + innerGap;
      return { x: effX, y: effY, width: twoThirdsW, height: effH };
    }
    case "center-two-thirds": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const twoThirdsW = 2 * unitW + innerGap;
      const x = effX + Math.floor((effW - twoThirdsW) / 2);
      return { x, y: effY, width: twoThirdsW, height: effH };
    }
    case "last-two-thirds": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const twoThirdsW = effW - unitW - innerGap;
      return { x: effX + unitW + innerGap, y: effY, width: twoThirdsW, height: effH };
    }
    case "top-third": {
      const unitH = Math.floor((effH - 2 * innerGap) / 3);
      return { x: effX, y: effY, width: effW, height: unitH };
    }
    case "middle-third": {
      const unitH = Math.floor((effH - 2 * innerGap) / 3);
      return { x: effX, y: effY + unitH + innerGap, width: effW, height: unitH };
    }
    case "bottom-third": {
      const unitH = Math.floor((effH - 2 * innerGap) / 3);
      const bottomH = effH - 2 * unitH - 2 * innerGap;
      return { x: effX, y: effY + 2 * (unitH + innerGap), width: effW, height: bottomH };
    }

    // --- 3. Quarters ---
    case "top-left-quarter": {
      const halfW = Math.floor((effW - innerGap) / 2);
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX, y: effY, width: halfW, height: halfH };
    }
    case "top-right-quarter": {
      const halfW = Math.floor((effW - innerGap) / 2);
      const rightW = effW - halfW - innerGap;
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX + halfW + innerGap, y: effY, width: rightW, height: halfH };
    }
    case "bottom-left-quarter": {
      const halfW = Math.floor((effW - innerGap) / 2);
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX, y: effY + halfH + innerGap, width: halfW, height: bottomH };
    }
    case "bottom-right-quarter": {
      const halfW = Math.floor((effW - innerGap) / 2);
      const rightW = effW - halfW - innerGap;
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX + halfW + innerGap, y: effY + halfH + innerGap, width: rightW, height: bottomH };
    }

    // --- 4. Sixths (3 columns x 2 rows) ---
    case "top-left-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX, y: effY, width: unitW, height: halfH };
    }
    case "top-center-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX + unitW + innerGap, y: effY, width: unitW, height: halfH };
    }
    case "top-right-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const rightW = effW - 2 * unitW - 2 * innerGap;
      const halfH = Math.floor((effH - innerGap) / 2);
      return { x: effX + 2 * (unitW + innerGap), y: effY, width: rightW, height: halfH };
    }
    case "bottom-left-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX, y: effY + halfH + innerGap, width: unitW, height: bottomH };
    }
    case "bottom-center-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX + unitW + innerGap, y: effY + halfH + innerGap, width: unitW, height: bottomH };
    }
    case "bottom-right-sixth": {
      const unitW = Math.floor((effW - 2 * innerGap) / 3);
      const rightW = effW - 2 * unitW - 2 * innerGap;
      const halfH = Math.floor((effH - innerGap) / 2);
      const bottomH = effH - halfH - innerGap;
      return { x: effX + 2 * (unitW + innerGap), y: effY + halfH + innerGap, width: rightW, height: bottomH };
    }

    // --- 5. Center & Maximize ---
    case "maximize": {
      return { x: effX, y: effY, width: effW, height: effH };
    }
    case "restore": {
      const w = Math.round(effW * 0.7);
      const h = Math.round(effH * 0.7);
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "almost-maximize": {
      const w = Math.round(effW * percentage);
      const h = Math.round(effH * percentage);
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "almost-maximize-80": {
      const w = Math.round(effW * 0.8);
      const h = Math.round(effH * 0.8);
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "almost-maximize-70": {
      const w = Math.round(effW * 0.7);
      const h = Math.round(effH * 0.7);
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "almost-maximize-60": {
      const w = Math.round(effW * 0.6);
      const h = Math.round(effH * 0.6);
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "reasonable-size": {
      const w = Math.min(1024, Math.round(effW * 0.6));
      const h = Math.min(900, Math.round(effH * 0.8));
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "center": {
      const w = Math.max(300, Math.min(curWin.width, effW));
      const h = Math.max(200, Math.min(curWin.height, effH));
      return {
        x: effX + Math.round((effW - w) / 2),
        y: effY + Math.round((effH - h) / 2),
        width: w,
        height: h
      };
    }
    case "maximize-height": {
      return {
        x: curWin.x,
        y: effY,
        width: curWin.width,
        height: effH
      };
    }
    case "maximize-width": {
      return {
        x: effX,
        y: curWin.y,
        width: effW,
        height: curWin.height
      };
    }

    // --- 6. Resize ---
    case "make-larger": {
      const addW = Math.round(curWin.width * 0.1);
      const addH = Math.round(curWin.height * 0.1);
      const newW = Math.min(effW, curWin.width + addW);
      const newH = Math.min(effH, curWin.height + addH);
      return {
        x: Math.max(effX, curWin.x - Math.round(addW / 2)),
        y: Math.max(effY, curWin.y - Math.round(addH / 2)),
        width: newW,
        height: newH
      };
    }
    case "make-smaller": {
      const subW = Math.round(curWin.width * 0.1);
      const subH = Math.round(curWin.height * 0.1);
      const newW = Math.max(300, curWin.width - subW);
      const newH = Math.max(200, curWin.height - subH);
      return {
        x: curWin.x + Math.round(subW / 2),
        y: curWin.y + Math.round(subH / 2),
        width: newW,
        height: newH
      };
    }

    default:
      return { ...curWin };
  }
}

const savedWindowStatesMap = new Map<string, WindowRect>();
const currentWindowRectsMap = new Map<string, WindowRect>();
let lastExternalForegroundHwnd = "external-active-window";

export function hasWindowBoundsChanged(a: WindowRect, b: WindowRect): boolean {
  return (
    Math.round(a.x) !== Math.round(b.x) ||
    Math.round(a.y) !== Math.round(b.y) ||
    Math.round(a.width) !== Math.round(b.width) ||
    Math.round(a.height) !== Math.round(b.height)
  );
}

export function recordExternalForegroundWindow(
  windowId: string,
  bounds?: WindowRect,
  isZToolsSelf = false
): string {
  const cleaned = String(windowId || "").trim();
  if (!cleaned || isZToolsSelf || cleaned.toLowerCase().startsWith("ztools")) {
    return lastExternalForegroundHwnd;
  }
  lastExternalForegroundHwnd = cleaned;
  if (bounds) {
    currentWindowRectsMap.set(cleaned, { ...bounds });
  }
  return lastExternalForegroundHwnd;
}

export function getLastExternalForegroundWindow(): string {
  return lastExternalForegroundHwnd;
}

export function saveWindowState(windowId: string, rect: WindowRect): void {
  if (!windowId) return;
  savedWindowStatesMap.set(windowId, {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  });
}

export function getSavedWindowState(windowId: string): WindowRect | undefined {
  if (!windowId) return undefined;
  const saved = savedWindowStatesMap.get(windowId);
  return saved ? { ...saved } : undefined;
}

export function clearSavedWindowStates(): void {
  savedWindowStatesMap.clear();
  currentWindowRectsMap.clear();
  lastExternalForegroundHwnd = "external-active-window";
}

/**
 * 执行窗口调度动作
 */
export async function executeWindowAction(
  actionId: string,
  options: {
    windowId?: string;
    isZToolsSelf?: boolean;
    curWin?: WindowRect;
    monRect?: WindowRect;
    preferences?: Partial<WindowManagementPreferences>;
    hostBridge?: any;
    hostOverride?: any;
  } = {}
): Promise<WindowActionResult> {
  if (typeof actionId !== "string" || !actionId.trim()) {
    return {
      success: false,
      actionId: String(actionId || ""),
      actionName: "",
      error: "窗口调度动作标识不能为空"
    };
  }

  const definition = WINDOW_ACTIONS.find(a => a.id === actionId || ALIASES[actionId] === a.id);
  const actionName = definition ? definition.name : actionId;

  const rawWinId = String(options.windowId || "").trim();
  const targetWindowId =
    !rawWinId || options.isZToolsSelf || rawWinId.toLowerCase().startsWith("ztools")
      ? lastExternalForegroundHwnd
      : rawWinId;

  if (targetWindowId && !targetWindowId.toLowerCase().startsWith("ztools")) {
    lastExternalForegroundHwnd = targetWindowId;
  }

  const defaultMon: WindowRect = { x: 0, y: 0, width: 1920, height: 1040 };
  const defaultWin: WindowRect = { x: 100, y: 100, width: 800, height: 600 };

  const mon = options.monRect ?? defaultMon;
  const cur = options.curWin ?? currentWindowRectsMap.get(targetWindowId) ?? defaultWin;
  const prefs = options.preferences ?? await getWindowPreferences();

  let computedRect: WindowRect;
  const resolvedId = ALIASES[actionId] || actionId;

  if (resolvedId === "restore") {
    const saved = getSavedWindowState(targetWindowId);
    if (saved) {
      computedRect = { ...saved };
      if (hasWindowBoundsChanged(cur, saved)) {
        saveWindowState(targetWindowId, cur);
      }
    } else {
      computedRect = calculateWindowGeometry(actionId, cur, mon, prefs);
    }
  } else {
    computedRect = calculateWindowGeometry(actionId, cur, mon, prefs);
    if (hasWindowBoundsChanged(cur, computedRect)) {
      saveWindowState(targetWindowId, cur);
    }
  }

  currentWindowRectsMap.set(targetWindowId, { ...computedRect });

  const hostBridge = options.hostBridge ?? options.hostOverride;
  let hostExecuted = false;
  let hostError = "";

  // 1. 优先尝试注入的 windowManagement.executeAction 或 hostBridge.executeAction
  const customExec =
    typeof hostBridge?.executeAction === "function"
      ? hostBridge.executeAction
      : typeof (globalThis as any).ztools?.windowManagement?.executeAction === "function"
      ? (globalThis as any).ztools.windowManagement.executeAction
      : null;

  if (customExec) {
    try {
      const res = await customExec(actionId, { windowId: targetWindowId, rect: computedRect });
      if (res && typeof res === "object" && (res.ok === false || res.success === false)) {
        return {
          success: false,
          actionId,
          actionName,
          rect: computedRect,
          monitor: mon,
          error: String(res.error || res.message || "宿主窗口调度执行失败")
        };
      }
      hostExecuted = true;
    } catch (err: any) {
      return {
        success: false,
        actionId,
        actionName,
        rect: computedRect,
        monitor: mon,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // 2. 通过宿主 IPC window_manage_action 调度真实前台窗口
  if (!hostExecuted && (hostBridge || isRealElectronHost(hostBridge))) {
    const ipcRes = await callHostTransport<any>(
      "window_manage_action",
      { action: actionId, windowId: targetWindowId, rect: computedRect },
      hostBridge
    );
    if (ipcRes.ok && ipcRes.data?.ok !== false && ipcRes.data?.success !== false) {
      hostExecuted = true;
      if (ipcRes.data?.rect && typeof ipcRes.data.rect.width === "number") {
        computedRect = ipcRes.data.rect;
      }
    } else {
      hostError = ipcRes.error || String(ipcRes.data?.error || ipcRes.data?.message || "宿主窗口句柄移动失败");
      return {
        success: false,
        actionId,
        actionName,
        rect: computedRect,
        monitor: mon,
        error: hostError
      };
    }
  }

  // 3. 兼容 Declarative Bridge manageWindow
  if (!hostExecuted) {
    const bridge = getDeclarativeBridge();
    if (bridge?.manageWindow) {
      try {
        await bridge.manageWindow(actionId);
      } catch (err: any) {
        if (isRealElectronHost()) {
          return {
            success: false,
            actionId,
            actionName,
            rect: computedRect,
            monitor: mon,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }
    }
  }

  // 提示 HUD
  await showHUD(`已吸附: ${actionName}`);

  return {
    success: true,
    actionId,
    actionName,
    rect: computedRect,
    monitor: mon
  };
}
