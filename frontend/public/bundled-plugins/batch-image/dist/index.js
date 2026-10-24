import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { IMAGE_WORKSHOP_PRESETS, formatBytes, estimateCompressedBytes, fetchRealImageWorkspace, invokeNativeCapability, openImageFileLocation, trashImageFileItem } from './logic.js';
import { isRealElectronHost, readRealClipboardText } from './native-ipc.js';
export * from './logic.js';
const INITIAL_SAMPLE_IMAGES = [
    {
        id: 'img-sample-1',
        name: '产品发布会主视觉海报_4K_原图.png',
        path: 'D:\\Pictures\\Design\\产品发布会主视觉海报_4K_原图.png',
        parentDir: 'D:\\Pictures\\Design',
        extension: '.png',
        sizeBytes: Math.round(4.2 * 1024 * 1024),
        dimensionsText: '3840×2160',
        estimatedCompressedBytes: Math.round(1.1 * 1024 * 1024)
    },
    {
        id: 'img-sample-2',
        name: '财务报销凭证_高拍仪扫描件_01.jpg',
        path: 'C:\\Users\\Geek\\Pictures\\财务报销凭证_高拍仪扫描件_01.jpg',
        parentDir: 'C:\\Users\\Geek\\Pictures',
        extension: '.jpg',
        sizeBytes: Math.round(3.8 * 1024 * 1024),
        dimensionsText: '2560×1440',
        estimatedCompressedBytes: Math.round(420 * 1024)
    },
    {
        id: 'img-sample-3',
        name: '架构设计评审白板拍照_IMG_9082.jpeg',
        path: 'C:\\Users\\Geek\\Downloads\\架构设计评审白板拍照_IMG_9082.jpeg',
        parentDir: 'C:\\Users\\Geek\\Downloads',
        extension: '.jpeg',
        sizeBytes: Math.round(3.1 * 1024 * 1024),
        dimensionsText: '2560×1440',
        estimatedCompressedBytes: Math.round(580 * 1024)
    },
    {
        id: 'img-sample-4',
        name: 'Snipaste_2026-10-22_客户端双栏对比截图.png',
        path: 'C:\\Users\\Geek\\Desktop\\Snipaste_2026-10-22_客户端双栏对比截图.png',
        parentDir: 'C:\\Users\\Geek\\Desktop',
        extension: '.png',
        sizeBytes: Math.round(1.9 * 1024 * 1024),
        dimensionsText: '1920×1080',
        estimatedCompressedBytes: Math.round(540 * 1024)
    },
    {
        id: 'img-sample-5',
        name: '营业执照正本扫描件_政务网上传用.png',
        path: 'D:\\Pictures\\Certs\\营业执照正本扫描件_政务网上传用.png',
        parentDir: 'D:\\Pictures\\Certs',
        extension: '.png',
        sizeBytes: Math.round(1.4 * 1024 * 1024),
        dimensionsText: '1920×1080',
        estimatedCompressedBytes: Math.round(260 * 1024)
    },
    {
        id: 'img-sample-6',
        name: '官网首屏英雄区插画素材_Banner.webp',
        path: 'D:\\Pictures\\Web\\官网首屏英雄区插画素材_Banner.webp',
        parentDir: 'D:\\Pictures\\Web',
        extension: '.webp',
        sizeBytes: Math.round(860 * 1024),
        dimensionsText: '1920×1080',
        estimatedCompressedBytes: Math.round(290 * 1024)
    }
];
const FEATURE_TO_PRESET_ID = {
    'preset-lossless': 'preset-smart-lossless',
    'preset-gov-limit': 'preset-extreme-300k',
    'preset-to-jpg': 'preset-to-jpg',
    'preset-strip-exif': 'preset-strip-exif',
    'preset-merge-pdf': 'preset-merge-pdf',
    'preset-doc-bw': 'preset-doc-grayscale'
};
export function BatchImageCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'batch-image') ? String(launchCtx.featureCode || '').trim() : '';
    const resolvedPresetId = FEATURE_TO_PRESET_ID[initialFeature] || initialFeature;
    const initialPreset = IMAGE_WORKSHOP_PRESETS.find((p) => p.id === resolvedPresetId) || IMAGE_WORKSHOP_PRESETS[0];
    const [searchText, setSearchText] = useState('');
    const [activePresetId, setActivePresetId] = useState(initialPreset.id);
    const [outputFormat, setOutputFormat] = useState(initialPreset.defaultFormat);
    const [qualityTier, setQualityTier] = useState(initialPreset.defaultQuality);
    const [maxEdgePreset, setMaxEdgePreset] = useState(initialPreset.defaultMaxEdge);
    const [stripExif, setStripExif] = useState(true);
    const isRealHost = isRealElectronHost();
    const initialImages = isRealHost ? [] : INITIAL_SAMPLE_IMAGES;
    const [files, setFiles] = useState(initialImages);
    const [checkedIds, setCheckedIds] = useState(initialImages.map((f) => f.id));
    const [presets, setPresets] = useState(IMAGE_WORKSHOP_PRESETS);
    const [isLoading, setIsLoading] = useState(false);
    const runningRef = useRef(false);
    const scanningRef = useRef(false);
    async function refreshWorkspace(showIndicator = false) {
        if (scanningRef.current)
            return;
        scanningRef.current = true;
        setIsLoading(true);
        let progressToast = null;
        try {
            if (showIndicator) {
                progressToast = await showToast({
                    style: Toast.Style.Animated,
                    title: '正在扫描本机图片素材...',
                    message: '检索 Pictures / Downloads / Desktop 目录下的图片'
                });
            }
            const ws = await fetchRealImageWorkspace();
            const nextFiles = isRealElectronHost()
                ? ws.files
                : ws.files.length > 0
                    ? ws.files
                    : INITIAL_SAMPLE_IMAGES;
            setFiles(nextFiles);
            setCheckedIds(nextFiles.map((f) => f.id));
            setPresets(ws.presets);
            if (showIndicator) {
                await progressToast?.hide();
                await showToast({
                    style: Toast.Style.Success,
                    title: '图片队列已刷新',
                    message: `已加载 ${nextFiles.length} 张待处理图片`
                });
            }
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '扫描图片队列失败',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            scanningRef.current = false;
            setIsLoading(false);
        }
    }
    useEffect(() => {
        refreshWorkspace(false);
    }, []);
    function handleSelectPreset(presetId) {
        setActivePresetId(presetId);
        const found = presets.find((p) => p.id === presetId);
        if (found) {
            setOutputFormat(found.defaultFormat);
            setQualityTier(found.defaultQuality);
            setMaxEdgePreset(found.defaultMaxEdge);
        }
    }
    const activePreset = presets.find((p) => p.id === activePresetId) || IMAGE_WORKSHOP_PRESETS[0];
    const baseRatio = qualityTier === '70L'
        ? 0.22
        : qualityTier === '95L'
            ? 0.76
            : activePreset.ratioMultiplier || 0.34;
    const scaleFactor = maxEdgePreset === '1080'
        ? 0.65
        : maxEdgePreset === '1280'
            ? 0.75
            : maxEdgePreset === '1920'
                ? 0.88
                : 1;
    const effectiveRatio = Math.min(0.95, Math.max(0.12, baseRatio * scaleFactor));
    async function executeBatchProcess(targetFiles, forceMergePdf = false) {
        if (runningRef.current)
            return;
        if (targetFiles.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '请先勾选至少 1 张待处理的图片'
            });
            return;
        }
        const methodToCall = forceMergePdf || outputFormat === 'pdf' ? 'MergeImagesToPdf' : activePreset.method;
        const formatToUse = forceMergePdf ? 'pdf' : outputFormat;
        const maxEdgeNum = maxEdgePreset === 'source' ? 0 : Number(maxEdgePreset);
        runningRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: formatToUse === 'pdf'
                    ? `正在将 ${targetFiles.length} 张图片合并为 PDF...`
                    : `正在批量无损处理 ${targetFiles.length} 张图片...`,
                message: `${activePreset.title} · 画质档位 ${qualityTier}`
            });
            const res = await invokeNativeCapability(methodToCall, {
                files: targetFiles.map((f) => f.path),
                format: formatToUse,
                qualityTier,
                maxEdge: maxEdgeNum,
                stripExif,
                grayscale: activePreset.id === 'preset-doc-grayscale'
            });
            await progressToast?.hide();
            if (!res.ok) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: '图片批处理未完成',
                    message: res.error || '宿主图像引擎返回错误'
                });
                return;
            }
            const payload = (res.data ?? {});
            const itemResults = Array.isArray(payload.results)
                ? payload.results
                : [];
            if (itemResults.length > 0) {
                const resultMap = new Map();
                for (const r of itemResults) {
                    if (typeof r.inputPath === 'string') {
                        resultMap.set(r.inputPath.toLowerCase(), r);
                    }
                }
                setFiles((prev) => prev.map((item) => {
                    const matched = resultMap.get(item.path.toLowerCase());
                    if (!matched)
                        return item;
                    const compBytes = Number(matched.compressedBytes ?? item.estimatedCompressedBytes);
                    return {
                        ...item,
                        lastCompressedBytes: compBytes,
                        lastOutputPath: typeof matched.outputPath === 'string' ? matched.outputPath : item.lastOutputPath,
                        zeroRegressionTriggered: Boolean(matched.zeroRegressionTriggered)
                    };
                }));
            }
            const savedText = typeof payload.savedText === 'string' ? payload.savedText : '';
            const savePercent = typeof payload.savePercent === 'number' ? payload.savePercent : 0;
            await showToast({
                style: Toast.Style.Success,
                title: formatToUse === 'pdf'
                    ? `已合成单份 PDF (${targetFiles.length} 张图片)`
                    : `已完成 ${targetFiles.length} 张图片压缩与转换`,
                message: savedText ? `共节省 ${savedText} (-${savePercent}%) · 原图已安全保留` : '已输出至源同级目录 (*_min)'
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '图片批处理异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            runningRef.current = false;
        }
    }
    async function handlePasteImageFromClipboard() {
        const clipText = (await readRealClipboardText()).trim();
        if (clipText && /\.(?:png|jpg|jpeg|webp|bmp)$/i.test(clipText)) {
            const cleanPath = clipText.replace(/^["']|["']$/g, '');
            const fileName = cleanPath.split(/[\\/]/).pop() || 'Clipboard_Image.png';
            const parentDir = cleanPath.slice(0, Math.max(0, cleanPath.length - fileName.length - 1)) || 'C:\\Users\\Clipboard';
            const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
            const newItem = {
                id: `img-clip-${Date.now()}`,
                name: fileName,
                path: cleanPath,
                parentDir,
                extension: ext,
                sizeBytes: 920 * 1024,
                dimensionsText: '1920×1080',
                estimatedCompressedBytes: estimateCompressedBytes(920 * 1024, effectiveRatio, outputFormat, maxEdgePreset)
            };
            setFiles((prev) => [newItem, ...prev.filter((p) => p.path.toLowerCase() !== cleanPath.toLowerCase())]);
            setCheckedIds((prev) => Array.from(new Set([newItem.id, ...prev])));
            await showToast({
                style: Toast.Style.Success,
                title: '已从剪贴板导入图片路径',
                message: fileName
            });
            return;
        }
        await showToast({
            style: Toast.Style.Failure,
            title: '剪贴板中未检测到图片文件路径',
            message: '请先在资源管理器中复制图片文件或路径后再按 Ctrl+V'
        });
    }
    async function handleTrashOriginalImage(file) {
        const confirmed = await confirmAlert({
            title: '确认将原图移入系统回收站？',
            message: `文件名: ${file.name}\n大小: ${formatBytes(file.sizeBytes)}\n路径: ${file.path}\n\n原图将移入系统回收站，已生成的 *_min 压缩件不受影响。`,
            primaryAction: { title: '移入回收站', style: 'destructive' }
        });
        if (!confirmed)
            return;
        const res = await trashImageFileItem(file.path);
        if (!res.ok) {
            await showToast({
                style: Toast.Style.Failure,
                title: '移入回收站失败',
                message: res.error || '文件可能正被占用'
            });
            return;
        }
        setFiles((prev) => prev.filter((item) => item.id !== file.id));
        setCheckedIds((prev) => prev.filter((id) => id !== file.id));
        await showToast({
            style: Toast.Style.Success,
            title: '已将原图移入回收站',
            message: file.name
        });
    }
    const q = searchText.trim().toLowerCase();
    const filteredFiles = files.filter((f) => !q ||
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q) ||
        f.extension.toLowerCase().includes(q));
    const selectedFiles = files.filter((f) => checkedIds.includes(f.id));
    const totalOriginalBytes = selectedFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
    const totalEstimatedBytes = selectedFiles.reduce((acc, f) => acc +
        (f.lastCompressedBytes ??
            estimateCompressedBytes(f.sizeBytes, effectiveRatio, outputFormat, maxEdgePreset)), 0);
    const totalSavedBytes = Math.max(0, totalOriginalBytes - totalEstimatedBytes);
    const totalSavePercent = totalOriginalBytes > 0 ? Math.max(0, Math.round((totalSavedBytes / totalOriginalBytes) * 100)) : 0;
    const maxImageBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1);
    const outExtLabel = outputFormat === 'keep' ? '原格式' : outputFormat.toUpperCase();
    const rightQueueItems = filteredFiles.map((f) => {
        const isChecked = checkedIds.includes(f.id);
        const estOut = f.lastCompressedBytes ??
            estimateCompressedBytes(f.sizeBytes, effectiveRatio, outputFormat, maxEdgePreset);
        const itemSavePct = f.sizeBytes > 0 ? Math.max(0, Math.round(((f.sizeBytes - estOut) / f.sizeBytes) * 100)) : 0;
        const volRatio = Math.max(8, Math.min(100, Math.round((f.sizeBytes / maxImageBytes) * 100)));
        const statusBadge = f.zeroRegressionTriggered
            ? '已达最优·保留原件'
            : `→ ~${formatBytes(estOut)} (-${itemSavePct}%)`;
        return List.Item({
            id: f.id,
            title: f.name,
            subtitle: `${f.dimensionsText} · ${f.parentDir}`,
            checkable: true,
            checked: isChecked,
            onCheckChange: (checked) => {
                if (checked) {
                    setCheckedIds(Array.from(new Set([...checkedIds, f.id])));
                }
                else {
                    setCheckedIds(checkedIds.filter((id) => id !== f.id));
                }
            },
            icon: {
                source: Icon.Image,
                tintColor: Color.SecondaryText
            },
            accessories: [
                {
                    progress: {
                        value: volRatio
                    }
                },
                {
                    tag: {
                        value: statusBadge
                    }
                },
                { text: formatBytes(f.sizeBytes) }
            ],
            actions: ActionPanel({
                title: f.name,
                children: [
                    Action({
                        title: `开始批量处理 (${selectedFiles.length}项)`,
                        icon: Icon.Bolt,
                        onAction: () => executeBatchProcess(selectedFiles, false)
                    }),
                    Action({
                        title: '在资源管理器定位',
                        icon: Icon.Folder,
                        shortcut: { modifiers: ['ctrl'], key: 'enter' },
                        onAction: async () => {
                            await openImageFileLocation(f.lastOutputPath || f.path);
                        }
                    }),
                    Action({
                        title: '粘贴剪贴板截图入列',
                        icon: Icon.Clipboard,
                        shortcut: { modifiers: ['ctrl'], key: 'v' },
                        onAction: handlePasteImageFromClipboard
                    }),
                    Action({
                        title: '复制压缩后图片路径到剪贴板',
                        icon: Icon.CopyClipboard,
                        shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                        onAction: async () => {
                            const targetOut = f.lastOutputPath ||
                                f.path.replace(/(\.[^.]+)$/, `_min.${outputFormat === 'keep' ? f.extension.slice(1) : outputFormat}`);
                            await Clipboard.copy(targetOut);
                            await showToast({ style: Toast.Style.Success, title: '已复制输出文件路径', message: targetOut });
                        }
                    }),
                    Action({
                        title: `仅处理当前聚焦图片 (${f.name})`,
                        icon: Icon.Play,
                        shortcut: { modifiers: ['ctrl'], key: 's' },
                        onAction: () => executeBatchProcess([f], false)
                    }),
                    Action({
                        title: `多图合并导出为单份 PDF (${selectedFiles.length}项)`,
                        icon: Icon.Document,
                        shortcut: { modifiers: ['ctrl'], key: 'm' },
                        onAction: () => executeBatchProcess(selectedFiles.length > 0 ? selectedFiles : [f], true)
                    }),
                    Action({
                        title: filteredFiles.length > 0 && filteredFiles.every((item) => checkedIds.includes(item.id))
                            ? '取消全选当前列表'
                            : '全选当前列表',
                        icon: Icon.CheckCircle,
                        shortcut: { modifiers: ['ctrl'], key: 'a' },
                        onAction: () => {
                            const allSelected = filteredFiles.length > 0 && filteredFiles.every((item) => checkedIds.includes(item.id));
                            setCheckedIds(allSelected ? [] : filteredFiles.map((item) => item.id));
                        }
                    }),
                    Action({
                        title: '将原图移入系统回收站',
                        icon: Icon.Trash,
                        style: Action.Style.Destructive,
                        shortcut: { modifiers: [], key: 'delete' },
                        onAction: () => handleTrashOriginalImage(f)
                    })
                ]
            })
        });
    });
    return List({
        searchBarPlaceholder: '搜索队列图片名称、目录或后缀 (PNG / JPG / WebP / BMP)...',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '选择 8 大办公与政务图片批处理预设方案',
            value: activePresetId,
            onChange: (val) => handleSelectPreset(val),
            children: presets.map((p) => List.Dropdown.Item({
                title: `预设: ${p.tag}`,
                value: p.id
            }))
        }),
        filterBar: FilterBar({
            summaryText: `队列已选 ${selectedFiles.length}/${files.length} 张图片 (原始 ${formatBytes(totalOriginalBytes)}) · 预计瘦身后 ~${formatBytes(totalEstimatedBytes)} (节省 ${formatBytes(totalSavedBytes)} / -${totalSavePercent}%)`,
            actions: [
                {
                    id: 'paste-clipboard-image',
                    label: '粘贴剪贴板图片',
                    style: 'secondary',
                    onAction: handlePasteImageFromClipboard
                },
                {
                    id: 'rescan-images',
                    label: '重新扫描队列',
                    style: 'secondary',
                    onAction: () => refreshWorkspace(true)
                }
            ]
        }),
        workbenchPanel: {
            title: '图片压缩与转换参数工作台',
            subtitle: '零负优化防线 · 原图保护',
            fields: [
                {
                    id: 'wb-format',
                    label: '输出格式',
                    type: 'select',
                    value: outputFormat,
                    onChange: (val) => setOutputFormat(val),
                    options: [
                        { label: '保持原格式 (智能优化)', value: 'keep' },
                        { label: 'JPG (通用白底/报销高兼容)', value: 'jpg' },
                        { label: 'PNG (无损透明通道)', value: 'png' },
                        { label: '合并为单份扫描件 PDF', value: 'pdf' }
                    ]
                },
                {
                    id: 'wb-quality',
                    label: '画质档位',
                    type: 'select',
                    value: qualityTier,
                    onChange: (val) => setQualityTier(val),
                    options: [
                        { label: '85% 视觉无损 (推荐)', value: '85L' },
                        { label: '70% 政务/OA附件极限瘦身', value: '70L' },
                        { label: '95% 印刷级高保真', value: '95L' }
                    ]
                },
                {
                    id: 'wb-scale',
                    label: '尺寸约束',
                    type: 'select',
                    value: maxEdgePreset,
                    onChange: (val) => setMaxEdgePreset(val),
                    options: [
                        { label: '保持原始分辨率', value: 'source' },
                        { label: '最长边限制 1920px (FHD)', value: '1920' },
                        { label: '最长边限制 1280px (HD)', value: '1280' },
                        { label: '最长边限制 1080px (移动端)', value: '1080' }
                    ]
                },
                {
                    id: 'wb-exif',
                    label: '抹除 EXIF 隐私',
                    type: 'toggle',
                    value: stripExif,
                    onChange: (val) => setStripExif(Boolean(val))
                },
                {
                    id: 'wb-outdir',
                    label: '输出位置',
                    type: 'info',
                    value: `源同级目录 (*_min.${outExtLabel}) · 绝不覆写原图`
                }
            ],
            previewCard: {
                title: '批量瘦身与空间释放预估',
                badge: `预计省 ${totalSavePercent}%`,
                subtitle: `当前方案: ${activePreset.title}`,
                metrics: [
                    { label: '原始总体积', value: formatBytes(totalOriginalBytes) },
                    { label: '预计输出体积', value: `~${formatBytes(totalEstimatedBytes)}` },
                    { label: '预计节省空间', value: formatBytes(totalSavedBytes) },
                    { label: '已选待处理', value: `${selectedFiles.length} / ${files.length} 张` }
                ]
            }
        },
        subList: {
            title: '待处理图片队列 (按体积降序，勾选或按 ↵ 立即开始批量压缩)',
            subtitle: `${filteredFiles.length} 张图片 · 原始 ${formatBytes(totalOriginalBytes)} → 预计 ~${formatBytes(totalEstimatedBytes)}`,
            checkable: filteredFiles.length > 0,
            checked: filteredFiles.length > 0 && filteredFiles.every((f) => checkedIds.includes(f.id))
                ? true
                : filteredFiles.some((f) => checkedIds.includes(f.id))
                    ? 'indeterminate'
                    : false,
            onCheckChange: (checked) => {
                setCheckedIds(checked ? filteredFiles.map((f) => f.id) : []);
            },
            emptyText: '当前未找到匹配的图片素材',
            items: rightQueueItems
        },
        children: [
            List.Section({
                title: `待处理图片素材队列 (${filteredFiles.length})`,
                children: rightQueueItems
            })
        ]
    });
}
export default BatchImageCommand;
