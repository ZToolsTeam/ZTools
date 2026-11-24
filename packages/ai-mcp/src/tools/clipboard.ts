import { tAiMcp } from '../i18n.js';

export interface ClipboardAdapter {
  read(format?: 'text' | 'html'): Promise<string>;
  write(text: string, format?: 'text' | 'html'): Promise<void>;
}

class InMemoryClipboardAdapter implements ClipboardAdapter {
  private textContent: string = '';
  private htmlContent: string = '';

  public async read(format: 'text' | 'html' = 'text'): Promise<string> {
    return format === 'html' ? this.htmlContent : this.textContent;
  }

  public async write(text: string, format: 'text' | 'html' = 'text'): Promise<void> {
    if (format === 'html') {
      this.htmlContent = text;
    } else {
      this.textContent = text;
    }
  }
}

let activeClipboardAdapter: ClipboardAdapter = new InMemoryClipboardAdapter();

export function setClipboardAdapter(adapter: ClipboardAdapter): void {
  activeClipboardAdapter = adapter;
}

export function getClipboardAdapter(): ClipboardAdapter {
  return activeClipboardAdapter;
}

export interface ReadClipboardArgs {
  format?: 'text' | 'html';
}

export interface ReadClipboardResult {
  content: string;
  format: 'text' | 'html';
  length: number;
}

export async function readClipboard(args: ReadClipboardArgs = {}): Promise<ReadClipboardResult> {
  const format = args.format || 'text';
  const content = await activeClipboardAdapter.read(format);
  return {
    content,
    format,
    length: content.length
  };
}

export interface WriteClipboardArgs {
  text: string;
  format?: 'text' | 'html';
  locale?: string;
}

export interface WriteClipboardResult {
  success: boolean;
  bytesWritten: number;
  format: 'text' | 'html';
}

export async function writeClipboard(args: WriteClipboardArgs, locale?: string): Promise<WriteClipboardResult> {
  if (typeof args.text !== 'string') {
    throw new Error(tAiMcp('tools.clipboard.invalidText', undefined, locale ?? args.locale));
  }

  const format = args.format || 'text';
  await activeClipboardAdapter.write(args.text, format);

  return {
    success: true,
    bytesWritten: Buffer.byteLength(args.text, 'utf-8'),
    format
  };
}
