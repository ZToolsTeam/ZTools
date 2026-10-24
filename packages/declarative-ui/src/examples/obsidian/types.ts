export interface ObsidianVaultInfo {
  name: string;
  path: string;
  open?: boolean;
  ts?: number;
}

export interface ObsidianNote {
  id: string;
  title: string;
  vault: string;
  folder: string;
  tags: string[];
  content: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  isDaily?: boolean;
}

export interface DailyNoteAppendOptions {
  vault: string;
  content: string;
  heading?: string;
  timestamp?: boolean;
}
