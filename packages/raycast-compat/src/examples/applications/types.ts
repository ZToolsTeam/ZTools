export type ApplicationArchitecture = "x64" | "arm64" | "x86" | "neutral";

export type ApplicationCategory =
  | "all"
  | "installed"
  | "system"
  | "developer"
  | "game"
  | "running";

export interface ApplicationRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly installLocation: string;
  readonly path: string;
  readonly architecture: ApplicationArchitecture;
  readonly category: "installed" | "system" | "developer" | "game";
  readonly bundleId?: string;
  readonly uninstallString?: string;
  readonly quietUninstallString?: string;
  readonly displayIcon?: string;
  readonly estimatedSizeKb?: number;
  readonly isSystemComponent: boolean;
  readonly isUwp?: boolean;
  readonly pinyin: string;
  readonly pinyinInitials: string;
  readonly isRunning: boolean;
  readonly pid?: number;
  readonly isGame?: boolean;
  readonly autoQuitEnabled?: boolean;
}

export interface ApplicationActionResult {
  readonly success: boolean;
  readonly message: string;
  readonly error?: string;
  readonly app?: ApplicationRecord;
}
