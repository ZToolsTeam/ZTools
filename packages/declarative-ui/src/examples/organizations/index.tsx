import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  Clipboard
} from "../../index.js";
import { useState, useEffect, useMemo } from "../../runtime/hooks.js";
import {
  OrganizationData,
  OrgMember,
  OrgWebhook,
  TeamSharedSnippet,
  TeamSharedQuicklink,
  PrivateExtensionItem,
  ComplianceAuditItem,
  WorkspaceMode,
  WorkspaceInfo
} from "./types.js";
import {
  INITIAL_ORGANIZATION,
  getOrganizationData,
  saveOrganizationData,
  generateInviteLink,
  addOrgMember,
  removeOrgMember,
  addOrgWebhook,
  removeOrgWebhook,
  testTriggerWebhook,
  getAvailableWorkspaces,
  switchWorkspace,
  addSharedQuicklink,
  removeSharedQuicklink,
  recordAuditLog,
  syncTeamAssets
} from "./organizations-storage.js";

export * from "./types.js";
export * from "./organizations-storage.js";

/**
 * M1.5-28: Raycast for Teams / Organizations 商业与团队协同工作台
 */
export default function OrganizationsCommand() {
  const [org, setOrg] = useState<OrganizationData>(INITIAL_ORGANIZATION);
  const [isLoading, setIsLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>("all");

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const loaded = await getOrganizationData();
        if (isMounted) {
          setOrg(loaded);
          setIsLoading(false);
        }
      } catch {
        if (isMounted) setIsLoading(false);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleCopyInvite = async () => {
    const link = generateInviteLink(org);
    await Clipboard.copy(link);
    await showToast(Toast.Style.Success, "邀请链接已复制", link);
  };

  const handleSwitchWorkspace = async (mode: WorkspaceMode) => {
    await showToast(Toast.Style.Animated, `正在切换工作区至: ${mode === "personal" ? "个人工作区" : "团队企业空间"}...`);
    const updated = await switchWorkspace(mode);
    setOrg({ ...updated });
    await showToast(Toast.Style.Success, `已进入 ${mode === "personal" ? "个人本地空间" : org.name}`);
  };

  const handleSyncAssets = async () => {
    await showToast(Toast.Style.Animated, "正在通过 E2EE 通道同步团队资产...");
    const res = await syncTeamAssets();
    await showToast(Toast.Style.Success, "同步完成", res.message);
  };

  const handleTestWebhook = async (wh: OrgWebhook) => {
    await showToast(Toast.Style.Animated, `正在测试触发 Webhook: ${wh.name}...`);
    const res = await testTriggerWebhook(wh);
    if (res.success) {
      await showToast(Toast.Style.Success, res.message);
    } else {
      await showToast(Toast.Style.Failure, res.message);
    }
  };

  const handleRemoveMember = async (mem: OrgMember) => {
    if (mem.role === "owner") {
      await showToast(Toast.Style.Failure, "无法移除组织所有者 (Owner 保护机制生效)");
      return;
    }
    const updated = await removeOrgMember(mem.id);
    setOrg({ ...updated });
    await showToast(Toast.Style.Success, `已移除成员: ${mem.name}`);
  };

  const workspaces: WorkspaceInfo[] = useMemo(() => {
    return getAvailableWorkspaces();
  }, [org.activeWorkspace]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchBarPlaceholder="搜索工作区、团队共享短语、快捷指令、私有插件与合规审计..."
      searchBarAccessory={
        <List.Dropdown tooltip="筛选视图" value={filterType} onChange={setFilterType}>
          <List.Dropdown.Item title="全景协同大盘 (Overview)" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="工作区切换器 (Workspaces)" value="workspaces" icon={Icon.AppWindow} />
          <List.Dropdown.Item title="团队共享指令 (Quicklinks)" value="quicklinks" icon={Icon.Link} />
          <List.Dropdown.Item title="团队共享短语 (Snippets)" value="snippets" icon={Icon.Document} />
          <List.Dropdown.Item title="企业私有扩展 (Extensions)" value="extensions" icon={Icon.Folder} />
          <List.Dropdown.Item title="合规审计与权限 (Compliance)" value="compliance" icon={Icon.Shield} />
          <List.Dropdown.Item title="团队架构成员 (Members)" value="members" icon={Icon.Star} />
          <List.Dropdown.Item title="Webhooks 审计通知" value="webhooks" icon={Icon.ExclamationMark} />
        </List.Dropdown>
      }
    >
      {/* 1. 工作区切换器 */}
      {(filterType === "all" || filterType === "workspaces") && (
        <List.Section title="工作区协同环境 (Workspaces)">
          {workspaces.map((ws) => (
            <List.Item
              key={ws.id}
              id={ws.id}
              title={ws.name}
              subtitle={ws.description}
              icon={ws.isActive ? Icon.Checkmark : Icon.AppWindow}
              accessories={[
                { text: ws.badge },
                { text: ws.isActive ? "当前活跃" : "点击切换" }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 🏢 ${ws.name}\n\n${ws.description}\n\n- **工作区模式**: \`${ws.mode}\`\n- **活跃状态**: ${ws.isActive ? "🟢 正在使用" : "⚪ 未激活"}\n- **协作成员**: ${ws.memberCount} 人\n- **端到端加密**: ${ws.isE2eeEncrypted ? "✅ Argon2id + AES-256-GCM 本地加密隔离" : "未加密"}\n\n> **说明**: 切换工作区后，命令面板与搜索结果将仅展示当前工作区授权的资产与私有插件。`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="工作区名称" text={ws.name} icon={Icon.AppWindow} />
                      <List.Item.Detail.Metadata.Label title="空间模式" text={ws.mode} icon={Icon.Key} />
                      <List.Item.Detail.Metadata.Label title="成员数量" text={`${ws.memberCount} 人`} icon={Icon.Shield} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="状态">
                        <List.Item.Detail.Metadata.TagList.Item
                          text={ws.isActive ? "活跃工作区" : "可切换"}
                          color={ws.isActive ? Color.Green : Color.SecondaryText}
                        />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  {!ws.isActive && (
                    <Action
                      title={`切换至「${ws.name}」`}
                      icon={Icon.Check}
                      onAction={() => handleSwitchWorkspace(ws.mode)}
                    />
                  )}
                  <Action
                    title="触发团队资产同步"
                    icon={Icon.Repeat}
                    onAction={handleSyncAssets}
                  />
                  <Action
                    title="复制团队邀请链接"
                    icon={Icon.Link}
                    onAction={handleCopyInvite}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 2. 团队组织信息概览 */}
      {filterType === "all" && (
        <List.Section title="组织信息概览 (Organization Overview)">
          <List.Item
            id="org_header"
            title={org.name}
            subtitle={org.description}
            icon={Icon.List}
            accessories={[{ text: `SLUG: ${org.slug}` }]}
            detail={
              <List.Item.Detail
                markdown={`### 🏢 ${org.name} (ZTools for Teams)\n\n${org.description || "无详细描述"}\n\n- **组织标识 (Slug)**: \`${org.slug}\`\n- **当前空间**: \`${org.activeWorkspace === "personal" ? "个人工作区" : "企业团队空间"}\`\n- **团队成员**: ${org.members.length} 人\n- **共享指令**: ${(org.sharedQuicklinks || []).length} 条\n- **共享短语**: ${(org.sharedSnippets || []).length} 条\n- **私有扩展**: ${(org.privateExtensions || []).length} 款\n- **生效 Webhooks**: ${(org.webhooks || []).filter((w) => w.active).length} 个\n\n> 团队私有扩展与短语全部采用端到端密文通道同步，杜绝企业核心数据上报。`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="复制团队加入邀请链接"
                  icon={Icon.Link}
                  onAction={handleCopyInvite}
                />
                <Action
                  title="同步团队共享资产"
                  icon={Icon.Repeat}
                  onAction={handleSyncAssets}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {/* 3. 团队共享快捷指令 */}
      {(filterType === "all" || filterType === "quicklinks") && (
        <List.Section title={`团队共享快捷指令 (${(org.sharedQuicklinks || []).length})`}>
          {(org.sharedQuicklinks || []).map((ql) => (
            <List.Item
              key={ql.id}
              id={ql.id}
              title={ql.name}
              subtitle={ql.url}
              icon={Icon.Link}
              accessories={[
                { text: `别名: ${ql.alias || "无"}` },
                { text: ql.category }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 🔗 ${ql.name}\n\n- **目标 URL**: \`${ql.url}\`\n- **快捷别名**: \`${ql.alias || "未配置"}\`\n- **分类**: \`${ql.category}\`\n- **维护者**: \`${ql.author}\`\n- **更新时间**: \`${ql.updatedAt}\`\n\n> 团队指令会自动同步至全员启动器，在搜索栏输入别名即可毫秒直达。`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="指令名称" text={ql.name} icon={Icon.Link} />
                      <List.Item.Detail.Metadata.Label title="别名" text={ql.alias || "无"} icon={Icon.Terminal} />
                      <List.Item.Detail.Metadata.Label title="作者" text={ql.author} icon={Icon.Shield} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.TagList title="分类">
                        <List.Item.Detail.Metadata.TagList.Item text={ql.category} color={Color.Blue} />
                      </List.Item.Detail.Metadata.TagList>
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action.OpenInBrowser url={ql.url} title="在浏览器中打开指令" />
                  <Action
                    title="复制目标链接"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      await Clipboard.copy(ql.url);
                      await showToast(Toast.Style.Success, `已复制链接: ${ql.url}`);
                    }}
                  />
                  {ql.alias && (
                    <Action
                      title="复制快捷别名"
                      icon={Icon.Terminal}
                      onAction={async () => {
                        await Clipboard.copy(ql.alias!);
                        await showToast(Toast.Style.Success, `已复制别名: ${ql.alias}`);
                      }}
                    />
                  )}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 4. 团队共享短语 */}
      {(filterType === "all" || filterType === "snippets") && (
        <List.Section title={`团队共享快捷短语 (${(org.sharedSnippets || []).length})`}>
          {(org.sharedSnippets || []).map((snip) => (
            <List.Item
              key={snip.id}
              id={snip.id}
              title={snip.name}
              subtitle={`触发词: :${snip.keyword}`}
              icon={Icon.Document}
              accessories={[{ text: `作者: ${snip.author}` }]}
              detail={
                <List.Item.Detail
                  markdown={`### 📝 ${snip.name}\n\n**触发词**: \`:${snip.keyword}\`\n\n\`\`\`\n${snip.content}\n\`\`\`\n\n- **作者**: \`${snip.author}\`\n- **标签**: \`${(snip.tags || []).join(", ") || "无"}\`\n- **更新时间**: \`${snip.updatedAt}\``}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="复制短语内容"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      await Clipboard.copy(snip.content);
                      await showToast(Toast.Style.Success, `短语「${snip.name}」已复制`);
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 5. 团队私有扩展目录 */}
      {(filterType === "all" || filterType === "extensions") && (
        <List.Section title={`企业私有扩展目录 (${(org.privateExtensions || []).length})`}>
          {(org.privateExtensions || []).map((ext) => (
            <List.Item
              key={ext.id}
              id={ext.id}
              title={ext.name}
              subtitle={ext.description}
              icon={Icon.Folder}
              accessories={[
                { text: ext.installed ? "已部署" : "未部署" },
                { text: `v${ext.version}` }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 📦 ${ext.name} (v${ext.version})\n\n${ext.description}\n\n- **内部插件标识**: \`${ext.id}\`\n- **维护作者**: \`${ext.author}\`\n- **申请权限**: \`${(ext.permissions || ["basic"]).join(", ")}\`\n- **安全状态**: ${ext.securityAuditPassed ? "✅ 组织 CI AST 预检通过，具备内部专属签名" : "待审计"}\n\n> 私有扩展仅向组织内成员分发，支持 GitOps 内部流水线自动化部署。`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title={ext.installed ? "已安装到本地工作区" : "一键部署此私有扩展"}
                    icon={Icon.Check}
                    onAction={async () => {
                      ext.installed = !ext.installed;
                      await saveOrganizationData({ ...org });
                      await showToast(
                        Toast.Style.Success,
                        ext.installed ? `私有扩展「${ext.name}」已部署就绪` : `已卸载「${ext.name}」`
                      );
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 6. 组织级合规审计与权限管控卡片 */}
      {(filterType === "all" || filterType === "compliance") && (
        <List.Section title={`组织级合规审计与策略 (${(org.complianceAuditLogs || []).length})`}>
          {(org.complianceAuditLogs || []).map((aud) => (
            <List.Item
              key={aud.id}
              id={aud.id}
              title={aud.action}
              subtitle={`${aud.actor} • ${aud.resource}`}
              icon={aud.status === "allowed" ? Icon.Shield : Icon.ExclamationMark}
              accessories={[
                { text: aud.status.toUpperCase() },
                { text: aud.timestamp.slice(11, 16) }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 🛡️ 审计事件: ${aud.action}\n\n- **状态**: \`${aud.status.toUpperCase()}\` (${aud.status === "allowed" ? "通过" : "拦截"})\n- **操作主体 (Actor)**: \`${aud.actor}\`\n- **受控资源 (Resource)**: \`${aud.resource}\`\n- **发生时间**: \`${aud.timestamp}\`\n- **来源 IP**: \`${aud.ipAddress}\`\n\n#### 审计详情记录\n\`\`\`\n${aud.details}\n\`\`\`\n\n> **企业安全策略**: 严禁向外部公有云泄露代码，私有扩展强制 AST 安全扫描，E2EE 密文校验和审计留存 180 天。`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="复制审计详情"
                    icon={Icon.Clipboard}
                    onAction={async () => {
                      await Clipboard.copy(JSON.stringify(aud, null, 2));
                      await showToast(Toast.Style.Success, "审计日志详情已复制");
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 7. 团队成员架构 */}
      {(filterType === "all" || filterType === "members") && (
        <List.Section title={`团队成员架构 (${org.members.length})`}>
          {org.members.map((mem) => (
            <List.Item
              key={mem.id}
              id={mem.id}
              title={mem.name}
              subtitle={mem.email}
              icon={mem.role === "owner" ? Icon.Star : Icon.Shield}
              accessories={[{ text: mem.role.toUpperCase() }]}
              detail={
                <List.Item.Detail
                  markdown={`### 👤 ${mem.name}\n\n- **邮箱**: \`${mem.email}\`\n- **组织角色**: \`${mem.role.toUpperCase()}\`\n- **加入时间**: \`${mem.joinedAt}\`\n\n> **权限管控**: ${mem.role === "owner" ? "组织所有者 (具备 Owner 安全保护)" : mem.role === "admin" ? "组织管理员 (具备扩展审核与成员管理权)" : "研发协作者"}`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="复制团队加入邀请链接"
                    icon={Icon.Link}
                    onAction={handleCopyInvite}
                  />
                  {mem.role !== "owner" && (
                    <Action
                      title="移除成员"
                      icon={Icon.Trash}
                      onAction={() => handleRemoveMember(mem)}
                    />
                  )}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {/* 8. Webhooks 审计与自动化 */}
      {(filterType === "all" || filterType === "webhooks") && (
        <List.Section title={`Webhooks 审计通知 (${(org.webhooks || []).length})`}>
          {(org.webhooks || []).map((wh) => (
            <List.Item
              key={wh.id}
              id={wh.id}
              title={wh.name}
              subtitle={wh.url}
              icon={wh.active ? Icon.ExclamationMark : Icon.Circle}
              accessories={[{ text: wh.active ? "活跃" : "已暂停" }]}
              detail={
                <List.Item.Detail
                  markdown={`### 🔔 ${wh.name}\n\n- **目标 Webhook URL**: \`${wh.url}\`\n- **监听事件**: \`${(wh.eventTypes || []).join(", ")}\`\n- **创建日期**: \`${wh.createdAt}\`\n- **最后触发状态**: \`${wh.lastStatus || "未触发"}\`${wh.lastError ? `\n- **异常原因**: \`${wh.lastError}\`` : ""}\n\n> 支持发送钉钉、飞书、企业微信群机器人或标准 HTTP JSON Webhook。`}
                />
              }
              actions={
                <ActionPanel>
                  <Action
                    title="测试触发 Webhook (Test Ping)"
                    icon={Icon.Play}
                    onAction={() => handleTestWebhook(wh)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
