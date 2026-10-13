/**
 * Windows Taskbar (任务栏治理中枢) 类型定义
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows backend/index.mjs (key: windows-taskbar)
 * - 命令结构：toggleTaskbar: V({ title: "Toggle Taskbar Window", subtitle: "Taskbar", keywords: ["bar", "show", "hide"] })
 * - 偏好字段：showTaskbar, disableWindowsTaskbar, position, sidebar, compact, size, widgets
 */

export type TaskbarPosition = "bottom" | "top" | "left" | "right";
export type TaskbarAlignment = "start" | "center";
export type TaskbarSize = "smallest" | "small" | "regular" | "large" | "largest";

export interface TaskbarState {
  readonly visible: boolean;
  readonly autoHide: boolean;
  readonly position: TaskbarPosition;
  readonly alignment: TaskbarAlignment;
  readonly size: TaskbarSize;
  readonly multiMonitorEnabled: boolean;
  readonly secondaryTrayCount: number;
  readonly lastModifiedAt: number;
}

export interface TaskbarActionResult {
  readonly success: boolean;
  readonly visible?: boolean | undefined;
  readonly autoHide?: boolean | undefined;
  readonly message: string;
  readonly state: TaskbarState;
  readonly error?: string | undefined;
}
