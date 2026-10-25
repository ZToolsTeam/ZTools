import { callHostTransport, formatBytes, getRealEnvPaths, invokePluginService, isRealElectronHost, moveRealFilesToTrash, openRealPath, probeRealDiskDrives, readRealDirectory, scanRealDirectoryTree, showRealItemInFolder, writeRealClipboardText } from './native-ipc';
const INSTALLER_EXTS = new Set([
    '.exe', '.msi', '.dmg', '.pkg', '.deb', '.rpm', '.appimage', '.apk', '.msix'
]);
const ARCHIVE_EXTS = new Set([
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.zst', '.iso'
]);
const DOCUMENT_EXTS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.md', '.rtf', '.epub', '.ofd'
]);
const IMAGE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.heic', '.psd', '.tif', '.tiff'
]);
const MEDIA_EXTS = new Set([
    '.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.wmv', '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'
]);
const CODE_EXTS = new Set([
    '.json', '.yaml', '.yml', '.xml', '.sql', '.ts', '.tsx', '.js', '.mjs', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.cs', '.sh', '.ps1', '.bat', '.log'
]);
const TEMP_DOWNLOAD_SUFFIXES = [
    '.crdownload',
    '.part',
    '.partial',
    '.opdownload',
    '.download',
    '.td',
    '.xltd',
    '.baiduyun.p.downloading',
    '.aria2',
    '.tmp'
];
const PINNED_STORAGE_KEY = 'ztools_downloads_pinned_v1';
const CUSTOM_DIRS_STORAGE_KEY = 'ztools_downloads_custom_dirs_v1';
function loadPersistedSet(key) {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return new Set(parsed.filter((x) => typeof x === 'string' && x.trim().length > 0));
                }
            }
        }
    }
    catch {
        // ignore storage errors
    }
    return new Set();
}
function savePersistedSet(key, set) {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(key, JSON.stringify(Array.from(set)));
        }
    }
    catch {
        // ignore storage errors
    }
}
const pinnedIdSet = loadPersistedSet(PINNED_STORAGE_KEY);
const customDirectoriesStore = loadPersistedSet(CUSTOM_DIRS_STORAGE_KEY);
export function isDownloadTemporaryOrHiddenFile(fileName) {
    const lower = String(fileName || '').trim().toLowerCase();
    if (!lower || lower === 'desktop.ini' || lower === '.ds_store' || lower === 'thumbs.db') {
        return true;
    }
    return TEMP_DOWNLOAD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
export function classifyDownloadFile(fileName) {
    const dot = fileName.lastIndexOf('.');
    const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
    if (INSTALLER_EXTS.has(ext))
        return 'installer';
    if (ARCHIVE_EXTS.has(ext))
        return 'archive';
    if (DOCUMENT_EXTS.has(ext))
        return 'document';
    if (IMAGE_EXTS.has(ext))
        return 'image';
    if (MEDIA_EXTS.has(ext))
        return 'media';
    if (CODE_EXTS.has(ext))
        return 'code';
    return 'other';
}
export function getDownloadCategoryLabel(category) {
    switch (category) {
        case 'all': return '全部类型';
        case 'installer': return '安装包';
        case 'archive': return '压缩归档';
        case 'document': return '办公文档';
        case 'image': return '图片设计';
        case 'media': return '音视频';
        case 'code': return '代码与数据';
        case 'other': return '其他文件';
    }
}
export function getDownloadChannelLabel(channel) {
    switch (channel) {
        case 'all': return '全渠道汇总';
        case 'im': return '办公 IM 接收';
        case 'netdisk': return '网盘与下载器';
        case 'browser': return '浏览器与系统下载';
        case 'custom': return '自定义目录';
    }
}
function normalizePathKey(p) {
    const trimmed = String(p || '').trim().replace(/[\\/]+$/, '');
    const isWin = /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\\');
    return isWin ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}
function isAbsoluteFilePath(p) {
    const trimmed = String(p || '').trim();
    return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\');
}
export function validateCustomDownloadDirPath(rawPath) {
    const trimmed = String(rawPath || '').trim();
    if (!trimmed) {
        return { ok: false, error: 'INVALID_DIR_PATH: 目录路径不能为空' };
    }
    if (trimmed.includes('\0')) {
        return { ok: false, error: 'INVALID_DIR_PATH: 目录路径包含非法空字节' };
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed) || !isAbsoluteFilePath(trimmed)) {
        return { ok: false, error: 'PATH_TRAVERSAL_REJECTED: 仅允许无路径穿越的绝对目录路径' };
    }
    const isPosix = trimmed.startsWith('/');
    const normalized = isPosix
        ? trimmed.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
        : trimmed.replace(/\//g, '\\').replace(/\\+$/, '');
    return { ok: true, normalizedPath: normalized };
}
export function getCustomDownloadDirectories() {
    return Array.from(customDirectoriesStore);
}
export async function addCustomDownloadDirectory(rawDirPath, hostOverride) {
    const check = validateCustomDownloadDirPath(rawDirPath);
    if (!check.ok || !check.normalizedPath) {
        return { ok: false, error: check.error || 'INVALID_DIR_PATH' };
    }
    const targetDir = check.normalizedPath;
    const hostRes = await invokePluginService('DownloadsManagerPlugin', 'validateCustomDir', { dirPath: targetDir }, hostOverride);
    if (hostRes.ok && hostRes.data?.path) {
        customDirectoriesStore.add(hostRes.data.path);
        savePersistedSet(CUSTOM_DIRS_STORAGE_KEY, customDirectoriesStore);
        return { ok: true, path: hostRes.data.path };
    }
    if (hostRes.error && (hostRes.error.includes('NOT_A_DIRECTORY') || hostRes.error.includes('DIRECTORY_UNREADABLE') || hostRes.error.includes('PATH_TRAVERSAL'))) {
        return { ok: false, error: hostRes.error };
    }
    if (isRealElectronHost(hostOverride)) {
        const dirCheck = await callHostTransport('filesystem_directory_exists', { path: targetDir }, hostOverride);
        const isValidDir = dirCheck.ok &&
            (dirCheck.data === true ||
                (typeof dirCheck.data === 'object' &&
                    dirCheck.data !== null &&
                    (dirCheck.data.isDirectory === true || dirCheck.data.exists === true)));
        if (!isValidDir) {
            return { ok: false, error: dirCheck.error || 'DIRECTORY_UNREADABLE: 目标目录不存在或不可访问' };
        }
    }
    await readRealDirectory(targetDir, hostOverride);
    customDirectoriesStore.add(targetDir);
    savePersistedSet(CUSTOM_DIRS_STORAGE_KEY, customDirectoriesStore);
    return { ok: true, path: targetDir };
}
export function removeCustomDownloadDirectory(rawDirPath) {
    const targetKey = normalizePathKey(rawDirPath);
    for (const existing of customDirectoriesStore) {
        if (normalizePathKey(existing) === targetKey) {
            customDirectoriesStore.delete(existing);
            savePersistedSet(CUSTOM_DIRS_STORAGE_KEY, customDirectoriesStore);
            return true;
        }
    }
    return false;
}
export function clearCustomDownloadDirectories() {
    customDirectoriesStore.clear();
    savePersistedSet(CUSTOM_DIRS_STORAGE_KEY, customDirectoriesStore);
}
export async function discoverAllDownloadSources(customDirs = getCustomDownloadDirectories(), hostOverride) {
    const validCustomDirs = [];
    for (const raw of customDirs) {
        const v = validateCustomDownloadDirPath(raw);
        if (v.ok && v.normalizedPath)
            validCustomDirs.push(v.normalizedPath);
    }
    const sourcesMap = new Map();
    const registerSource = (src) => {
        if (!src.path)
            return;
        const key = normalizePathKey(src.path);
        if (!key || sourcesMap.has(key))
            return;
        sourcesMap.set(key, src);
    };
    const hostRes = await invokePluginService('DownloadsManagerPlugin', 'discoverSources', { customDirs: validCustomDirs }, hostOverride);
    if (hostRes.ok && Array.isArray(hostRes.data?.sources)) {
        for (const s of hostRes.data.sources) {
            if (s && typeof s.path === 'string' && s.path.trim()) {
                registerSource({
                    id: String(s.id || `src-${sourcesMap.size + 1}`),
                    label: String(s.label || '下载目录'),
                    channel: s.channel || 'browser',
                    appName: String(s.appName || '系统下载'),
                    path: s.path.trim(),
                    exists: true
                });
            }
        }
    }
    const envPaths = await getRealEnvPaths(hostOverride);
    const sep = envPaths.home.startsWith('/') ? '/' : '\\';
    if (envPaths.downloads) {
        registerSource({
            id: 'browser-default',
            label: '浏览器与系统下载',
            channel: 'browser',
            appName: '系统下载',
            path: envPaths.downloads,
            exists: true
        });
    }
    if (sourcesMap.size <= 1) {
        const drives = await probeRealDiskDrives(['C', 'D', 'E', 'F'], hostOverride);
        const driveRoots = drives.length > 0
            ? drives.map((d) => (d.drive.startsWith('/') ? d.drive : `${d.drive.replace(/[\\/]+$/, '')}\\`))
            : envPaths.home.startsWith('/')
                ? [envPaths.home]
                : ['C:\\', 'D:\\'];
        const netdiskCandidates = [
            { sub: 'BaiduNetdiskDownload', label: '百度网盘下载', appName: '百度网盘' },
            { sub: 'QuarkDownload', label: '夸克网盘下载', appName: '夸克网盘' },
            { sub: 'AliyunPanDownload', label: '阿里云盘下载', appName: '阿里云盘' },
            { sub: '迅雷下载', label: '迅雷下载', appName: '迅雷' },
            { sub: '360Download', label: '360浏览器下载', appName: '360浏览器', channel: 'browser' }
        ];
        for (const root of driveRoots) {
            const cleanRoot = root.replace(/[\\/]+$/, '');
            for (const cand of netdiskCandidates) {
                const candidatePath = `${cleanRoot}${sep}${cand.sub}`;
                registerSource({
                    id: `netdisk-${cand.appName}-${cleanRoot.replace(/[^A-Za-z0-9]/g, '')}`,
                    label: cand.label,
                    channel: cand.channel ?? 'netdisk',
                    appName: cand.appName,
                    path: candidatePath
                });
            }
        }
        if (envPaths.documents) {
            const cleanDocs = envPaths.documents.replace(/[\\/]+$/, '');
            registerSource({
                id: 'im-dingtalk-files',
                label: '钉钉接收文件',
                channel: 'im',
                appName: '钉钉',
                path: `${cleanDocs}${sep}DingTalk Files`
            });
        }
        if (envPaths.downloads) {
            const cleanDl = envPaths.downloads.replace(/[\\/]+$/, '');
            registerSource({
                id: 'im-lark-dl',
                label: '飞书下载',
                channel: 'im',
                appName: '飞书',
                path: `${cleanDl}${sep}Lark`
            });
        }
    }
    for (let i = 0; i < validCustomDirs.length; i++) {
        const customPath = validCustomDirs[i];
        const baseName = customPath.split(/[\\/]/).filter(Boolean).pop() || customPath;
        registerSource({
            id: `custom-${i + 1}`,
            label: `自定义 (${baseName})`,
            channel: 'custom',
            appName: '自定义目录',
            path: customPath,
            exists: true
        });
    }
    return Array.from(sourcesMap.values());
}
function buildDownloadEntry(raw, source, nowMs) {
    const fileName = String(raw.name || raw.path.split(/[\\/]/).pop() || '').trim();
    if (!fileName || isDownloadTemporaryOrHiddenFile(fileName)) {
        return null;
    }
    const sizeBytes = Math.max(0, Number(raw.size || 0));
    if (sizeBytes <= 0)
        return null;
    const dotIdx = fileName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';
    const mtimeMs = Number.isFinite(raw.mtimeMs) && raw.mtimeMs > 0 ? raw.mtimeMs : nowMs;
    const ageDays = Math.max(0, Math.floor((nowMs - mtimeMs) / 86_400_000));
    const id = `dl-${normalizePathKey(raw.path)}`;
    const dt = new Date(mtimeMs);
    const modifiedAt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    return {
        id,
        name: fileName,
        path: raw.path,
        dirPath: source.path,
        ext,
        category: classifyDownloadFile(fileName),
        sizeBytes,
        sizeFormatted: formatBytes(sizeBytes),
        modifiedAt,
        mtimeMs,
        ageDays,
        isPinned: pinnedIdSet.has(id),
        channel: source.channel,
        sourceId: source.id,
        sourceLabel: source.label,
        appName: source.appName
    };
}
export async function scanDownloadsDirectory(customDirOrOptions, hostOverride) {
    const nowMs = Date.now();
    const explicitDir = typeof customDirOrOptions === 'string' && customDirOrOptions.trim()
        ? customDirOrOptions.trim()
        : '';
    const customDirs = typeof customDirOrOptions === 'object' && Array.isArray(customDirOrOptions?.customDirs)
        ? customDirOrOptions.customDirs
        : getCustomDownloadDirectories();
    const maxFilesPerSource = typeof customDirOrOptions === 'object' && typeof customDirOrOptions?.maxFilesPerSource === 'number'
        ? customDirOrOptions.maxFilesPerSource
        : 80;
    let sources;
    if (explicitDir) {
        const check = validateCustomDownloadDirPath(explicitDir);
        if (!check.ok || !check.normalizedPath) {
            throw new Error(check.error || 'INVALID_DIR_PATH');
        }
        sources = [
            {
                id: 'explicit-dir',
                label: '指定下载目录',
                channel: 'browser',
                appName: '系统下载',
                path: check.normalizedPath,
                exists: true
            }
        ];
    }
    else {
        sources = await discoverAllDownloadSources(customDirs, hostOverride);
    }
    const seenPaths = new Set();
    const entries = [];
    const activeSources = [];
    await Promise.all(sources.map(async (source) => {
        try {
            const scanRes = await scanRealDirectoryTree(source.path, { maxFiles: maxFilesPerSource, hostOverride }, hostOverride);
            let rawFiles = scanRes.files.filter((f) => !f.isDir);
            if (rawFiles.length === 0) {
                const fallbackList = await readRealDirectory(source.path, hostOverride);
                rawFiles = fallbackList.filter((f) => !f.isDir);
            }
            if (rawFiles.length > 0 || source.exists) {
                activeSources.push({ ...source, exists: true });
            }
            for (const f of rawFiles) {
                const normKey = normalizePathKey(f.path);
                if (!normKey || seenPaths.has(normKey))
                    continue;
                const entry = buildDownloadEntry({
                    name: f.name,
                    path: f.path,
                    size: f.sizeBytes ?? f.size,
                    mtimeMs: f.mtimeMs || (f.mtime > 1e11 ? f.mtime : f.mtime * 1000)
                }, source, nowMs);
                if (!entry)
                    continue;
                seenPaths.add(normKey);
                entries.push(entry);
            }
        }
        catch {
            // 单个渠道无权限或目录不存在时静默跳过，不中断其他渠道
        }
    }));
    return computeDashboardSummary(explicitDir || activeSources[0]?.path || sources[0]?.path || '', entries, activeSources.length > 0 ? activeSources : sources);
}
export function computeDashboardSummary(downloadDir, entries, sources = []) {
    const sorted = [...entries].sort((a, b) => {
        if (a.isPinned !== b.isPinned)
            return a.isPinned ? -1 : 1;
        return b.mtimeMs - a.mtimeMs || b.sizeBytes - a.sizeBytes;
    });
    let totalSizeBytes = 0;
    let installerCount = 0;
    let installerSizeBytes = 0;
    let largeFileCount = 0;
    let oldFileCount = 0;
    let oldFileSizeBytes = 0;
    for (const e of sorted) {
        totalSizeBytes += e.sizeBytes;
        if (e.category === 'installer') {
            installerCount++;
            installerSizeBytes += e.sizeBytes;
        }
        if (e.sizeBytes >= 100 * 1024 * 1024) {
            largeFileCount++;
        }
        if (e.ageDays >= 30 && !e.isPinned) {
            oldFileCount++;
            oldFileSizeBytes += e.sizeBytes;
        }
    }
    return {
        downloadDir,
        sources,
        totalCount: sorted.length,
        totalSizeBytes,
        totalSizeFormatted: formatBytes(totalSizeBytes),
        installerCount,
        installerSizeBytes,
        installerSizeFormatted: formatBytes(installerSizeBytes),
        largeFileCount,
        oldFileCount,
        oldFileSizeBytes,
        oldFileSizeFormatted: formatBytes(oldFileSizeBytes),
        entries: sorted
    };
}
export function filterDownloadEntries(entries, options) {
    const rawFilter = String(options.filterValue || 'all').trim();
    let targetChannel = options.channel ?? 'all';
    let targetCategory = options.category ?? 'all';
    if (rawFilter.startsWith('type:')) {
        targetCategory = rawFilter.slice(5);
    }
    else if (['all', 'im', 'netdisk', 'browser', 'custom'].includes(rawFilter)) {
        targetChannel = rawFilter;
    }
    else if (['installer', 'archive', 'document', 'image', 'media', 'code', 'other'].includes(rawFilter)) {
        targetCategory = rawFilter;
    }
    const q = (options.query || '').trim().toLowerCase();
    const filtered = entries.filter((item) => {
        if (targetChannel !== 'all' && item.channel !== targetChannel) {
            return false;
        }
        if (targetCategory !== 'all' && item.category !== targetCategory) {
            return false;
        }
        if (options.onlyLarge && item.sizeBytes < 100 * 1024 * 1024) {
            return false;
        }
        if (q) {
            const matchName = item.name.toLowerCase().includes(q);
            const matchExt = item.ext.toLowerCase().includes(q);
            const matchSource = item.sourceLabel.toLowerCase().includes(q) || item.appName.toLowerCase().includes(q);
            return matchName || matchExt || matchSource;
        }
        return true;
    });
    const sortBy = options.sortBy ?? (targetCategory === 'installer' ? 'size' : 'mtime');
    return filtered.sort((a, b) => {
        if (a.isPinned !== b.isPinned)
            return a.isPinned ? -1 : 1;
        if (sortBy === 'size') {
            return b.sizeBytes - a.sizeBytes || b.mtimeMs - a.mtimeMs;
        }
        return b.mtimeMs - a.mtimeMs || b.sizeBytes - a.sizeBytes;
    });
}
export function togglePinEntry(entries, id) {
    if (pinnedIdSet.has(id)) {
        pinnedIdSet.delete(id);
    }
    else {
        pinnedIdSet.add(id);
    }
    savePersistedSet(PINNED_STORAGE_KEY, pinnedIdSet);
    return entries.map((item) => (item.id === id ? { ...item, isPinned: !item.isPinned } : item));
}
async function executeBatchTrashClean(entries, toClean, hostOverride) {
    if (toClean.length === 0) {
        return {
            cleanedCount: 0,
            freedBytes: 0,
            freedFormatted: '0 B',
            remainingEntries: entries
        };
    }
    const trashRes = await moveRealFilesToTrash(toClean.map((item) => item.path), hostOverride);
    const failedSet = new Set((trashRes.failedPaths || []).map(normalizePathKey));
    const deletedEntries = toClean.filter((item) => !failedSet.has(normalizePathKey(item.path)));
    const deletedIds = new Set(deletedEntries.map((item) => item.id));
    const freedBytes = deletedEntries.reduce((sum, item) => sum + item.sizeBytes, 0);
    const remainingEntries = entries.filter((item) => !deletedIds.has(item.id));
    return {
        cleanedCount: deletedEntries.length,
        freedBytes,
        freedFormatted: formatBytes(freedBytes),
        remainingEntries,
        ...(trashRes.failedPaths && trashRes.failedPaths.length > 0 ? { failedPaths: trashRes.failedPaths } : {}),
        ...(trashRes.error ? { error: trashRes.error } : {})
    };
}
export async function cleanRedundantInstallers(entries, hostOverride) {
    const toClean = entries.filter((item) => item.category === 'installer' && !item.isPinned);
    return executeBatchTrashClean(entries, toClean, hostOverride);
}
export async function cleanExpiredDownloads(entries, daysThreshold = 30, minSizeBytes = 0, hostOverride) {
    const toClean = entries.filter((item) => item.ageDays >= daysThreshold && item.sizeBytes >= minSizeBytes && !item.isPinned);
    return executeBatchTrashClean(entries, toClean, hostOverride);
}
export async function trashDownloadItem(entries, targetIdOrPath, hostOverride) {
    const target = entries.find((item) => item.id === targetIdOrPath || item.path === targetIdOrPath);
    if (!target) {
        return { ok: false, remainingEntries: entries, freedBytes: 0, error: 'FILE_NOT_FOUND: 未找到目标下载项' };
    }
    const trashRes = await moveRealFilesToTrash([target.path], hostOverride);
    if (!trashRes.ok || trashRes.deletedCount === 0) {
        return {
            ok: false,
            remainingEntries: entries,
            freedBytes: 0,
            error: trashRes.error || 'TRASH_FAILED: 移入回收站失败（文件可能正在被占用或已不存在）'
        };
    }
    return {
        ok: true,
        remainingEntries: entries.filter((item) => item.id !== target.id),
        freedBytes: target.sizeBytes
    };
}
export async function copyDownloadFileEntity(filePath, hostOverride) {
    const trimmed = String(filePath || '').trim();
    if (!trimmed) {
        return { ok: false, error: 'EMPTY_FILE_PATH: 文件路径不能为空' };
    }
    const res = await callHostTransport('clipboard_copy_file', { filePath: trimmed }, hostOverride);
    if (res.ok) {
        return { ok: true };
    }
    return {
        ok: false,
        error: res.error || 'CLIPBOARD_COPY_FILE_FAILED: 复制文件实体失败'
    };
}
export async function copyDownloadFilePath(filePath, hostOverride) {
    const trimmed = String(filePath || '').trim();
    if (!trimmed)
        return false;
    const res = await callHostTransport('clipboard_copy_text', { text: trimmed }, hostOverride);
    if (res.ok)
        return true;
    return writeRealClipboardText(trimmed, hostOverride);
}
export async function openDownloadItem(filePath, hostOverride) {
    return openRealPath(filePath, hostOverride);
}
export async function revealDownloadItem(filePath, hostOverride) {
    return showRealItemInFolder(filePath, hostOverride);
}
