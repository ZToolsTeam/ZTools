/**
 * 全能解压缩与包内透视工作台业务逻辑层 (ArchiveManager 1.0 Logic)
 *
 * 核心能力：
 * 1. 免解压秒级透视 .zip 内部文件树、CRC32 摘要、压缩率与文件分类
 * 2. 自动识别 UTF-8 与 GBK/GB18030 编码，彻底解决 Windows 与 macOS 互传中文名乱码
 * 3. 智能解压（防套娃 & 防桌面散落）+ 按勾选只提取包内需要的单个办公文档
 * 4. 严密 Zip Slip 路径穿越 (`../`) 安全拦截与加密包预检
 */
import { getRealSystemPath, invokeDllPluginCapability, scanRealDirectoryTree, showRealItemInFolder, trashRealItem } from './native-ipc.js';
export { formatBytes } from './native-ipc.js';
export const DLL_PLUGIN_NAME = 'ArchiveManagerPlugin';
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i');
export const FORBIDDEN_REASON = '归档提取目标路径不可指向系统受保护目录或包含路径穿越 (Zip Slip)';
export const ARCHIVE_CATEGORY_GROUPS = [
    { id: 'ALL', name: '全部包内文件' },
    { id: '办公文档', name: '办公文档 (.pdf/.docx/.xlsx)' },
    { id: '图片与媒体', name: '图片与媒体 (.png/.jpg/.mp4)' },
    { id: '源码与配置', name: '源码与配置 (.ts/.json/.sql)' },
    { id: '可执行程序', name: '可执行程序 (.exe/.msi)' },
    { id: '其他文件', name: '其他文件' }
];
/**
 * 校验包内相对路径是否存在 Zip Slip (`../` 或绝对路径) 越界风险
 */
export function isUnsafeEntryPath(entryName) {
    const norm = String(entryName || '').replace(/\\/g, '/');
    if (!norm || norm.includes('\0'))
        return true;
    if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm))
        return true;
    const segments = norm.split('/');
    return segments.some((seg) => seg === '..');
}
export function classifyEntryCategory(fileName, isDirectory = false) {
    if (isDirectory)
        return '文件夹';
    const dot = fileName.lastIndexOf('.');
    const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
    if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv'].includes(ext)) {
        return '办公文档';
    }
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.mp4', '.mov', '.mp3', '.wav'].includes(ext)) {
        return '图片与媒体';
    }
    if ([
        '.ts',
        '.tsx',
        '.js',
        '.mjs',
        '.cjs',
        '.json',
        '.py',
        '.rs',
        '.go',
        '.java',
        '.c',
        '.cpp',
        '.cs',
        '.html',
        '.css',
        '.sql',
        '.xml',
        '.yaml',
        '.yml'
    ].includes(ext)) {
        return '源码与配置';
    }
    if (['.exe', '.msi', '.dll', '.bat', '.cmd', '.ps1', '.sh'].includes(ext)) {
        return '可执行程序';
    }
    return '其他文件';
}
export function validateInvocationPayload(method, params) {
    if (typeof method !== 'string' || method.trim().length === 0) {
        return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' };
    }
    if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
        return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' };
    }
    if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
        return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' };
    }
    const record = params;
    for (const [key, val] of Object.entries(record)) {
        if (typeof val === 'string') {
            if (val.length > 4096) {
                return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` };
            }
            if ((key === 'targetDir' || key === 'outputDir' || key === 'outputPath') && FORBIDDEN_TARGET_PATTERN.test(val)) {
                return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` };
            }
        }
    }
    return { valid: true };
}
export async function invokeNativeCapability(method, params, hostBridge) {
    const check = validateInvocationPayload(method, params);
    if (!check.valid) {
        throw new Error(check.error || '参数校验失败');
    }
    const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge);
    return {
        ok: res.ok,
        pluginName: DLL_PLUGIN_NAME,
        method: method.trim(),
        data: res.data ?? undefined,
        error: res.error,
        fromFallback: res.fromFallback
    };
}
const ARCHIVE_EXT_REGEX = /\.(?:zip)$/i;
export async function fetchRealArchiveCandidates(hostOverride) {
    const [downloadsDir, desktopDir, documentsDir] = await Promise.all([
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('desktop', hostOverride),
        getRealSystemPath('documents', hostOverride)
    ]);
    const scannedDirs = [downloadsDir, desktopDir, documentsDir].filter(Boolean);
    const candidates = [];
    const seen = new Set();
    for (const dir of scannedDirs) {
        const scan = await scanRealDirectoryTree(dir, {
            maxDepth: 2,
            maxFiles: 200,
            collectTopN: 40,
            filterExt: ARCHIVE_EXT_REGEX,
            hostOverride
        });
        for (const f of scan.files) {
            if (f.sizeBytes <= 0)
                continue;
            if (!ARCHIVE_EXT_REGEX.test(f.name))
                continue;
            const norm = f.path.toLowerCase();
            if (seen.has(norm))
                continue;
            seen.add(norm);
            const dot = f.name.lastIndexOf('.');
            candidates.push({
                id: `arc-${candidates.length}-${f.path}`,
                name: f.name,
                path: f.path,
                parentDir: dir,
                extension: dot > 0 ? f.name.slice(dot).toLowerCase() : '.zip',
                sizeBytes: f.sizeBytes,
                mtime: f.mtime
            });
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime || b.sizeBytes - a.sizeBytes);
    return candidates;
}
export async function inspectArchiveEntries(archivePath, hostOverride) {
    if (!archivePath || !archivePath.trim()) {
        return {
            ok: false,
            archivePath: '',
            archiveName: '',
            archiveSizeBytes: 0,
            totalEntries: 0,
            fileCount: 0,
            totalUncompressedBytes: 0,
            totalCompressedBytes: 0,
            compressionRatio: 0,
            encryptedCount: 0,
            isEncrypted: false,
            traversalRiskCount: 0,
            hasSingleRootFolder: false,
            singleRootFolderName: null,
            entries: [],
            error: '压缩包路径不能为空'
        };
    }
    const res = await invokeNativeCapability('ListArchiveEntries', { archivePath: archivePath.trim() }, hostOverride);
    if (!res.ok || !res.data || typeof res.data !== 'object') {
        return {
            ok: false,
            archivePath,
            archiveName: archivePath.split(/[\\/]/).pop() || archivePath,
            archiveSizeBytes: 0,
            totalEntries: 0,
            fileCount: 0,
            totalUncompressedBytes: 0,
            totalCompressedBytes: 0,
            compressionRatio: 0,
            encryptedCount: 0,
            isEncrypted: false,
            traversalRiskCount: 0,
            hasSingleRootFolder: false,
            singleRootFolderName: null,
            entries: [],
            error: res.error || '透视压缩包失败'
        };
    }
    const raw = res.data;
    const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
    const entries = rawEntries
        .filter((e) => !e.isDirectory)
        .map((e, idx) => {
        const entryName = String(e.entryName ?? e.name ?? '');
        const baseName = String(e.name ?? (entryName.split('/').pop() || entryName));
        const uncomp = Number(e.uncompressedSize ?? 0);
        const comp = Number(e.compressedSize ?? 0);
        const hasRisk = Boolean(e.hasPathTraversalRisk) || isUnsafeEntryPath(entryName);
        return {
            id: `entry-${idx}-${entryName}`,
            entryName,
            name: baseName,
            category: String(e.category ?? classifyEntryCategory(baseName, false)),
            uncompressedSize: uncomp,
            compressedSize: comp,
            compressionRatio: Number(e.compressionRatio ?? (uncomp > 0 ? Math.round((1 - comp / uncomp) * 100) : 0)),
            crc32: String(e.crc32 ?? '00000000'),
            isDirectory: false,
            isEncrypted: Boolean(e.isEncrypted),
            hasPathTraversalRisk: hasRisk,
            lastModified: String(e.lastModified ?? '')
        };
    })
        .sort((a, b) => b.uncompressedSize - a.uncompressedSize);
    const traversalRiskCount = entries.filter((e) => e.hasPathTraversalRisk).length;
    const encryptedCount = entries.filter((e) => e.isEncrypted).length;
    return {
        ok: true,
        archivePath: String(raw.archivePath ?? archivePath),
        archiveName: String(raw.archiveName ?? (archivePath.split(/[\\/]/).pop() || archivePath)),
        archiveSizeBytes: Number(raw.archiveSizeBytes ?? 0),
        totalEntries: Number(raw.totalEntries ?? entries.length),
        fileCount: entries.length,
        totalUncompressedBytes: Number(raw.totalUncompressedBytes ?? entries.reduce((acc, e) => acc + e.uncompressedSize, 0)),
        totalCompressedBytes: Number(raw.totalCompressedBytes ?? entries.reduce((acc, e) => acc + e.compressedSize, 0)),
        compressionRatio: Number(raw.compressionRatio ?? 0),
        encryptedCount,
        isEncrypted: Boolean(raw.isEncrypted) || encryptedCount > 0,
        traversalRiskCount: Math.max(Number(raw.traversalRiskCount ?? 0), traversalRiskCount),
        hasSingleRootFolder: Boolean(raw.hasSingleRootFolder),
        singleRootFolderName: typeof raw.singleRootFolderName === 'string' ? raw.singleRootFolderName : null,
        entries
    };
}
export async function extractArchiveEntries(archivePath, options = {}, hostOverride) {
    if (Array.isArray(options.entryNames) && options.entryNames.some((n) => isUnsafeEntryPath(n))) {
        return {
            ok: false,
            extractedCount: 0,
            extractedFiles: [],
            blockedEntries: options.entryNames.filter((n) => isUnsafeEntryPath(n)),
            error: `ZIP_SLIP_BLOCKED: ${FORBIDDEN_REASON}`
        };
    }
    const res = await invokeNativeCapability('ExtractArchiveEntries', {
        archivePath,
        ...(options.entryNames && options.entryNames.length > 0 ? { entryNames: options.entryNames } : {}),
        ...(options.targetDir ? { targetDir: options.targetDir } : {}),
        smartUnwrap: options.smartUnwrap !== false,
        flattenSelected: Boolean(options.flattenSelected)
    }, hostOverride);
    if (!res.ok) {
        return {
            ok: false,
            extractedCount: 0,
            extractedFiles: [],
            blockedEntries: [],
            error: res.error || '解压提取失败'
        };
    }
    const payload = (res.data ?? {});
    return {
        ok: true,
        targetDir: typeof payload.targetDir === 'string' ? payload.targetDir : undefined,
        extractedCount: Number(payload.extractedCount ?? 0),
        extractedFiles: Array.isArray(payload.extractedFiles) ? payload.extractedFiles.map(String) : [],
        blockedEntries: Array.isArray(payload.blockedEntries) ? payload.blockedEntries.map(String) : []
    };
}
export async function openArchiveLocation(targetPath, hostOverride) {
    return showRealItemInFolder(targetPath, hostOverride);
}
export async function trashArchiveFile(archivePath, hostOverride) {
    if (!archivePath || FORBIDDEN_TARGET_PATTERN.test(archivePath)) {
        return { ok: false, error: FORBIDDEN_REASON };
    }
    return trashRealItem(archivePath, hostOverride);
}
