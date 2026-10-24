/**
 * 宿主能力调用失败时抛出的错误：code 为宿主错误码（如 PROCESS_PROTECTED、SECURE_STORAGE_UNAVAILABLE），
 * details 为宿主允许公开的结构化补充信息（如结束进程超时时仍在运行的 pid）。
 */
export class ZToolsHostError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "ZToolsHostError";
    this.code = code;
    if (details) this.details = details;
  }
}

export function isZToolsHostError(error: unknown): error is ZToolsHostError {
  return error instanceof ZToolsHostError ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ZToolsHostError" &&
      typeof (error as { code?: unknown }).code === "string");
}
