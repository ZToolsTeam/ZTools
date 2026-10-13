export type GithubItemType = "pr" | "issue" | "workflow" | "repo" | "notification";

export interface GithubPrItem {
  type: "pr";
  id: string;
  number: number;
  title: string;
  repo: string;
  author: string;
  branch: string;
  targetBranch: string;
  status: "open" | "merged" | "closed" | "draft";
  prCategory?: "created" | "assigned" | "mentioned" | "review_requests";
  reviewStatus?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  additions: number;
  deletions: number;
  commentsCount: number;
  url: string;
  updatedAt: string;
  body: string;
}

export interface GithubIssueItem {
  type: "issue";
  id: string;
  number: number;
  title: string;
  repo: string;
  author: string;
  labels: string[];
  status: "open" | "closed";
  issueCategory?: "created" | "assigned" | "mentioned";
  commentsCount: number;
  url: string;
  updatedAt: string;
  body: string;
}

export interface GithubNotificationItem {
  type: "notification";
  id: string;
  title: string;
  repo: string;
  reason: "mention" | "review_requested" | "assigned" | "subscribed" | "author";
  unread: boolean;
  updatedAt: string;
  url: string;
  itemType: "pr" | "issue" | "workflow";
}

export interface GithubWorkflowRunItem {
  type: "workflow";
  id: string;
  name: string;
  repo: string;
  branch: string;
  commitHash: string;
  status: "success" | "failure" | "in_progress";
  duration: string;
  url: string;
  event: string;
  runAt: string;
}

export interface GithubStarredRepoItem {
  type: "repo";
  id: string;
  name: string;
  owner: string;
  description: string;
  stars: number;
  forks: number;
  primaryLanguage: string;
  url: string;
  updatedAt: string;
}

export interface GithubTokenConfig {
  token: string;
  username?: string;
  configuredAt: string;
}

export type GithubDashboardItem =
  | GithubPrItem
  | GithubIssueItem
  | GithubNotificationItem
  | GithubWorkflowRunItem
  | GithubStarredRepoItem;
