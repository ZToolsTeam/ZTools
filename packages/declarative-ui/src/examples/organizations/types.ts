/**
 * Raycast for Teams / Organizations 商业与团队协同类型契约
 * 对标 Raycast for Teams 商业协同中枢架构
 */

export type OrgRole = "owner" | "admin" | "member" | "guest";
export type WorkspaceMode = "personal" | "team_enterprise";

export interface OrgMember {
  id: string;
  name: string;
  email: string;
  role: OrgRole;
  avatarUrl?: string;
  joinedAt: string;
}

export interface OrgWebhook {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  events?: string[];
  active: boolean;
  secretKey?: string;
  createdAt: string;
  lastTriggered?: string | null;
  lastStatus?: string;
  lastError?: string | null;
}

export interface TeamSharedSnippet {
  id: string;
  name: string;
  keyword: string;
  content: string;
  author: string;
  updatedAt: string;
  tags?: string[];
}

export interface TeamSharedQuicklink {
  id: string;
  name: string;
  url: string;
  alias?: string;
  author: string;
  category: string;
  updatedAt: string;
  pinned?: boolean;
}

export interface PrivateExtensionItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  downloadUrl?: string;
  installed: boolean;
  permissions?: string[];
  securityAuditPassed?: boolean;
}

export interface ComplianceAuditItem {
  id: string;
  action: string;
  actor: string;
  timestamp: string;
  resource: string;
  status: "allowed" | "denied" | "flagged";
  ipAddress: string;
  details: string;
}

export interface OrgPermissionPolicy {
  aiDataSharingAllowed: boolean;
  allowedAiProviders: string[];
  requireE2eeSync: boolean;
  requireTwoManRuleForExtensions: boolean;
  auditLogRetentionDays: number;
  allowMemberInvite: boolean;
}

export interface WorkspaceInfo {
  id: string;
  mode: WorkspaceMode;
  name: string;
  description: string;
  badge: string;
  memberCount: number;
  isActive: boolean;
  isE2eeEncrypted: boolean;
}

export interface OrganizationData {
  id: string;
  name: string;
  slug: string;
  description?: string;
  inviteCode: string;
  activeWorkspace: WorkspaceMode;
  members: OrgMember[];
  webhooks: OrgWebhook[];
  sharedSnippets: TeamSharedSnippet[];
  sharedQuicklinks: TeamSharedQuicklink[];
  privateExtensions: PrivateExtensionItem[];
  complianceAuditLogs: ComplianceAuditItem[];
  policies: OrgPermissionPolicy;
}
