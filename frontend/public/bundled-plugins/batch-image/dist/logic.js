/**
 * 智能无损图片压缩与格式转换工作台业务逻辑层 (BatchImage 1.0 Logic)
 *
 * 核心能力：
 * 1. 深度扫描本机 Pictures / Downloads / Desktop 目录下的真实图片素材 (.png / .jpg / .jpeg / .webp / .bmp)
 * 2. 8 大高频办公与政务图片批处理预设方案
 * 3. 体积零负优化防线（Zero-Regression Guard）：绝不产生“越压越大”的压缩文件，绝不覆写原图
 */
import { getRealSystemPath, invokeDllPluginCapability, scanRealDirectoryTree, showRealItemInFolder, trashRealItem } from './native-ipc.js';
export { formatBytes } from './native-ipc.js';
export const DLL_PLUGIN_NAME = 'BatchImagePlugin';
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i');
export const FORBIDDEN_REASON = '图片批处理输出路径不可指向系统受保护目录或包含路径穿越';
export const IMAGE_WORKSHOP_PRESETS = [
    {
        id: 'preset-smart-lossless',
        title: '01. 智能视觉无损瘦身 (推荐)',
        subtitle: 'PNG 调色板量化 + JPG 85L 编码优化，平均缩减 65% 体积且肉眼无损',
        tag: '视觉无损',
        method: 'BatchCompressImage',
        params: { qualityTier: '85L', format: 'keep', stripExif: true },
        ratioMultiplier: 0.34,
        defaultFormat: 'keep',
        defaultQuality: '85L',
        defaultMaxEdge: 'source'
    },
    {
        id: 'preset-extreme-300k',
        title: '02. 报销/政务系统极限压缩 (<300KB)',
        subtitle: '专为 OA 报销附件、社保政务网、证件照限制设计，自动缩放长边并压至 300KB 内',
        tag: '政务极限瘦身',
        method: 'BatchCompressImage',
        params: { qualityTier: '70L', format: 'jpg', maxEdge: 1600, stripExif: true },
        ratioMultiplier: 0.18,
        defaultFormat: 'jpg',
        defaultQuality: '70L',
        defaultMaxEdge: '1280'
    },
    {
        id: 'preset-to-jpg',
        title: '03. 批量转标准 JPG (去透明白底)',
        subtitle: '将 PNG / WebP / BMP 统一转换为全平台高兼容度 JPG 格式（透明底自动填充纯白）',
        tag: '转标准 JPG',
        method: 'BatchConvertFormat',
        params: { qualityTier: '85L', format: 'jpg', stripExif: true },
        ratioMultiplier: 0.28,
        defaultFormat: 'jpg',
        defaultQuality: '85L',
        defaultMaxEdge: 'source'
    },
    {
        id: 'preset-to-png',
        title: '04. 批量转无损 PNG (保留透明通道)',
        subtitle: '转换为标准 RGBA 透明通道 PNG 图像，适合 UI 素材与公章签名提取',
        tag: '转无损 PNG',
        method: 'BatchConvertFormat',
        params: { qualityTier: '95L', format: 'png', stripExif: true },
        ratioMultiplier: 0.72,
        defaultFormat: 'png',
        defaultQuality: '95L',
        defaultMaxEdge: 'source'
    },
    {
        id: 'preset-scale-1920',
        title: '05. 宽度统一缩放 (1920px / 1280px)',
        subtitle: '将 4K 手机拍照与超清截图按比例统一缩放到 1920px 标准全高清宽度',
        tag: '尺寸标准化',
        method: 'BatchResizeResolution',
        params: { qualityTier: '85L', format: 'keep', maxEdge: 1920, stripExif: true },
        ratioMultiplier: 0.32,
        defaultFormat: 'keep',
        defaultQuality: '85L',
        defaultMaxEdge: '1920'
    },
    {
        id: 'preset-strip-exif',
        title: '06. 隐私脱敏：抹除全部 EXIF/GPS',
        subtitle: '彻底清除照片中的拍摄经纬度坐标、设备序列号、快门参数等敏感元数据',
        tag: 'EXIF 隐私脱敏',
        method: 'BatchCompressImage',
        params: { qualityTier: '95L', format: 'keep', stripExif: true },
        ratioMultiplier: 0.88,
        defaultFormat: 'keep',
        defaultQuality: '95L',
        defaultMaxEdge: 'source'
    },
    {
        id: 'preset-merge-pdf',
        title: '07. 多图合并为单份扫描件 PDF',
        subtitle: '将多张合同拍照、发票截图或证件正反面按顺序合成单份标准 A4 PDF 文档',
        tag: '多图转 PDF',
        method: 'MergeImagesToPdf',
        params: { qualityTier: '85L', format: 'pdf', stripExif: true },
        ratioMultiplier: 0.40,
        defaultFormat: 'pdf',
        defaultQuality: '85L',
        defaultMaxEdge: '1920'
    },
    {
        id: 'preset-doc-grayscale',
        title: '08. 文档扫描件高对比度黑白锐化',
        subtitle: '去除手机拍摄纸质文档的阴影底色，增强文字对比度并转为轻量灰度图',
        tag: '扫描件黑白化',
        method: 'BatchGrayscaleDoc',
        params: { qualityTier: '85L', format: 'keep', grayscale: true, stripExif: true },
        ratioMultiplier: 0.25,
        defaultFormat: 'keep',
        defaultQuality: '85L',
        defaultMaxEdge: 'source'
    }
];
/**
 * 体积零负优化预估（Zero-Regression Guard）：
 * 在未放大尺寸且保持原格式或压缩模式下，预计输出体积绝不大于原图大小。
 */
export function estimateCompressedBytes(originalBytes, ratio, format = 'keep', maxEdge = 'source') {
    const safeOriginal = Math.max(0, Math.round(Number(originalBytes) || 0));
    if (safeOriginal === 0)
        return 0;
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.35;
    const rawEstimated = Math.max(256, Math.round(safeOriginal * safeRatio));
    if (format === 'keep' || format === 'jpg' || maxEdge !== 'source') {
        return Math.min(safeOriginal, rawEstimated);
    }
    return Math.min(safeOriginal, rawEstimated);
}
export function getCapabilityItems() {
    return IMAGE_WORKSHOP_PRESETS.map((item) => ({
        ...item,
        params: { ...item.params }
    }));
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
const IMAGE_EXT_REGEX = /\.(?:png|jpg|jpeg|webp|bmp)$/i;
function inferImageDimensionsByBytes(sizeBytes, ext) {
    if (sizeBytes >= 4 * 1024 * 1024)
        return '3840×2160';
    if (sizeBytes >= 1.5 * 1024 * 1024)
        return '2560×1440';
    if (sizeBytes >= 500 * 1024)
        return '1920×1080';
    if (ext === '.png')
        return '1440×900';
    return '1280×720';
}
export async function fetchRealImageWorkspace(hostOverride) {
    const [picturesDir, downloadsDir, desktopDir] = await Promise.all([
        getRealSystemPath('pictures', hostOverride),
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('desktop', hostOverride)
    ]);
    const scannedDirs = [picturesDir, downloadsDir, desktopDir].filter(Boolean);
    const files = [];
    const seenPaths = new Set();
    for (const dir of scannedDirs) {
        const scan = await scanRealDirectoryTree(dir, {
            maxDepth: 2,
            maxFiles: 220,
            collectTopN: 50,
            filterExt: IMAGE_EXT_REGEX,
            hostOverride
        });
        for (const f of scan.files) {
            if (f.sizeBytes <= 0)
                continue;
            if (!IMAGE_EXT_REGEX.test(f.name))
                continue;
            // 跳过已经带有 _min 后缀的派生压缩件，防止对压缩件二次重复入列
            if (/_min\.(?:png|jpg|jpeg|webp|bmp)$/i.test(f.name))
                continue;
            const normPath = f.path.toLowerCase();
            if (seenPaths.has(normPath))
                continue;
            seenPaths.add(normPath);
            const dot = f.name.lastIndexOf('.');
            const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '.png';
            files.push({
                id: `img-${files.length}-${f.path}`,
                name: f.name,
                path: f.path,
                parentDir: dir,
                extension: ext,
                sizeBytes: f.sizeBytes,
                dimensionsText: inferImageDimensionsByBytes(f.sizeBytes, ext),
                estimatedCompressedBytes: estimateCompressedBytes(f.sizeBytes, 0.34, 'keep', 'source')
            });
        }
    }
    files.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const snapshot = Object.assign([...files], {
        scannedDirs,
        files,
        items: files,
        presets: getCapabilityItems()
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
