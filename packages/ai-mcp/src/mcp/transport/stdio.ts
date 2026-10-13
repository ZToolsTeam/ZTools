import { spawn, ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { JsonRpcMessage } from '../../types/mcp.js';
import { McpTransport } from './transport.js';

export interface StdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface StdioProcessStreams {
  stdin: Writable;
  stdout: Readable;
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
  private options?: StdioClientOptions;

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
      const child = spawn(this.options.command, this.options.args || [], {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'inherit']
      });

      this.childProcess = child;
      this.inStream = child.stdin!;
      this.outStream = child.stdout!;

      child.on('error', (err: any) => {
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

    this.outStream.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString('utf-8'));
    });

    this.outStream.on('error', (err: any) => {
      this.emitError(err);
    });

    this.outStream.on('end', () => {
      this.connected = false;
      this.emitClose();
    });
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
          } catch (err: any) {
            this.emitError(err);
          }
        }
      } catch (err: any) {
        this.emitError(new Error(`Failed to parse incoming JSON-RPC line: ${trimmed} (${err.message})`));
      }
    }
  }

  public async send(message: JsonRpcMessage): Promise<void> {
    if (!this.connected || !this.inStream) {
      throw new Error('StdioTransport is not connected');
    }

    const json = JSON.stringify(message) + '\n';
    return new Promise((resolve, reject) => {
      this.inStream!.write(json, 'utf-8', (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  public async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;

    if (this.childProcess) {
      try {
        this.childProcess.kill();
      } catch {}
    }

    this.emitClose();
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
      } catch {}
    }
  }

  private emitClose(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {}
    }
  }
}
