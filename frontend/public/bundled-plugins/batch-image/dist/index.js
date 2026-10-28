import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { FORMAT_OPTIONS, IMAGE_WORKSHOP_PRESETS, QUALITY_OPTIONS, RESIZE_OPTIONS, SCAN_TOP_N_PER_DIR, describeOutcomeDetail, describeOutcomeTag, fetchRealImageWorkspace, formatBytes, makeImageItem, openImageFileLocation, parseClipboardImagePaths, processImageBatch, readImageFileSize, summarizeOutcomes, trashImageFileItem } from './logic.js';
export * from './logic.js';
/** 插件入口子命令 → 处理方案 */
const FEATURE_TO_PRESET_ID = {
    'preset-lossless': 'preset-smart-lossless',
    'preset-gov-limit': 'preset-extreme-300k',
    'preset-to-jpg': 'preset-to-jpg',
    'preset-doc-bw': 'preset-doc-grayscale'
};
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
export function BatchImageCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'batch-image') ? String(launchCtx.featureCode || '').trim() : '';
    const resolvedPresetId = FEATURE_TO_PRESET_ID[initialFeature] || initialFeature;
    const initialPreset = IMAGE_WORKSHOP_PRESETS.find((p) => p.id === resolvedPresetId) || IMAGE_WORKSHOP_PRESETS[0];
    const [searchText, setSearchText] = useState('');
    const [activePresetId, setActivePresetId] = useState(initialPreset.id);
    const [outputFormat, setOutputFormat] = useState(initialPreset.defaultFormat);
    const [qualityTier, setQualityTier] = useState(initialPreset.defaultQuality);
    const [resizePreset, setResizePreset] = useState(initialPreset.defaultResize);
    const [files, setFiles] = useState([]);
    const [checkedIds, setCheckedIds] = useState([]);
    const [presets, setPresets] = useState(IMAGE_WORKSHOP_PRESETS);
    const [isLoading, setIsLoading] = useState(false);
    const [scanTruncated, setScanTruncated] = useState(false);
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
                    title: '正在扫描图片...',
                    message: '扫描图片、下载、桌面目录'
                });
            }
            const ws = await fetchRealImageWorkspace();
            setFiles(ws.files);
            setCheckedIds(ws.files.map((f) => f.id));
            setPresets(ws.presets);
            setScanTruncated(ws.truncated);
            if (showIndicator) {
                await progressToast?.hide();
                await showToast({
                    style: Toast.Style.Success,
                    title: '图片队列已刷新',
                    message: `找到 ${ws.files.length} 张图片`
                });
            }
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '扫描图片失败',
                message: errorText(err)
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
            setResizePreset(found.defaultResize);
        }
    }
    const activePreset = presets.find((p) => p.id === activePresetId) || IMAGE_WORKSHOP_PRESETS[0];
    async function executeBatchProcess(targetFiles) {
        if (runningRef.current)
            return;
        if (targetFiles.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '请先勾选至少 1 张图片'
            });
            return;
        }
        const settings = {
            method: activePreset.method,
            outputFormat,
            qualityTier,
            resizePreset,
            grayscale: activePreset.grayscale,
            sizeLimitBytes: activePreset.sizeLimitBytes
        };
        runningRef.current = true;
        setIsLoading(true);
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: `正在处理 ${targetFiles.length} 张图片...`,
                message: activePreset.title
            });
            const outcomes = await processImageBatch(targetFiles, settings, {
                onItem: (id, outcome) => {
                    setFiles((prev) => prev.map((item) => {
                        if (item.id !== id)
                            return item;
                        const knownSize = item.sizeBytes ?? (outcome.status === 'done' ? outcome.originalBytes : null);
                        return { ...item, sizeBytes: knownSize, result: outcome };
                    }));
                }
            });
            await progressToast?.hide();
            const summary = summarizeOutcomes(outcomes.values());
            if (summary.done === 0) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: summary.total > 1 ? `${summary.total} 张图片全部处理失败` : '图片处理失败',
                    message: summary.firstError || '宿主图片处理返回失败'
                });
                return;
            }
            if (summary.failed > 0) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: `已处理 ${summary.done} 张，${summary.failed} 张失败`,
                    message: summary.firstError
                });
                return;
            }
            if (summary.overLimit > 0 && settings.sizeLimitBytes) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: `已处理 ${summary.done} 张，${summary.overLimit} 张仍超过 ${formatBytes(settings.sizeLimitBytes)}`,
                    message: '超过限额的图片已在队列中标出'
                });
                return;
            }
            const savedText = summary.comparableOriginalBytes > 0
                ? `，节省 ${formatBytes(summary.savedBytes)} (-${summary.savePercent}%)`
                : '';
            const notSmallerText = summary.notSmaller > 0 ? `；${summary.notSmaller} 张未变小` : '';
            await showToast({
                style: Toast.Style.Success,
                title: `已处理 ${summary.done} 张图片`,
                message: `输出共 ${formatBytes(summary.outputBytes)}${savedText}${notSmallerText}。结果另存为 *_opt 文件，原图未改动`
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '图片处理异常',
                message: errorText(err)
            });
        }
        finally {
            await progressToast?.hide();
            runningRef.current = false;
            setIsLoading(false);
        }
    }
    async function handleAddFromClipboard() {
        let clipText = '';
        try {
            clipText = await Clipboard.readText();
        }
        catch (err) {
            await showToast({
                style: Toast.Style.Failure,
                title: '读取剪贴板失败',
                message: errorText(err)
            });
            return;
        }
        const paths = parseClipboardImagePaths(clipText);
        if (paths.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '剪贴板中没有图片文件路径',
                message: '在资源管理器中右键图片，选择「复制为路径」后再添加（支持 PNG / JPG / WebP / BMP）'
            });
            return;
        }
        const existing = new Set(files.map((f) => f.path.toLowerCase()));
        const fresh = paths.filter((p) => !existing.has(p.toLowerCase()));
        if (fresh.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '这些图片已在队列中',
                message: paths[0]
            });
            return;
        }
        const stamp = Date.now();
        const newItems = [];
        for (let i = 0; i < fresh.length; i++) {
            const p = fresh[i];
            const size = await readImageFileSize(p);
            newItems.push(makeImageItem(`img-clip-${stamp}-${i}`, p, size));
        }
        setFiles((prev) => [...newItems, ...prev]);
        setCheckedIds((prev) => Array.from(new Set([...newItems.map((it) => it.id), ...prev])));
        const unknownSize = newItems.filter((it) => it.sizeBytes === null).length;
        await showToast({
            style: Toast.Style.Success,
            title: `已从剪贴板添加 ${newItems.length} 张图片`,
            message: unknownSize > 0 ? `${unknownSize} 张大小未识别，处理后显示实际大小` : newItems[0].name
        });
    }
    async function handleTrashOriginalImage(file) {
        const outputNote = file.result?.status === 'done'
            ? `已生成的输出文件不受影响：${file.result.outputPath}`
            : '这张图片还没有生成输出文件。';
        const confirmed = await confirmAlert({
            title: '确认将原图移入系统回收站？',
            message: `文件名: ${file.name}\n大小: ${file.sizeBytes === null ? '未识别' : formatBytes(file.sizeBytes)}\n路径: ${file.path}\n\n${outputNote}`,
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
    async function handleRevealInFolder(file) {
        const target = file.result?.status === 'done' ? file.result.outputPath : file.path;
        const ok = await openImageFileLocation(target);
        if (!ok) {
            await showToast({
                style: Toast.Style.Failure,
                title: '无法在资源管理器中显示',
                message: target
            });
        }
    }
    const q = searchText.trim().toLowerCase();
    const filteredFiles = files.filter((f) => !q ||
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q) ||
        f.extension.toLowerCase().includes(q));
    const selectedFiles = files.filter((f) => checkedIds.includes(f.id));
    const selectedKnownBytes = selectedFiles.reduce((acc, f) => acc + (f.sizeBytes ?? 0), 0);
    const selectedUnknown = selectedFiles.filter((f) => f.sizeBytes === null).length;
    const resultSummary = summarizeOutcomes(files.map((f) => f.result).filter((r) => Boolean(r)));
    const hasResults = resultSummary.total > 0;
    const maxImageBytes = Math.max(1, ...files.map((f) => f.sizeBytes ?? 0));
    const outExtLabel = outputFormat === 'keep' ? '原扩展名' : outputFormat;
    const selectedSizeText = `${formatBytes(selectedKnownBytes)}${selectedUnknown > 0 ? `（${selectedUnknown} 张大小未识别）` : ''}`;
    const resultText = hasResults ? ` · 已输出 ${resultSummary.done} 张，失败 ${resultSummary.failed} 张` : '';
    const truncatedText = scanTruncated ? ` · 每个目录最多列出体积最大的 ${SCAN_TOP_N_PER_DIR} 张` : '';
    const rightQueueItems = filteredFiles.map((f) => {
        const isChecked = checkedIds.includes(f.id);
        const accessories = [];
        if (f.sizeBytes !== null) {
            accessories.push({
                progress: { value: Math.max(8, Math.min(100, Math.round((f.sizeBytes / maxImageBytes) * 100))) }
            });
        }
        accessories.push({ tag: { value: describeOutcomeTag(f.result) } });
        accessories.push({ text: f.sizeBytes === null ? '大小未识别' : formatBytes(f.sizeBytes) });
        const doneResult = f.result?.status === 'done' ? f.result : null;
        const actionChildren = [
            Action({
                title: `开始处理已选图片 (${selectedFiles.length} 张)`,
                icon: Icon.Bolt,
                onAction: () => executeBatchProcess(selectedFiles)
            }),
            Action({
                title: doneResult ? '在资源管理器中显示输出文件' : '在资源管理器中显示原图',
                icon: Icon.Folder,
                shortcut: { modifiers: ['ctrl'], key: 'enter' },
                onAction: () => handleRevealInFolder(f)
            }),
            Action({
                title: '仅处理这张图片',
                icon: Icon.Play,
                shortcut: { modifiers: ['ctrl'], key: 's' },
                onAction: () => executeBatchProcess([f])
            })
        ];
        if (doneResult) {
            actionChildren.push(Action({
                title: '复制输出文件路径',
                icon: Icon.CopyClipboard,
                shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                onAction: async () => {
                    try {
                        await Clipboard.copy(doneResult.outputPath);
                        await showToast({ style: Toast.Style.Success, title: '已复制输出文件路径', message: doneResult.outputPath });
                    }
                    catch (err) {
                        await showToast({ style: Toast.Style.Failure, title: '复制失败', message: errorText(err) });
                    }
                }
            }));
        }
        actionChildren.push(Action({
            title: filteredFiles.length > 0 && filteredFiles.every((item) => checkedIds.includes(item.id))
                ? '取消全选当前列表'
                : '全选当前列表',
            icon: Icon.CheckCircle,
            shortcut: { modifiers: ['ctrl'], key: 'a' },
            onAction: () => {
                const allSelected = filteredFiles.length > 0 && filteredFiles.every((item) => checkedIds.includes(item.id));
                setCheckedIds(allSelected ? [] : filteredFiles.map((item) => item.id));
            }
        }), Action({
            title: '将原图移入系统回收站',
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            shortcut: { modifiers: [], key: 'delete' },
            onAction: () => handleTrashOriginalImage(f)
        }));
        return List.Item({
            id: f.id,
            title: f.name,
            subtitle: describeOutcomeDetail(f.result, f.parentDir),
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
            accessories,
            actions: ActionPanel({
                title: f.name,
                children: actionChildren
            })
        });
    });
    return List({
        searchBarPlaceholder: '搜索图片名称、目录或后缀 (PNG / JPG / WebP / BMP)...',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '选择处理方案',
            value: activePresetId,
            onChange: (val) => handleSelectPreset(val),
            children: presets.map((p) => List.Dropdown.Item({
                title: `方案: ${p.tag}`,
                value: p.id
            }))
        }),
        filterBar: FilterBar({
            summaryText: `已选 ${selectedFiles.length}/${files.length} 张 · 原图 ${selectedSizeText}${resultText}${truncatedText}`,
            actions: [
                {
                    id: 'paste-clipboard-image',
                    label: '从剪贴板添加',
                    style: 'secondary',
                    onAction: handleAddFromClipboard
                },
                {
                    id: 'rescan-images',
                    label: '重新扫描',
                    style: 'secondary',
                    onAction: () => refreshWorkspace(true)
                }
            ]
        }),
        workbenchPanel: {
            title: '处理参数',
            subtitle: activePreset.subtitle,
            fields: [
                {
                    id: 'wb-format',
                    label: '输出格式',
                    type: 'select',
                    value: outputFormat,
                    onChange: (val) => setOutputFormat(val),
                    options: FORMAT_OPTIONS
                },
                {
                    id: 'wb-quality',
                    label: '画质档位',
                    type: 'select',
                    value: qualityTier,
                    onChange: (val) => setQualityTier(val),
                    options: QUALITY_OPTIONS
                },
                {
                    id: 'wb-scale',
                    label: '尺寸约束',
                    type: 'select',
                    value: resizePreset,
                    onChange: (val) => setResizePreset(val),
                    options: RESIZE_OPTIONS
                },
                {
                    id: 'wb-outdir',
                    label: '输出位置',
                    type: 'info',
                    value: `原图同目录，另存为 <文件名>_opt.${outExtLabel}；已有同名文件时自动换名，不覆盖原图`
                },
                {
                    id: 'wb-limits',
                    label: '已知限制',
                    type: 'info',
                    value: 'WebP 图片需要本机已安装 ffmpeg；重新编码不保留照片方向标记，部分竖拍照片输出后可能显示为横向'
                }
            ],
            previewCard: {
                title: '处理结果',
                badge: hasResults ? `已输出 ${resultSummary.done} 张` : '未处理',
                subtitle: `当前方案: ${activePreset.title}`,
                metrics: [
                    { label: '已选图片', value: `${selectedFiles.length} / ${files.length} 张` },
                    { label: '已选原图大小', value: selectedSizeText },
                    {
                        label: '输出总大小',
                        value: hasResults && resultSummary.done > 0 ? formatBytes(resultSummary.outputBytes) : '—'
                    },
                    {
                        label: '实际节省',
                        value: resultSummary.comparableOriginalBytes > 0
                            ? `${formatBytes(resultSummary.savedBytes)} (-${resultSummary.savePercent}%)`
                            : '—'
                    },
                    { label: '失败', value: hasResults ? `${resultSummary.failed} 张` : '—' }
                ]
            }
        },
        subList: {
            title: '待处理图片 (勾选后按 Enter 开始处理)',
            subtitle: `${filteredFiles.length} 张图片`,
            checkable: filteredFiles.length > 0,
            checked: filteredFiles.length > 0 && filteredFiles.every((f) => checkedIds.includes(f.id))
                ? true
                : filteredFiles.some((f) => checkedIds.includes(f.id))
                    ? 'indeterminate'
                    : false,
            onCheckChange: (checked) => {
                setCheckedIds(checked ? filteredFiles.map((f) => f.id) : []);
            },
            emptyText: q
                ? '没有匹配的图片'
                : '未在图片、下载、桌面目录找到图片。可在资源管理器中「复制为路径」后点「从剪贴板添加」',
            items: rightQueueItems
        },
        children: [
            List.Section({
                title: `待处理图片 (${filteredFiles.length})`,
                children: rightQueueItems
            })
        ]
    });
}
export default BatchImageCommand;
