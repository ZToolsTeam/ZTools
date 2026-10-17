/**
 * Windows Run Dialog (极客运行中枢) 类型定义
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows backend/index.mjs (key: windows-run)
 * - 视图规范提取自 frontend/main-window-*.js (WindowsRunView / SearchWindowsRunCommandsView)
 */

export type WindowsRunItemKind =
  | "executable"
  | "controlPanelApplet"
  | "managementConsole"
  | "environmentVariable"
  | "path"
  | "uri"
  | "command";

export interface WindowsRunItem {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly arguments?: string | undefined;
  readonly fullCommandLine: string;
  readonly description: string;
  readonly descriptionZh: string;
  readonly pinyin: string;
  readonly category: string;
  readonly kind: WindowsRunItemKind;
  readonly icon: string;
  readonly label: string;
  readonly isBuiltin: boolean;
  readonly runAsAdminByDefault?: boolean | undefined;
  readonly executionCount?: number | undefined;
  readonly lastExecutedAt?: number | undefined;
}

export interface RunHistoryRecord {
  readonly id: string;
  readonly command: string;
  readonly arguments?: string | undefined;
  readonly fullCommandLine: string;
  readonly executedAt: number;
  readonly runCount: number;
  readonly asAdmin?: boolean | undefined;
  readonly shell?: string | undefined;
}

export type RunShellType = "default" | "cmd" | "powershell" | "wt" | "none";

export interface ExecuteRunOptions {
  args?: readonly string[] | undefined;
  arguments?: string | undefined;
  asAdministrator?: boolean | undefined;
  runAsAdmin?: boolean | undefined;
  shell?: RunShellType | undefined;
  workingDirectory?: string | undefined;
}

export interface CommandLineParsed {
  readonly command: string;
  readonly arguments?: string | undefined;
  readonly fullCommandLine: string;
  readonly kind: WindowsRunItemKind;
}

export interface RunExecutionResult {
  readonly success: boolean;
  readonly pid?: number | undefined;
  readonly message: string;
  readonly command: string;
  readonly asAdmin: boolean;
  readonly shell: RunShellType;
  readonly error?: string | undefined;
}
