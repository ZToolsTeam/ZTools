export interface Snippet {
  id: string;
  name: string;
  keyword: string;
  snippet: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  category?: string;
  isPinned?: boolean;
}

export interface SnippetArgumentDescriptor {
  name: string;
  type: "text" | "password" | "dropdown";
  defaultValue: string;
  options: string[];
  required: boolean;
}

export interface SnippetFilterOptions {
  query?: string;
  enabledOnly?: boolean;
  category?: string;
}

export interface SnippetMacroContext {
  clipboard?: string;
  now?: Date;
  args?: Record<string, string>;
  previewPlaceholders?: boolean;
}

export interface MacroExpandResult {
  expanded: string;
  cursorOffset: number;
  hasCursor: boolean;
  arguments?: SnippetArgumentDescriptor[];
}

export interface SnippetImportExportResult {
  total: number;
  imported: number;
  updated: number;
  failed: number;
  errors?: string[];
}
