import { LocalStorage } from "../../api/storage.js";
import {
  GithubDashboardItem,
  GithubPrItem,
  GithubIssueItem,
  GithubNotificationItem,
  GithubWorkflowRunItem,
  GithubStarredRepoItem,
  GithubTokenConfig
} from "./types.js";

export const STORAGE_KEY_GITHUB_TOKEN = "github_personal_access_token";

export const SAMPLE_GITHUB_ITEMS: GithubDashboardItem[] = [
  {
    type: "pr",
    id: "pr-1",
    number: 142,
    title: "feat(renderer): Support declarative virtual view reconciliation",
    repo: "ztools/declarative-core",
    author: "octocat",
    branch: "feat/virtual-reconciler",
    targetBranch: "main",
    status: "open",
    prCategory: "created",
    reviewStatus: "REVIEW_REQUIRED",
    additions: 450,
    deletions: 32,
    commentsCount: 6,
    url: "https://github.com/ztools/declarative-core/pull/142",
    updatedAt: "10 分钟前",
    body: "实现了声明式 Virtual View Descriptors 的 diff 与 reconciliation 机制，全面解耦 React DOM 依赖并接入 Fluent 渲染管线。"
  },
  {
    type: "pr",
    id: "pr-2",
    number: 139,
    title: "fix(storage): Resolve LocalStorage async race condition during batch write",
    repo: "ztools/declarative-core",
    author: "torvalds",
    branch: "fix/storage-race",
    targetBranch: "main",
    status: "merged",
    prCategory: "assigned",
    reviewStatus: "APPROVED",
    additions: 88,
    deletions: 14,
    commentsCount: 3,
    url: "https://github.com/ztools/declarative-core/pull/139",
    updatedAt: "2 小时前",
    body: "修正批量持久化过程中的微任务队列竞争，增加互斥锁保障写入事务原子性。"
  },
  {
    type: "pr",
    id: "pr-3",
    number: 145,
    title: "refactor(native): Decouple Rust sidecar IPC pipeline & streaming response",
    repo: "ztools/core-engine",
    author: "antigravity-dev",
    branch: "refactor/sidecar-ipc",
    targetBranch: "main",
    status: "open",
    prCategory: "review_requests",
    reviewStatus: "REVIEW_REQUIRED",
    additions: 240,
    deletions: 80,
    commentsCount: 4,
    url: "https://github.com/ztools/core-engine/pull/145",
    updatedAt: "25 分钟前",
    body: "优化 Rust 子进程管道通信协议，支持流式增量回传与内存占用下沉。"
  },
  {
    type: "pr",
    id: "pr-4",
    number: 148,
    title: "docs(api): Add declarative component specifications",
    repo: "ztools/sdk",
    author: "alice",
    branch: "docs/declarative-core",
    targetBranch: "main",
    status: "draft",
    prCategory: "mentioned",
    reviewStatus: "CHANGES_REQUESTED",
    additions: 120,
    deletions: 5,
    commentsCount: 2,
    url: "https://github.com/ztools/sdk/pull/148",
    updatedAt: "1 小时前",
    body: "完善声明式扩展生态白皮书，涵盖 ActionPanel、Detail、Form 与 List 组件生命周期。"
  },
  {
    type: "issue",
    id: "issue-1",
    number: 88,
    title: "bug: High CPU usage in background file watcher under Windows 11",
    repo: "ztools/core-engine",
    author: "dev-lead",
    labels: ["bug", "windows", "performance"],
    status: "open",
    issueCategory: "assigned",
    commentsCount: 12,
    url: "https://github.com/ztools/core-engine/issues/88",
    updatedAt: "35 分钟前",
    body: "在 Windows 11 23H2 环境下，递归监听大目录可能产生轮询占用过高，需要切换为 ReadDirectoryChangesW 批量事件合并。"
  },
  {
    type: "issue",
    id: "issue-2",
    number: 76,
    title: "feat: Request Obsidian & Declarative extensions parity test harness",
    repo: "ztools/sdk",
    author: "extension-dev",
    labels: ["enhancement", "testing"],
    status: "closed",
    issueCategory: "created",
    commentsCount: 4,
    url: "https://github.com/ztools/sdk/issues/76",
    updatedAt: "1 天前",
    body: "希望官方提供端到端迁移套件，验证声明式组件体系渲染与系统原生输出 100% 契合。"
  },
  {
    type: "issue",
    id: "issue-3",
    number: 95,
    title: "feat: BYOK personal access token persistence in LocalStorage",
    repo: "ztools/plugins",
    author: "octocat",
    labels: ["security", "auth", "byok"],
    status: "open",
    issueCategory: "created",
    commentsCount: 5,
    url: "https://github.com/ztools/plugins/issues/95",
    updatedAt: "15 分钟前",
    body: "支持用户直接在设置面板中填入 GitHub Personal Access Token (PAT)，实现无感鉴权与私有库直连。"
  },
  {
    type: "notification",
    id: "notif-1",
    title: "Review requested on PR #145: Decouple Rust sidecar IPC pipeline",
    repo: "ztools/core-engine",
    reason: "review_requested",
    unread: true,
    updatedAt: "25 分钟前",
    url: "https://github.com/ztools/core-engine/pull/145",
    itemType: "pr"
  },
  {
    type: "notification",
    id: "notif-2",
    title: "Mentioned in issue #88: High CPU usage in background file watcher",
    repo: "ztools/core-engine",
    reason: "mention",
    unread: true,
    updatedAt: "35 分钟前",
    url: "https://github.com/ztools/core-engine/issues/88",
    itemType: "issue"
  },
  {
    type: "notification",
    id: "notif-3",
    title: "Subscribed: CI / Build & Test passed on main",
    repo: "ztools/declarative-core",
    reason: "subscribed",
    unread: false,
    updatedAt: "1 小时前",
    url: "https://github.com/ztools/declarative-core/actions/runs/1089201",
    itemType: "workflow"
  },
  {
    type: "workflow",
    id: "wf-1",
    name: "CI / Build & Test - Win32 x64 & macOS",
    repo: "ztools/declarative-core",
    branch: "main",
    commitHash: "7b4e82f",
    status: "success",
    duration: "2m 14s",
    url: "https://github.com/ztools/declarative-core/actions/runs/1089201",
    event: "push",
    runAt: "15 分钟前"
  },
  {
    type: "workflow",
    id: "wf-2",
    name: "Release / Package & Sign Universal Artifacts",
    repo: "ztools/declarative-core",
    branch: "v1.0.0",
    commitHash: "9a01c3d",
    status: "in_progress",
    duration: "1m 02s",
    url: "https://github.com/ztools/declarative-core/actions/runs/1089345",
    event: "release",
    runAt: "2 分钟前"
  },
  {
    type: "repo",
    id: "repo-1",
    name: "vscode",
    owner: "microsoft",
    description: "Visual Studio Code - Code Editing. Redefined.",
    stars: 165000,
    forks: 34000,
    primaryLanguage: "TypeScript",
    url: "https://github.com/microsoft/vscode",
    updatedAt: "今日"
  },
  {
    type: "repo",
    id: "repo-2",
    name: "react",
    owner: "facebook",
    description: "The library for web and native user interfaces.",
    stars: 230000,
    forks: 46000,
    primaryLanguage: "JavaScript",
    url: "https://github.com/facebook/react",
    updatedAt: "今日"
  }
];

export async function getGithubToken(): Promise<GithubTokenConfig | null> {
  try {
    const raw = await LocalStorage.getItem<string | GithubTokenConfig>(STORAGE_KEY_GITHUB_TOKEN);
    if (!raw) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return { token: raw, username: "octocat", configuredAt: new Date().toISOString() };
      }
    }
    return raw;
  } catch {
    return null;
  }
}

export async function setGithubToken(token: string, username = "octocat"): Promise<GithubTokenConfig> {
  const config: GithubTokenConfig = {
    token: token.trim(),
    username: username.trim(),
    configuredAt: new Date().toISOString()
  };
  await LocalStorage.setItem(STORAGE_KEY_GITHUB_TOKEN, JSON.stringify(config));
  return config;
}

export async function clearGithubToken(): Promise<void> {
  await LocalStorage.removeItem(STORAGE_KEY_GITHUB_TOKEN);
}

export async function isGithubTokenConfigured(): Promise<boolean> {
  const cfg = await getGithubToken();
  return !!cfg && !!cfg.token;
}

export function filterGithubItems(
  items: GithubDashboardItem[],
  query: string,
  category: string,
  subFilter?: string
): GithubDashboardItem[] {
  let list = items;
  if (category && category !== "all") {
    list = list.filter((item) => item.type === category);
  }

  if (subFilter && subFilter !== "all") {
    if (category === "pr") {
      list = list.filter((i) => {
        if (i.type !== "pr") return false;
        if (subFilter === "created") return i.prCategory === "created";
        if (subFilter === "assigned") return i.prCategory === "assigned";
        if (subFilter === "mentioned") return i.prCategory === "mentioned";
        if (subFilter === "review_requests") return i.prCategory === "review_requests";
        if (subFilter === "open") return i.status === "open";
        if (subFilter === "merged") return i.status === "merged";
        if (subFilter === "closed") return i.status === "closed";
        if (subFilter === "draft") return i.status === "draft";
        return true;
      });
    } else if (category === "issue") {
      list = list.filter((i) => {
        if (i.type !== "issue") return false;
        if (subFilter === "open") return i.status === "open";
        if (subFilter === "closed") return i.status === "closed";
        if (subFilter === "mine") return i.issueCategory === "created" || i.author === "octocat";
        return true;
      });
    } else if (category === "notification") {
      list = list.filter((i) => {
        if (i.type !== "notification") return false;
        if (subFilter === "unread") return i.unread;
        if (subFilter === "read") return !i.unread;
        return true;
      });
    }
  }

  if (!query || !query.trim()) {
    return list;
  }

  const q = query.toLowerCase().trim();
  return list.filter((item) => {
    switch (item.type) {
      case "pr":
        return (
          item.title.toLowerCase().includes(q) ||
          item.repo.toLowerCase().includes(q) ||
          item.author.toLowerCase().includes(q) ||
          item.branch.toLowerCase().includes(q) ||
          item.targetBranch.toLowerCase().includes(q) ||
          `#${item.number}`.includes(q)
        );
      case "issue":
        return (
          item.title.toLowerCase().includes(q) ||
          item.repo.toLowerCase().includes(q) ||
          item.author.toLowerCase().includes(q) ||
          item.labels.some((l) => l.toLowerCase().includes(q)) ||
          `#${item.number}`.includes(q)
        );
      case "notification":
        return (
          item.title.toLowerCase().includes(q) ||
          item.repo.toLowerCase().includes(q) ||
          item.reason.toLowerCase().includes(q)
        );
      case "workflow":
        return (
          item.name.toLowerCase().includes(q) ||
          item.repo.toLowerCase().includes(q) ||
          item.branch.toLowerCase().includes(q) ||
          item.commitHash.toLowerCase().includes(q)
        );
      case "repo":
        return (
          item.name.toLowerCase().includes(q) ||
          item.owner.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.primaryLanguage.toLowerCase().includes(q)
        );
      default:
        return false;
    }
  });
}
