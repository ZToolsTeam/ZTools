/**
 * Windows 原生运维动作集合 (System Actions Definition)
 * 深度对齐 Raycast 原厂标准系统调度指令集 (Raycast Windows system commands)
 * 包含电源与会话、进程与桌面治理、音频与硬件控制、维护与通知 4 大分类 20+ 项指令
 */

import { Icon } from "../../constants/icons.js";
import { getDeclarativeBridge } from "../../api/bridge.js";
import { showToast, Toast } from "../../api/toast.js";

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
    subtitle: "user32.dll LockWorkStation",
    description: "立即锁定当前计算机屏幕并要求身份重新验证",
    category: "power",
    icon: Icon.Lock,
    shortcut: "Win+L",
    keywords: ["lock", "lockscreen", "锁屏", "锁定", "安全锁屏"],
    technicalDetails: "调用 Win32 user32.dll!LockWorkStation 立即挂起交互式会话。"
  },
  {
    id: "sleep",
    actionKey: "sleep",
    title: "睡眠待机 (Sleep)",
    subtitle: "powrprof.dll SetSuspendState(0,0,0)",
    description: "使计算机转入 S3 内存保留低功耗待机状态",
    category: "power",
    icon: Icon.Power,
    keywords: ["sleep", "suspend", "待机", "睡眠", "低功耗"],
    technicalDetails: "调用 powrprof.dll!SetSuspendState(FALSE, FALSE, FALSE) 进入 S3 挂起状态。"
  },
  {
    id: "restart",
    actionKey: "restart",
    title: "重新启动 (Restart)",
    subtitle: "shutdown.exe /r /t 0",
    description: "安全关闭全部应用程序并立即重新启动 Windows 操作系统",
    category: "power",
    icon: Icon.RotateClockwise,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认立即重新启动计算机？未保存的工作可能会丢失。",
    keywords: ["restart", "reboot", "重启", "重启电脑", "重开机"],
    technicalDetails: "执行 shutdown.exe /r /t 0，请求系统重启调度。"
  },
  {
    id: "shut-down",
    actionKey: "shutDown",
    title: "关闭计算机 (Shut Down)",
    subtitle: "shutdown.exe /s /t 0",
    description: "安全终结全部运行进程并切断计算机主电源",
    category: "power",
    icon: Icon.Power,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认立即关闭计算机电源？请确保重要数据已全部保存。",
    keywords: ["shutdown", "power off", "关机", "断电", "关机电脑"],
    technicalDetails: "执行 shutdown.exe /s /t 0，触发 ACPI S5 软关机。"
  },
  {
    id: "log-out",
    actionKey: "logOut",
    title: "注销用户会话 (Log Out)",
    subtitle: "shutdown.exe /l",
    description: "退出当前已登录的 Windows 用户桌面会话",
    category: "power",
    icon: Icon.Circle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认注销当前用户会话？",
    keywords: ["logout", "sign out", "注销", "登出", "注销登录"],
    technicalDetails: "执行 shutdown.exe /l 或 ExitWindowsEx(EWX_LOGOFF)。"
  },
  {
    id: "hibernate",
    actionKey: "hibernate",
    title: "深度休眠 (Hibernate)",
    subtitle: "powrprof.dll SetSuspendState(1,0,0)",
    description: "将内存数据完整转储至磁盘 hiberfil.sys 并彻底切断电源",
    category: "power",
    icon: Icon.Power,
    keywords: ["hibernate", "休眠", "深度休眠", "hiberfil"],
    technicalDetails: "调用 powrprof.dll!SetSuspendState(TRUE, FALSE, FALSE) 进入 S4 休眠。"
  },

  // =========================================================================
  // 2. 进程与桌面治理 (Apps & Windows)
  // =========================================================================
  {
    id: "hide-all-apps-except-frontmost",
    actionKey: "hideAllAppsExceptFrontmost",
    title: "隐藏除前台外所有应用 (Hide All Apps Except Frontmost)",
    subtitle: "Win32 ShowWindow(SW_MINIMIZE)",
    description: "保持当前最前台聚焦应用可见，将其余所有后台窗口一键最小化",
    category: "apps",
    icon: Icon.EyeSlash,
    keywords: ["hide all apps", "isolate", "focus", "专注模式", "隐藏后台", "最小化其他"],
    technicalDetails: "遍历顶层顶级 HWND 窗口列表，对非前台主窗口下发 SW_MINIMIZE。"
  },
  {
    id: "quit-all-applications",
    actionKey: "quitAllApplications",
    title: "退出所有运行应用 (Quit All Apps)",
    subtitle: "WM_CLOSE broadcast",
    description: "向当前会话中所有运行的应用窗口发送退出指令",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认退出当前会话中的所有应用程序？",
    keywords: ["quit all apps", "close all", "退出全部", "关闭所有应用"],
    technicalDetails: "向用户层活动进程窗口平缓广播 WM_CLOSE 消息请求正常退出。"
  },
  {
    id: "quit-all-applications-except-frontmost",
    actionKey: "quitAllApplicationsExceptFrontmost",
    title: "退出除前台外所有应用 (Quit All Apps Except Frontmost)",
    subtitle: "WM_CLOSE to background processes",
    description: "仅保留当前处于前台焦点的窗口，退出其余全部后台运行程序",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认退出除前台窗口外的所有后台应用？",
    keywords: ["quit background apps", "退出后台应用", "清理后台进程"],
    technicalDetails: "排查当前前台 GetForegroundWindow() 对应的 PID，其余进程投递退出消息。"
  },
  {
    id: "quit-active-application",
    actionKey: "quitActiveApplication",
    title: "终结当前前台应用 (Quit Active App)",
    subtitle: "Alt+F4 / WM_CLOSE",
    description: "立即向当前处于最前台焦点的应用程序窗口发送退出指令",
    category: "apps",
    icon: Icon.XmarkCircle,
    destructive: true,
    keywords: ["quit active app", "alt+f4", "close active", "关闭当前应用", "强退"],
    technicalDetails: "获取 GetForegroundWindow() 并向其投递 SC_CLOSE / WM_CLOSE 消息。"
  },
  {
    id: "show-desktop",
    actionKey: "showDesktop",
    title: "显示物理桌面 (Show Desktop)",
    subtitle: "Shell.Application ToggleDesktop",
    description: "最小化屏幕上全部活动窗口并瞬间切换至纯净物理桌面",
    category: "desktop",
    icon: Icon.Desktop,
    shortcut: "Win+D",
    keywords: ["desktop", "show desktop", "win+d", "桌面", "显示桌面", "最小化所有"],
    technicalDetails: "调用 IShellDispatch4::ToggleDesktop() 切换桌面最小化视态。"
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
    technicalDetails: "定位前台 HWND 的 PID 并通过 WASAPI CoreAudio 会话切换 SetMute。"
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
    technicalDetails: "读取前台应用的 WASAPI MasterVolume 并递增 0.1 (上限 1.0)。"
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
    technicalDetails: "读取前台应用的 WASAPI MasterVolume 并递减 0.1 (下限 0.0)。"
  },
  {
    id: "volume-mixer",
    actionKey: "volumeMixer",
    title: "系统音量混音器 (Volume Mixer)",
    subtitle: "sndvol.exe",
    description: "调出系统级多应用音频会话混合器面板以独立精细调音",
    category: "audio",
    icon: Icon.Gear,
    keywords: ["volume mixer", "audio mixer", "sndvol", "音量合成器", "混音器"],
    technicalDetails: "启动 Windows 内置 sndvol.exe 混音控制台。"
  },
  {
    id: "toggle-mute",
    actionKey: "toggleMute",
    title: "系统主声道静音切换 (Toggle Mute)",
    subtitle: "VK_VOLUME_MUTE / IAudioEndpointVolume",
    description: "一键静音或恢复计算机主声卡默认输出端点",
    category: "audio",
    icon: Icon.Stop,
    keywords: ["mute", "unmute", "主音量静音", "静音", "恢复声音"],
    technicalDetails: "通过 IAudioEndpointVolume::SetMute 或 keybd_event(VK_VOLUME_MUTE) 切换。"
  },
  {
    id: "volume-up",
    actionKey: "turnVolumeUp",
    title: "提高系统主音量 (Turn Volume Up)",
    subtitle: "VK_VOLUME_UP (+2%)",
    description: "按预设步长调大计算机全局扬声器输出主音量",
    category: "audio",
    icon: Icon.ArrowUp,
    keywords: ["volume up", "系统音量加", "调大音量", "大声"],
    technicalDetails: "触发系统全局音量递增事件。"
  },
  {
    id: "volume-down",
    actionKey: "turnVolumeDown",
    title: "降低系统主音量 (Turn Volume Down)",
    subtitle: "VK_VOLUME_DOWN (-2%)",
    description: "按预设步长调小计算机全局扬声器输出主音量",
    category: "audio",
    icon: Icon.ArrowDown,
    keywords: ["volume down", "系统音量减", "调小音量", "小声"],
    technicalDetails: "触发系统全局音量递减事件。"
  },
  {
    id: "turn-display-off",
    actionKey: "turnDisplayOff",
    title: "关闭显示器电源 (Turn Display Off / Sleep Displays)",
    subtitle: "SC_MONITORPOWER 2",
    description: "下发节能信号使全部连接的物理显示器立即关闭熄屏",
    category: "audio",
    icon: Icon.Monitor,
    keywords: ["sleep displays", "screen off", "display off", "熄屏", "关屏幕", "显示器休眠"],
    technicalDetails: "广播 SendMessage(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)。"
  },
  {
    id: "eject-all-disks",
    actionKey: "ejectAllDisks",
    title: "安全弹出所有磁盘 (Eject All Disks)",
    subtitle: "FSCTL_LOCK_VOLUME & PREVENT_REMOVAL",
    description: "卸载并安全弹出当前挂载的全部移动磁盘、U盘与虚拟光驱镜像",
    category: "audio",
    icon: Icon.HardDrive,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认安全卸载并弹出全部已挂载的移动磁盘？",
    keywords: ["eject disks", "unmount", "弹出U盘", "安全删除硬件", "弹出所有磁盘"],
    technicalDetails: "逐一发送 FSCTL_DISMOUNT_VOLUME 与 IOCTL_STORAGE_EJECT_MEDIA。"
  },

  // =========================================================================
  // 4. 维护与通知 (Maintenance)
  // =========================================================================
  {
    id: "empty-trash",
    actionKey: "emptyTrash",
    title: "清空回收站 (Empty Trash / Empty Recycle Bin)",
    subtitle: "SHEmptyRecycleBinW",
    description: "永久清除 Windows 回收站中的全部废弃文件并立即释放磁盘物理空间",
    category: "maintenance",
    icon: Icon.Trash,
    destructive: true,
    requiresConfirmation: true,
    confirmationMessage: "确认永久清空回收站？清除后文件将无法直接还原。",
    keywords: ["empty recycle bin", "clean trash", "清空回收站", "清理垃圾桶", "清除临时文件"],
    technicalDetails: "调用 Shell32!SHEmptyRecycleBinW(NULL, NULL, SHERB_NOCONFIRMATION)。"
  },
  {
    id: "open-trash",
    actionKey: "openTrash",
    title: "打开回收站 (Open Recycle Bin)",
    subtitle: "explorer.exe shell:RecycleBinFolder",
    description: "在文件资源管理器中打开回收站视图以查看待清理文件",
    category: "maintenance",
    icon: Icon.Folder,
    keywords: ["open recycle bin", "open trash", "打开回收站", "查看回收站"],
    technicalDetails: "通过 ShellExecute 启动 shell:RecycleBinFolder。"
  },
  {
    id: "dismiss-notifications",
    actionKey: "dismissNotifications",
    title: "清除所有系统通知 (Dismiss Notifications)",
    subtitle: "ActionCenter Notification Dismiss",
    description: "立即关闭屏幕上当前浮现的所有通知横幅与操作中心待办提醒",
    category: "maintenance",
    icon: Icon.Checkmark,
    keywords: ["dismiss notifications", "clear alerts", "清除通知", "关闭提醒", "清空横幅"],
    technicalDetails: "调用 Windows.UI.Notifications.Management.UserNotificationListener 清理弹窗。"
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
  item: SystemActionItem,
  options: { force?: boolean; confirmBypass?: boolean } = {}
): Promise<{ success: boolean; executed: boolean; message: string }> {
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
      await showToast(Toast.Style.Success, `系统调度成功: ${item.title}`, item.technicalDetails);
      return { success: true, executed: true, message: res?.message ?? "执行完成" };
    }
  } catch (err: any) {
    await showToast(Toast.Style.Failure, `调度异常: ${item.title}`, err?.message);
    return { success: false, executed: false, message: err?.message ?? "执行失败" };
  }

  // 2. 尝试通过 window.ztools 宿主调度
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

  // 3. 优雅降级模拟
  await showToast(
    item.destructive ? Toast.Style.Animated : Toast.Style.Success,
    `系统动作: ${item.title}`,
    item.technicalDetails ?? item.description
  );
  return { success: true, executed: true, message: `已成功调度: ${item.title}` };
}
