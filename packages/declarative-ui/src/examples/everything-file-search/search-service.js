export function formatBytes(bytes) {
    if (bytes <= 0 || !Number.isFinite(bytes))
        return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
export function truncatePath(fullPath, maxLength = 46) {
    if (!fullPath)
        return "";
    if (fullPath.length <= maxLength)
        return fullPath;
    const parts = fullPath.split(/[\\/]/);
    if (parts.length <= 3)
        return fullPath;
    return `${parts[0]}\\...\\${parts.slice(-2).join("\\")}`;
}
export function getFileCategory(fileName, isDir) {
    if (isDir)
        return "folder";
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    if (["doc", "docx", "pdf", "txt", "md", "xls", "xlsx", "ppt", "pptx", "csv"].includes(ext)) {
        return "document";
    }
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) {
        return "image";
    }
    if (["mp4", "mkv", "avi", "mov", "mp3", "wav", "flac", "aac", "ogg"].includes(ext)) {
        return "media";
    }
    if (["js", "ts", "vue", "html", "css", "json", "py", "cpp", "c", "h", "rs", "go", "java", "sql"].includes(ext)) {
        return "code";
    }
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
        return "archive";
    }
    if (["exe", "bat", "cmd", "msi", "ps1"].includes(ext)) {
        return "app";
    }
    return "document";
}
export const SAMPLE_FILES = [
    {
        name: "ZTools-Architecture-Design.docx",
        path: "C:\\Users\\User\\Documents\\ZTools\\ZTools-Architecture-Design.docx",
        isDir: false,
        size: 4520192,
        mtime: Date.now() - 3600000 * 2,
        acronym: "zad",
        pinyin: "ztools architecture"
    },
    {
        name: "raycast-windows-deep-reverse-analysis.md",
        path: "E:\\csdwork3\\git\\ZTools\\docs\\raycast-windows-deep-reverse-analysis.md",
        isDir: false,
        size: 25451,
        mtime: Date.now() - 3600000 * 5,
        acronym: "rwdra",
        pinyin: "raycast windows"
    },
    {
        name: "Development-Plan-2026.pdf",
        path: "C:\\Users\\User\\Downloads\\Development-Plan-2026.pdf",
        isDir: false,
        size: 1845120,
        mtime: Date.now() - 3600000 * 12,
        acronym: "dp2",
        pinyin: "development plan"
    },
    {
        name: "ztools-indexer.exe",
        path: "E:\\csdwork3\\git\\ZTools\\electron-client\\out\\native\\win32-x64\\bin\\ztools-indexer.exe",
        isDir: false,
        size: 891240,
        mtime: Date.now() - 3600000 * 18,
        acronym: "zi",
        pinyin: "ztools indexer"
    },
    {
        name: "Projects",
        path: "D:\\Workspace\\Projects",
        isDir: true,
        size: 0,
        mtime: Date.now() - 86400000 * 3,
        acronym: "p",
        pinyin: "projects"
    },
    {
        name: "wechat-backup-2026.zip",
        path: "D:\\Backup\\wechat-backup-2026.zip",
        isDir: false,
        size: 852910240,
        mtime: Date.now() - 86400000 * 6,
        acronym: "wb",
        pinyin: "wechat backup"
    },
    {
        name: "indexer.rs",
        path: "E:\\csdwork3\\git\\ZTools\\electron-client\\native\\indexer\\src\\main.rs",
        isDir: false,
        size: 14208,
        mtime: Date.now() - 3600000 * 3,
        acronym: "ir",
        pinyin: "indexer rs"
    },
    {
        name: "architecture-diagram.png",
        path: "E:\\csdwork3\\git\\ZTools\\docs\\images\\architecture-diagram.png",
        isDir: false,
        size: 382910,
        mtime: Date.now() - 3600000 * 8,
        acronym: "adp",
        pinyin: "architecture diagram"
    }
];
export function sortAndFilterFiles(files, sortOption, typeFilter) {
    let result = files;
    if (typeFilter !== "all") {
        result = result.filter((f) => getFileCategory(f.name, f.isDir) === typeFilter);
    }
    const sorted = [...result];
    switch (sortOption) {
        case "name-asc":
            sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
            break;
        case "name-desc":
            sorted.sort((a, b) => b.name.localeCompare(a.name, "zh-CN"));
            break;
        case "size-desc":
            sorted.sort((a, b) => b.size - a.size);
            break;
        case "size-asc":
            sorted.sort((a, b) => a.size - b.size);
            break;
        case "mtime-desc":
            sorted.sort((a, b) => b.mtime - a.mtime);
            break;
        case "mtime-asc":
            sorted.sort((a, b) => a.mtime - b.mtime);
            break;
    }
    return sorted;
}
export async function searchLocalFiles(query, limit = 50) {
    const trimmed = (query || "").trim().toLowerCase();
    // 1. 若在真实宿主浏览器/Renderer环境中，调用自有底层引擎
    try {
        const launcher = globalThis.__ztoolsLauncher;
        const system = globalThis.ztools?.system;
        let res = null;
        if (launcher?.searchFiles) {
            res = await launcher.searchFiles(trimmed, limit);
        }
        else if (system?.searchFiles) {
            res = await system.searchFiles(trimmed, limit);
        }
        if (res && Array.isArray(res.files)) {
            return res.files.map((f) => ({
                name: f.name,
                path: f.path,
                isDir: Boolean(f.is_dir),
                size: Number(f.size) || 0,
                mtime: Number(f.mtime) || Date.now(),
                acronym: f.acronym,
                pinyin: f.pinyin
            }));
        }
    }
    catch (err) {
        console.warn("[EverythingFileSearch] 调用宿主引擎异常，转入回退引擎:", err);
    }
    // 2. 离线/测试/降级兜底引擎
    if (!trimmed) {
        return SAMPLE_FILES;
    }
    return SAMPLE_FILES.filter((f) => f.name.toLowerCase().includes(trimmed) ||
        f.path.toLowerCase().includes(trimmed) ||
        (f.acronym && f.acronym.includes(trimmed)) ||
        (f.pinyin && f.pinyin.includes(trimmed)));
}
