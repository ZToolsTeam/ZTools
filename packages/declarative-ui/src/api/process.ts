import { getDeclarativeBridge } from "./bridge.js";
import { ZToolsHostError } from "./host-error.js";

export interface TerminateProcessOptions {
  /** graceful：请求正常退出（POSIX SIGTERM / Windows WM_CLOSE）；force：强制结束。默认 graceful */
  mode?: "graceful" | "force";
  /** 连同子孙进程一起结束，默认 false */
  tree?: boolean;
  /** 等待进程真正退出的时间，100–10000 毫秒；默认 graceful 3000 / force 2000 */
  timeoutMs?: number;
  /** 列表里看到的进程名；与当前该 pid 的进程名不一致时拒绝（防 pid 复用误杀） */
  expectedName?: string;
}

export interface TerminateProcessResult {
  pid: number;
  mode: "graceful" | "force";
  tree: boolean;
  /** 实际确认退出的 pid（先子后父） */
  terminated: number[];
}

/**
 * 结束本机任意进程。插件必须在 plugin.json 声明 "process" 权限。
 *
 * 失败抛 ZToolsHostError，常见 code：
 * PROCESS_PROTECTED（details.reason: system / host-self / host-ancestor / host-child）、PROCESS_NOT_FOUND、
 * PROCESS_ACCESS_DENIED、PROCESS_IDENTITY_MISMATCH、PROCESS_TERMINATE_TIMEOUT（details.stillRunning；宿主不会自动升级 force）、
 * PLUGIN_PERMISSION_REQUIRED、PLUGIN_IDENTITY_REQUIRED、HOST_FEATURE_UNAVAILABLE（宿主过旧）。
 */
export async function terminateProcess(pid: number, options: TerminateProcessOptions = {}): Promise<TerminateProcessResult> {
  if (!Number.isInteger(pid) || pid < 2 || pid > 0xffff_ffff) {
    throw new ZToolsHostError("INVALID_REQUEST", "pid 必须是 2–4294967295 的整数");
  }
  const impl = getDeclarativeBridge()?.terminateProcess;
  if (!impl) throw new ZToolsHostError("HOST_FEATURE_UNAVAILABLE", "当前宿主不支持结束任意进程，请升级 ZTools");
  return impl(pid, options);
}

/** 插件专属的宿主调用通道（调用自动带上本插件的身份）；宿主不支持时返回 null */
export interface HostTransport {
  call<T = unknown>(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>;
}

export function getHostTransport(): HostTransport | null {
  return getDeclarativeBridge()?.hostTransport ?? null;
}
