import { ToastOptions, ToastStyle } from "../constants/toast.js";
import type { SecureStorageApi } from "./secure-storage.js";
import type { HostTransport, TerminateProcessOptions, TerminateProcessResult } from "./process.js";

/**
 * 宿主与兼容运行时的统一通信桥接接口
 */
export interface ZToolsDeclarativeBridge {
  showToast?: (options: ToastOptions) => {
    id: string;
    update: (options: Partial<ToastOptions>) => void;
    hide: () => void;
  };
  copyToClipboard?: (text: string | number) => Promise<void>;
  /** 清空系统剪贴板 */
  clearClipboard?: () => Promise<void>;
  readClipboardText?: () => Promise<string>;
  pasteToActive?: (text: string | number) => Promise<void>;
  manageWindow?: (action: string) => Promise<boolean>;
  storageGetItem?: (key: string) => Promise<any>;
  storageCompareAndSet?: (key: string, expected: unknown, value: unknown) => Promise<boolean>;
  storageSetItem?: (key: string, value: any) => Promise<void>;
  storageRemoveItem?: (key: string) => Promise<void>;
  storageClear?: () => Promise<void>;
  storageAll?: () => Promise<Record<string, any>>;
  openExternal?: (url: string) => Promise<void>;
  showHUD?: (title: string, icon?: string) => Promise<void>;
  confirmAlert?: (options: {
    title: string;
    message?: string;
    primaryAction?: { title: string; style?: "default" | "destructive"; onAction?: () => void };
    dismissAction?: { title?: string; onAction?: () => void };
  }) => Promise<boolean>;
  navigation?: {
    push: (target: any) => void;
    pop: () => void;
  };
  clipboardHistory?: {
    query?: (options?: any) => Promise<any[]>;
    togglePin?: (id: string) => Promise<boolean>;
    delete?: (id: string) => Promise<boolean>;
    clearUnpinned?: () => Promise<number>;
    pasteSequential?: () => Promise<{ success: boolean; item?: any; sequenceIndex?: number; total?: number; message?: string }>;
    resetSequence?: () => Promise<{ success: boolean }>;
  };
  snippets?: {
    list?: (query?: string) => Promise<any[]>;
    create?: (snippet: any) => Promise<any>;
    update?: (id: string, snippet: any) => Promise<any>;
    delete?: (id: string) => Promise<boolean>;
    toggle?: (id: string) => Promise<boolean>;
    matchAndExpand?: (typedText: string, clipboardContent?: string) => Promise<any>;
    import?: (data: any[]) => Promise<{ total: number; imported: number; updated: number; failed: number }>;
    export?: () => Promise<any[]>;
  };
  /** 加密存储实现（宿主按插件注入；测试可注入替身）。缺省时 SecureStorage 报 host-unsupported，绝不回落明文 */
  secureStorage?: Partial<SecureStorageApi>;
  /** 结束本机任意进程（宿主按插件注入） */
  terminateProcess?: (pid: number, options: TerminateProcessOptions) => Promise<TerminateProcessResult>;
  /** 插件专属宿主调用通道 */
  hostTransport?: HostTransport;
}

let customBridge: ZToolsDeclarativeBridge | null = null;

/**
 * 允许宿主或测试环境设置自定义 Bridge
 */
export function setDeclarativeBridge(bridge: ZToolsDeclarativeBridge | null): void {
  customBridge = bridge;
}

/**
 * 获取当前有效的 Bridge
 */
export function getDeclarativeBridge(): ZToolsDeclarativeBridge | null {
  if (customBridge) {
    return customBridge;
  }
  if (typeof globalThis !== "undefined" && (globalThis as any).__ZTOOLS_RAYCAST_BRIDGE__) {
    return (globalThis as any).__ZTOOLS_RAYCAST_BRIDGE__;
  }
  return null;
}
