/**
 * ZTools 2.0 标杆原生插件: 系统与开发环境关键配置备份工坊 (System Backup 2.0)
 *
 * 核心能力：
 * 1. 自动扫描并汇总本机关键系统与极客开发配置项：
 *    - 网络与系统配置：Windows Hosts 文件、系统/用户 PATH 环境变量快照、防火墙与代理规则配置
 *    - 开发者密钥与终端配置：~/.ssh/config、~/.gitconfig、~/.npmrc、PowerShell $PROFILE、Windows Terminal settings.json
 *    - 编辑器与效率工具配置：VSCode settings.json / keybindings.json、ZTools 本地快捷指令与配置库
 *    - 历史备份快照归档：已创建的增量与全量配置归档包 (.zip / .zbak)
 * 2. 支持一键打包创建时间戳快照备份、还原指定配置项、在资源管理器中定位原配置文件
 */

import {
  formatBytes,
  getRealFileSize,
  invokeHostCapability,
  invokePluginService,
  isRealElectronHost,
  openRealPath,
  resolveRealSpecialPaths,
  scanRealDirectoryTree,
  showRealItemInFolder,
  type NativeInvocationResult
} from "../shared/native-ipc.js";

export { formatBytes };
export type { NativeInvocationResult };

export const DLL_PLUGIN_NAME = "SystemBackupPlugin";
export const FORBIDDEN_TARGET_PATTERN =
  /(^|[\\/])(Windows|System32|SysWOW64|Program Files|Program Files \(x86\)|\.\.)($|[\\/])/i;
export const FORBIDDEN_REASON = "备份目标路径严禁指向系统核心保护目录或包含路径穿越字符";

export type BackupCategory =
  | "all"
  | "network_sys"
  | "dev_terminal"
  | "editor_tools"
  | "snapshot_archives";

export interface BackupCategoryMeta {
  id: BackupCategory;
  name: string;
  subtitle: string;
}

export const BACKUP_CATEGORIES: BackupCategoryMeta[] = [
  {
    id: "network_sys",
    name: "网络与系统配置",
    subtitle: "Windows Hosts 映射表、系统与用户环境变量 PATH、网络代理配置"
  },
  {
    id: "dev_terminal",
    name: "开发者密钥与终端配置",
    subtitle: "~/.ssh/config、~/.gitconfig、~/.npmrc、PowerShell Profile 与 Terminal 配置"
  },
  {
    id: "editor_tools",
    name: "编辑器与效率工具配置",
    subtitle: "VSCode settings.json / keybindings.json、ZTools 本地配置与指令集"
  },
  {
    id: "snapshot_archives",
    name: "历史备份快照归档",
    subtitle: "本机已生成的配置全量/增量快照压缩包，支持一键原子回滚"
  }
];

export type BackupProfileMode = "full_bundle" | "dotfiles_only" | "incremental_fast";

export const BACKUP_PROFILES: Array<{ id: BackupProfileMode; label: string; desc: string }> = [
  {
    id: "full_bundle",
    label: "全量系统与开发配置快照 (Full Bundle)",
    desc: "完整打包 Hosts、环境变量、SSH/Git 与 VSCode/Terminal 全部配置"
  },
  {
    id: "dotfiles_only",
    label: "极客 Dotfiles 专项备份 (Git/SSH/Terminal)",
    desc: "仅打包开发者跨机器迁移所需的纯文本 Dotfiles 配置文件"
  },
  {
    id: "incremental_fast",
    label: "增量变更快速归档 (Incremental SHA-256)",
    desc: "仅针对与上次快照相比发生哈希变更的配置文件创建轻量归档"
  }
];

export interface BackupConfigItem {
  id: string;
  name: string;
  path: string;
  category: BackupCategory;
  categoryName: string;
  sizeBytes: number;
  lastModified: string;
  statusTag: string;
}

export interface SystemBackupSnapshot {
  backupVaultDir: string;
  items: BackupConfigItem[];
  totalSizeBytes: number;
  updatedAt: string;
}

export function validateInvocationPayload(
  method: string,
  params: Record<string, unknown>
): { valid: boolean; reason?: string } {
  if (!method || typeof method !== "string" || method.trim().length === 0) {
    return { valid: false, reason: "调用方法名 (method) 不能为空" };
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { valid: false, reason: "调用参数 (params) 必须是非空对象" };
  }
  const vault = String(params.vaultDir || params.target || "");
  if (vault && FORBIDDEN_TARGET_PATTERN.test(vault)) {
    return { valid: false, reason: FORBIDDEN_REASON };
  }
  return { valid: true };
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostOverride?: any
): Promise<NativeInvocationResult> {
  const validation = validateInvocationPayload(method, params);
  if (!validation.valid) {
    return {
      ok: false,
      code: -1,
      message: `VALIDATION_FAILED: ${validation.reason}`,
      error: `VALIDATION_FAILED: ${validation.reason}`
    };
  }
  return invokePluginService(DLL_PLUGIN_NAME, method.trim(), params, hostOverride);
}

export function createInitialSystemBackupSnapshot(): SystemBackupSnapshot {
  const items: BackupConfigItem[] = [
    {
      id: "bak_hosts",
      name: "Windows Hosts 域名映射表 (etc\\hosts)",
      path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
      category: "network_sys",
      categoryName: "网络与系统配置",
      sizeBytes: 16 * 1024,
      lastModified: "今日已校验",
      statusTag: "核心配置"
    },
    {
      id: "bak_env_path",
      name: "系统与用户环境变量注册表快照 (ENV & PATH)",
      path: "HKCU\\Environment & HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      category: "network_sys",
      categoryName: "网络与系统配置",
      sizeBytes: 32 * 1024,
      lastModified: "今日已校验",
      statusTag: "注册表导出"
    },
    {
      id: "bak_ssh_config",
      name: "SSH 客户端主机与跳板机配置 (.ssh\\config)",
      path: "C:\\Users\\Default\\.ssh\\config",
      category: "dev_terminal",
      categoryName: "开发者密钥与终端配置",
      sizeBytes: 12 * 1024,
      lastModified: "2 天前更新",
      statusTag: "Dotfiles"
    },
    {
      id: "bak_gitconfig",
      name: "Git 全局别名与签名配置 (.gitconfig)",
      path: "C:\\Users\\Default\\.gitconfig",
      category: "dev_terminal",
      categoryName: "开发者密钥与终端配置",
      sizeBytes: 8 * 1024,
      lastModified: "3 天前更新",
      statusTag: "Dotfiles"
    },
    {
      id: "bak_ps_profile",
      name: "PowerShell 7 终端启动脚本 (Microsoft.PowerShell_profile.ps1)",
      path: "C:\\Users\\Default\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
      category: "dev_terminal",
      categoryName: "开发者密钥与终端配置",
      sizeBytes: 24 * 1024,
      lastModified: "昨天更新",
      statusTag: "终端脚本"
    },
    {
      id: "bak_vscode_settings",
      name: "VSCode 全局设置与快捷键绑定 (settings.json & keybindings.json)",
      path: "C:\\Users\\Default\\AppData\\Roaming\\Code\\User\\settings.json",
      category: "editor_tools",
      categoryName: "编辑器与效率工具配置",
      sizeBytes: 96 * 1024,
      lastModified: "今日更新",
      statusTag: "IDE 配置"
    },
    {
      id: "bak_archive_latest",
      name: "ZTools_SystemBackup_20261018_Full.zip",
      path: "C:\\Users\\Default\\Documents\\ZToolsBackups\\ZTools_SystemBackup_20261018_Full.zip",
      category: "snapshot_archives",
      categoryName: "历史备份快照归档",
      sizeBytes: 4250 * 1024,
      lastModified: "最近一次快照",
      statusTag: "可回滚快照"
    }
  ];

  return {
    backupVaultDir: "C:\\Users\\Default\\Documents\\ZToolsBackups",
    items,
    totalSizeBytes: items.reduce((acc, item) => acc + item.sizeBytes, 0),
    updatedAt: "初始化就绪"
  };
}

export async function fetchSystemBackupSnapshot(hostBridge?: any): Promise<SystemBackupSnapshot> {
  const initial = createInitialSystemBackupSnapshot();
  const isRealHost = Boolean(hostBridge) || isRealElectronHost(hostBridge) || isRealElectronHost();
  try {
    const paths = await resolveRealSpecialPaths(hostBridge);
    const userProfile = paths.userProfile || "C:\\Users\\Default";
    const appData = paths.appData || `${userProfile}\\AppData\\Roaming`;
    const localAppData = paths.localAppData || `${userProfile}\\AppData\\Local`;
    const docs = paths.documents || `${userProfile}\\Documents`;
    const backupVaultDir = `${docs}\\ZToolsBackups`;

    const candidateConfigs: Array<Omit<BackupConfigItem, "sizeBytes" | "lastModified"> & { fallbackSize: number }> = [
      {
        id: "bak_hosts",
        name: "Windows Hosts 域名映射表 (etc\\hosts)",
        path: "C:\\Windows\\System32\\drivers\\etc\\hosts",
        category: "network_sys",
        categoryName: "网络与系统配置",
        statusTag: "核心配置",
        fallbackSize: 16 * 1024
      },
      {
        id: "bak_ssh_config",
        name: "SSH 客户端主机与跳板机配置 (.ssh\\config)",
        path: `${userProfile}\\.ssh\\config`,
        category: "dev_terminal",
        categoryName: "开发者密钥与终端配置",
        statusTag: "Dotfiles",
        fallbackSize: 12 * 1024
      },
      {
        id: "bak_gitconfig",
        name: "Git 全局别名与签名配置 (.gitconfig)",
        path: `${userProfile}\\.gitconfig`,
        category: "dev_terminal",
        categoryName: "开发者密钥与终端配置",
        statusTag: "Dotfiles",
        fallbackSize: 8 * 1024
      },
      {
        id: "bak_npmrc",
        name: "NPM 全局镜像与凭证配置 (.npmrc)",
        path: `${userProfile}\\.npmrc`,
        category: "dev_terminal",
        categoryName: "开发者密钥与终端配置",
        statusTag: "Dotfiles",
        fallbackSize: 4 * 1024
      },
      {
        id: "bak_wt_settings",
        name: "Windows Terminal 终端配置 (settings.json)",
        path: `${localAppData}\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json`,
        category: "dev_terminal",
        categoryName: "开发者密钥与终端配置",
        statusTag: "终端配置",
        fallbackSize: 18 * 1024
      },
      {
        id: "bak_ps_profile",
        name: "PowerShell 7 终端启动脚本 (Microsoft.PowerShell_profile.ps1)",
        path: `${docs}\\PowerShell\\Microsoft.PowerShell_profile.ps1`,
        category: "dev_terminal",
        categoryName: "开发者密钥与终端配置",
        statusTag: "终端脚本",
        fallbackSize: 24 * 1024
      },
      {
        id: "bak_vscode_settings",
        name: "VSCode 全局设置 (settings.json)",
        path: `${appData}\\Code\\User\\settings.json`,
        category: "editor_tools",
        categoryName: "编辑器与效率工具配置",
        statusTag: "IDE 配置",
        fallbackSize: 96 * 1024
      }
    ];

    const [probedSizes, vaultScan] = await Promise.all([
      Promise.all(candidateConfigs.map((c) => getRealFileSize(c.path, hostBridge))),
      scanRealDirectoryTree(
        backupVaultDir,
        { maxDepth: 1, maxFiles: 30, filterExt: /\.(?:zip|zbak)$/i },
        hostBridge
      )
    ]);

    const realItems: BackupConfigItem[] = [];
    for (let i = 0; i < candidateConfigs.length; i++) {
      const cfg = candidateConfigs[i];
      const realSize = probedSizes[i];
      if (realSize > 0) {
        realItems.push({
          id: cfg.id,
          name: cfg.name,
          path: cfg.path,
          category: cfg.category,
          categoryName: cfg.categoryName,
          sizeBytes: realSize,
          lastModified: "本机已验证存在",
          statusTag: cfg.statusTag
        });
      }
    }

    const archiveItems: BackupConfigItem[] = vaultScan.files
      .filter((entry) => !entry.isDirectory && entry.sizeBytes > 0)
      .map((entry, idx) => ({
        id: `bak_archive_real_${idx}`,
        name: entry.name,
        path: entry.path,
        category: "snapshot_archives" as const,
        categoryName: "历史备份快照归档",
        sizeBytes: entry.sizeBytes,
        lastModified: entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toLocaleDateString() : "历史归档",
        statusTag: "可回滚快照"
      }));

    if (isRealHost) {
      const combined = [...realItems, ...archiveItems];
      return {
        backupVaultDir,
        items: combined,
        totalSizeBytes: combined.reduce((acc, item) => acc + item.sizeBytes, 0),
        updatedAt: new Date().toLocaleTimeString()
      };
    }

    const fallbackItems = realItems.length > 0 || archiveItems.length > 0 ? [...realItems, ...archiveItems] : initial.items;
    return {
      backupVaultDir,
      items: fallbackItems,
      totalSizeBytes: fallbackItems.reduce((acc, item) => acc + item.sizeBytes, 0),
      updatedAt: new Date().toLocaleTimeString()
    };
  } catch {
    if (isRealHost) {
      return {
        backupVaultDir: "C:\\Users\\Default\\Documents\\ZToolsBackups",
        items: [],
        totalSizeBytes: 0,
        updatedAt: new Date().toLocaleTimeString()
      };
    }
    return initial;
  }
}

export async function createBackupArchive(
  items: BackupConfigItem[],
  profileMode: BackupProfileMode,
  vaultDir: string,
  hostOverride?: any
): Promise<{
  ok: boolean;
  archivePath: string;
  backedUpCount: number;
  sizeBytes?: number;
  message: string;
}> {
  if (!vaultDir || FORBIDDEN_TARGET_PATTERN.test(vaultDir)) {
    return { ok: false, archivePath: "", backedUpCount: 0, sizeBytes: 0, message: FORBIDDEN_REASON };
  }
  if (!items || items.length === 0) {
    return {
      ok: false,
      archivePath: "",
      backedUpCount: 0,
      sizeBytes: 0,
      message: "请先勾选至少一项待备份配置"
    };
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const archivePath = `${vaultDir.replace(/[\\/]+$/, "")}\\ZTools_Backup_${profileMode}_${stamp}.zip`;
  const validPaths = items.map((i) => i.path).filter(Boolean);

  const res = await invokeHostCapability<any>(
    "backup.createSnapshotArchive",
    {
      profileMode,
      vaultDir,
      backupDir: vaultDir,
      archivePath,
      paths: validPaths,
      sourcePaths: validPaths,
      compression: "zstd"
    },
    hostOverride
  );

  if (!res.ok) {
    return {
      ok: false,
      archivePath: "",
      backedUpCount: 0,
      sizeBytes: 0,
      message: res.error || res.message || "创建配置备份归档失败"
    };
  }

  const resolvedArchivePath = String(
    res.data?.archivePath ?? res.data?.backupPath ?? archivePath
  );
  const realArchiveSize =
    Number(res.data?.sizeBytes ?? res.data?.size ?? 0) ||
    (await getRealFileSize(resolvedArchivePath, hostOverride)) ||
    items.reduce((s, i) => s + i.sizeBytes, 0);

  return {
    ok: true,
    archivePath: resolvedArchivePath,
    backedUpCount: items.length,
    sizeBytes: realArchiveSize,
    message: `已成功打包 ${items.length} 项关键配置并生成快照归档: ${resolvedArchivePath} (${formatBytes(realArchiveSize)})`
  };
}

export async function restoreBackupSnapshot(
  archivePath: string,
  targetDirOrHost?: any,
  hostOverride?: any
): Promise<{ ok: boolean; message: string }> {
  const trimmed = String(archivePath || "").trim();
  const targetDir = typeof targetDirOrHost === "string" ? targetDirOrHost.trim() : undefined;
  const resolvedHost = typeof targetDirOrHost === "string" ? hostOverride : (hostOverride ?? targetDirOrHost);
  if (!trimmed || FORBIDDEN_TARGET_PATTERN.test(trimmed)) {
    return { ok: false, message: FORBIDDEN_REASON };
  }
  if (targetDir && FORBIDDEN_TARGET_PATTERN.test(targetDir)) {
    return { ok: false, message: FORBIDDEN_REASON };
  }
  const res = await invokeHostCapability(
    "backup.restoreSnapshotArchive",
    {
      archivePath: trimmed,
      backupPath: trimmed,
      ...(targetDir ? { targetDir } : {})
    },
    resolvedHost
  );
  if (!res.ok) {
    return {
      ok: false,
      message: res.error || res.message || `从归档快照 ${trimmed} 还原配置失败`
    };
  }
  return {
    ok: true,
    message: `已从归档快照 ${trimmed} 原子还原所选配置文件`
  };
}

export async function openBackupConfigLocation(targetPath: string, hostBridge?: any): Promise<boolean> {
  if (!targetPath || targetPath.startsWith("HKCU")) return false;
  const shown = await showRealItemInFolder(targetPath, hostBridge);
  if (shown) return true;
  return openRealPath(targetPath, hostBridge);
}
