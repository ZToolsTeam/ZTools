/**
 * 核心系统（更新检查、版本公告）类型契约
 */

export interface ReleaseNoteItem {
  version: string;
  releaseDate: string;
  title: string;
  highlights: string[];
  markdownNotes: string;
  isCurrentVersion?: boolean;
}

export interface AnnouncementItem {
  id: string;
  title: string;
  content: string;
  date: string;
  severity: "info" | "warning" | "critical";
  linkUrl?: string;
  dismissed?: boolean;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseNotes?: string;
  sha256?: string;
}
