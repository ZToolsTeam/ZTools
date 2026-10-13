export const SAMPLE_WINGET_PACKAGES = [
    {
        id: "Microsoft.VisualStudioCode",
        name: "Visual Studio Code",
        publisher: "Microsoft Corporation",
        installedVersion: "1.92.0",
        latestVersion: "1.94.2",
        status: "upgradable",
        description: "功能强大的开源跨平台代码编辑器，支持丰富的插件扩展与内置 Git/终端调试能力。",
        tags: ["editor", "development", "typescript", "ide", "vscode"],
        license: "MIT",
        homepage: "https://code.visualstudio.com",
        architecture: "x64"
    },
    {
        id: "Git.Git",
        name: "Git",
        publisher: "Software Freedom Conservancy",
        installedVersion: "2.46.0",
        latestVersion: "2.46.0",
        status: "installed",
        description: "快速、可扩展、分布式的版本控制系统，全球开发者事实上的标准协作工具。",
        tags: ["vcs", "git", "cli", "tools"],
        license: "GPL-2.0",
        homepage: "https://git-scm.com",
        architecture: "x64"
    },
    {
        id: "Google.Chrome",
        name: "Google Chrome",
        publisher: "Google LLC",
        installedVersion: "128.0.6613.120",
        latestVersion: "129.0.6668.71",
        status: "upgradable",
        description: "快速、安全且备受信赖的网络浏览器，基于 Chromium 核心构建。",
        tags: ["browser", "web", "chromium"],
        license: "Freeware",
        homepage: "https://www.google.com/chrome",
        architecture: "x64"
    },
    {
        id: "OpenJS.NodeJS.LTS",
        name: "Node.js (LTS)",
        publisher: "OpenJS Foundation",
        installedVersion: "20.17.0",
        latestVersion: "20.17.0",
        status: "installed",
        description: "基于 Chrome V8 引擎的高性能异步事件驱动 JavaScript 运行时环境。",
        tags: ["javascript", "runtime", "backend"],
        license: "MIT",
        homepage: "https://nodejs.org",
        architecture: "x64"
    },
    {
        id: "Oven-sh.Bun",
        name: "Bun",
        publisher: "Oven",
        installedVersion: null,
        latestVersion: "1.1.29",
        status: "available",
        description: "极速的 JavaScript & TypeScript 一体化运行时、打包工具、测试运行器与包管理器。",
        tags: ["javascript", "typescript", "runtime", "fast"],
        license: "MIT",
        homepage: "https://bun.sh",
        architecture: "x64"
    },
    {
        id: "7zip.7zip",
        name: "7-Zip",
        publisher: "Igor Pavlov",
        installedVersion: "24.07",
        latestVersion: "24.08",
        status: "upgradable",
        description: "高压缩比的文件归档实用工具，支持 7z, ZIP, RAR, TAR, GZIP 等多种格式。",
        tags: ["compression", "utility", "archive"],
        license: "LGPL",
        homepage: "https://www.7-zip.org",
        architecture: "x64"
    },
    {
        id: "Rustlang.Rustup",
        name: "Rustup",
        publisher: "Rust Project Developers",
        installedVersion: null,
        latestVersion: "1.27.1",
        status: "available",
        description: "Rust 编程语言官方工具链安装管理器，支持多工具链平滑切换与交叉编译。",
        tags: ["rust", "compiler", "toolchain"],
        license: "MIT / Apache-2.0",
        homepage: "https://rustup.rs",
        architecture: "x64"
    },
    {
        id: "Docker.DockerDesktop",
        name: "Docker Desktop",
        publisher: "Docker Inc.",
        installedVersion: null,
        latestVersion: "4.34.2",
        status: "available",
        description: "轻松在 Windows 上构建、共享与运行容器化应用的开发者桌面应用。",
        tags: ["containers", "docker", "virtualization"],
        license: "Subscription",
        homepage: "https://www.docker.com",
        architecture: "x64"
    }
];
export function filterWingetPackages(packages, query, filterType) {
    let list = packages;
    if (filterType !== "all") {
        list = list.filter((p) => p.status === filterType);
    }
    if (!query || !query.trim()) {
        return list;
    }
    const q = query.toLowerCase().trim();
    return list.filter((p) => p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.publisher.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)));
}
