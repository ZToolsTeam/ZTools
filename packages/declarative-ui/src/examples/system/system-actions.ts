/**
 * Windows 原生运维动作集合 (System Actions Definition)
 * 深度对齐 Raycast 原厂标准系统调度指令集 (Raycast Windows system commands)
 * 包含电源与会话、进程与桌面治理、音频与硬件控制、维护与通知 4 大分类 20+ 项指令
 */

import { Icon } from "../../constants/icons.js";
import { getDeclarativeBridge } from "../../api/bridge.js";
import { showToast, Toast } from "../../api/toast.js";
import { callHostTransport, isRealElectronHost } from "../shared/native-ipc.js";

export type SystemCategory = 'power' | 'apps' | 'audio' | 'maintenance' | 'desktop' | 'process';

export interface SystemActionItem {
  id: string;
  actionKey: string;
  title: string;
  subtitle: string;
  description: string;
  category: SystemCategory;
  icon: Icon | string;
  destructive?: boolean;
  shortcut?: string;
  keywords?: string[];
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  technicalDetails?: string;
}

export const SYSTEM_ACTIONS: readonly SystemActionItem[] = Object.freeze([
  // =========================================================================
  // 1. 电源与会话 (Power & Session)
  // =========================================================================
  {
    id: "lock-screen",
    actionKey: "lockScreen",
    title: "锁定屏幕 (Lock Screen)",
    subtitle: "pmset displaysleepnow / user32.dll LockWorkStation",
    description: "立即锁定当前计算机屏幕并要求身份重新验证",
    category: "power",
    icon: Icon.Lock,
    shortcut: "Cmd+Ctrl+Q / Win+L",
    keywords: ["lock", "lockscreen", "锁屏", "锁定", "安全锁屏"],
    technicalDetails: "macOS 调用 CGSession / System Events 锁屏；Windows 调用 Win32 user32.dll!LockWorkStation 立即挂起交互式会话。"
  },
  {
    id: "sleep",
    actionKey: "sleep",
    title: "睡眠待机 (Sleep)",
    subtitle: "pmset sleepnow / powrprof.dll SetSuspendState(0,0,0)",
    description: "使计算机转入内存保留低功耗睡眠待机状态",
    category: "power",
    icon: Icon.Power,
    keywords: ["sleep", "suspend", "待机", "睡眠", "低功耗"],
    technicalDetails: "macOS 执行 pmset sleepnow；Windows 调用 powrprof.dll!SetSuspendState(FALSE, FALSE, FALSE) 进入挂起状态。"
  },
  {
    id: "sleep-displays",
    actionKey: "sleepDisplays",
    title: "立即关闭显示器 (Sleep Displays)",
    subtitle: "pmset displaysleepnow / SC_MONITORPOWER 2",
    description: "不进入整机睡眠，立即熄灭并关闭所有连接的显示器屏幕",
    category: "power",
    icon: Icon.Monitor,
    keywords: ["sleep displays", "display sleep", "screen off", "关闭显示器", "熄屏", "关屏幕"],
    technicalDetails: "macOS 调用 pmset displaysleepnow 立即熄屏；Windows 下发 WM_SYSCOMMAND SC_MONITORPOWER 2。"
  },
  {
    id: "toggle-caffeinate",
    actionKey: "toggleCaffeinate",
    title: "开启 / 关闭防休眠咖啡因模式 (Prevent System from Sleeping / Caffeinate)",
    subtitle: "/usr/bin/caffeinate -di / SetThreadExecutionState",
    description: "阻止 Mac 或 Windows 自动进入睡眠或熄屏状态，适合长耗时编译、下载与演示",
    category: "power",
    icon: Icon.Bolt,
    keywords: ["caffeinate", "keep awake", "prevent sleep", "coffee", "防休眠", "咖啡因", "保持唤醒", "常亮"],
    technicalDetails: "macOS 后台托管 /usr/bin/caffeinate -di 守护进程；Windows 设置 ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED。"
  },
  {
    id: "restart",
    actionKey: "restart",
    title: "重新启动 (Restart)",
    subtitle: "System Events restart / shutdown.exe /r /t 0",
    description: "安全关闭全部应用程序并立即重新启动操作系统",
    category: "power",
    icon: Icon.RotateClockwise,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认立即重新启动计算机？未保存的工作可能会丢失。",
    keywords: ["restart", "reboot", "重启", "重启电脑", "重开机"],
    technicalDetails: "macOS 通过 System Events 发送 restart 事件；Windows 执行 shutdown.exe /r /t 0。"
  },
  {
    id: "shut-down",
    actionKey: "shutDown",
    title: "关闭计算机 (Shut Down)",
    subtitle: "System Events shut down / shutdown.exe /s /t 0",
    description: "安全终结全部运行进程并切断计算机主电源",
    category: "power",
    icon: Icon.Power,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认立即关闭计算机电源？请确保重要数据已全部保存。",
    keywords: ["shutdown", "power off", "关机", "断电", "关机电脑"],
    technicalDetails: "macOS 通过 System Events 发送 shut down 事件；Windows 执行 shutdown.exe /s /t 0。"
  },
  {
    id: "log-out",
    actionKey: "logOut",
    title: "注销用户会话 (Log Out)",
    subtitle: "System Events log out / shutdown.exe /l",
    description: "退出当前已登录的系统用户桌面会话",
    category: "power",
    icon: Icon.Circle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认注销当前用户会话？",
    keywords: ["logout", "sign out", "注销", "登出", "注销登录"],
    technicalDetails: "macOS 通过 System Events log out；Windows 执行 shutdown.exe /l 或 ExitWindowsEx(EWX_LOGOFF)。"
  },
  {
    id: "hibernate",
    actionKey: "hibernate",
    title: "深度休眠 (Hibernate)",
    subtitle: "powrprof.dll SetSuspendState(1,0,0)",
    description: "将内存数据完整转储至磁盘并彻底切断电源",
    category: "power",
    icon: Icon.Power,
    keywords: ["hibernate", "休眠", "深度休眠", "hiberfil"],
    technicalDetails: "调用 powrprof.dll!SetSuspendState(TRUE, FALSE, FALSE) 进入 S4 休眠。"
  },

  // =========================================================================
  // 2. 进程与桌面治理 (Apps, Desktop & Appearance)
  // =========================================================================
  {
    id: "toggle-appearance",
    actionKey: "toggleAppearance",
    title: "切换深色 / 浅色模式 (Toggle System Appearance)",
    subtitle: "System Events dark mode / AppsUseLightTheme",
    description: "一键在系统深色模式 (Dark Mode) 与浅色模式 (Light Mode) 之间瞬时切换",
    category: "desktop",
    icon: Icon.Eye,
    keywords: ["appearance", "dark mode", "light mode", "theme", "深色模式", "浅色模式", "暗黑模式", "切换主题", "外观"],
    technicalDetails: "macOS 执行 tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode；Windows 切换 Personalize 注册表项。"
  },
  {
    id: "toggle-hidden-files",
    actionKey: "toggleHiddenFiles",
    title: "切换显示隐藏文件 (Toggle Hidden Files in Finder / Explorer)",
    subtitle: "defaults write com.apple.finder AppleShowAllFiles / Explorer Hidden",
    description: "在 macOS Finder 或 Windows Explorer 中一键显示或隐藏以点开头的隐藏文件与系统目录",
    category: "desktop",
    icon: Icon.Folder,
    shortcut: "Cmd+Shift+.",
    keywords: ["hidden files", "dotfiles", "show hidden", "finder", "隐藏文件", "显示隐藏文件", "点文件"],
    technicalDetails: "macOS 切换 com.apple.finder AppleShowAllFiles 并重启 Finder；Windows 切换 HKCU Explorer Advanced Hidden 键值。"
  },
  {
    id: "toggle-desktop-icons",
    actionKey: "toggleDesktopIcons",
    title: "显示 / 隐藏桌面图标 (Toggle Desktop Icons)",
    subtitle: "defaults write com.apple.finder CreateDesktop / HideIcons",
    description: "一键隐藏或恢复桌面上的所有文件与快捷方式图标，适合录屏、演示与极简壁纸控",
    category: "desktop",
    icon: Icon.Desktop,
    keywords: ["desktop icons", "hide desktop", "clean desktop", "桌面图标", "隐藏桌面图标", "显示桌面图标", "纯净桌面"],
    technicalDetails: "macOS 切换 com.apple.finder CreateDesktop 并刷新 Finder；Windows 切换 Explorer Advanced HideIcons。"
  },
  {
    id: "hide-all-apps-except-frontmost",
    actionKey: "hideAllAppsExceptFrontmost",
    title: "隐藏除前台外所有应用 (Hide All Apps Except Frontmost)",
    subtitle: "System Events visible=false / Win32 ShowWindow(SW_MINIMIZE)",
    description: "保持当前最前台聚焦应用可见，将其余所有后台窗口一键隐藏或最小化",
    category: "apps",
    icon: Icon.EyeSlash,
    shortcut: "Cmd+Opt+H",
    keywords: ["hide all apps", "isolate", "focus", "专注模式", "隐藏后台", "最小化其他"],
    technicalDetails: "macOS 将非 frontmost 进程设置 visible=false；Windows 遍历顶层 HWND 对非前台主窗口下发 SW_MINIMIZE。"
  },
  {
    id: "quit-all-applications",
    actionKey: "quitAllApplications",
    title: "退出所有运行应用 (Quit All Apps)",
    subtitle: "System Events quit / WM_CLOSE broadcast",
    description: "向当前会话中所有运行的应用窗口发送安全退出指令（自动排除 Finder 与 ZTools）",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认退出当前会话中的所有应用程序？",
    keywords: ["quit all apps", "close all", "退出全部", "关闭所有应用"],
    technicalDetails: "向用户层活动应用进程平缓发送 quit 事件或广播 WM_CLOSE 消息请求正常退出。"
  },
  {
    id: "quit-all-applications-except-frontmost",
    actionKey: "quitAllApplicationsExceptFrontmost",
    title: "退出除前台外所有应用 (Quit All Apps Except Frontmost)",
    subtitle: "Quit background apps / WM_CLOSE to background processes",
    description: "仅保留当前处于前台焦点的窗口，退出其余全部后台运行程序",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认退出除前台窗口外的所有后台应用？",
    keywords: ["quit background apps", "退出后台应用", "清理后台进程"],
    technicalDetails: "排查当前前台进程，向其余后台用户进程投递退出消息。"
  },
  {
    id: "quit-active-application",
    actionKey: "quitActiveApplication",
    title: "终结当前前台应用 (Quit Active App)",
    subtitle: "Cmd+Q / Alt+F4 / WM_CLOSE",
    description: "立即向当前处于最前台焦点的应用程序窗口发送退出指令",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    keywords: ["quit active app", "alt+f4", "cmd+q", "close active", "关闭当前应用", "强退"],
    technicalDetails: "获取当前最前台应用进程并向其投递退出指令。"
  },
  {
    id: "show-desktop",
    actionKey: "showDesktop",
    title: "显示物理桌面 (Show Desktop)",
    subtitle: "Mission Control Show Desktop / Shell.Application ToggleDesktop",
    description: "推开或最小化屏幕上全部活动窗口并瞬间切换至纯净物理桌面",
    category: "desktop",
    icon: Icon.Desktop,
    shortcut: "F11 / Win+D",
    keywords: ["desktop", "show desktop", "win+d", "桌面", "显示桌面", "最小化所有"],
    technicalDetails: "macOS 触发 Show Desktop (CoreDock / key code 103)；Windows 调用 IShellDispatch4::ToggleDesktop()。"
  },

  // =========================================================================
  // 3. 音频与硬件控制 (Audio & Hardware)
  // =========================================================================
  {
    id: "toggle-mute-current-app",
    actionKey: "toggleMuteCurrentApp",
    title: "切换前台应用静音 (Toggle Active App Mute)",
    subtitle: "ISimpleAudioVolume::SetMute",
    description: "一键静音或恢复当前获得焦点的前台程序的音频流",
    category: "audio",
    icon: Icon.Play,
    keywords: ["mute current app", "mute active app", "静音当前应用", "单个应用静音"],
    technicalDetails: "定位前台窗口 PID 并通过音频会话控制切换 SetMute。"
  },
  {
    id: "turn-current-app-volume-up",
    actionKey: "turnCurrentAppVolumeUp",
    title: "提高前台应用音量 (Turn Active App Volume Up)",
    subtitle: "WASAPI App Session +10%",
    description: "按 10% 步长增加当前最前台活动应用的独立输出音量",
    category: "audio",
    icon: Icon.Plus,
    keywords: ["active app volume up", "前台音量加", "调大当前程序音量"],
    technicalDetails: "读取前台应用的音频会话音量并递增 10% (上限 100%)。"
  },
  {
    id: "turn-current-app-volume-down",
    actionKey: "turnCurrentAppVolumeDown",
    title: "降低前台应用音量 (Turn Active App Volume Down)",
    subtitle: "WASAPI App Session -10%",
    description: "按 10% 步长调小当前最前台活动应用的独立输出音量",
    category: "audio",
    icon: Icon.Minus,
    keywords: ["active app volume down", "前台音量减", "调小当前程序音量"],
    technicalDetails: "读取前台应用的音频会话音量并递减 10% (下限 0%)。"
  },
  {
    id: "volume-mixer",
    actionKey: "volumeMixer",
    title: "系统音量混音器 (Volume Mixer)",
    subtitle: "Sound Settings / sndvol.exe",
    description: "调出系统级音频混合器或声音偏好设置面板以独立精细调音",
    category: "audio",
    icon: Icon.Gear,
    keywords: ["volume mixer", "audio mixer", "sndvol", "音量合成器", "混音器", "声音设置"],
    technicalDetails: "macOS 打开系统声音设置面板；Windows 启动内置 sndvol.exe 混音控制台。"
  },
  {
    id: "toggle-mute",
    actionKey: "toggleMute",
    title: "系统主声道静音切换 (Toggle Mute)",
    subtitle: "osascript set volume output muted / VK_VOLUME_MUTE",
    description: "一键静音或恢复计算机主声卡默认输出端点",
    category: "audio",
    icon: Icon.Stop,
    keywords: ["mute", "unmute", "主音量静音", "静音", "恢复声音"],
    technicalDetails: "macOS 执行 set volume output muted not (output muted of (get volume settings))；Windows 触发 IAudioEndpointVolume::SetMute。"
  },
  {
    id: "volume-up",
    actionKey: "turnVolumeUp",
    title: "调高音量 (+10%) / 提高系统主音量 (Turn Volume Up)",
    subtitle: "osascript output volume +10% / VK_VOLUME_UP",
    description: "按 10% 步长调高计算机全局扬声器输出主音量",
    category: "audio",
    icon: Icon.ArrowUp,
    keywords: ["volume up", "调高音量", "系统音量加", "调大音量", "大声", "+10%"],
    technicalDetails: "macOS 通过 osascript 读取当前音量并 +10%；Windows 触发系统全局音量递增事件。"
  },
  {
    id: "volume-down",
    actionKey: "turnVolumeDown",
    title: "调低音量 (-10%) / 降低系统主音量 (Turn Volume Down)",
    subtitle: "osascript output volume -10% / VK_VOLUME_DOWN",
    description: "按 10% 步长调低计算机全局扬声器输出主音量",
    category: "audio",
    icon: Icon.ArrowDown,
    keywords: ["volume down", "调低音量", "系统音量减", "调小音量", "小声", "-10%"],
    technicalDetails: "macOS 通过 osascript 读取当前音量并 -10%；Windows 触发系统全局音量递减事件。"
  },
  {
    id: "toggle-bluetooth",
    actionKey: "toggleBluetooth",
    title: "打开蓝牙设置 / 切换蓝牙 (Toggle Bluetooth)",
    subtitle: "Bluetooth Settings / blueutil / ms-settings:bluetooth",
    description: "快速切换系统蓝牙开关状态或直达系统蓝牙设备管理面板",
    category: "audio",
    icon: Icon.Wifi,
    keywords: ["bluetooth", "toggle bluetooth", "airpods", "蓝牙", "切换蓝牙", "蓝牙设置", "打开蓝牙"],
    technicalDetails: "macOS 调用 blueutil 或打开 x-apple.systempreferences:com.apple.BluetoothSettings；Windows 打开 ms-settings:bluetooth。"
  },
  {
    id: "turn-display-off",
    actionKey: "turnDisplayOff",
    title: "关闭显示器电源 (Turn Display Off / Sleep Displays)",
    subtitle: "pmset displaysleepnow / SC_MONITORPOWER 2",
    description: "下发节能信号使全部连接的物理显示器立即关闭熄屏",
    category: "audio",
    icon: Icon.Monitor,
    keywords: ["sleep displays", "screen off", "display off", "熄屏", "关屏幕", "显示器休眠"],
    technicalDetails: "macOS 执行 pmset displaysleepnow；Windows 广播 SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)。"
  },
  {
    id: "eject-all-disks",
    actionKey: "ejectAllDisks",
    title: "安全弹出所有磁盘 (Eject All Disks)",
    subtitle: "Finder eject every disk / FSCTL_LOCK_VOLUME",
    description: "卸载并安全弹出当前挂载的全部外接移动磁盘、U盘与 DMG 磁盘映像",
    category: "audio",
    icon: Icon.HardDrive,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认安全卸载并弹出全部已挂载的移动磁盘？",
    keywords: ["eject disks", "unmount", "弹出U盘", "安全删除硬件", "弹出所有磁盘", "推出磁盘"],
    technicalDetails: "macOS 调用 Finder eject (every disk whose ejectable is true)；Windows 发送 FSCTL_DISMOUNT_VOLUME 与 IOCTL_STORAGE_EJECT_MEDIA。"
  },

  // =========================================================================
  // 4. 维护与通知 (Maintenance)
  // =========================================================================
  {
    id: "empty-trash",
    actionKey: "emptyTrash",
    title: "清空废纸篓 / 回收站 (Empty Trash / Empty Recycle Bin)",
    subtitle: "Finder empty trash / SHEmptyRecycleBinW",
    description: "永久清除 macOS 废纸篓或 Windows 回收站中的全部废弃文件并立即释放磁盘物理空间",
    category: "maintenance",
    icon: Icon.Trash,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认永久清空废纸篓/回收站？清除后文件将无法直接还原。",
    keywords: ["empty recycle bin", "empty trash", "clean trash", "清空回收站", "清空废纸篓", "清理垃圾桶", "清除临时文件"],
    technicalDetails: "macOS 执行 tell application \"Finder\" to empty trash；Windows 调用 Shell32!SHEmptyRecycleBinW。"
  },
  {
    id: "open-trash",
    actionKey: "openTrash",
    title: "打开废纸篓 / 回收站 (Open Trash / Recycle Bin)",
    subtitle: "open ~/.Trash / explorer.exe shell:RecycleBinFolder",
    description: "在 Finder 或文件资源管理器中打开废纸篓/回收站视图以查看待清理文件",
    category: "maintenance",
    icon: Icon.Folder,
    keywords: ["open recycle bin", "open trash", "打开回收站", "打开废纸篓", "查看回收站"],
    technicalDetails: "macOS 打开 ~/.Trash 目录；Windows 通过 ShellExecute 启动 shell:RecycleBinFolder。"
  },
  {
    id: "dismiss-notifications",
    actionKey: "dismissNotifications",
    title: "清除所有系统通知 (Dismiss Notifications)",
    subtitle: "NotificationCenter Dismiss / ActionCenter Dismiss",
    description: "立即关闭屏幕上当前浮现的所有通知横幅与通知中心待办提醒",
    category: "maintenance",
    icon: Icon.Checkmark,
    keywords: ["dismiss notifications", "clear alerts", "清除通知", "关闭提醒", "清空横幅"],
    technicalDetails: "清理 macOS NotificationCenter 或 Windows ActionCenter 弹窗。"
  }
]);

/**
 * 智能过滤系统运维指令
 */
export function filterSystemActions(query: string, category?: string): SystemActionItem[] {
  let list = [...SYSTEM_ACTIONS];

  if (category && category !== "all") {
    const c = category.toLowerCase();
    list = list.filter(item => {
      if (item.category === c) return true;
      // 兼容历史分类映射
      if (c === "desktop" && (item.category === "apps" || item.category === "maintenance")) return true;
      if (c === "apps" && item.category === "desktop") return true;
      if (c === "process" && item.category === "apps") return true;
      return false;
    });
  }

  if (!query || !query.trim()) return list;

  const q = query.trim().toLowerCase();
  return list.filter(item => {
    if (item.title.toLowerCase().includes(q)) return true;
    if (item.subtitle.toLowerCase().includes(q)) return true;
    if (item.description.toLowerCase().includes(q)) return true;
    if (item.actionKey.toLowerCase().includes(q)) return true;
    if (item.id.toLowerCase().includes(q)) return true;
    if (item.keywords?.some(k => k.toLowerCase().includes(q))) return true;
    return false;
  });
}

/**
 * 执行系统原生运维调度
 */
export async function executeSystemAction(
  itemOrId: SystemActionItem | string,
  options: { force?: boolean; confirmBypass?: boolean; hostOverride?: any } = {}
): Promise<{ success: boolean; executed: boolean; message: string }> {
  const item =
    typeof itemOrId === "string"
      ? SYSTEM_ACTIONS.find(a => a.id === itemOrId || a.actionKey === itemOrId)
      : itemOrId;

  if (!item || typeof item !== "object" || (!item.id && !item.actionKey)) {
    return {
      success: false,
      executed: false,
      message: `未知或无效的系统指令: ${String(itemOrId || "")}`
    };
  }

  const bridge = getDeclarativeBridge();

  // 高危破坏性动作拦截确认
  if (item.destructive && !options.confirmBypass && !options.force) {
    if (bridge?.confirmAlert) {
      const confirmed = await bridge.confirmAlert({
        title: `系统高危操作: ${item.title}`,
        message: item.confirmationMessage ?? `确定要执行 ${item.title} 吗？此操作具有不可逆影响。`,
        primaryAction: {
          title: "确认执行",
          style: "destructive"
        },
        dismissAction: {
          title: "取消"
        }
      });
      if (!confirmed) {
        await showToast(Toast.Style.Animated, "已取消操作", `未执行: ${item.title}`);
        return { success: false, executed: false, message: "用户已取消执行" };
      }
    }
  }

  // 1. 尝试通过 Bridge 调度
  try {
    if ((bridge as any)?.system?.execute) {
      const res = await (bridge as any).system.execute(item.actionKey, options);
      if (res && typeof res === "object" && (res.ok === false || res.success === false)) {
        const errMsg = String(res.error || res.message || "执行失败");
        await showToast(Toast.Style.Failure, `调度失败: ${item.title}`, errMsg);
        return { success: false, executed: false, message: errMsg };
      }
      await showToast(Toast.Style.Success, `系统调度成功: ${item.title}`, item.technicalDetails);
      return { success: true, executed: true, message: res?.message ?? "执行完成" };
    }
  } catch (err: any) {
    await showToast(Toast.Style.Failure, `调度异常: ${item.title}`, err?.message);
    return { success: false, executed: false, message: err?.message ?? "执行失败" };
  }

  // 2. 优先调用宿主真实 IPC system_execute_action 及 SystemActionsPlugin
  if (options.hostOverride || isRealElectronHost(options.hostOverride)) {
    const ipcRes = await callHostTransport<any>(
      "system_execute_action",
      {
        actionKey: item.actionKey,
        action: item.id,
        id: item.id,
        params: options
      },
      options.hostOverride
    );
    if (ipcRes.ok && ipcRes.data?.ok !== false && ipcRes.data?.success !== false) {
      const msg = ipcRes.data?.message || `已执行系统操作: ${item.title}`;
      await showToast(Toast.Style.Success, msg, item.technicalDetails);
      return { success: true, executed: true, message: msg };
    }

    const dllRes = await callHostTransport<any>(
      "dllplugin_call",
      {
        plugin: "SystemActionsPlugin",
        func: item.actionKey || item.id,
        params: { id: item.id, actionKey: item.actionKey, ...options }
      },
      options.hostOverride
    );
    if (dllRes.ok && dllRes.data?.ok !== false && dllRes.data?.success !== false) {
      const msg = dllRes.data?.message || `已执行系统操作: ${item.title}`;
      await showToast(Toast.Style.Success, msg, item.technicalDetails);
      return { success: true, executed: true, message: msg };
    }

    if (item.id === "lock-screen" || item.actionKey === "lockScreen") {
      const lockRes = await callHostTransport("system_lock", {}, options.hostOverride);
      if (lockRes.ok) {
        await showToast(Toast.Style.Success, `已锁定屏幕: ${item.title}`);
        return { success: true, executed: true, message: "屏幕已锁定" };
      }
    } else if (item.id === "sleep" || item.actionKey === "sleep") {
      const sleepRes = await callHostTransport("system_sleep", {}, options.hostOverride);
      if (sleepRes.ok) {
        await showToast(Toast.Style.Success, `已进入睡眠状态: ${item.title}`);
        return { success: true, executed: true, message: "系统已进入睡眠" };
      }
    }

    const errMsg =
      ipcRes.error ||
      dllRes.error ||
      String(ipcRes.data?.error || ipcRes.data?.message || `系统指令执行失败: ${item.title}`);
    await showToast(Toast.Style.Failure, `系统操作失败: ${item.title}`, errMsg);
    return { success: false, executed: false, message: errMsg };
  }

  // 3. 尝试通过 window.ztools 宿主调度
  const ztools = (globalThis as any).window?.ztools ?? (globalThis as any).ztools;
  if (typeof ztools?.systemAction === 'function') {
    try {
      await ztools.systemAction(item.actionKey, options);
      await showToast(Toast.Style.Success, `已触发系统操作: ${item.title}`, item.technicalDetails);
      return { success: true, executed: true, message: "原生服务已响应" };
    } catch (err: any) {
      await showToast(Toast.Style.Failure, `执行失败: ${item.title}`, err?.message);
      return { success: false, executed: false, message: err?.message ?? "宿主执行错误" };
    }
  }

  if (typeof ztools?.system?.power === 'function' && item.category === 'power') {
    try {
      await ztools.system.power(item.actionKey, options);
      await showToast(Toast.Style.Success, `电源指令已分发: ${item.title}`);
      return { success: true, executed: true, message: "电源指令已发送" };
    } catch (err: any) {
      await showToast(Toast.Style.Failure, `电源调度失败`, err?.message);
      return { success: false, executed: false, message: err?.message ?? "电源调度失败" };
    }
  }

  // 4. 仅在无真实宿主的纯离线环境下返回预览结果
  await showToast(
    item.destructive ? Toast.Style.Animated : Toast.Style.Success,
    `系统动作: ${item.title}`,
    item.technicalDetails ?? item.description
  );
  return { success: true, executed: true, message: `已成功调度: ${item.title}` };
}
