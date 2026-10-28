import { isRealElectronHost } from '../shared/native-ipc.js';
import React from "../../index.js";
import {
  List,
  Detail,
  Form,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  GithubDashboardItem,
  GithubPrItem,
  GithubIssueItem,
  GithubNotificationItem,
  GithubWorkflowRunItem,
  GithubStarredRepoItem,
  GithubTokenConfig
} from "./types.js";
import {
  SAMPLE_GITHUB_ITEMS,
  filterGithubItems,
  getGithubToken,
  setGithubToken,
  clearGithubToken,
  isGithubTokenConfigured
} from "./data.js";

export * from "./types.js";
export * from "./data.js";

/**
 * GitHub Personal Access Token / BYOK 配置表单
 */
export function GithubTokenForm({ onSaved }: { onSaved?: () => void }) {
  const { pop } = useNavigation();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("octocat");

  useEffect(() => {
    getGithubToken().then((cfg) => {
      if (cfg) {
        setToken(cfg.token);
        if (cfg.username) setUsername(cfg.username);
      }
    });
  }, []);

  const handleSubmit = async (values: { token?: string; username?: string }) => {
    const pat = values.token || token;
    const user = values.username || username;
    if (!pat || !pat.trim()) {
      await showToast(Toast.Style.Failure, "请输入有效的 Personal Access Token");
      return;
    }
    await setGithubToken(pat, user);
    await showToast(Toast.Style.Success, `GitHub 凭据已保存 (授权用户: @${user})`);
    onSaved?.();
    pop();
  };

  return (
    <Form
      navigationTitle="配置 GitHub Personal Access Token (BYOK)"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存凭据并生效" onSubmit={handleSubmit} icon={Icon.Check} />
          <Action
            title="清除已保存凭据"
            icon={Icon.Trash}
            onAction={async () => {
              await clearGithubToken();
              await showToast(Toast.Style.Success, "GitHub Token 已清除");
              onSaved?.();
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="username"
        title="GitHub 用户名"
        placeholder="例如: octocat"
        value={username}
        onChange={(v: string) => setUsername(v)}
      />
      <Form.TextField
        id="token"
        title="Personal Access Token"
        placeholder="ghp_xxxx 或 github_pat_xxxx"
        value={token}
        onChange={(v: string) => setToken(v)}
      />
    </Form>
  );
}

/**
 * GitHub 详情视图 (现代纯正 TSX 模式)
 */
export function GithubDetailView({
  item,
  onUpdate
}: {
  item: GithubDashboardItem;
  onUpdate?: (updated: GithubDashboardItem) => void;
}) {
  if (item.type === "pr") {
    const markdown = `
# [#${item.number}] ${item.title}

> **仓库**: \`${item.repo}\` | **作者**: \`@${item.author}\` | **分支**: \`${item.branch}\` ➔ \`${item.targetBranch}\`

### 说明
${item.body}

---
- **变更统计**: +${item.additions} / -${item.deletions}
- **评审状态**: \`${item.reviewStatus || "PENDING"}\`
- **评论数**: ${item.commentsCount}
- **更新时间**: ${item.updatedAt}
    `;

    return (
      <Detail
        markdown={markdown}
        navigationTitle={`PR #${item.number}`}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="仓库" text={item.repo} icon={Icon.Document} />
            <Detail.Metadata.Label title="作者" text={`@${item.author}`} icon={Icon.Pencil} />
            <Detail.Metadata.Label title="源分支" text={item.branch} icon={Icon.Code} />
            <Detail.Metadata.Label title="目标分支" text={item.targetBranch} icon={Icon.ArrowRight} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="状态">
              <Detail.Metadata.TagList.Item
                text={item.status.toUpperCase()}
                color={
                  item.status === "open"
                    ? Color.Green
                    : item.status === "merged"
                    ? Color.Purple
                    : item.status === "draft"
                    ? Color.SecondaryText
                    : Color.Red
                }
              />
              {item.reviewStatus && (
                <Detail.Metadata.TagList.Item
                  text={item.reviewStatus}
                  color={
                    item.reviewStatus === "APPROVED"
                      ? Color.Green
                      : item.reviewStatus === "CHANGES_REQUESTED"
                      ? Color.Red
                      : Color.Yellow
                  }
                />
              )}
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        }
        actions={
          <ActionPanel title="PR 操作">
            <Action.OpenInBrowser title="在浏览器打开 PR" url={item.url} icon={Icon.Globe} />
            <Action.CopyToClipboard title="复制 PR 链接" content={item.url} icon={Icon.Link} />
            <Action.CopyToClipboard
              title="复制分支检出命令"
              content={`git fetch origin ${item.branch} && git checkout ${item.branch}`}
              icon={Icon.Terminal}
            />
            <Action.CopyToClipboard
              title="复制源分支名称"
              content={item.branch}
              icon={Icon.Code}
            />
            <Action
              title="批准此 PR (Approve)"
              icon={Icon.Checkmark}
              onAction={async () => {
                const updated: GithubPrItem = { ...item, reviewStatus: "APPROVED" };
                onUpdate?.(updated);
                await showToast(Toast.Style.Success, `PR #${item.number} 已批准 (Approved)`);
              }}
            />
            <Action
              title="合并此 PR (Merge)"
              icon={Icon.Check}
              onAction={async () => {
                const updated: GithubPrItem = { ...item, status: "merged" };
                onUpdate?.(updated);
                await showToast(Toast.Style.Success, `PR #${item.number} 已成功合并 (Merged)`);
              }}
            />
          </ActionPanel>
        }
      />
    );
  }

  if (item.type === "issue") {
    const markdown = `
# [#${item.number}] ${item.title}

> **仓库**: \`${item.repo}\` | **提问者**: \`@${item.author}\`

### 问题内容
${item.body}

---
- **标签**: ${item.labels.map((l) => `\`${l}\``).join(" ")}
- **评论数**: ${item.commentsCount}
- **最后更新**: ${item.updatedAt}
    `;

    return (
      <Detail
        markdown={markdown}
        navigationTitle={`Issue #${item.number}`}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="仓库" text={item.repo} icon={Icon.Document} />
            <Detail.Metadata.Label title="提问者" text={`@${item.author}`} icon={Icon.Pencil} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="状态">
              <Detail.Metadata.TagList.Item
                text={item.status === "open" ? "OPEN" : "CLOSED"}
                color={item.status === "open" ? Color.Green : Color.SecondaryText}
              />
            </Detail.Metadata.TagList>
            <Detail.Metadata.TagList title="标签">
              {item.labels.map((l) => (
                <Detail.Metadata.TagList.Item key={l} text={l} color={Color.Blue} />
              ))}
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        }
        actions={
          <ActionPanel title="Issue 操作">
            <Action.OpenInBrowser title="在浏览器打开 Issue" url={item.url} icon={Icon.Globe} />
            <Action.CopyToClipboard title="复制 Issue 链接" content={item.url} icon={Icon.Link} />
            <Action.CopyToClipboard
              title="复制 Issue 编号与标题"
              content={`#${item.number} ${item.title}`}
              icon={Icon.CopyClipboard}
            />
            <Action
              title={item.status === "open" ? "关闭此 Issue" : "重新开启此 Issue"}
              icon={item.status === "open" ? Icon.XMarkCircle : Icon.Checkmark}
              onAction={async () => {
                const nextStatus = item.status === "open" ? "closed" : "open";
                const updated: GithubIssueItem = { ...item, status: nextStatus };
                onUpdate?.(updated);
                await showToast(
                  Toast.Style.Success,
                  `Issue #${item.number} 已${nextStatus === "open" ? "开启" : "关闭"}`
                );
              }}
            />
          </ActionPanel>
        }
      />
    );
  }

  if (item.type === "notification") {
    const markdown = `
# ${item.title}

> **仓库**: \`${item.repo}\` | **原因**: \`${item.reason}\`

### 通知详情
- **关联类型**: \`${item.itemType.toUpperCase()}\`
- **读取状态**: \`${item.unread ? "未读 (Unread)" : "已读 (Read)"}\`
- **更新时间**: \`${item.updatedAt}\`
    `;

    return (
      <Detail
        markdown={markdown}
        navigationTitle="通知详情"
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="仓库" text={item.repo} icon={Icon.Document} />
            <Detail.Metadata.Label title="通知原因" text={item.reason} icon={Icon.Bell} />
            <Detail.Metadata.Label title="更新时间" text={item.updatedAt} icon={Icon.Clock} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="状态">
              <Detail.Metadata.TagList.Item
                text={item.unread ? "UNREAD" : "READ"}
                color={item.unread ? Color.Blue : Color.SecondaryText}
              />
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        }
        actions={
          <ActionPanel title="通知操作">
            <Action.OpenInBrowser title="在浏览器打开关联页面" url={item.url} icon={Icon.Globe} />
            <Action.CopyToClipboard title="复制通知链接" content={item.url} icon={Icon.Link} />
            <Action
              title="标为已读"
              icon={Icon.Check}
              onAction={async () => {
                const updated: GithubNotificationItem = { ...item, unread: false };
                onUpdate?.(updated);
                await showToast(Toast.Style.Success, "通知已标为已读");
              }}
            />
          </ActionPanel>
        }
      />
    );
  }

  if (item.type === "workflow") {
    const markdown = `
# ${item.name}

> **仓库**: \`${item.repo}\` | **分支**: \`${item.branch}\` | **提交**: \`${item.commitHash}\`

### 运行状态
- **触发事件**: \`${item.event}\`
- **执行时长**: \`${item.duration}\`
- **运行时间**: \`${item.runAt}\`
- **构建结果**: \`${item.status.toUpperCase()}\`
    `;

    return (
      <Detail
        markdown={markdown}
        navigationTitle={item.name}
        metadata={
          <Detail.Metadata>
            <Detail.Metadata.Label title="仓库" text={item.repo} icon={Icon.Document} />
            <Detail.Metadata.Label title="分支" text={item.branch} icon={Icon.Code} />
            <Detail.Metadata.Label title="Commit" text={item.commitHash} icon={Icon.Pin} />
            <Detail.Metadata.Label title="耗时" text={item.duration} icon={Icon.Clock} />
            <Detail.Metadata.Separator />
            <Detail.Metadata.TagList title="结果">
              <Detail.Metadata.TagList.Item
                text={item.status.toUpperCase()}
                color={
                  item.status === "success"
                    ? Color.Green
                    : item.status === "in_progress"
                    ? Color.Yellow
                    : Color.Red
                }
              />
            </Detail.Metadata.TagList>
          </Detail.Metadata>
        }
        actions={
          <ActionPanel title="Workflow 操作">
            <Action.OpenInBrowser title="在浏览器打开 CI 详情" url={item.url} icon={Icon.Globe} />
            <Action.CopyToClipboard title="复制 Workflow 链接" content={item.url} icon={Icon.Link} />
            <Action
              title="重新运行 CI 流水线 (Re-run)"
              icon={Icon.Repeat}
              onAction={async () => {
                const updated: GithubWorkflowRunItem = {
                  ...item,
                  status: "in_progress",
                  runAt: "刚刚"
                };
                onUpdate?.(updated);
                await showToast(Toast.Style.Success, "Workflow CI 已重新触发运行 (Re-run triggered)");
              }}
            />
          </ActionPanel>
        }
      />
    );
  }


  // Starred Repo
  const repo = item as GithubStarredRepoItem;
  const markdown = `
# ${repo.owner}/${repo.name}

> ${repo.description}

### 仓库指标
- **主要语言**: \`${repo.primaryLanguage}\`
- **Stars**: \`${repo.stars.toLocaleString()}\`
- **Forks**: \`${repo.forks.toLocaleString()}\`
- **最近活跃**: \`${repo.updatedAt}\`
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle={`${repo.owner}/${repo.name}`}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="所有者" text={repo.owner} icon={Icon.Pencil} />
          <Detail.Metadata.Label title="主要语言" text={repo.primaryLanguage} icon={Icon.Code} />
          <Detail.Metadata.Label title="Stars" text={String(repo.stars)} icon={Icon.Star} />
          <Detail.Metadata.Label title="Forks" text={String(repo.forks)} icon={Icon.Repeat} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="仓库操作">
          <Action.OpenInBrowser title="在浏览器打开仓库" url={repo.url} icon={Icon.Globe} />
          <Action.CopyToClipboard title="复制仓库链接" content={repo.url} icon={Icon.Link} />
          <Action.CopyToClipboard
            title="复制克隆命令"
            content={`git clone ${repo.url}.git`}
            icon={Icon.Terminal}
          />
        </ActionPanel>
      }
    />
  );
}

/**
 * GitHub 仪表盘主命令 (现代纯正 TSX 模式)
 */
export default function GithubDashboardCommand() {
  const [items, setItems] = useState<GithubDashboardItem[]>(isRealElectronHost() ? [] : SAMPLE_GITHUB_ITEMS);
  const [category, setCategory] = useState<string>("all");
  const [subFilter, setSubFilter] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [tokenConfig, setTokenConfig] = useState<GithubTokenConfig | null>(null);
  const { push } = useNavigation();

  useEffect(() => {
    getGithubToken().then((cfg) => setTokenConfig(cfg));
  }, []);

  const handleItemUpdate = (updated: GithubDashboardItem) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
  };

  const handleRefresh = async () => {
    const cfg = await getGithubToken();
    setTokenConfig(cfg);
    await showToast(Toast.Style.Success, "GitHub 数据与凭据状态已刷新");
  };

  const filtered = filterGithubItems(items, searchText, category, subFilter);

  const prs = filtered.filter((i) => i.type === "pr") as GithubPrItem[];
  const issues = filtered.filter((i) => i.type === "issue") as GithubIssueItem[];
  const notifications = filtered.filter((i) => i.type === "notification") as GithubNotificationItem[];
  const workflows = filtered.filter((i) => i.type === "workflow") as GithubWorkflowRunItem[];
  const repos = filtered.filter((i) => i.type === "repo") as GithubStarredRepoItem[];

  const unreadNotifsCount = items.filter((i) => i.type === "notification" && (i as GithubNotificationItem).unread).length;

  return (
    <List
      navigationTitle="GitHub 仪表盘"
      searchBarPlaceholder="搜索 Pull Requests、Issues、通知、Workflows、Starred..."
      searchText={searchText}
      onSearchTextChange={(val) => setSearchText(val)}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选类别"
          value={category}
          onChange={(newVal) => {
            setCategory(newVal);
            setSubFilter("all");
          }}
        >
          <List.Dropdown.Item title="全部动态" value="all" />
          <List.Dropdown.Item title="Pull Requests (拉取请求)" value="pr" />
          <List.Dropdown.Item title="Issues (问题追踪)" value="issue" />
          <List.Dropdown.Item
            title={unreadNotifsCount > 0 ? `Notifications (${unreadNotifsCount} 条未读)` : "Notifications (通知)"}
            value="notification"
          />
          <List.Dropdown.Item title="Workflow Runs (CI 流水线)" value="workflow" />
          <List.Dropdown.Item title="Starred Repos (标星项目)" value="repo" />
        </List.Dropdown>
      }
      actions={
        <ActionPanel title="全局操作">
          <Action title="刷新数据" icon={Icon.Repeat} onAction={handleRefresh} />
          <Action.Push
            title="配置 Personal Access Token (BYOK)"
            icon={Icon.Key}
            target={() => <GithubTokenForm onSaved={handleRefresh} />}
          />
          {unreadNotifsCount > 0 && (
            <Action
              title="全部通知标为已读"
              icon={Icon.Check}
              onAction={async () => {
                setItems((prev) =>
                  prev.map((it) => (it.type === "notification" ? { ...it, unread: false } : it))
                );
                await showToast(Toast.Style.Success, "所有通知已全部标为已读");
              }}
            />
          )}
        </ActionPanel>
      }
    >
      {prs.length > 0 && (
        <List.Section title={`Pull Requests (${prs.length})`}>
          {prs.map((pr) => (
            <List.Item
              key={pr.id}
              id={pr.id}
              title={`#${pr.number} ${pr.title}`}
              subtitle={`${pr.repo} (${pr.branch})`}
              icon={
                pr.status === "open"
                  ? Icon.Checkmark
                  : pr.status === "merged"
                  ? Icon.Check
                  : pr.status === "draft"
                  ? Icon.Document
                  : Icon.XMarkCircle
              }
              accessories={[
                { text: `@${pr.author}` },
                {
                  text: pr.reviewStatus ? `${pr.status.toUpperCase()} [${pr.reviewStatus}]` : pr.status.toUpperCase(),
                  tag: pr.status
                },
                { text: pr.updatedAt }
              ]}
              actions={
                <ActionPanel title={pr.title}>
                  <Action.Push
                    title="查看 PR 详情"
                    icon={Icon.Eye}
                    target={() => <GithubDetailView item={pr} onUpdate={handleItemUpdate} />}
                  />
                  <Action.OpenInBrowser
                    title="在浏览器中打开"
                    url={pr.url}
                    icon={Icon.Globe}
                  />
                  <Action.CopyToClipboard
                    title="复制 PR URL"
                    content={pr.url}
                    icon={Icon.Link}
                  />
                  <Action.CopyToClipboard
                    title="复制分支名称"
                    content={pr.branch}
                    icon={Icon.Code}
                  />
                  <Action.CopyToClipboard
                    title="复制检出命令"
                    content={`git checkout ${pr.branch}`}
                    icon={Icon.Terminal}
                  />
                  <Action
                    title="批准此 PR (Approve)"
                    icon={Icon.Checkmark}
                    onAction={async () => {
                      handleItemUpdate({ ...pr, reviewStatus: "APPROVED" });
                      await showToast(Toast.Style.Success, `PR #${pr.number} 已批准 (Approved)`);
                    }}
                  />
                  <Action
                    title="合并此 PR (Merge)"
                    icon={Icon.Check}
                    onAction={async () => {
                      handleItemUpdate({ ...pr, status: "merged" });
                      await showToast(Toast.Style.Success, `PR #${pr.number} 已成功合并 (Merged)`);
                    }}
                  />
                  <Action.Push
                    title="配置 Personal Access Token"
                    icon={Icon.Key}
                    target={() => <GithubTokenForm onSaved={handleRefresh} />}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {issues.length > 0 && (
        <List.Section title={`Issues (${issues.length})`}>
          {issues.map((issue) => (
            <List.Item
              key={issue.id}
              id={issue.id}
              title={`#${issue.number} ${issue.title}`}
              subtitle={issue.repo}
              icon={issue.status === "open" ? Icon.ExclamationMark : Icon.Checkmark}
              accessories={[
                { text: `@${issue.author}` },
                { text: `${issue.commentsCount} 条回复` },
                { text: issue.updatedAt }
              ]}
              actions={
                <ActionPanel title={issue.title}>
                  <Action.Push
                    title="查看 Issue 详情"
                    icon={Icon.Eye}
                    target={() => <GithubDetailView item={issue} onUpdate={handleItemUpdate} />}
                  />
                  <Action.OpenInBrowser
                    title="在浏览器中打开"
                    url={issue.url}
                    icon={Icon.Globe}
                  />
                  <Action.CopyToClipboard
                    title="复制 Issue 链接"
                    content={issue.url}
                    icon={Icon.Link}
                  />
                  <Action
                    title={issue.status === "open" ? "关闭此 Issue" : "重新开启此 Issue"}
                    icon={Icon.Checkmark}
                    onAction={async () => {
                      const next = issue.status === "open" ? "closed" : "open";
                      handleItemUpdate({ ...issue, status: next });
                      await showToast(Toast.Style.Success, `Issue #${issue.number} 已${next === "open" ? "开启" : "关闭"}`);
                    }}
                  />
                  <Action.Push
                    title="配置 Personal Access Token"
                    icon={Icon.Key}
                    target={() => <GithubTokenForm onSaved={handleRefresh} />}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {notifications.length > 0 && (
        <List.Section title={`Notifications (${notifications.length})`}>
          {notifications.map((notif) => (
            <List.Item
              key={notif.id}
              id={notif.id}
              title={notif.title}
              subtitle={`${notif.repo} · ${notif.reason}`}
              icon={notif.unread ? Icon.Bell : Icon.Check}
              accessories={[
                { text: notif.itemType.toUpperCase() },
                { text: notif.unread ? "未读" : "已读", tag: notif.unread ? "unread" : "read" },
                { text: notif.updatedAt }
              ]}
              actions={
                <ActionPanel title={notif.title}>
                  <Action.Push
                    title="查看通知详情"
                    icon={Icon.Eye}
                    target={() => <GithubDetailView item={notif} onUpdate={handleItemUpdate} />}
                  />
                  <Action.OpenInBrowser
                    title="在浏览器中打开"
                    url={notif.url}
                    icon={Icon.Globe}
                  />
                  {notif.unread && (
                    <Action
                      title="标为已读"
                      icon={Icon.Check}
                      onAction={async () => {
                        handleItemUpdate({ ...notif, unread: false });
                        await showToast(Toast.Style.Success, "该通知已标为已读");
                      }}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="复制通知链接"
                    content={notif.url}
                    icon={Icon.Link}
                  />
                  <Action.Push
                    title="配置 Personal Access Token"
                    icon={Icon.Key}
                    target={() => <GithubTokenForm onSaved={handleRefresh} />}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {workflows.length > 0 && (
        <List.Section title={`Workflow Runs (${workflows.length})`}>
          {workflows.map((wf) => (
            <List.Item
              key={wf.id}
              id={wf.id}
              title={wf.name}
              subtitle={`${wf.repo} (${wf.branch} @ ${wf.commitHash})`}
              icon={
                wf.status === "success"
                  ? Icon.Check
                  : wf.status === "in_progress"
                  ? Icon.Clock
                  : Icon.XMarkCircle
              }
              accessories={[
                { text: wf.status.toUpperCase() },
                { text: wf.duration },
                { text: wf.runAt }
              ]}
              actions={
                <ActionPanel title={wf.name}>
                  <Action.Push
                    title="查看运行详情"
                    icon={Icon.Eye}
                    target={() => <GithubDetailView item={wf} onUpdate={handleItemUpdate} />}
                  />
                  <Action.OpenInBrowser
                    title="在浏览器中打开"
                    url={wf.url}
                    icon={Icon.Globe}
                  />
                  <Action.CopyToClipboard
                    title="复制运行链接"
                    content={wf.url}
                    icon={Icon.Link}
                  />
                  <Action
                    title="重新运行 CI 流水线 (Re-run)"
                    icon={Icon.Repeat}
                    onAction={async () => {
                      handleItemUpdate({ ...wf, status: "in_progress", runAt: "刚刚" });
                      await showToast(Toast.Style.Success, "Workflow CI 已重新触发运行 (Re-run triggered)");
                    }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {repos.length > 0 && (
        <List.Section title={`Starred Repositories (${repos.length})`}>
          {repos.map((repo) => (
            <List.Item
              key={repo.id}
              id={repo.id}
              title={`${repo.owner}/${repo.name}`}
              subtitle={repo.description}
              icon={Icon.Star}
              accessories={[
                { text: repo.primaryLanguage },
                { text: `★ ${repo.stars.toLocaleString()}` }
              ]}
              actions={
                <ActionPanel title={repo.name}>
                  <Action.Push
                    title="查看仓库详情"
                    icon={Icon.Eye}
                    target={() => <GithubDetailView item={repo} />}
                  />
                  <Action.OpenInBrowser
                    title="在浏览器中打开"
                    url={repo.url}
                    icon={Icon.Globe}
                  />
                  <Action.CopyToClipboard
                    title="复制仓库链接"
                    content={repo.url}
                    icon={Icon.Link}
                  />
                  <Action.CopyToClipboard
                    title="复制 Clone 命令"
                    content={`git clone ${repo.url}.git`}
                    icon={Icon.Terminal}
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
