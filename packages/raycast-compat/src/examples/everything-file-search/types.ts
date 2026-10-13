export type SortOption =
  | "name-asc"
  | "name-desc"
  | "size-desc"
  | "size-asc"
  | "mtime-desc"
  | "mtime-asc";

export type TypeFilter =
  | "all"
  | "document"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "folder"
  | "media" // 向后兼容
  | "app";

export interface FileRecord {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  category?: TypeFilter;
  extension?: string;
  acronym?: string;
  pinyin?: string;
  md5?: string;
  sha256?: string;
  attributes?: {
    isHidden?: boolean;
    isReadOnly?: boolean;
    isSystem?: boolean;
  };
}

export interface FileQuickLookResult {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  category: TypeFilter;
  previewType: "code" | "image" | "markdown" | "directory" | "binary" | "empty" | "error";
  content?: string;
  codeLanguage?: string;
  totalLines?: number;
  truncated?: boolean;
  dirEntries?: Array<{ name: string; isDir: boolean }>;
  error?: string;
}

export interface FileActionResult {
  success: boolean;
  message: string;
  path: string;
  error?: string;
}
