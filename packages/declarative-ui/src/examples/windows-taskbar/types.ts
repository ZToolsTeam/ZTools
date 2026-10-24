/**
 * Windows Taskbar (任务栏治理中枢) 类型定义
 * 
 * 参考常见启动器的任务栏控制交互自研实现：
 * - 核心命令：切换任务栏显示/隐藏（关键词 bar / show / hide）
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
