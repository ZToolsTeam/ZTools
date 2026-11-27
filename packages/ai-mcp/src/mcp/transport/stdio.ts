import { spawn, ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { JsonRpcMessage } from '../../types/mcp.js';
import { McpTransport } from './transport.js';

export interface StdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * 允许额外从宿主 process.env 透传给子进程的环境变量名白名单
   */
  envAllowlist?: string[];
}

export interface StdioProcessStreams {
  stdin: Writable;
  stdout: Readable;
}

// Windows 最小跨平台安全环境变量白名单（按大写归一化匹配）
const WINDOWS_SAFE_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'WINDIR',
  'NODE_ENV'
]);

// POSIX 最小跨平台安全环境变量白名单
const POSIX_SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'NODE_ENV'
]);

/**
 * 构造最小权限的子进程环境变量，避免将宿主敏感密钥（Token / API Key）无条件泄露给外部 MCP 子进程
 */
function buildSanitizedChildEnv(
  options: StdioClientOptions,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const isWindows = platform === 'win32';
  const extraAllowlist = new Set(
    (options.envAllowlist || []).map((key) => (isWindows ? key.toUpperCase() : key))
  );

  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (isWindows) {
      const upper = key.toUpperCase();
      if (WINDOWS_SAFE_ENV_KEYS.has(upper) || extraAllowlist.has(upper)) {
        sanitized[key] = value;
      }
    } else {
      if (
        POSIX_SAFE_ENV_KEYS.has(key) ||
        key.startsWith('LC_') ||
        extraAllowlist.has(key)
      ) {
        sanitized[key] = value;
      }
    }
  }

  // 合并调用方显式指定的子进程环境变量
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Windows 下使用 taskkill /F /T /PID 清理整棵子进程树，防止孤儿进程驻留占锁
 */
function terminateWindowsProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number') {
    try {
      child.kill();
    } catch (err: unknown) {
      void err;
    }
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      resolve();
    };

    const fallbackTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (err: unknown) {
        void err;
      }
      finish();
    }, 3000);

    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', () => {
        try {
          child.kill();
        } catch (err: unknown) {
          void err;
        }
        finish();
      });
      killer.once('close', () => {
        finish();
      });
    } catch (err: unknown) {
      void err;
      try {
        child.kill();
      } catch (killErr: unknown) {
        void killErr;
      }
      finish();
    }
  });
}

/**
 * POSIX 下先发送 SIGTERM，超时仍未退出时再发送 SIGKILL
 */
function terminatePosixProcess(child: ChildProcess, graceMs = 2000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      child.removeListener('exit', onExit);
      resolve();
    };

    const onExit = () => finish();
    child.once('exit', onExit);

    const forceTimer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      } catch (err: unknown) {
        void err;
      }
      finish();
    }, graceMs);

    try {
      child.kill('SIGTERM');
    } catch (err: unknown) {
      void err;
      finish();
    }
  });
}

export class StdioTransport implements McpTransport {
  private childProcess?: ChildProcess;
  private inStream?: Writable;
  private outStream?: Readable;
  private buffer: string = '';
  private messageHandlers: Array<(msg: JsonRpcMessage) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private connected: boolean = false;
  private closedEmitted: boolean = false;
  private options?: StdioClientOptions;
  private onOutData?: (chunk: Buffer) => void;
  private onOutError?: (err: Error) => void;
  private onOutEnd?: () => void;

  constructor(optionsOrStreams: StdioClientOptions | StdioProcessStreams) {
    if ('command' in optionsOrStreams) {
      this.options = optionsOrStreams;
    } else {
      this.inStream = optionsOrStreams.stdin;
      this.outStream = optionsOrStreams.stdout;
    }
  }

  public get isConnected(): boolean {
    return this.connected;
  }

  public async connect(): Promise<void> {
    if (this.options) {
      const sanitizedEnv = buildSanitizedChildEnv(this.options);
      const child = spawn(this.options.command, this.options.args || [], {
        cwd: this.options.cwd,
        env: sanitizedEnv,
        stdio: ['pipe', 'pipe', 'inherit']
      });

      this.childProcess = child;
      this.inStream = child.stdin!;
      this.outStream = child.stdout!;

      child.on('error', (err: Error) => {
        this.emitError(err);
      });

      child.on('exit', () => {
        this.connected = false;
        this.emitClose();
      });
    }

    if (!this.inStream || !this.outStream) {
      throw new Error('Stdio streams are not available');
    }

    this.connected = true;
    this.closedEmitted = false;

    this.onOutData = (chunk: Buffer) => {
      this.handleData(chunk.toString('utf-8'));
    };
    this.onOutError = (err: Error) => {
      this.emitError(err);
    };
    this.onOutEnd = () => {
      this.connected = false;
      this.emitClose();
    };

    this.outStream.on('data', this.onOutData);
    this.outStream.on('error', this.onOutError);
    this.outStream.on('end', this.onOutEnd);
  }

  private handleData(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as JsonRpcMessage;
        for (const handler of this.messageHandlers) {
          try {
            handler(parsed);
          } catch (err: unknown) {
            this.emitError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.emitError(new Error(`Failed to parse incoming JSON-RPC line: ${trimmed} (${errMsg})`));
      }
    }
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (!this.connected || !this.inStream) {
      throw new Error('StdioTransport is not connected');
    }

    const json = JSON.stringify(message) + '\n';
    return new Promise((resolve, reject) => {
      this.inStream!.write(json, 'utf-8', (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async close(): Promise<void> {
    const wasConnected = this.connected;
    this.connected = false;

    // 卸载输出流事件监听，避免关闭过程中触发多余回调
    if (this.outStream) {
      if (this.onOutData) this.outStream.removeListener('data', this.onOutData);
      if (this.onOutError) this.outStream.removeListener('error', this.onOutError);
      if (this.onOutEnd) this.outStream.removeListener('end', this.onOutEnd);
    }
    this.onOutData = undefined;
    this.onOutError = undefined;
    this.onOutEnd = undefined;

    const child = this.childProcess;
    this.childProcess = undefined;

    if (child) {
      // 先安全关闭 stdin/stdout/stderr 并移除监听，防止句柄占锁
      const streams = [child.stdin, child.stdout, child.stderr];
      for (const stream of streams) {
        if (!stream) continue;
        try {
          stream.removeAllListeners();
          if ('end' in stream && typeof stream.end === 'function' && !stream.destroyed) {
            stream.end();
          }
          if (!stream.destroyed) {
            stream.destroy();
          }
        } catch (err: unknown) {
          void err;
        }
      }

      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          await terminateWindowsProcessTree(child);
        } else {
          await terminatePosixProcess(child);
        }
      }
    }

    if (wasConnected || child) {
      this.emitClose();
    }
  }

  public onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  public onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(err);
      } catch (handlerErr: unknown) {
        void handlerErr;
      }
    }
  }

  private emitClose(): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch (handlerErr: unknown) {
        void handlerErr;
      }
    }
  }
}
