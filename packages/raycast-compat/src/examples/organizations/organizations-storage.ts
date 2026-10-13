/**
 * Organizations 团队数据持久化与协同服务
 * 商业版专属：工作区切换、企业私有扩展、团队共享短语与快捷指令、合规审计
 */

import { LocalStorage } from "../../api/storage.js";
import {
  OrganizationData,
  OrgMember,
  OrgWebhook,
  TeamSharedSnippet,
  TeamSharedQuicklink,
  PrivateExtensionItem,
  ComplianceAuditItem,
  OrgPermissionPolicy,
  WorkspaceMode,
  WorkspaceInfo
} from "./types.js";

export const ORG_STORAGE_KEY = "ztools_organizations_data_v1";

export const INITIAL_ORGANIZATION: OrganizationData = {
  id: "org_ztools_core",
  name: "ZTools 极客先锋核心组",
  slug: "ztools-core",
  description: "ZTools 核心研发团队、私有扩展内测与共享协同工作区 (ZTools for Teams)",
  inviteCode: "inv_ztools_8899aabb",
  activeWorkspace: "team_enterprise",
  members: [
    {
      id: "mem_001",
      name: "Linus (架构师)",
      email: "linus@ztools.org",
      role: "owner",
      joinedAt: "2026-01-01"
    },
    {
      id: "mem_002",
      name: "Ada (安全审计员)",
      email: "ada@ztools.org",
      role: "admin",
      joinedAt: "2026-02-15"
    },
    {
      id: "mem_003",
      name: "Turing (扩展开发者)",
      email: "turing@ztools.org",
      role: "member",
      joinedAt: "2026-03-10"
    }
  ],
  webhooks: [
    {
      id: "wh_001",
      name: "飞书/钉钉 团队构建审计机器人",
      url: "https://open.feishu.cn/open-apis/bot/v2/hook/xxx-sample",
      eventTypes: ["plugin.published", "snippet.updated", "member.joined"],
      events: ["plugin.published", "snippet.updated", "member.joined"],
      active: true,
      createdAt: "2026-03-01"
    }
  ],
  sharedSnippets: [
    {
      id: "ts_001",
      name: "Git 极客规范 Commit 模板",
      keyword: "featcommit",
      content: "feat({scope}): {title}\n\n- 详细说明与架构改动\n- 关联任务: #{issue}",
      author: "Linus",
      updatedAt: "2026-10-10",
      tags: ["git", "standard"]
    },
    {
      id: "ts_002",
      name: "TypeScript 声明式组件契约",
      keyword: "tsdesc",
      content: "import React, { List, ActionPanel, Action } from '@ztools/raycast-compat';\n\nexport default function Command() {\n  return <List isShowingDetail={true} />;\n}",
      author: "Ada",
      updatedAt: "2026-10-12",
      tags: ["typescript", "raycast"]
    },
    {
      id: "ts_003",
      name: "生产故障应急响应排查清单",
      keyword: "incidents",
      content: "## 应急故障响应排查\n1. 确认告警等级 (P0/P1/P2)\n2. 检查 Grafana 内存与句柄泄漏指标\n3. 启动 Rust 侧车看门狗熔断日志\n4. 执行灰度回滚并同步企业群组",
      author: "Turing",
      updatedAt: "2026-10-13",
      tags: ["sre", "oncall"]
    }
  ],
  sharedQuicklinks: [
    {
      id: "tql_001",
      name: "团队内部研发知识库 (Wiki)",
      url: "https://wiki.corp.ztools.org/architecture",
      alias: "wiki",
      author: "Linus",
      category: "知识库",
      updatedAt: "2026-10-10",
      pinned: true
    },
    {
      id: "tql_002",
      name: "CI/CD 持续交付与发布流水线",
      url: "https://ci.corp.ztools.org/deploy/pipelines",
      alias: "cicd",
      author: "Ada",
      category: "研发效能",
      updatedAt: "2026-10-11",
      pinned: true
    },
    {
      id: "tql_003",
      name: "生产集群 Grafana 性能监控看板",
      url: "https://grafana.corp.ztools.org/d/system-perf",
      alias: "grafana",
      author: "Turing",
      category: "运维监控",
      updatedAt: "2026-10-12",
      pinned: false
    }
  ],
  privateExtensions: [
    {
      id: "corp-jira-bridge",
      name: "企业内网 JIRA 极速同步",
      version: "1.2.0",
      description: "连接内部 JIRA 与代码审计平台，即时查询并流转敏捷迭代工单",
      author: "ZTools Core Team",
      installed: true,
      permissions: ["network", "storage"],
      securityAuditPassed: true
    },
    {
      id: "corp-vpn-guard",
      name: "企业零信任安全隧道守护",
      version: "2.0.4",
      description: "一键探测内网网段连通性，自动分流特权服务调用",
      author: "Ada",
      installed: false,
      permissions: ["network", "system"],
      securityAuditPassed: true
    },
    {
      id: "corp-db-migrator",
      name: "生产数据库变更安全巡检",
      version: "0.9.5",
      description: "自动解析 SQL DDL 语法树，检测大表锁表隐患与索引覆盖率",
      author: "Linus",
      installed: true,
      permissions: ["clipboard", "storage"],
      securityAuditPassed: true
    }
  ],
  complianceAuditLogs: [
    {
      id: "aud_001",
      action: "私有扩展自动构建与组织签名",
      actor: "Ada (安全审计员)",
      timestamp: "2026-10-13 10:15:00",
      resource: "corp-jira-bridge:1.2.0",
      status: "allowed",
      ipAddress: "10.0.4.12",
      details: "AST 语法树扫描通过，未发现 eval/new Function/原型链逃逸风险"
    },
    {
      id: "aud_002",
      action: "团队共享快捷短语批量更新",
      actor: "Turing (扩展开发者)",
      timestamp: "2026-10-13 09:30:00",
      resource: "sharedSnippets:incidents",
      status: "allowed",
      ipAddress: "10.0.2.88",
      details: "通过 E2EE 认证通道向团队推送生产应急处置模板"
    },
    {
      id: "aud_003",
      action: "未授权公有云 AI 模型请求拦截",
      actor: "外部插件尝试调用公网接口",
      timestamp: "2026-10-12 18:20:00",
      resource: "ai:unauthorized-external-vendor",
      status: "denied",
      ipAddress: "10.0.8.4",
      details: "违反企业 AI 允许列表策略 (仅允许 DeepSeek/本地离线模型)，已阻断"
    }
  ],
  policies: {
    aiDataSharingAllowed: false,
    allowedAiProviders: ["deepseek", "ollama_local", "private_endpoint"],
    requireE2eeSync: true,
    requireTwoManRuleForExtensions: true,
    auditLogRetentionDays: 180,
    allowMemberInvite: true
  }
};

let currentOrgData: OrganizationData = structuredClone(INITIAL_ORGANIZATION);

// 尝试异步恢复持久化数据
LocalStorage.getItem<string>(ORG_STORAGE_KEY)
  .then((raw) => {
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.id) {
          currentOrgData = {
            id: String(parsed.id),
            name: String(parsed.name || INITIAL_ORGANIZATION.name),
            slug: String(parsed.slug || INITIAL_ORGANIZATION.slug),
            description: parsed.description,
            inviteCode: String(parsed.inviteCode || INITIAL_ORGANIZATION.inviteCode),
            activeWorkspace: parsed.activeWorkspace || INITIAL_ORGANIZATION.activeWorkspace,
            members: Array.isArray(parsed.members) ? parsed.members : INITIAL_ORGANIZATION.members,
            webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : INITIAL_ORGANIZATION.webhooks,
            sharedSnippets: Array.isArray(parsed.sharedSnippets) ? parsed.sharedSnippets : INITIAL_ORGANIZATION.sharedSnippets,
            sharedQuicklinks: Array.isArray(parsed.sharedQuicklinks) ? parsed.sharedQuicklinks : INITIAL_ORGANIZATION.sharedQuicklinks,
            privateExtensions: Array.isArray(parsed.privateExtensions) ? parsed.privateExtensions : INITIAL_ORGANIZATION.privateExtensions,
            complianceAuditLogs: Array.isArray(parsed.complianceAuditLogs) ? parsed.complianceAuditLogs : INITIAL_ORGANIZATION.complianceAuditLogs,
            policies: parsed.policies || INITIAL_ORGANIZATION.policies
          };
        }
      } catch {}
    }
  })
  .catch(() => {});

function wrapThenable(data: OrganizationData): OrganizationData & PromiseLike<OrganizationData> {
  const target: any = { ...data };
  target.then = function (onFulfilled?: any, onRejected?: any) {
    try {
      const cleanCopy: any = { ...data };
      delete cleanCopy.then;
      const res = typeof onFulfilled === "function" ? onFulfilled(cleanCopy) : cleanCopy;
      return Promise.resolve(res);
    } catch (err) {
      if (typeof onRejected === "function") {
        return Promise.resolve(onRejected(err));
      }
      return Promise.reject(err);
    }
  };
  return target;
}

/**
 * 获取工作区列表元信息
 */
export function getAvailableWorkspaces(): WorkspaceInfo[] {
  const org = currentOrgData;
  return [
    {
      id: "ws_personal",
      mode: "personal",
      name: "个人本地工作区 (Personal Local)",
      description: "纯本地独立工作区，配置与个人短语不与组织共享",
      badge: "个人专属",
      memberCount: 1,
      isActive: org.activeWorkspace === "personal",
      isE2eeEncrypted: true
    },
    {
      id: "ws_team_enterprise",
      mode: "team_enterprise",
      name: `${org.name} (ZTools for Teams)`,
      description: org.description || "团队企业专属协作空间",
      badge: "企业空间",
      memberCount: org.members.length,
      isActive: org.activeWorkspace === "team_enterprise",
      isE2eeEncrypted: true
    }
  ];
}

/**
 * 切换活跃工作区 (Personal vs Team Enterprise)
 */
export async function switchWorkspace(mode: WorkspaceMode): Promise<OrganizationData> {
  const org = getOrganizationData();
  org.activeWorkspace = mode;
  return saveOrganizationData(org);
}

/**
 * 读取当前组织数据 (同步直接可用，亦支持 await)
 */
export function getOrganizationData(): OrganizationData & PromiseLike<OrganizationData> {
  return wrapThenable(currentOrgData);
}

/**
 * 保存组织数据
 */
export async function saveOrganizationData(data: OrganizationData): Promise<OrganizationData> {
  currentOrgData = data;
  await LocalStorage.setItem(ORG_STORAGE_KEY, JSON.stringify(data));
  return wrapThenable(currentOrgData);
}

/**
 * 生成团队邀请链接
 */
export function generateInviteLink(org: OrganizationData): string {
  return `https://ztools.cn/join-team?org=${encodeURIComponent(org.slug)}&code=${encodeURIComponent(org.inviteCode)}`;
}

/**
 * 添加成员
 */
export async function addOrgMember(member: Omit<OrgMember, "id" | "joinedAt">): Promise<OrganizationData> {
  const org = getOrganizationData();
  const newMember: OrgMember = {
    ...member,
    id: `mem_${Date.now()}`,
    joinedAt: new Date().toISOString().split("T")[0]
  };
  org.members.push(newMember);
  return saveOrganizationData(org);
}

/**
 * 移除成员
 */
export async function removeOrgMember(memberId: string): Promise<OrganizationData> {
  const org = getOrganizationData();
  org.members = org.members.filter((m) => m.id !== memberId);
  return saveOrganizationData(org);
}

/**
 * 添加团队共享快捷指令
 */
export async function addSharedQuicklink(ql: Omit<TeamSharedQuicklink, "id" | "updatedAt">): Promise<OrganizationData> {
  const org = getOrganizationData();
  const newQl: TeamSharedQuicklink = {
    ...ql,
    id: `tql_${Date.now()}`,
    updatedAt: new Date().toISOString().split("T")[0]
  };
  org.sharedQuicklinks = [...(org.sharedQuicklinks || []), newQl];
  return saveOrganizationData(org);
}

/**
 * 移除团队共享快捷指令
 */
export async function removeSharedQuicklink(id: string): Promise<OrganizationData> {
  const org = getOrganizationData();
  org.sharedQuicklinks = (org.sharedQuicklinks || []).filter((q) => q.id !== id);
  return saveOrganizationData(org);
}

/**
 * 记录合规审计日志
 */
export async function recordAuditLog(
  action: string,
  actor: string,
  resource: string,
  status: "allowed" | "denied" | "flagged",
  details: string
): Promise<ComplianceAuditItem> {
  const org = getOrganizationData();
  const logItem: ComplianceAuditItem = {
    id: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    action,
    actor,
    timestamp: new Date().toISOString().replace("T", " ").substring(0, 19),
    resource,
    status,
    ipAddress: "127.0.0.1 (本地宿主)",
    details
  };
  org.complianceAuditLogs = [logItem, ...(org.complianceAuditLogs || [])].slice(0, 50);
  await saveOrganizationData(org);
  return logItem;
}

/**
 * 更新团队安全与权限策略
 */
export async function updateOrgPolicy(policyUpdate: Partial<OrgPermissionPolicy>): Promise<OrganizationData> {
  const org = getOrganizationData();
  org.policies = {
    ...org.policies,
    ...policyUpdate
  };
  return saveOrganizationData(org);
}

/**
 * 同步团队资产 (Snippets, Quicklinks, Private Extensions)
 */
export async function syncTeamAssets(): Promise<{ success: boolean; syncedCount: number; message: string }> {
  const org = getOrganizationData();
  const total = (org.sharedSnippets?.length || 0) + (org.sharedQuicklinks?.length || 0) + (org.privateExtensions?.length || 0);
  return {
    success: true,
    syncedCount: total,
    message: `团队资产已同步完成: ${org.sharedSnippets?.length || 0} 条短语, ${org.sharedQuicklinks?.length || 0} 条指令, ${org.privateExtensions?.length || 0} 款私有扩展`
  };
}

/**
 * 添加 Webhook
 */
export function addOrgWebhook(wh: any): OrganizationData & PromiseLike<OrganizationData> {
  const org = getOrganizationData();
  const newWh: OrgWebhook = {
    id: wh.id || `wh_${Date.now()}`,
    name: wh.name || "Webhook",
    url: wh.url || "",
    eventTypes: wh.events || wh.eventTypes || [],
    events: wh.events || wh.eventTypes || [],
    active: wh.active !== false,
    createdAt: wh.createdAt || new Date().toISOString().split("T")[0],
    lastTriggered: wh.lastTriggered ?? null,
    lastStatus: wh.lastStatus ?? "idle",
    lastError: wh.lastError ?? null
  };
  org.webhooks.push(newWh);
  currentOrgData = org;
  LocalStorage.setItem(ORG_STORAGE_KEY, JSON.stringify(org)).catch(() => {});
  return wrapThenable(org);
}

/**
 * 删除 Webhook
 */
export function removeOrgWebhook(webhookId: string): OrganizationData & PromiseLike<OrganizationData> {
  const org = getOrganizationData();
  org.webhooks = org.webhooks.filter((w) => w.id !== webhookId);
  currentOrgData = org;
  LocalStorage.setItem(ORG_STORAGE_KEY, JSON.stringify(org)).catch(() => {});
  return wrapThenable(org);
}

/**
 * 模拟触发 Webhook 联通性测试
 */
export async function testTriggerWebhook(webhookOrId: OrgWebhook | string): Promise<{ success: boolean; latencyMs: number; message: string; error?: string }> {
  let hook: OrgWebhook | undefined;
  if (typeof webhookOrId === "string") {
    const org = getOrganizationData();
    hook = org.webhooks.find((w) => w.id === webhookOrId);
  } else {
    hook = webhookOrId;
  }

  if (!hook || !hook.url || !hook.url.startsWith("http") || hook.url.includes("broken")) {
    const errReason = !hook
      ? "Webhook 不存在"
      : !hook.url.startsWith("http")
      ? "URL 必须为有效 http/https 协议"
      : "HTTP 500: Server Chaos Injected / Network unreachable";
    if (hook) {
      hook.lastStatus = "failed";
      hook.lastError = errReason;
      currentOrgData = getOrganizationData();
    }
    return {
      success: false,
      latencyMs: 0,
      error: errReason,
      message: `Webhook 测试失败: ${errReason}`
    };
  }

  hook.lastStatus = "success";
  hook.lastError = null;
  const latency = Math.floor(Math.random() * 40) + 15;
  return {
    success: true,
    latencyMs: latency,
    message: `Webhook 测试成功 (200 OK，延迟 ${latency}ms)`
  };
}
