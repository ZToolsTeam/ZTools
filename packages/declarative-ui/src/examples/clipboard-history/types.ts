export type ClipboardContentType = "text" | "code" | "image" | "files" | "link" | "color" | "json";

export interface ClipboardItem {
  id: string;
  type: ClipboardContentType;
  content: string;
  preview: string;
  copiedAt: number;
  pinned: boolean;
  charCount?: number;
  wordCount?: number;
  lineCount?: number;
  filePaths?: string[];
  imageDimensions?: { width: number; height: number };
  colorHex?: string;
  sourceAppName?: string;
  sourceAppPath?: string;
  isSensitive?: boolean;
  sensitiveMaskedPreview?: string;
}

export interface ClipboardFilterOptions {
  type?: ClipboardContentType | "all" | "pinned";
  query?: string;
}

export interface ClipboardPreferences {
  historyDuration?: "P1D" | "P1W" | "P1M" | "P3M" | "P1Y" | "never";
  primaryAction?: "paste" | "copy";
  preferPastingAsPlainText?: boolean;
  updateHistoryAfterAction?: boolean;
}

export interface PasteSequenceState {
  offset: number;
  lastInvocation: number | null;
  topItemId: string | null;
}
