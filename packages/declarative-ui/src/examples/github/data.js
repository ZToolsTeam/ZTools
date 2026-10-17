export const SAMPLE_GITHUB_ITEMS = [
    {
        type: "pr",
        id: "pr-1",
        number: 142,
        title: "feat(renderer): Support declarative virtual view reconciliation",
        repo: "ztools/raycast-compat",
        author: "octocat",
        branch: "feat/virtual-reconciler",
        targetBranch: "main",
        status: "open",
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
        additions: 88,
        deletions: 14,
        commentsCount: 3,
        url: "https://github.com/ztools/declarative-core/pull/139",
        updatedAt: "2 小时前",
        body: "修正批量持久化过程中的微任务队列竞争，增加互斥锁保障写入事务原子性。"
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
        commentsCount: 4,
        url: "https://github.com/ztools/sdk/issues/76",
        updatedAt: "1 天前",
        body: "希望官方提供端到端迁移套件，验证声明式组件体系渲染与系统原生输出 100% 契合。"
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
export function filterGithubItems(items, query, category) {
    let list = items;
    if (category && category !== "all") {
        list = list.filter((item) => item.type === category);
    }
    if (!query || !query.trim()) {
        return list;
    }
    const q = query.toLowerCase().trim();
    return list.filter((item) => {
        switch (item.type) {
            case "pr":
                return (item.title.toLowerCase().includes(q) ||
                    item.repo.toLowerCase().includes(q) ||
                    item.author.toLowerCase().includes(q) ||
                    item.branch.toLowerCase().includes(q) ||
                    `#${item.number}`.includes(q));
            case "issue":
                return (item.title.toLowerCase().includes(q) ||
                    item.repo.toLowerCase().includes(q) ||
                    item.author.toLowerCase().includes(q) ||
                    `#${item.number}`.includes(q));
            case "workflow":
                return (item.name.toLowerCase().includes(q) ||
                    item.repo.toLowerCase().includes(q) ||
                    item.branch.toLowerCase().includes(q) ||
                    item.commitHash.toLowerCase().includes(q));
            case "repo":
                return (item.name.toLowerCase().includes(q) ||
                    item.owner.toLowerCase().includes(q) ||
                    item.description.toLowerCase().includes(q) ||
                    item.primaryLanguage.toLowerCase().includes(q));
            default:
                return false;
        }
    });
}
