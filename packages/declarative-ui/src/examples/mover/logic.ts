/**
 * ZTools 2.0 标杆原生插件: C盘大目录无感乾坤大挪移 (Mover 2.0 - NTFS Junction 符号链接无感迁移引擎)
 *
 * 核心能力：
 * 1. 扫描 C:\Users 下的大体积目录（Downloads, Documents, Desktop, AppData\Local\Temp, 微信 WeChat Files, QQ Tencent Files, npm/pip/NuGet/VSCode 缓存）
 * 2. 支持将 C 盘高占用目录物理迁移至目标大容量分区（如 D:\ZToolsMoved、E:\ZToolsMoved），并在原路径建立 NTFS Junction 目录联接 (`mklink /J`)，应用无感知运行
 * 3. 严格拦截 C:\Windows、C:\Windows\System32、C:\Program Files 等系统核心路径，设置 lockedReason 禁止勾选迁移
 */

import {
  callHostTransport,
  formatBytes,
  invokeHostCapability,
  invokePluginService,
  isRealElectronHost,
  openRealPath,
  probeRealDiskDrives,
  readRealDirectory,
  resolveRealSpecialPaths,
  scanRealDirectoryTree,
  showRealItemInFolder,
  type NativeInvocationResult
} from "../shared/native-ipc.js";

export { formatBytes };
export type { NativeInvocationResult };

export const DLL_PLUGIN_NAME = "MoverPlugin";
export const FORBIDDEN_TARGET_PATTERN =
  /(^|[\\/])(Windows|System32|SysWOW64|Program Files|Program Files \(x86\)|Boot|Recovery|\.\.)($|[\\/])/i;
export const FORBIDDEN_REASON = "禁止迁移 Windows 系统核心目录或包含路径穿越字符";

export type MoverCategory = "all" | "social_office" | "user_profile" | "dev_cache" | "system_locked";

export interface MoverCategoryMeta {
  id: MoverCategory;
  name: string;
  subtitle: string;
}

export const MOVER_CATEGORIES: MoverCategoryMeta[] = [
  {
    id: "social_office",
    name: "社交与办公数据",
    subtitle: "微信 WeChat Files、QQ Tencent Files、飞书与企业办公缓存"
  },
  {
    id: "user_profile",
    name: "系统用户个人目录",
    subtitle: "Downloads 下载、Documents 文档、Videos 视频与 Desktop 桌面大目录"
  },
  {
    id: "dev_cache",
    name: "开发者与构建缓存",
    subtitle: "npm-cache、pip、NuGet packages、VSCode extensions 与 Cargo 缓存"
  },
  {
    id: "system_locked",
    name: "系统核心目录 (安全锁定)",
    subtitle: "Windows 核心组件与引导分区，硬性保护禁止迁移"
  }
];

export interface TargetDriveOption {
  id: string;
  driveLetter: string;
  targetRoot: string;
  label: string;
  freeBytes: number;
  totalBytes: number;
}

export const DEFAULT_TARGET_DRIVES: TargetDriveOption[] = [
  {
    id: "D:\\ZToolsMoved",
    driveLetter: "D:",
    targetRoot: "D:\\ZToolsMoved",
    label: "迁移至 D:\\ZToolsMoved (NTFS Junction 无感链接)",
    freeBytes: 380 * 1024 * 1024 * 1024,
    totalBytes: 1024 * 1024 * 1024 * 1024
  },
  {
    id: "E:\\ZToolsMoved",
    driveLetter: "E:",
    targetRoot: "E:\\ZToolsMoved",
    label: "迁移至 E:\\ZToolsMoved (高速扩展盘)",
    freeBytes: 620 * 1024 * 1024 * 1024,
    totalBytes: 1024 * 1024 * 1024 * 1024
  }
];

export interface MovableFolderItem {
  id: string;
  name: string;
  sourcePath: string;
  category: MoverCategory;
  categoryName: string;
  sizeBytes: number;
  fileCount: number;
  junctionSupported: boolean;
  isSystemLocked: boolean;
  lockedReason?: string;
}

export interface MoverSnapshot {
  cDriveTotalBytes: number;
  cDriveFreeBytes: number;
  targetDrives: TargetDriveOption[];
  folders: MovableFolderItem[];
  totalMovableBytes: number;
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
  const sourcePath = String(params.sourcePath || params.target || "");
  const destPath = String(params.destinationPath || params.targetRoot || "");
  if (FORBIDDEN_TARGET_PATTERN.test(sourcePath) || FORBIDDEN_TARGET_PATTERN.test(destPath)) {
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

export function createInitialMoverSnapshot(): MoverSnapshot {
  const folders: MovableFolderItem[] = [
    {
      id: "mover_wechat",
      name: "WeChat Files (微信聊天与附件目录)",
      sourcePath: "C:\\Users\\Default\\Documents\\WeChat Files",
      category: "social_office",
      categoryName: "社交与办公数据",
      sizeBytes: 18.6 * 1024 * 1024 * 1024,
      fileCount: 24580,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_qq",
      name: "Tencent Files (QQ 群文件与缓存目录)",
      sourcePath: "C:\\Users\\Default\\Documents\\Tencent Files",
      category: "social_office",
      categoryName: "社交与办公数据",
      sizeBytes: 9.4 * 1024 * 1024 * 1024,
      fileCount: 12800,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_downloads",
      name: "Downloads (系统个人下载主目录)",
      sourcePath: "C:\\Users\\Default\\Downloads",
      category: "user_profile",
      categoryName: "系统用户个人目录",
      sizeBytes: 14.2 * 1024 * 1024 * 1024,
      fileCount: 412,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_documents",
      name: "Documents (个人办公文档与工程库)",
      sourcePath: "C:\\Users\\Default\\Documents",
      category: "user_profile",
      categoryName: "系统用户个人目录",
      sizeBytes: 6.8 * 1024 * 1024 * 1024,
      fileCount: 1930,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_npm_cache",
      name: "npm-cache & pnpm store (前端包管理全局缓存)",
      sourcePath: "C:\\Users\\Default\\AppData\\Local\\npm-cache",
      category: "dev_cache",
      categoryName: "开发者与构建缓存",
      sizeBytes: 7.5 * 1024 * 1024 * 1024,
      fileCount: 48200,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_pip_nuget",
      name: "pip & NuGet Packages (Python/C# 全局依赖缓存)",
      sourcePath: "C:\\Users\\Default\\.nuget\\packages",
      category: "dev_cache",
      categoryName: "开发者与构建缓存",
      sizeBytes: 5.1 * 1024 * 1024 * 1024,
      fileCount: 16400,
      junctionSupported: true,
      isSystemLocked: false
    },
    {
      id: "mover_sys_windows",
      name: "Windows System32 核心运行库目录",
      sourcePath: "C:\\Windows\\System32",
      category: "system_locked",
      categoryName: "系统核心目录",
      sizeBytes: 12.4 * 1024 * 1024 * 1024,
      fileCount: 18500,
      junctionSupported: false,
      isSystemLocked: true,
      lockedReason: "系统核心目录严禁迁移"
    }
  ];

  const totalMovableBytes = folders
    .filter((f) => !f.isSystemLocked)
    .reduce((acc, item) => acc + item.sizeBytes, 0);

  return {
    cDriveTotalBytes: 256 * 1024 * 1024 * 1024,
    cDriveFreeBytes: 22 * 1024 * 1024 * 1024,
    targetDrives: DEFAULT_TARGET_DRIVES,
    folders,
    totalMovableBytes,
    updatedAt: "初始化就绪"
  };
}

export async function fetchMoverSnapshot(hostBridge?: any): Promise<MoverSnapshot> {
  const initial = createInitialMoverSnapshot();
  const isRealHost = Boolean(hostBridge) || isRealElectronHost(hostBridge) || isRealElectronHost();
  try {
    const [paths, drives] = await Promise.all([
      resolveRealSpecialPaths(hostBridge),
      probeRealDiskDrives(undefined, hostBridge)
    ]);

    const cDrive = drives.find((d) => d.drive.toUpperCase().startsWith("C"));
    const otherDrives = drives.filter((d) => !d.drive.toUpperCase().startsWith("C"));

    const targetDrives: TargetDriveOption[] =
      otherDrives.length > 0
        ? otherDrives.map((d) => {
            const letter = d.drive.replace(/[\\/]+$/, "");
            const root = `${letter}\\ZToolsMoved`;
            return {
              id: root,
              driveLetter: letter,
              targetRoot: root,
              label: `迁移至 ${root} (可用 ${formatBytes(d.availableBytes)})`,
              freeBytes: d.availableBytes,
              totalBytes: d.totalBytes
            };
          })
        : isRealHost
          ? []
          : DEFAULT_TARGET_DRIVES;

    const candidateDefs: Array<{
      id: string;
      name: string;
      sourcePath: string;
      category: MoverCategory;
      categoryName: string;
    }> = [
      {
        id: "mover_wechat",
        name: "WeChat Files (微信聊天与附件目录)",
        sourcePath: `${paths.documents}\\WeChat Files`,
        category: "social_office",
        categoryName: "社交与办公数据"
      },
      {
        id: "mover_xwechat",
        name: "xwechat_files (新版微信存储目录)",
        sourcePath: `${paths.documents}\\xwechat_files`,
        category: "social_office",
        categoryName: "社交与办公数据"
      },
      {
        id: "mover_qq",
        name: "Tencent Files (QQ 群文件与缓存目录)",
        sourcePath: `${paths.documents}\\Tencent Files`,
        category: "social_office",
        categoryName: "社交与办公数据"
      },
      {
        id: "mover_downloads",
        name: "Downloads (系统个人下载主目录)",
        sourcePath: paths.downloads,
        category: "user_profile",
        categoryName: "系统用户个人目录"
      },
      {
        id: "mover_documents",
        name: "Documents (个人办公文档与工程库)",
        sourcePath: paths.documents,
        category: "user_profile",
        categoryName: "系统用户个人目录"
      },
      {
        id: "mover_videos",
        name: "Videos (个人视频媒体库)",
        sourcePath: paths.videos,
        category: "user_profile",
        categoryName: "系统用户个人目录"
      },
      {
        id: "mover_npm_cache",
        name: "npm-cache (前端包管理全局缓存)",
        sourcePath: `${paths.localAppData}\\npm-cache`,
        category: "dev_cache",
        categoryName: "开发者与构建缓存"
      },
      {
        id: "mover_pip_cache",
        name: "pip Cache (Python 全局依赖缓存)",
        sourcePath: `${paths.localAppData}\\pip\\Cache`,
        category: "dev_cache",
        categoryName: "开发者与构建缓存"
      },
      {
        id: "mover_nuget_cache",
        name: "NuGet Packages (C#/.NET 全局依赖缓存)",
        sourcePath: `${paths.userProfile}\\.nuget\\packages`,
        category: "dev_cache",
        categoryName: "开发者与构建缓存"
      },
      {
        id: "mover_temp_cache",
        name: "Temp (用户本地临时工作目录)",
        sourcePath: paths.temp,
        category: "dev_cache",
        categoryName: "开发者与构建缓存"
      }
    ];

    // 动态读取 %LOCALAPPDATA% 与 %APPDATA% 下真实存在的顶层应用目录
    const [localAppEntries, roamingEntries] = await Promise.all([
      readRealDirectory(paths.localAppData, hostBridge),
      readRealDirectory(paths.appData, hostBridge)
    ]);
    for (const entry of [...localAppEntries.slice(0, 6), ...roamingEntries.slice(0, 6)]) {
      if (!entry.isDirectory || !entry.path) continue;
      if (candidateDefs.some((c) => c.sourcePath.toLowerCase() === entry.path.toLowerCase())) continue;
      candidateDefs.push({
        id: `mover_app_${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        name: `${entry.name} (应用数据缓存)`,
        sourcePath: entry.path,
        category: "dev_cache",
        categoryName: "开发者与构建缓存"
      });
    }

    const scannedResults = await Promise.all(
      candidateDefs.map(async (def): Promise<MovableFolderItem | null> => {
        if (!def.sourcePath) return null;
        const scan = await scanRealDirectoryTree(
          def.sourcePath,
          { maxDepth: 2, maxFiles: 120 },
          hostBridge
        );
        if (scan.totalFiles <= 0 && scan.totalBytes <= 0 && scan.files.length === 0) {
          return null;
        }
        return {
          id: def.id,
          name: def.name,
          sourcePath: def.sourcePath,
          category: def.category,
          categoryName: def.categoryName,
          sizeBytes: scan.totalBytes,
          fileCount: Math.max(scan.totalFiles, scan.files.length),
          junctionSupported: true,
          isSystemLocked: false
        };
      })
    );

    const realFolders = scannedResults.filter((item): item is MovableFolderItem => item !== null);

    if (isRealHost) {
      const systemLockedItem: MovableFolderItem = {
        id: "mover_sys_windows",
        name: "Windows System32 核心运行库目录",
        sourcePath: "C:\\Windows\\System32",
        category: "system_locked",
        categoryName: "系统核心目录",
        sizeBytes: 0,
        fileCount: 0,
        junctionSupported: false,
        isSystemLocked: true,
        lockedReason: "系统核心目录严禁迁移"
      };
      const folders = [...realFolders, systemLockedItem];
      const totalMovableBytes = realFolders.reduce((acc, item) => acc + item.sizeBytes, 0);
      return {
        cDriveTotalBytes: cDrive?.totalBytes || 0,
        cDriveFreeBytes: cDrive?.availableBytes || 0,
        targetDrives: targetDrives.length > 0 ? targetDrives : DEFAULT_TARGET_DRIVES,
        folders,
        totalMovableBytes,
        updatedAt: new Date().toLocaleTimeString()
      };
    }

    const finalFolders = realFolders.length > 0 ? [...realFolders, initial.folders[initial.folders.length - 1]] : initial.folders;
    return {
      cDriveTotalBytes: cDrive?.totalBytes || initial.cDriveTotalBytes,
      cDriveFreeBytes: cDrive?.availableBytes || initial.cDriveFreeBytes,
      targetDrives: targetDrives.length > 0 ? targetDrives : DEFAULT_TARGET_DRIVES,
      folders: finalFolders,
      totalMovableBytes: finalFolders
        .filter((f) => !f.isSystemLocked)
        .reduce((acc, item) => acc + item.sizeBytes, 0),
      updatedAt: new Date().toLocaleTimeString()
    };
  } catch {
    if (isRealHost) {
      return {
        cDriveTotalBytes: 0,
        cDriveFreeBytes: 0,
        targetDrives: DEFAULT_TARGET_DRIVES,
        folders: [],
        totalMovableBytes: 0,
        updatedAt: new Date().toLocaleTimeString()
      };
    }
    return initial;
  }
}

export async function executeDirectoryMove(
  items: MovableFolderItem[],
  targetRoot: string,
  hostOverride?: any
): Promise<{ ok: boolean; movedCount: number; freedBytes: number; message: string }> {
  if (!targetRoot || FORBIDDEN_TARGET_PATTERN.test(targetRoot)) {
    return { ok: false, movedCount: 0, freedBytes: 0, message: FORBIDDEN_REASON };
  }
  const movable = (items || []).filter(
    (item) => item && !item.isSystemLocked && !FORBIDDEN_TARGET_PATTERN.test(item.sourcePath)
  );
  if (movable.length === 0) {
    return {
      ok: false,
      movedCount: 0,
      freedBytes: 0,
      message: "未选择可安全迁移的目录（系统核心目录禁止迁移）"
    };
  }

  let movedCount = 0;
  let freedBytes = 0;
  let lastError = "";
  for (const folder of movable) {
    const folderBase = folder.sourcePath.split(/[\\/]/).pop() || folder.id;
    const destinationPath = `${targetRoot.replace(/[\\/]+$/, "")}\\${folderBase}`;
    const res = await invokeHostCapability(
      "mover.relocateWithJunction",
      {
        sourcePath: folder.sourcePath,
        targetRoot,
        targetPath: destinationPath,
        destinationPath,
        createJunction: true
      },
      hostOverride
    );
    if (!res.ok) {
      lastError = res.error || res.message || `迁移目录失败: ${folder.sourcePath}`;
      continue;
    }
    movedCount += 1;
    freedBytes += folder.sizeBytes;
  }

  if (movedCount === 0) {
    return {
      ok: false,
      movedCount: 0,
      freedBytes: 0,
      message: lastError || "目录迁移失败：宿主未能执行物理搬移或建立 Junction 链接"
    };
  }

  return {
    ok: true,
    movedCount,
    freedBytes,
    message: `已成功将 ${movedCount} 个大目录迁移至 ${targetRoot} 并建立 NTFS Junction 无感符号链接，为 C 盘腾出 ${formatBytes(freedBytes)}`
  };
}

export async function openMoverFolderLocation(folderPath: string, hostBridge?: any): Promise<boolean> {
  if (!folderPath) return false;
  const shown = await showRealItemInFolder(folderPath, hostBridge);
  if (shown) return true;
  return openRealPath(folderPath, hostBridge);
}

export async function invokeMoverAction(
  actionId: string,
  targetRoot: string,
  hostOverride?: any
): Promise<NativeInvocationResult> {
  return invokePluginService(
    DLL_PLUGIN_NAME,
    "RelocateDirectoryWithJunction",
    { actionId, targetRoot },
    hostOverride
  );
}
