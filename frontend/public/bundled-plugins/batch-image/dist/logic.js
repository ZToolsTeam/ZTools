/**
 * 批量图片压缩与格式转换：业务逻辑层
 *
 * - 扫描本机 图片 / 下载 / 桌面 目录下的图片（.png / .jpg / .jpeg / .webp / .bmp）
 * - 6 个处理方案，参数映射到宿主图片处理接口真实支持的取值（画质 q70 / q85 / q95，缩放 source / max1920 / max1280）
 * - 逐张调用宿主处理，每张图都显式指定输出路径：输出前避开已存在的同名文件，绝不覆盖原图
 * - 只展示宿主返回的真实结果（输出路径、体积、尺寸），读不到的信息标为未识别，不做估算
 */
import { callHostTransport, formatBytes, getRealSystemPath, invokeDllPluginCapability, scanRealDirectoryTree, showRealItemInFolder, trashRealItem } from './native-ipc.js';
export { formatBytes } from './native-ipc.js';
export const DLL_PLUGIN_NAME = 'BatchImagePlugin';
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i');
export const FORBIDDEN_REASON = '图片批处理输出路径不可指向系统受保护目录或包含路径穿越';
export const IMAGE_SIZE_LIMIT_300KB = 300 * 1024;
/** 输出文件名后缀：<原文件名>_opt.<扩展名> */
export const OUTPUT_SUFFIX = '_opt';
const MAX_NAME_ATTEMPTS = 20;
export const QUALITY_OPTIONS = [
    { label: '中：画质 85，PNG 每通道保留 5 位色深', value: 'q85' },
    { label: '低：画质 70，PNG 每通道保留 4 位色深', value: 'q70' },
    { label: '高：画质 95，PNG 不降色深', value: 'q95' }
];
export const RESIZE_OPTIONS = [
    { label: '保持原始尺寸', value: 'source' },
    { label: '最长边不超过 1920px', value: 'max1920' },
    { label: '最长边不超过 1280px', value: 'max1280' }
];
export const FORMAT_OPTIONS = [
    { label: '保持原格式', value: 'keep' },
    { label: 'JPG', value: 'jpg' },
    { label: 'PNG', value: 'png' }
];
export const IMAGE_WORKSHOP_PRESETS = [
    {
        id: 'preset-smart-lossless',
        title: '常规压缩',
        subtitle: '保持原格式与尺寸，按中档画质重新编码；JPG 与 PNG 都会有轻微画质损失',
        tag: '常规压缩',
        method: 'BatchCompressImage',
        defaultFormat: 'keep',
        defaultQuality: 'q85',
        defaultResize: 'source',
        grayscale: false
    },
    {
        id: 'preset-extreme-300k',
        title: '报销/政务附件压缩（检查 300KB）',
        subtitle: '转为 JPG、低档画质、最长边不超过 1280px，处理后标出仍超过 300KB 的图片',
        tag: '附件 300KB',
        method: 'BatchCompressImage',
        defaultFormat: 'jpg',
        defaultQuality: 'q70',
        defaultResize: 'max1280',
        grayscale: false,
        sizeLimitBytes: IMAGE_SIZE_LIMIT_300KB
    },
    {
        id: 'preset-to-jpg',
        title: '批量转 JPG',
        subtitle: '转为 JPG 格式；带透明背景的图片转换后，透明区域可能变成黑色',
        tag: '转 JPG',
        method: 'BatchConvertFormat',
        defaultFormat: 'jpg',
        defaultQuality: 'q85',
        defaultResize: 'source',
        grayscale: false
    },
    {
        id: 'preset-to-png',
        title: '批量转 PNG',
        subtitle: '转为 PNG 格式并保留透明通道；由 JPG 转换时文件通常会变大',
        tag: '转 PNG',
        method: 'BatchConvertFormat',
        defaultFormat: 'png',
        defaultQuality: 'q95',
        defaultResize: 'source',
        grayscale: false
    },
    {
        id: 'preset-scale-1920',
        title: '限制最长边 1920px',
        subtitle: '最长边超过 1920px 的图片按比例缩小，较小的图片保持原尺寸',
        tag: '限制尺寸',
        method: 'BatchResizeResolution',
        defaultFormat: 'keep',
        defaultQuality: 'q85',
        defaultResize: 'max1920',
        grayscale: false
    },
    {
        id: 'preset-doc-grayscale',
        title: '扫描件转灰度',
        subtitle: '把文档照片或扫描件转为灰度图',
        tag: '转灰度',
        method: 'BatchGrayscaleDoc',
        defaultFormat: 'keep',
        defaultQuality: 'q85',
        defaultResize: 'source',
        grayscale: true
    }
];
export function getCapabilityItems() {
    return IMAGE_WORKSHOP_PRESETS.map((item) => ({ ...item }));
}
export function filterCapabilityItems(items, query) {
    if (!Array.isArray(items))
        return [];
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!q)
        return items;
    return items.filter((item) => {
        if (!item || typeof item.title !== 'string')
            return false;
        return (item.title.toLowerCase().includes(q) ||
            item.subtitle.toLowerCase().includes(q) ||
            item.tag.toLowerCase().includes(q) ||
            item.method.toLowerCase().includes(q));
    });
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
            if (FORBIDDEN_TARGET_PATTERN.test(val)) {
                return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` };
            }
        }
        else if (typeof val === 'number') {
            if (!Number.isFinite(val) || val < 0 || val > 100_000_000) {
                return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` };
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
export const IMAGE_EXT_REGEX = /\.(?:png|jpg|jpeg|webp|bmp)$/i;
/** 本插件生成的输出文件（*_opt、*_opt_2、*_opt_<时间>），扫描时不再重复列入 */
const DERIVED_OUTPUT_REGEX = /_opt(?:_\d+){0,2}\.(?:png|jpg|jpeg|webp|bmp)$/i;
function splitPath(filePath) {
    const sepIdx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    const dir = sepIdx >= 0 ? filePath.slice(0, sepIdx) : '';
    const fileName = sepIdx >= 0 ? filePath.slice(sepIdx + 1) : filePath;
    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
    return { dir, fileName, base, ext };
}
/** 输出扩展名：保持原格式时取原图扩展名（小写），否则取目标格式；识别不到扩展名返回 null */
export function resolveTargetExtension(sourcePath, format) {
    if (format === 'jpg')
        return '.jpg';
    if (format === 'png')
        return '.png';
    const { ext } = splitPath(sourcePath);
    return ext || null;
}
/** 在原图同目录生成 <原文件名><后缀><扩展名> */
export function buildOutputCandidate(sourcePath, targetExt, suffix) {
    const sepIdx = Math.max(sourcePath.lastIndexOf('\\'), sourcePath.lastIndexOf('/'));
    const dirWithSep = sepIdx >= 0 ? sourcePath.slice(0, sepIdx + 1) : '';
    const { base } = splitPath(sourcePath);
    return `${dirWithSep}${base}${suffix}${targetExt}`;
}
/** 批次时间标记（YYYYMMDDHHmmss），用于无法确认同名文件时生成不重复的输出文件名 */
export function makeBatchTag(now = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
/** 查询文件是否存在：true / false 为宿主明确答复，null 表示无法确认（未授权、接口不可用、返回格式异常） */
async function probeFileExists(filePath, hostOverride) {
    const res = await callHostTransport('filesystem_file_exists', { path: filePath }, hostOverride);
    if (!res.ok)
        return null;
    const data = res.data;
    if (typeof data === 'boolean')
        return data;
    if (data && typeof data === 'object' && typeof data.exists === 'boolean') {
        return data.exists;
    }
    return null;
}
/**
 * 选择不会覆盖已有文件的输出路径：
 * 1. 依次尝试 <名>_opt、<名>_opt_2 …，宿主明确答复不存在才使用；
 * 2. 宿主无法确认是否存在时，改用带批次时间标记的文件名（<名>_opt_<时间>），不使用可能已存在的普通名称；
 * 同一批次内已分配的路径与原图路径都不会重复使用。
 */
export async function chooseOutputPath(sourcePath, targetExt, reserved, batchTag, hostOverride) {
    const key = (p) => p.toLowerCase();
    const sourceKey = key(sourcePath);
    const take = (candidate) => {
        reserved.add(key(candidate));
        return candidate;
    };
    for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
        const candidate = buildOutputCandidate(sourcePath, targetExt, n === 1 ? OUTPUT_SUFFIX : `${OUTPUT_SUFFIX}_${n}`);
        if (reserved.has(key(candidate)) || key(candidate) === sourceKey)
            continue;
        const exists = await probeFileExists(candidate, hostOverride);
        if (exists === false)
            return take(candidate);
        if (exists === null)
            break;
    }
    for (let n = 1; n <= 1000; n++) {
        const suffix = n === 1 ? `${OUTPUT_SUFFIX}_${batchTag}` : `${OUTPUT_SUFFIX}_${batchTag}_${n}`;
        const candidate = buildOutputCandidate(sourcePath, targetExt, suffix);
        if (!reserved.has(key(candidate)) && key(candidate) !== sourceKey)
            return take(candidate);
    }
    throw new Error('无法为输出文件生成不重复的文件名');
}
/** 把宿主单张图片的处理结果解析为界面结果；缺少输出信息时按失败处理，不当作成功 */
export function parseHostImageResult(data, fallbackOriginalBytes, sizeLimitBytes) {
    const payload = (data && typeof data === 'object' ? data : {});
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length > 0) {
        const first = errors[0];
        return { status: 'failed', error: String(first?.error || first?.message || '宿主报告处理失败') };
    }
    const results = Array.isArray(payload.results) ? payload.results : [];
    const r = results[0];
    if (!r || typeof r !== 'object') {
        return { status: 'failed', error: '宿主未返回处理结果，无法确认是否已生成输出文件' };
    }
    const outputPath = typeof r.outputPath === 'string' ? r.outputPath.trim() : '';
    const outputBytes = Number(r.outputBytes ?? r.sizeBytes);
    if (!outputPath || !Number.isFinite(outputBytes) || outputBytes <= 0) {
        return { status: 'failed', error: '宿主返回的结果缺少输出文件路径或大小' };
    }
    const rawOriginal = Number(r.originalBytes);
    const originalBytes = Number.isFinite(rawOriginal) && rawOriginal > 0 ? rawOriginal : fallbackOriginalBytes;
    const width = Number(r.width);
    const height = Number(r.height);
    const limit = typeof sizeLimitBytes === 'number' && sizeLimitBytes > 0 ? sizeLimitBytes : null;
    return {
        status: 'done',
        outputPath,
        originalBytes,
        outputBytes,
        width: Number.isFinite(width) && width > 0 ? width : 0,
        height: Number.isFinite(height) && height > 0 ? height : 0,
        notSmaller: originalBytes !== null && outputBytes >= originalBytes,
        overLimitBytes: limit !== null && outputBytes > limit ? limit : null
    };
}
/** 处理一张图片：先选好不覆盖已有文件的输出路径，再以该路径调用宿主 */
export async function processImageFile(file, settings, reserved, batchTag, hostOverride) {
    const targetExt = resolveTargetExtension(file.path, settings.outputFormat);
    if (!targetExt) {
        return { status: 'failed', error: '无法识别图片扩展名，请指定输出格式' };
    }
    try {
        const outputPath = await chooseOutputPath(file.path, targetExt, reserved, batchTag, hostOverride);
        const res = await invokeNativeCapability(settings.method, {
            files: [file.path],
            outputPath,
            outputFormat: settings.outputFormat,
            qualityTier: settings.qualityTier,
            resizePreset: settings.resizePreset,
            grayscale: settings.grayscale
        }, hostOverride);
        if (!res.ok) {
            return { status: 'failed', error: res.error || '宿主图片处理返回失败' };
        }
        return parseHostImageResult(res.data, file.sizeBytes, settings.sizeLimitBytes);
    }
    catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
}
/** 逐张处理；每张完成后回调一次，单张失败不影响其余图片 */
export async function processImageBatch(files, settings, options = {}) {
    const reserved = new Set();
    const batchTag = options.batchTag || makeBatchTag();
    const outcomes = new Map();
    for (const file of files) {
        const outcome = await processImageFile(file, settings, reserved, batchTag, options.hostOverride);
        outcomes.set(file.id, outcome);
        options.onItem?.(file.id, outcome);
    }
    return outcomes;
}
export function summarizeOutcomes(outcomes) {
    const summary = {
        total: 0,
        done: 0,
        failed: 0,
        notSmaller: 0,
        overLimit: 0,
        outputBytes: 0,
        comparableOriginalBytes: 0,
        savedBytes: 0,
        savePercent: 0,
        firstError: ''
    };
    for (const o of outcomes) {
        summary.total += 1;
        if (o.status === 'failed') {
            summary.failed += 1;
            if (!summary.firstError)
                summary.firstError = o.error;
            continue;
        }
        summary.done += 1;
        summary.outputBytes += o.outputBytes;
        if (o.notSmaller)
            summary.notSmaller += 1;
        if (o.overLimitBytes !== null)
            summary.overLimit += 1;
        if (o.originalBytes !== null) {
            summary.comparableOriginalBytes += o.originalBytes;
            summary.savedBytes += Math.max(0, o.originalBytes - o.outputBytes);
        }
    }
    summary.savePercent =
        summary.comparableOriginalBytes > 0 ? Math.round((summary.savedBytes / summary.comparableOriginalBytes) * 100) : 0;
    return summary;
}
/**
 * 从剪贴板文本解析图片路径：每行一个，去掉两端引号；只接受绝对路径与支持的图片扩展名
 */
export function parseClipboardImagePaths(text, limit = 200) {
    if (typeof text !== 'string' || !text.trim())
        return [];
    const out = [];
    const seen = new Set();
    for (const line of text.split(/\r?\n/)) {
        const cleaned = line.trim().replace(/^["']+|["']+$/g, '').trim();
        if (!cleaned)
            continue;
        const isAbsolute = /^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\') || cleaned.startsWith('/');
        if (!isAbsolute || !IMAGE_EXT_REGEX.test(cleaned))
            continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(cleaned);
        if (out.length >= limit)
            break;
    }
    return out;
}
/** 读取文件大小；宿主未授权或接口不可用时返回 null（界面显示「大小未识别」），不填默认值 */
export async function readImageFileSize(filePath, hostOverride) {
    const res = await callHostTransport('filesystem_get_file_size', { path: filePath }, hostOverride);
    if (!res.ok)
        return null;
    const data = res.data;
    const size = typeof data === 'number'
        ? data
        : data && typeof data === 'object'
            ? Number(data.size)
            : NaN;
    return Number.isFinite(size) && size >= 0 ? size : null;
}
/** 由路径构造队列项；大小由调用方传入（读不到时为 null） */
export function makeImageItem(id, filePath, sizeBytes, parentDirOverride) {
    const { dir, fileName, ext } = splitPath(filePath);
    return {
        id,
        name: fileName,
        path: filePath,
        parentDir: parentDirOverride ?? dir,
        extension: ext,
        sizeBytes
    };
}
export const SCAN_TOP_N_PER_DIR = 50;
export async function fetchRealImageWorkspace(hostOverride) {
    const [picturesDir, downloadsDir, desktopDir] = await Promise.all([
        getRealSystemPath('pictures', hostOverride),
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('desktop', hostOverride)
    ]);
    const scannedDirs = [picturesDir, downloadsDir, desktopDir].filter(Boolean);
    if (scannedDirs.length === 0) {
        throw new Error('无法获取图片、下载、桌面目录的路径');
    }
    const files = [];
    const seenPaths = new Set();
    let truncated = false;
    for (const dir of scannedDirs) {
        const scan = await scanRealDirectoryTree(dir, {
            maxDepth: 2,
            maxFiles: 220,
            collectTopN: SCAN_TOP_N_PER_DIR,
            filterExt: IMAGE_EXT_REGEX,
            hostOverride
        });
        if (scan.truncated || scan.files.length >= SCAN_TOP_N_PER_DIR)
            truncated = true;
        for (const f of scan.files) {
            if (f.sizeBytes <= 0)
                continue;
            if (!IMAGE_EXT_REGEX.test(f.name))
                continue;
            // 跳过本插件生成的输出文件，避免对输出再次处理
            if (DERIVED_OUTPUT_REGEX.test(f.name))
                continue;
            const normPath = f.path.toLowerCase();
            if (seenPaths.has(normPath))
                continue;
            seenPaths.add(normPath);
            files.push(makeImageItem(`img-${files.length}-${f.path}`, f.path, f.sizeBytes, dir));
        }
    }
    files.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
    const snapshot = Object.assign([...files], {
        scannedDirs,
        files,
        items: files,
        presets: getCapabilityItems(),
        truncated
    });
    return snapshot;
}
export async function openImageFileLocation(filePath, hostOverride) {
    return showRealItemInFolder(filePath, hostOverride);
}
export async function trashImageFileItem(filePath, hostOverride) {
    if (!filePath || FORBIDDEN_TARGET_PATTERN.test(filePath)) {
        return { ok: false, error: FORBIDDEN_REASON };
    }
    return trashRealItem(filePath, hostOverride);
}
/** 结果状态的短标签（列表行右侧） */
export function describeOutcomeTag(result) {
    if (!result)
        return '待处理';
    if (result.status === 'failed')
        return '失败';
    if (result.overLimitBytes !== null)
        return `超过 ${formatBytes(result.overLimitBytes)}`;
    if (result.notSmaller)
        return `未变小 · ${formatBytes(result.outputBytes)}`;
    const pct = result.originalBytes !== null && result.originalBytes > 0
        ? ` (-${Math.round(((result.originalBytes - result.outputBytes) / result.originalBytes) * 100)}%)`
        : '';
    return `已输出 ${formatBytes(result.outputBytes)}${pct}`;
}
/** 结果说明（列表行副标题） */
export function describeOutcomeDetail(result, parentDir) {
    if (!result)
        return parentDir;
    if (result.status === 'failed')
        return `失败原因：${result.error}`;
    const outName = splitPath(result.outputPath).fileName;
    const dims = result.width > 0 && result.height > 0 ? `${result.width}×${result.height}` : '尺寸未识别';
    return `输出 ${outName} · ${dims}`;
}
