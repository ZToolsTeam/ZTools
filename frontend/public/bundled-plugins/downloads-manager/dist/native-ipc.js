/**
 * ZTools 真实宿主 IPC 与系统能力桥接层 (Real Host IPC Bridge)
 *
 * 严格遵循《ZTools Declarative UI 2.0 架构与 35 款原生插件全量升级规范》5.1 真实环境铁律：
 * - 在真实 Electron 宿主环境中，100% 走通 Preload (__ztoolsElectron.transport.methods / window.ztools / __ztoolsLauncher) 真实调用链路
 * - 严禁在真实环境中因参数格式或嵌套响应结构差异而回退到假数据
 */
let ipcReqSeq = 1;
const realFileSizeCache = new Map();
export function nextMessageId(prefix = 'ipc') {
    ipcReqSeq = (ipcReqSeq + 1) % 1_000_000;
    return `${prefix}_${Date.now()}_${ipcReqSeq}`;
}
/**
 * 判断当前是否处于真实的 ZTools Electron 渲染进程宿主环境
 */
export function isRealElectronHost(hostOverride) {
    if (hostOverride)
        return false;
    if (typeof window === 'undefined')
        return false;
    const w = window;
    return Boolean(w.__ztoolsElectron?.transport?.methods ||
        w.ztools?.transport?.call ||
        w.ztools?.transport?.methods);
}
function normalizeMethodParams(method, params) {
    if (!params || typeof params !== 'object')
        return {};
    const next = { ...params };
    if (method === 'system_get_disk_usage') {
        const rawDrive = String(next.drive || next.path || 'C:\\').trim();
        if (rawDrive.startsWith('/')) {
            next.drive = rawDrive;
        }
        else {
            const match = rawDrive.match(/^([A-Za-z]):/);
            next.drive = match ? `${match[1].toUpperCase()}:\\` : rawDrive.replace(/\//g, '\\');
        }
        delete next.path;
    }
    return next;
}
function normalizeMethodResult(method, payload) {
    if (!payload || typeof payload !== 'object')
        return payload;
    if (method === 'system_get_disk_usage') {
        const avail = typeof payload.available === 'number'
            ? payload.available
            : typeof payload.free === 'number'
                ? payload.free
                : Math.max(0, Number(payload.total || 0) - Number(payload.used || 0));
        return {
            ...payload,
            available: avail,
            free: avail
        };
    }
    if (method === 'system_get_hardware_summary') {
        const cpuModel = typeof payload.cpuModel === 'string' && payload.cpuModel.trim()
            ? payload.cpuModel.trim()
            : Array.isArray(payload.cpuModels) && payload.cpuModels.length > 0
                ? String(payload.cpuModels[0]).trim()
                : 'x86_64 Processor';
        return {
            ...payload,
            cpuModel
        };
    }
    if (method === 'system_get_battery_status') {
        // 宿主约定 percent 超出 0-100（如 255）表示无电池或电量未知，不能改写成 100%
        const rawPct = payload.percent;
        const hasBattery = typeof rawPct === 'number' && Number.isFinite(rawPct) && rawPct >= 0 && rawPct <= 100;
        return {
            ...payload,
            percent: hasBattery ? rawPct : null,
            hasBattery
        };
    }
    if (method === 'screen_get_all_displays') {
        const list = Array.isArray(payload)
            ? payload
            : Array.isArray(payload.displays)
                ? payload.displays
                : [];
        return list.map((d) => ({
            ...d,
            label: d?.label || d?.name || `Display #${d?.id ?? 1}`
        }));
    }
    return payload;
}
function unwrapTransportResponse(method, raw) {
    if (raw === null || raw === undefined) {
        return { ok: false, error: 'EMPTY_IPC_RESPONSE' };
    }
    if (typeof raw !== 'object') {
        return { ok: true, data: raw };
    }
    if (raw.success === false) {
        const errObj = raw.error;
        const errMsg = typeof errObj === 'object' && errObj !== null
            ? String(errObj.message || errObj.code || JSON.stringify(errObj))
            : String(errObj || 'IPC 调用返回失败');
        return { ok: false, error: errMsg };
    }
    const firstLayer = 'data' in raw && raw.data !== undefined ? raw.data : raw;
    if (firstLayer && typeof firstLayer === 'object' && !Array.isArray(firstLayer)) {
        if (firstLayer.success === false) {
            const errObj = firstLayer.error;
            const errMsg = typeof errObj === 'object' && errObj !== null
                ? String(errObj.message || errObj.code || JSON.stringify(errObj))
                : String(errObj || 'IPC 内部调用失败');
            return { ok: false, error: errMsg };
        }
        if ('data' in firstLayer && firstLayer.data !== undefined) {
            return { ok: true, data: normalizeMethodResult(method, firstLayer.data) };
        }
    }
    return { ok: true, data: normalizeMethodResult(method, firstLayer) };
}
/**
 * 调用 Electron Preload Transport 方法（自动封装合法的 alphanumeric messageId 与双层解包）
 */
export async function callHostTransport(method, params = {}, hostOverride) {
    const normalizedParams = normalizeMethodParams(method, params);
    // 1. 测试注入的 hostOverride 优先
    if (hostOverride) {
        if (typeof hostOverride[method] === 'function') {
            try {
                const res = await hostOverride[method](normalizedParams);
                const unwrapped = unwrapTransportResponse(method, res);
                return unwrapped;
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
        if (typeof hostOverride?.transport?.call === 'function') {
            try {
                const res = await hostOverride.transport.call(method, normalizedParams);
                const unwrapped = unwrapTransportResponse(method, res);
                return unwrapped;
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
    }
    if (typeof window === 'undefined') {
        return { ok: false, error: 'NO_WINDOW_ENV' };
    }
    const w = window;
    const methods = w.__ztoolsElectron?.transport?.methods || w.ztools?.transport?.methods;
    const fn = methods?.[method];
    if (typeof fn === 'function') {
        try {
            const messageId = nextMessageId(method.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 24));
            const raw = await fn({ messageId, params: normalizedParams });
            return unwrapTransportResponse(method, raw);
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    if (typeof w.ztools?.transport?.call === 'function') {
        try {
            const raw = await w.ztools.transport.call(method, normalizedParams);
            return unwrapTransportResponse(method, raw);
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    return { ok: false, error: `METHOD_NOT_AVAILABLE: ${method}` };
}
/**
 * 探测本机全部真实挂载磁盘分区 (C:\ ~ Z:\ 或 macOS/POSIX 挂载点 '/')
 */
export async function probeRealDiskDrives(candidateLetters = ['C', 'D', 'E', 'F', 'G'], hostOverride) {
    const drives = [];
    const results = await Promise.all(candidateLetters.map(async (letter) => {
        const raw = String(letter || '').trim();
        const isPosix = raw.startsWith('/');
        const drivePath = isPosix ? raw : `${raw.replace(/:\\?$/, '').toUpperCase()}:\\`;
        const res = await callHostTransport('system_get_disk_usage', { drive: drivePath }, hostOverride);
        if (res.ok && res.data && typeof res.data.total === 'number' && res.data.total > 0) {
            const availableBytes = typeof res.data.available === 'number'
                ? res.data.available
                : typeof res.data.free === 'number'
                    ? res.data.free
                    : Math.max(0, res.data.total - res.data.used);
            return {
                drive: isPosix ? raw : `${raw.replace(/:\\?$/, '').toUpperCase()}:`,
                totalBytes: res.data.total,
                usedBytes: res.data.used,
                availableBytes,
                usagePercent: res.data.percent
            };
        }
        return null;
    }));
    for (const item of results) {
        if (item)
            drives.push(item);
    }
    if (drives.length === 0 && !candidateLetters.includes('/')) {
        const posixRes = await callHostTransport('system_get_disk_usage', { drive: '/' }, hostOverride);
        if (posixRes.ok && posixRes.data && typeof posixRes.data.total === 'number' && posixRes.data.total > 0) {
            const availableBytes = typeof posixRes.data.available === 'number'
                ? posixRes.data.available
                : typeof posixRes.data.free === 'number'
                    ? posixRes.data.free
                    : Math.max(0, posixRes.data.total - posixRes.data.used);
            drives.push({
                drive: '/',
                totalBytes: posixRes.data.total,
                usedBytes: posixRes.data.used,
                availableBytes,
                usagePercent: posixRes.data.percent
            });
        }
    }
    return drives;
}
/**
 * 获取本机真实系统特殊路径（支持 home 派生标准子目录兜底，自动兼容 Windows 与 macOS/POSIX）
 */
export async function getRealSystemPath(name, hostOverride) {
    const res = await callHostTransport('system_get_path', { name }, hostOverride);
    if (res.ok && res.data) {
        if (typeof res.data === 'string' && res.data.trim().length > 0) {
            return res.data.trim();
        }
        if (typeof res.data.path === 'string' && res.data.path.trim().length > 0) {
            return res.data.path.trim();
        }
    }
    if (name !== 'home') {
        const home = await getRealSystemPath('home', hostOverride);
        if (home) {
            const isPosix = home.startsWith('/');
            const subMap = isPosix
                ? {
                    desktop: `${home}/Desktop`,
                    documents: `${home}/Documents`,
                    downloads: `${home}/Downloads`,
                    music: `${home}/Music`,
                    pictures: `${home}/Pictures`,
                    videos: `${home}/Videos`,
                    appData: `${home}/Library/Application Support`,
                    userData: `${home}/Library/Application Support/ZTools`,
                    temp: '/tmp',
                    cache: `${home}/Library/Caches`
                }
                : {
                    desktop: `${home}\\Desktop`,
                    documents: `${home}\\Documents`,
                    downloads: `${home}\\Downloads`,
                    music: `${home}\\Music`,
                    pictures: `${home}\\Pictures`,
                    videos: `${home}\\Videos`,
                    appData: `${home}\\AppData\\Roaming`,
                    userData: `${home}\\AppData\\Roaming\\ZTools`,
                    temp: `${home}\\AppData\\Local\\Temp`,
                    cache: `${home}\\AppData\\Local`
                };
            if (subMap[name])
                return subMap[name];
        }
    }
    return '';
}
function extractFileExt(fileNameOrPath) {
    const base = String(fileNameOrPath || '').split(/[\\/]/).pop() || '';
    const dotIdx = base.lastIndexOf('.');
    return dotIdx > 0 ? base.slice(dotIdx).toLowerCase() : '';
}
function normalizeIndexedFileEntry(f) {
    const p = String(f?.path || '');
    const name = String(f?.name || p.split(/[\\/]/).pop() || '');
    const sz = Number(f?.size ?? f?.sizeBytes ?? 0);
    const isDir = Boolean(f?.is_dir || f?.isDir || f?.isDirectory);
    const rawMtime = Number(f?.mtime ?? f?.mtimeMs ?? 0);
    const mtimeMs = rawMtime > 1e11 ? rawMtime : rawMtime > 0 ? rawMtime * 1000 : Date.now();
    const mtimeSec = rawMtime > 1e11 ? Math.floor(rawMtime / 1000) : rawMtime;
    if (p && sz >= 0)
        realFileSizeCache.set(p, sz);
    return {
        name,
        path: p,
        ext: extractFileExt(name || p),
        isDir,
        isDirectory: isDir,
        size: sz,
        sizeBytes: sz,
        mtime: mtimeSec,
        mtimeMs,
        lastModifiedMs: mtimeMs
    };
}
function makeScanResult(files, totalFiles, totalBytes, subdirs, meta = {}) {
    return {
        files,
        totalFiles,
        fileCount: totalFiles,
        totalBytes,
        subdirs,
        ...(meta.truncated ? { truncated: true } : {}),
        ...(meta.approximate ? { approximate: true } : {}),
        ...(typeof meta.visitedEntries === 'number' ? { visitedEntries: meta.visitedEntries } : {}),
        [Symbol.iterator]() {
            return files[Symbol.iterator]();
        }
    };
}
/**
 * 调用本机 Rust NTFS MFT 硬件级索引引擎 (ztools-indexer) 毫秒级检索真实文件
 */
export async function searchRealIndexedFiles(query, limit = 40, hostOverride) {
    if (!query || !query.trim())
        return [];
    const q = query.trim();
    const safeLimit = Math.min(200, Math.max(1, Math.floor(limit || 40)));
    try {
        const res = await callHostTransport('system_search_files', { query: q, limit: safeLimit }, hostOverride);
        if (res.ok && res.data && Array.isArray(res.data.files)) {
            return res.data.files.map(normalizeIndexedFileEntry);
        }
        if (!hostOverride && typeof window !== 'undefined') {
            const w = window;
            if (typeof w.__ztoolsLauncher?.searchFiles === 'function') {
                const rawOuter = await w.__ztoolsLauncher.searchFiles(q, safeLimit);
                const raw = rawOuter && typeof rawOuter === 'object' && 'data' in rawOuter && rawOuter.data ? rawOuter.data : rawOuter;
                if (raw && Array.isArray(raw.files)) {
                    return raw.files.map(normalizeIndexedFileEntry);
                }
            }
        }
    }
    catch {
        // ignore
    }
    return [];
}
/**
 * 深度扫描指定真实物理目录树（支持符号链接穿透，如 AppData\Roaming\Tencent -> D:\Local\Roaming\Tencent）
 * 返回该目录下 Top 文件列表、全树真实文件总数、全树真实总字节数与一级子目录汇总
 */
export async function scanRealDirectoryTree(dirPath, limitOrOptions = 160, hostOverrideArg) {
    return (await scanDirectoryTreeWithError(dirPath, limitOrOptions, hostOverrideArg)).scan;
}
/** scanRealDirectoryTree 的实现：额外带回读取失败原因（目录不存在 / 为空 / 无权限 / 载荷异常） */
async function scanDirectoryTreeWithError(dirPath, limitOrOptions, hostOverrideArg) {
    const empty = makeScanResult([], 0, 0, []);
    if (!dirPath || !dirPath.trim())
        return { scan: empty, error: 'EMPTY_DIRECTORY_PATH' };
    const targetDir = dirPath.trim();
    const opts = typeof limitOrOptions === 'number'
        ? { maxFiles: limitOrOptions, hostOverride: hostOverrideArg }
        : { ...limitOrOptions, hostOverride: limitOrOptions?.hostOverride ?? hostOverrideArg };
    const rawLimit = opts.maxFiles ?? opts.collectTopN ?? 160;
    const safeLimit = Math.min(200, Math.max(1, Math.floor(rawLimit || 160)));
    const hostOverride = opts.hostOverride;
    const filterExt = opts.filterExt;
    const dirQuery = `dir:${targetDir}`;
    try {
        let rawPayload = null;
        const res = await callHostTransport('system_search_files', { query: dirQuery, limit: safeLimit }, hostOverride);
        if (res.ok && res.data) {
            rawPayload = res.data;
        }
        if (!rawPayload && !hostOverride && typeof window !== 'undefined') {
            const w = window;
            if (typeof w.__ztoolsLauncher?.searchFiles === 'function') {
                const rawOuter = await w.__ztoolsLauncher.searchFiles(dirQuery, safeLimit);
                rawPayload =
                    rawOuter && typeof rawOuter === 'object' && 'data' in rawOuter && rawOuter.data
                        ? rawOuter.data
                        : rawOuter;
            }
        }
        if (rawPayload &&
            Array.isArray(rawPayload.files) &&
            (rawPayload.files.length > 0 ||
                Number(rawPayload.total_matches || 0) > 0 ||
                (Array.isArray(rawPayload.subdirs) && rawPayload.subdirs.length > 0))) {
            let files = rawPayload.files.map(normalizeIndexedFileEntry);
            if (filterExt instanceof RegExp) {
                files = files.filter(f => !f.isDir && (filterExt.test(f.name) || filterExt.test(f.ext)));
                // 若目录 Top-N 大文件均为其他后缀，使用 MFT 索引直接检索目标扩展名
                if (files.length === 0 && !hostOverride) {
                    const extTokens = (filterExt.source.match(/[a-z0-9]{2,5}/gi) || [])
                        .filter(t => !['thumbcache', 'iconcache'].includes(t.toLowerCase()))
                        .slice(0, 4);
                    // 只接受确实位于目标目录下的检索结果，不能用别处同后缀文件冒充目录内容
                    const prefixLower = `${targetDir.replace(/[\\/]+$/, '')}${isWindowsStylePath(targetDir) ? '\\' : '/'}`.toLowerCase();
                    const extraLists = await Promise.all(extTokens.map(ext => searchRealIndexedFiles(`.${ext.toLowerCase()}`, 30, hostOverride)));
                    const seen = new Set();
                    for (const list of extraLists) {
                        for (const item of list) {
                            if (!item.isDir && item.size > 0 && !seen.has(item.path)) {
                                if (item.path.replace(/\//g, isWindowsStylePath(targetDir) ? '\\' : '/').toLowerCase().startsWith(prefixLower)) {
                                    seen.add(item.path);
                                    files.push(item);
                                }
                            }
                        }
                    }
                }
            }
            if (typeof opts.collectTopN === 'number' && opts.collectTopN > 0 && files.length > opts.collectTopN) {
                files = files.slice(0, opts.collectTopN);
            }
            const subdirs = Array.isArray(rawPayload.subdirs)
                ? rawPayload.subdirs.map((s) => ({
                    name: String(s.name || ''),
                    path: String(s.path || ''),
                    fileCount: Number(s.file_count ?? s.fileCount ?? 0),
                    totalBytes: Number(s.total_bytes ?? s.totalBytes ?? 0),
                    mtime: Number(s.mtime || 0),
                    ...(s.approximate === true ? { approximate: true } : {})
                }))
                : [];
            const computedBytes = files.reduce((acc, f) => acc + (f.isDir ? 0 : f.size), 0);
            const totalFilesCount = filterExt instanceof RegExp ? files.length : Number(rawPayload.total_matches ?? files.length);
            const totalBytesCount = filterExt instanceof RegExp ? computedBytes : Number(rawPayload.total_bytes ?? computedBytes);
            const visited = Number(rawPayload.visited_entries);
            return {
                scan: makeScanResult(files, totalFilesCount, totalBytesCount, subdirs, {
                    truncated: rawPayload.truncated === true,
                    approximate: rawPayload.approximate === true,
                    ...(Number.isFinite(visited) && visited >= 0 ? { visitedEntries: visited } : {})
                })
            };
        }
        // dir: 扫描无结果（目录不存在 / 为空 / 测试替身未实现）时，退回 filesystem_get_directory_contents 读取一级目录
        const listing = await listDirectoryViaFilesystem(targetDir, hostOverride, { withSizes: true, limit: safeLimit });
        if (listing.ok && listing.entries.length > 0) {
            const files = [];
            let totalBytes = 0;
            for (const entry of listing.entries) {
                if (filterExt instanceof RegExp && !filterExt.test(entry.name) && !filterExt.test(entry.ext)) {
                    continue;
                }
                files.push(entry);
                totalBytes += entry.isDir ? 0 : entry.size;
            }
            return { scan: makeScanResult(files, files.length, totalBytes, []) };
        }
        return { scan: empty, error: listing.ok ? DIRECTORY_EMPTY_OR_UNREADABLE : listing.error };
    }
    catch {
        // ignore
    }
    return { scan: empty, error: DIRECTORY_EMPTY_OR_UNREADABLE };
}
/** 目录读取不到任何条目（不存在 / 为空 / 无权限）时的错误码 */
export const DIRECTORY_EMPTY_OR_UNREADABLE = 'DIRECTORY_EMPTY_OR_UNREADABLE';
function stripTrailingSeparators(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    return trimmed || p.slice(0, 1);
}
function isWindowsStylePath(p) {
    return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') || (p.includes('\\') && !p.includes('/'));
}
function comparablePath(p) {
    const stripped = stripTrailingSeparators(String(p || '').trim());
    return isWindowsStylePath(stripped) ? stripped.replace(/\//g, '\\').toLowerCase() : stripped;
}
function parentDirOf(p) {
    const stripped = stripTrailingSeparators(String(p || ''));
    const idx = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
    if (idx < 0)
        return '';
    if (idx === 0)
        return stripped.slice(0, 1);
    const parent = stripped.slice(0, idx);
    return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
function isDirectChildPath(dirPath, candidate) {
    if (!candidate)
        return false;
    return comparablePath(parentDirOf(candidate)) === comparablePath(dirPath);
}
function joinChildPath(dirPath, name) {
    const sep = isWindowsStylePath(dirPath) ? '\\' : '/';
    const base = dirPath.replace(/[\\/]+$/, '');
    return `${base}${sep}${name}`;
}
/**
 * 通过 filesystem_get_directory_contents 读取一级目录（需宿主授权）。
 * 宿主真实返回 { success, files: [{ name, size, isDirectory, lastModified }] }（name 为文件名）；
 * 兼容旧测试替身返回的完整路径字符串数组。
 */
async function listDirectoryViaFilesystem(dirPath, hostOverride, options = {}) {
    const res = await callHostTransport('filesystem_get_directory_contents', { path: dirPath }, hostOverride);
    if (!res.ok)
        return { ok: false, entries: [], error: res.error || 'DIRECTORY_READ_FAILED' };
    const data = res.data;
    const rawList = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : null;
    if (!rawList)
        return { ok: false, entries: [], error: 'INVALID_DIRECTORY_PAYLOAD' };
    const limit = Math.max(1, Math.floor(options.limit ?? 1000));
    const nowSec = Math.floor(Date.now() / 1000);
    const entries = [];
    const seen = new Set();
    for (const item of rawList) {
        if (entries.length >= limit)
            break;
        let entry = null;
        if (typeof item === 'string') {
            const itemPath = item.trim();
            if (!itemPath)
                continue;
            const name = itemPath.split(/[\\/]/).pop() || itemPath;
            const sz = options.withSizes ? await getRealFileSize(itemPath, hostOverride) : 0;
            entry = normalizeIndexedFileEntry({
                name,
                path: itemPath,
                isDir: sz === 0 && !name.includes('.'),
                size: sz,
                mtime: nowSec
            });
        }
        else if (item && typeof item === 'object' && typeof item.name === 'string') {
            const raw = item;
            const rawName = raw.name.trim();
            if (!rawName || rawName === '.' || rawName === '..')
                continue;
            // 只接受文件名，或确实位于该目录下的完整路径，拒绝越界路径
            const fullPath = /[\\/]/.test(rawName) ? rawName : joinChildPath(dirPath, rawName);
            if (!isDirectChildPath(dirPath, fullPath))
                continue;
            const isDir = Boolean(raw.isDirectory ?? raw.isDir ?? raw.is_dir);
            const parsedMtime = Date.parse(String(raw.lastModified || ''));
            entry = normalizeIndexedFileEntry({
                name: fullPath.split(/[\\/]/).pop() || rawName,
                path: fullPath,
                isDir,
                size: isDir ? 0 : Math.max(0, Number(raw.size) || 0),
                mtime: Number.isFinite(parsedMtime) ? parsedMtime : nowSec
            });
        }
        if (!entry || seen.has(entry.path))
            continue;
        seen.add(entry.path);
        entries.push(entry);
    }
    return { ok: true, entries };
}
/**
 * 读取真实目录下的条目路径（真实宿主中优先走 dir: 扫描：一级子目录 + 全树 Top-N 大文件），并返回失败原因。
 * 目录不存在、为空或无权限时返回空列表与错误码，绝不用全盘关键词搜索结果冒充目录内容。
 */
export async function listRealDirectoryContentsResult(dirPath, hostOverride) {
    if (!dirPath || !dirPath.trim())
        return { entries: [], error: 'EMPTY_DIRECTORY_PATH' };
    const targetDir = dirPath.trim();
    if (!hostOverride && isRealElectronHost()) {
        const tree = await scanRealDirectoryTree(targetDir, 60);
        const paths = [];
        for (const s of tree.subdirs) {
            if (s.path)
                paths.push(s.path);
        }
        for (const f of tree.files) {
            if (f.path)
                paths.push(f.path);
        }
        if (paths.length > 0)
            return { entries: Array.from(new Set(paths)) };
    }
    const listing = await listDirectoryViaFilesystem(targetDir, hostOverride);
    if (!listing.ok)
        return { entries: [], error: listing.error };
    if (listing.entries.length === 0)
        return { entries: [], error: DIRECTORY_EMPTY_OR_UNREADABLE };
    return { entries: listing.entries.map(e => e.path) };
}
/**
 * 读取真实目录下的条目路径（保持旧签名：失败时返回空数组，需要失败原因请用 listRealDirectoryContentsResult）
 */
export async function listRealDirectoryContents(dirPath, hostOverride) {
    return (await listRealDirectoryContentsResult(dirPath, hostOverride)).entries;
}
/**
 * 只列出目录的直接子项（子目录 + 直接位于该目录下的文件），用于文件夹预览、按目录改名等场景。
 * dir: 扫描结果中只保留 subdirs 与父目录等于 dirPath 的文件；扫描达到上限时 partial=true，由插件如实提示「仅显示部分」。
 */
export async function listDirectChildren(dirPath, hostOverride) {
    if (!dirPath || !dirPath.trim())
        return { entries: [], partial: false, error: 'EMPTY_DIRECTORY_PATH' };
    const targetDir = dirPath.trim();
    const scanLimit = 200;
    const entries = [];
    const seen = new Set();
    const push = (entry) => {
        const key = comparablePath(entry.path);
        if (!entry.path || seen.has(key))
            return;
        seen.add(key);
        entries.push(entry);
    };
    const { scan: tree, error } = await scanDirectoryTreeWithError(targetDir, { maxFiles: scanLimit, hostOverride });
    for (const s of tree.subdirs) {
        if (!s.path || !isDirectChildPath(targetDir, s.path))
            continue;
        push(normalizeIndexedFileEntry({
            name: s.name || s.path.split(/[\\/]/).pop(),
            path: s.path,
            isDir: true,
            size: s.totalBytes,
            mtime: s.mtime
        }));
    }
    let directFileCount = 0;
    for (const f of tree.files) {
        if (!isDirectChildPath(targetDir, f.path))
            continue;
        directFileCount++;
        push(f);
    }
    // 宿主 total_matches 是全树文件数、subdirs[].file_count 是各子目录全树文件数，差值即直接子文件数；
    // 拿到的直接子文件少于它就说明被 Top-N 截断了。计数不可用时按是否达到扫描上限判断
    const expectedDirectFiles = tree.totalFiles - tree.subdirs.reduce((sum, d) => sum + (Number(d.fileCount) || 0), 0);
    const partial = Number.isFinite(expectedDirectFiles) && expectedDirectFiles >= 0
        ? directFileCount < expectedDirectFiles
        : tree.files.length >= scanLimit;
    if (entries.length > 0) {
        return { entries, partial };
    }
    if (tree.files.length > 0) {
        // dir: 扫描只返回了深层文件（直接子文件被 Top-N 截掉），如实标注部分结果
        return { entries: [], partial: true, error: DIRECTORY_EMPTY_OR_UNREADABLE };
    }
    return { entries: [], partial: false, error: error || DIRECTORY_EMPTY_OR_UNREADABLE };
}
/**
 * 获取真实文件字节大小（优先命中 MFT 硬件级索引实时缓存，再走 filesystem_get_file_size）
 */
export async function getRealFileSize(filePath, hostOverride) {
    if (!filePath)
        return 0;
    if (!hostOverride && realFileSizeCache.has(filePath)) {
        const cached = realFileSizeCache.get(filePath);
        if (cached > 0)
            return cached;
    }
    const res = await callHostTransport('filesystem_get_file_size', { path: filePath }, hostOverride);
    if (res.ok && typeof res.data === 'number' && Number.isFinite(res.data) && res.data >= 0) {
        realFileSizeCache.set(filePath, res.data);
        return res.data;
    }
    return 0;
}
/**
 * 在 Windows Explorer 中定位并高亮文件/目录
 */
export async function showRealItemInFolder(fullPath, hostOverride) {
    if (!fullPath)
        return false;
    const res = await callHostTransport('shell_show_item_in_folder', { fullPath }, hostOverride);
    if (res.ok)
        return true;
    const fallback = await callHostTransport('shell_open_path', { fullPath }, hostOverride);
    return fallback.ok;
}
/**
 * 使用系统默认程序打开文件或目录
 */
export async function openRealPath(fullPath, hostOverride) {
    if (!fullPath)
        return false;
    const res = await callHostTransport('shell_open_path', { fullPath }, hostOverride);
    return res.ok;
}
/**
 * 将真实文件或目录移入系统回收站（安全可恢复删除）
 */
export async function trashRealItem(fullPath, hostOverride) {
    if (!fullPath)
        return { ok: false, error: '路径不能为空' };
    const res = await callHostTransport('shell_trash_item', { fullPath }, hostOverride);
    return { ok: res.ok, error: res.error };
}
export async function invokeDllPluginCapability(pluginName, method, params = {}, hostBridge, offlineFallback) {
    if (!method || typeof method !== 'string' || method.trim().length === 0) {
        return {
            ok: false,
            code: -1,
            data: null,
            message: 'method 参数不能为空',
            error: 'INVALID_METHOD: method 不能为空且必须为字符串',
            pluginName,
            method: String(method || '')
        };
    }
    const trimmedMethod = method.trim();
    const unwrapDllRawPayload = (raw, unwrapDataProperty) => {
        let parsed = raw;
        if (typeof raw === 'string') {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                throw new Error('MALFORMED_DLL_RESPONSE: 原生组件返回了损坏的 JSON 数据');
            }
        }
        if (parsed && typeof parsed === 'object') {
            if ('error' in parsed && parsed.error !== undefined && parsed.error !== null && parsed.error !== '') {
                const errMsg = `DLL_ERROR: ${String(parsed.error)}`;
                return {
                    ok: false,
                    code: typeof parsed.code === 'number' ? parsed.code : -1,
                    data: null,
                    message: errMsg,
                    error: errMsg,
                    pluginName,
                    method: trimmedMethod,
                    fromFallback: false
                };
            }
            if ('ok' in parsed && parsed.ok === false) {
                const errMsg = `DLL_ERROR: ${String(parsed.error || parsed.message || '原生组件返回未知错误')}`;
                return {
                    ok: false,
                    code: typeof parsed.code === 'number' ? parsed.code : -1,
                    data: null,
                    message: errMsg,
                    error: errMsg,
                    pluginName,
                    method: trimmedMethod,
                    fromFallback: false
                };
            }
            const dataPayload = unwrapDataProperty && 'data' in parsed && parsed.data !== undefined ? parsed.data : parsed;
            return {
                ok: true,
                code: typeof parsed.code === 'number' ? parsed.code : 0,
                data: dataPayload,
                message: typeof parsed.message === 'string' ? parsed.message : undefined,
                pluginName,
                method: trimmedMethod,
                fromFallback: false
            };
        }
        return {
            ok: true,
            code: 0,
            data: (parsed ?? null),
            pluginName,
            method: trimmedMethod,
            fromFallback: false
        };
    };
    const wrapCaughtDllError = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('MALFORMED_DLL_RESPONSE:')) {
            throw err;
        }
        const errMsg = `NATIVE_CALL_FAILED: ${message}`;
        return {
            ok: false,
            code: -1,
            data: null,
            message: errMsg,
            error: errMsg,
            pluginName,
            method: trimmedMethod,
            fromFallback: false
        };
    };
    if (hostBridge && typeof hostBridge.invokeNative === 'function') {
        try {
            const raw = await hostBridge.invokeNative(pluginName, trimmedMethod, params);
            return unwrapDllRawPayload(raw, true);
        }
        catch (err) {
            return wrapCaughtDllError(err);
        }
    }
    const runtimeHost = (hostBridge ?? globalThis.ztools);
    const callFn = runtimeHost?.dllplugin?.call;
    if (typeof callFn === 'function') {
        try {
            const raw = await callFn.call(runtimeHost?.dllplugin, pluginName, trimmedMethod, params);
            return unwrapDllRawPayload(raw, false);
        }
        catch (err) {
            return wrapCaughtDllError(err);
        }
    }
    const ipcRes = await callHostTransport('dllplugin_call', {
        plugin: pluginName,
        pluginName,
        func: trimmedMethod,
        method: trimmedMethod,
        params
    }, hostBridge);
    if (ipcRes.ok && ipcRes.data !== undefined && ipcRes.data !== null) {
        return unwrapDllRawPayload(ipcRes.data, false);
    }
    const isExplicitTransportFailure = typeof ipcRes.error === 'string' &&
        ipcRes.error.length > 0 &&
        ipcRes.error !== 'NO_WINDOW_ENV' &&
        !ipcRes.error.startsWith('METHOD_NOT_AVAILABLE:');
    if (isRealElectronHost(hostBridge) ||
        isRealElectronHost() ||
        Boolean(hostBridge?.__isRealHost) ||
        isExplicitTransportFailure) {
        const errMsg = ipcRes.error || `HOST_IPC_FAILED: ${pluginName}.${trimmedMethod} 调用失败`;
        return {
            ok: false,
            code: -1,
            data: null,
            message: errMsg,
            error: errMsg,
            pluginName,
            method: trimmedMethod,
            fromFallback: false
        };
    }
    if (typeof offlineFallback === 'function') {
        const fallbackData = await offlineFallback();
        return {
            ok: true,
            code: 0,
            data: fallbackData,
            pluginName,
            method: trimmedMethod,
            fromFallback: true
        };
    }
    const unavailableMsg = ipcRes.error || `HOST_UNAVAILABLE: ${pluginName}.${trimmedMethod} 宿主接口未就绪`;
    return {
        ok: false,
        code: -1,
        data: null,
        message: unavailableMsg,
        error: unavailableMsg,
        pluginName,
        method: trimmedMethod,
        fromFallback: false
    };
}
export function formatBytes(bytes, decimals = 1) {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0)
        return '0 B';
    if (num < 1024)
        return `${Math.round(num)} B`;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let val = num;
    let idx = 0;
    while (val >= 1024 && idx < units.length - 1) {
        val /= 1024;
        idx += 1;
    }
    const safeDecimals = Math.max(0, Math.floor(decimals));
    return `${val >= 100 ? val.toFixed(0) : val.toFixed(safeDecimals)} ${units[idx]}`;
}
export function joinWinPath(...segments) {
    return segments
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
        .join('\\');
}
export async function getRealEnvPaths(hostOverride) {
    const [homeRaw, appData, downloads, documents, desktop, pictures, videos, music] = await Promise.all([
        getRealSystemPath('home', hostOverride),
        getRealSystemPath('appData', hostOverride),
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('documents', hostOverride),
        getRealSystemPath('desktop', hostOverride),
        getRealSystemPath('pictures', hostOverride),
        getRealSystemPath('videos', hostOverride),
        getRealSystemPath('music', hostOverride)
    ]);
    const home = homeRaw || 'C:\\Users\\Default';
    const isPosix = home.startsWith('/');
    const tempRes = hostOverride ? await getRealSystemPath('temp', hostOverride) : '';
    if (isPosix) {
        return {
            home,
            userProfile: home,
            appData: appData || `${home}/Library/Application Support`,
            localAppData: `${home}/Library/Application Support`,
            temp: tempRes || '/tmp',
            downloads: downloads || `${home}/Downloads`,
            documents: documents || `${home}/Documents`,
            desktop: desktop || `${home}/Desktop`,
            pictures: pictures || `${home}/Pictures`,
            videos: videos || `${home}/Videos`,
            music: music || `${home}/Music`
        };
    }
    return {
        home,
        userProfile: home,
        appData: appData || `${home}\\AppData\\Roaming`,
        localAppData: `${home}\\AppData\\Local`,
        temp: tempRes || `${home}\\AppData\\Local\\Temp`,
        downloads: downloads || `${home}\\Downloads`,
        documents: documents || `${home}\\Documents`,
        desktop: desktop || `${home}\\Desktop`,
        pictures: pictures || `${home}\\Pictures`,
        videos: videos || `${home}\\Videos`,
        music: music || `${home}\\Music`
    };
}
export const resolveRealSpecialPaths = getRealEnvPaths;
export async function readRealDirectory(dirPath, hostOverride) {
    if (!dirPath)
        return [];
    const tree = await scanRealDirectoryTree(dirPath, { maxFiles: 120, hostOverride });
    const entries = [];
    for (const s of tree.subdirs) {
        entries.push(normalizeIndexedFileEntry({
            name: s.name,
            path: s.path,
            isDir: true,
            isDirectory: true,
            size: s.totalBytes,
            mtime: s.mtime
        }));
    }
    for (const f of tree.files) {
        entries.push(f);
    }
    // scanRealDirectoryTree 已在 dir: 扫描无结果时退回一级目录读取；仍为空即目录不存在 / 为空 / 无权限，如实返回空列表
    return entries;
}
export async function moveRealFilesToTrash(paths, hostOverride) {
    let deletedCount = 0;
    const failedPaths = [];
    let lastError;
    for (const p of paths) {
        if (!p)
            continue;
        const res = await trashRealItem(p, hostOverride);
        if (res.ok) {
            deletedCount += 1;
        }
        else {
            failedPaths.push(p);
            if (res.error)
                lastError = res.error;
        }
    }
    return {
        ok: deletedCount > 0 || paths.length === 0,
        trashedCount: deletedCount,
        deletedCount,
        failedPaths,
        error: lastError
    };
}
const CAPABILITY_TO_PLUGIN_MAP = {
    'mover.relocateWithJunction': { plugin: 'MoverPlugin', func: 'relocateWithJunction' },
    'mover.scanCandidates': { plugin: 'MoverPlugin', func: 'scanCandidates' },
    'recovery.restoreFile': { plugin: 'DataRecoveryPlugin', func: 'restoreFile' },
    'recovery.scanDeletedFiles': { plugin: 'DataRecoveryPlugin', func: 'scanDeletedFiles' },
    'shredder.secureWipeFile': { plugin: 'ShredderPlugin', func: 'secureWipeFile' },
    'shredder.scanCandidates': { plugin: 'ShredderPlugin', func: 'scanCandidates' },
    'backup.createSnapshotArchive': { plugin: 'SystemBackupPlugin', func: 'createSnapshotArchive' },
    'backup.restoreSnapshotArchive': { plugin: 'SystemBackupPlugin', func: 'restoreSnapshotArchive' },
    'backup.scanSnapshots': { plugin: 'SystemBackupPlugin', func: 'scanSnapshots' },
    'sqlite.execute': { plugin: 'SqlitePlugin', func: 'execute' },
    'sqlite.query': { plugin: 'SqlitePlugin', func: 'executeQuery' },
    'sqlite.inspectWorkspace': { plugin: 'SqlitePlugin', func: 'inspectWorkspace' }
};
export async function invokeHostCapability(capability, params = {}, hostOverride) {
    const normalizedMethod = capability.replace(/\./g, '_');
    // 若测试显式注入了对应 normalizedMethod 的 mock 函数，优先调用测试桩
    if (hostOverride && typeof hostOverride[normalizedMethod] === 'function') {
        const mockRes = await callHostTransport(normalizedMethod, params, hostOverride);
        return {
            ok: mockRes.ok,
            code: mockRes.ok ? 0 : -1,
            message: mockRes.ok ? 'OK' : mockRes.error || '调用失败',
            data: mockRes.data,
            error: mockRes.error
        };
    }
    if (capability === 'system.info') {
        const drives = await probeRealDiskDrives(['C', 'D', 'E', 'F'], hostOverride);
        return {
            ok: true,
            code: 0,
            message: 'OK',
            data: {
                storage: drives.map(d => ({
                    mount: d.drive,
                    fs: d.drive,
                    size: d.totalBytes,
                    total: d.totalBytes,
                    used: d.usedBytes,
                    available: d.availableBytes,
                    free: d.availableBytes,
                    percent: d.usagePercent
                }))
            }
        };
    }
    if (capability === 'filesystem.deleteItem') {
        const targetPath = String(params.path || params.fullPath || '');
        const tr = await trashRealItem(targetPath, hostOverride);
        return {
            ok: tr.ok,
            code: tr.ok ? 0 : -1,
            message: tr.ok ? '已移入回收站' : tr.error || '删除失败',
            error: tr.error
        };
    }
    if (capability === 'system.showItemInFolder') {
        const targetPath = String(params.path || params.fullPath || '');
        const ok = await showRealItemInFolder(targetPath, hostOverride);
        return { ok, code: ok ? 0 : -1, message: ok ? '已定位文件' : '定位失败' };
    }
    if (capability === 'filesystem.openItem' || capability === 'system.openUrl') {
        const target = String(params.path || params.url || params.fullPath || '');
        const method = capability === 'system.openUrl' ? 'shell_open_external' : 'shell_open_path';
        const res = await callHostTransport(method, capability === 'system.openUrl' ? { url: target } : { fullPath: target }, hostOverride);
        return {
            ok: res.ok,
            code: res.ok ? 0 : -1,
            message: res.ok ? '已打开' : res.error || '打开失败',
            data: res.data,
            error: res.error
        };
    }
    const pluginMapping = CAPABILITY_TO_PLUGIN_MAP[capability];
    if (pluginMapping) {
        const dllRes = await invokePluginService(pluginMapping.plugin, pluginMapping.func, params, hostOverride);
        if (dllRes.ok)
            return dllRes;
        if (hostOverride) {
            const fallbackMock = await callHostTransport(normalizedMethod, params, hostOverride);
            if (fallbackMock.ok) {
                return {
                    ok: true,
                    code: 0,
                    message: 'OK',
                    data: fallbackMock.data
                };
            }
        }
        return dllRes;
    }
    const res = await callHostTransport(normalizedMethod, params, hostOverride);
    return {
        ok: res.ok,
        code: res.ok ? 0 : -1,
        message: res.ok ? 'OK' : res.error || '调用失败',
        data: res.data,
        error: res.error
    };
}
export async function invokePluginService(pluginName, action, params = {}, hostOverride) {
    // 1. 若测试注入了专门拦截 plugin_invoke 的 mock，支持调用
    if (hostOverride && typeof hostOverride.plugin_invoke === 'function') {
        const mockRes = await callHostTransport('plugin_invoke', { plugin: pluginName, action, params }, hostOverride);
        return {
            ok: mockRes.ok,
            code: mockRes.ok ? 0 : -1,
            message: mockRes.ok ? 'OK' : mockRes.error || '插件调用未就绪',
            data: mockRes.data,
            error: mockRes.error
        };
    }
    // 2. 优先走真实 Electron IPC 的 dllplugin_call 通道
    const dllRes = await callHostTransport('dllplugin_call', { plugin: pluginName, func: action, params }, hostOverride);
    if (dllRes.ok) {
        const inner = dllRes.data;
        if (inner && typeof inner === 'object' && typeof inner.error === 'string' && inner.error.length > 0 && inner.ok !== true) {
            return {
                ok: false,
                code: -1,
                message: inner.error,
                error: inner.error
            };
        }
        return {
            ok: true,
            code: 0,
            message: 'OK',
            data: inner
        };
    }
    // 3. 兼容单元测试中通过 transport.call('plugin_invoke') 注入的测试桩
    if (hostOverride) {
        const legacyRes = await callHostTransport('plugin_invoke', { plugin: pluginName, action, params }, hostOverride);
        if (legacyRes.ok) {
            return {
                ok: true,
                code: 0,
                message: 'OK',
                data: legacyRes.data
            };
        }
    }
    // 4. 兼容旧版 globalThis.ztools.dllplugin.call
    const g = globalThis;
    if (!hostOverride && typeof g?.ztools?.dllplugin?.call === 'function') {
        try {
            const raw = await g.ztools.dllplugin.call(pluginName, action, params);
            if (raw && typeof raw === 'object' && raw.ok === false) {
                return {
                    ok: false,
                    code: -1,
                    message: String(raw.error || '调用失败'),
                    error: String(raw.error || '调用失败')
                };
            }
            const data = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
            return { ok: true, code: 0, message: 'OK', data: data };
        }
        catch (err) {
            return {
                ok: false,
                code: -1,
                message: err instanceof Error ? err.message : String(err),
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }
    return {
        ok: false,
        code: -1,
        message: dllRes.error || '插件调用未就绪',
        error: dllRes.error || '插件调用未就绪'
    };
}
const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
function rotr32(x, n) {
    return (x >>> n) | (x << (32 - n));
}
/**
 * 标准 FIPS 180-4 SHA-256 真实字节摘要算法（返回 64 位小写 Hex）
 */
export function computeRealSha256Hex(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input || []);
    const bitLen = bytes.length * 8;
    const padLen = ((bytes.length + 9 + 63) & ~63);
    const buf = new Uint8Array(padLen);
    buf.set(bytes, 0);
    buf[bytes.length] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(padLen - 4, bitLen >>> 0, false);
    let h0 = 0x6a09e667;
    let h1 = 0xbb67ae85;
    let h2 = 0x3c6ef372;
    let h3 = 0xa54ff53a;
    let h4 = 0x510e527f;
    let h5 = 0x9b05688c;
    let h6 = 0x1f83d9ab;
    let h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let offset = 0; offset < padLen; offset += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(offset + i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }
        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0;
        h5 = (h5 + f) >>> 0;
        h6 = (h6 + g) >>> 0;
        h7 = (h7 + h) >>> 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
        .map(v => (v >>> 0).toString(16).padStart(8, '0'))
        .join('');
}
/**
 * 读取本地文件真实字节并计算标准 SHA-256：宿主 filesearch_sha256（只接受 path 字段）优先，Windows 上再试 FileComparePlugin。
 * 都拿不到时返回空字符串，由调用方提示失败；不再把文件按 UTF-8 文本读出来再算（二进制文件会算出错误的值）。
 */
export async function computeRealFileSha256(filePath, hostOverride) {
    if (!filePath || !filePath.trim())
        return '';
    const target = filePath.trim();
    const shaRes = await callHostTransport('filesearch_sha256', { fullPath: target, filePath: target, path: target }, hostOverride);
    if (shaRes.ok && shaRes.data) {
        const hash = typeof shaRes.data === 'string' ? shaRes.data : String(shaRes.data?.sha256 || shaRes.data?.hash || '');
        if (/^[0-9a-f]{64}$/i.test(hash))
            return hash.toLowerCase();
    }
    const dllRes = await invokePluginService('FileComparePlugin', 'computeFileSha256', { path: target }, hostOverride);
    if (dllRes.ok && dllRes.data) {
        const hash = typeof dllRes.data === 'string' ? dllRes.data : String(dllRes.data?.sha256 || dllRes.data?.hash || '');
        if (/^[0-9a-f]{64}$/i.test(hash))
            return hash.toLowerCase();
    }
    return '';
}
export async function readRealClipboardText(hostOverride) {
    const res = await callHostTransport('clipboard_read_text', {}, hostOverride);
    if (res.ok && res.data !== undefined && res.data !== null) {
        if (typeof res.data === 'string')
            return res.data;
        if (typeof res.data?.text === 'string')
            return res.data.text;
    }
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
            return await navigator.clipboard.readText();
        }
    }
    catch {
        // ignore
    }
    return '';
}
export async function writeRealClipboardText(text, hostOverride) {
    const payload = { text: String(text || '') };
    const res = await callHostTransport('clipboard_copy_text', payload, hostOverride);
    if (res.ok)
        return true;
    const fallbackRes = await callHostTransport('clipboard_write_text', payload, hostOverride);
    if (fallbackRes.ok)
        return true;
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(String(text || ''));
            return true;
        }
    }
    catch {
        // ignore
    }
    return false;
}
export async function showRealToast(title, style = 'info') {
    try {
        const { showToast, Toast } = await import('@ztools/declarative-ui');
        await showToast({
            title,
            style: style === 'success'
                ? Toast.Style.Success
                : style === 'failure'
                    ? Toast.Style.Failure
                    : Toast.Style.Animated
        });
    }
    catch {
        // ignore
    }
}
