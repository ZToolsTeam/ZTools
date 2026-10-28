import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { ARCHIVE_CATEGORY_GROUPS, NOT_IN_CLIENT_MESSAGE, describeExtractTarget, formatBytes, fetchRealArchiveCandidates, inspectArchiveEntries, extractArchiveEntries, invokeNativeCapability, openArchiveLocation, summarizeExtractResult, summarizeVerifyResult, trashArchiveFile } from './logic.js';
import { isRealElectronHost } from './native-ipc.js';
export * from './logic.js';
const EMPTY_META = {
    archiveSizeBytes: 0,
    totalUncompressedBytes: 0,
    compressionRatio: 0,
    isEncrypted: false,
    traversalRiskCount: 0,
    hasSingleRootFolder: false,
    singleRootFolderName: null
};
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
function readLaunchFeature() {
    const scope = (globalThis.window || globalThis);
    const ctx = scope.__ztoolsLaunchContext;
    if (!ctx || (ctx.pluginId && ctx.pluginId !== 'archive-manager'))
        return '';
    return String(ctx.featureCode || '').trim();
}
export function ArchiveManagerCommand() {
    const initialCategory = readLaunchFeature() === 'archive-docs' ? '办公文档' : 'ALL';
    const isRealHost = isRealElectronHost();
    const [searchText, setSearchText] = useState('');
    const [archives, setArchives] = useState([]);
    const [hasScanned, setHasScanned] = useState(false);
    const [selectedArchivePath, setSelectedArchivePath] = useState('');
    const [selectedCategory, setSelectedCategory] = useState(initialCategory);
    const [entries, setEntries] = useState([]);
    const [inspectError, setInspectError] = useState('');
    const [checkedEntryIds, setCheckedEntryIds] = useState([]);
    const [archiveMeta, setArchiveMeta] = useState(EMPTY_META);
    const [isLoading, setIsLoading] = useState(false);
    // 切换压缩包时只采用最后一次读取的结果，避免慢的旧结果把别的压缩包内容显示在当前压缩包下
    const inspectSeqRef = useRef(0);
    const extractingRef = useRef(false);
    async function loadArchiveInspection(targetPath, showIndicator = false) {
        if (!targetPath)
            return;
        const seq = ++inspectSeqRef.current;
        setIsLoading(true);
        // 先清掉上一个压缩包的内容，读取失败时不能把旧内容当成当前压缩包显示
        setEntries([]);
        setCheckedEntryIds([]);
        setArchiveMeta(EMPTY_META);
        setInspectError('');
        try {
            const res = await inspectArchiveEntries(targetPath);
            if (seq !== inspectSeqRef.current)
                return;
            if (!res.ok) {
                const reason = res.error || '文件可能已损坏或不是 ZIP 格式';
                setInspectError(reason);
                await showToast({ style: Toast.Style.Failure, title: '读取压缩包失败', message: reason });
                return;
            }
            setEntries(res.entries);
            setArchiveMeta({
                archiveSizeBytes: res.archiveSizeBytes,
                totalUncompressedBytes: res.totalUncompressedBytes,
                compressionRatio: res.compressionRatio,
                isEncrypted: res.isEncrypted,
                traversalRiskCount: res.traversalRiskCount,
                hasSingleRootFolder: res.hasSingleRootFolder,
                singleRootFolderName: res.singleRootFolderName
            });
            if (showIndicator) {
                await showToast({
                    style: Toast.Style.Success,
                    title: '已读取压缩包目录',
                    message: `${res.entries.length} 个文件 · 解压后 ${formatBytes(res.totalUncompressedBytes)}`
                });
            }
        }
        catch (err) {
            if (seq !== inspectSeqRef.current)
                return;
            setInspectError(errorText(err));
            await showToast({ style: Toast.Style.Failure, title: '读取压缩包失败', message: errorText(err) });
        }
        finally {
            if (seq === inspectSeqRef.current)
                setIsLoading(false);
        }
    }
    async function refreshArchivesList(showIndicator = false) {
        setIsLoading(true);
        try {
            const scanned = await fetchRealArchiveCandidates();
            setArchives(scanned);
            setHasScanned(true);
            const activePath = selectedArchivePath && scanned.some((a) => a.path === selectedArchivePath)
                ? selectedArchivePath
                : scanned[0]?.path || '';
            setSelectedArchivePath(activePath);
            if (activePath) {
                await loadArchiveInspection(activePath, showIndicator);
            }
            else {
                inspectSeqRef.current++;
                setEntries([]);
                setCheckedEntryIds([]);
                setArchiveMeta(EMPTY_META);
                setInspectError('');
                if (showIndicator) {
                    await showToast({ style: Toast.Style.Failure, title: '没有找到 ZIP 压缩包', message: '只扫描下载、桌面、文档目录' });
                }
            }
        }
        catch (err) {
            setHasScanned(true);
            await showToast({ style: Toast.Style.Failure, title: '扫描压缩包失败', message: errorText(err) });
        }
        finally {
            setIsLoading(false);
        }
    }
    useEffect(() => {
        if (isRealHost)
            refreshArchivesList(false);
    }, []);
    async function handleSelectArchive(nextPath) {
        setSelectedArchivePath(nextPath);
        setSelectedCategory('ALL');
        await loadArchiveInspection(nextPath, true);
    }
    const checkedSet = new Set(checkedEntryIds);
    const checkedEntries = entries.filter((e) => checkedSet.has(e.id) && !e.hasPathTraversalRisk);
    /** 解压会覆盖目标位置的同名文件，执行前必须让用户确认目标文件夹 */
    async function confirmExtract(selective, count) {
        if (archiveMeta.isEncrypted) {
            await showToast({
                style: Toast.Style.Failure,
                title: '暂不支持解压加密的压缩包',
                message: '这个压缩包含加密条目，客户端目前不能解压'
            });
            return false;
        }
        const target = describeExtractTarget(selectedArchivePath, archiveMeta, selective);
        return confirmAlert({
            title: selective ? `提取 ${count} 个文件？` : '解压全部文件？',
            message: `解压到：${target}\n目标位置已有同名文件会被覆盖。`,
            primaryAction: { title: selective ? '提取' : '解压' }
        });
    }
    async function runExtract(options, progressTitle) {
        extractingRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: progressTitle,
                message: selectedArchivePath.split(/[\\/]/).pop() || ''
            });
            const res = await extractArchiveEntries(selectedArchivePath, options);
            await progressToast?.hide();
            const summary = summarizeExtractResult(res);
            await showToast({
                style: summary.ok ? Toast.Style.Success : Toast.Style.Failure,
                title: summary.title,
                ...(summary.message ? { message: summary.message } : {})
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({ style: Toast.Style.Failure, title: '解压失败', message: errorText(err) });
        }
        finally {
            extractingRef.current = false;
        }
    }
    async function handleExtractAll() {
        if (extractingRef.current)
            return;
        if (!selectedArchivePath || inspectError || entries.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '没有可解压的压缩包',
                message: inspectError ? `读取压缩包失败：${inspectError}` : '请先选择一个能读取的 ZIP 压缩包'
            });
            return;
        }
        if (!(await confirmExtract(false, entries.length)))
            return;
        await runExtract({ smartUnwrap: true }, '正在解压…');
    }
    async function handleExtractSelectedEntries(targetEntries) {
        if (!selectedArchivePath || extractingRef.current)
            return;
        const safeTargets = targetEntries.filter((e) => !e.hasPathTraversalRisk);
        if (safeTargets.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '没有可提取的文件',
                message: '所选条目为空，或路径含 ../ 等越界写法'
            });
            return;
        }
        if (!(await confirmExtract(true, safeTargets.length)))
            return;
        await runExtract({ entryNames: safeTargets.map((e) => e.entryName), smartUnwrap: false }, `正在提取 ${safeTargets.length} 个文件…`);
    }
    async function handleVerifyArchive() {
        if (!selectedArchivePath)
            return;
        let res;
        try {
            res = await invokeNativeCapability('VerifyArchive', { archivePath: selectedArchivePath });
        }
        catch (err) {
            await showToast({ style: Toast.Style.Failure, title: '校验失败', message: errorText(err) });
            return;
        }
        if (!res.ok) {
            await showToast({
                style: Toast.Style.Failure,
                title: '校验失败',
                message: res.error || '压缩包可能已损坏或不是 ZIP 格式'
            });
            return;
        }
        const summary = summarizeVerifyResult(res.data);
        await showToast({
            style: summary.ok ? Toast.Style.Success : Toast.Style.Failure,
            title: summary.title,
            message: summary.message
        });
    }
    async function handleRevealArchive() {
        if (!selectedArchivePath)
            return;
        const ok = await openArchiveLocation(selectedArchivePath);
        if (!ok) {
            await showToast({ style: Toast.Style.Failure, title: '无法在资源管理器中定位', message: selectedArchivePath });
        }
    }
    async function handleTrashArchive() {
        if (!selectedArchivePath)
            return;
        const ok = await confirmAlert({
            title: '将原压缩包移入回收站？',
            message: `${selectedArchivePath}\n可以从回收站恢复。`,
            primaryAction: { title: '移入回收站', style: 'destructive' }
        });
        if (!ok)
            return;
        const tr = await trashArchiveFile(selectedArchivePath);
        if (tr.ok) {
            await showToast({ style: Toast.Style.Success, title: '已将压缩包移入回收站' });
            await refreshArchivesList(false);
        }
        else {
            await showToast({
                style: Toast.Style.Failure,
                title: '移入回收站失败',
                message: tr.error || '压缩包可能正被占用'
            });
        }
    }
    if (!isRealHost) {
        return List({
            searchBarPlaceholder: '搜索包内文件名或路径',
            children: [
                List.Section({
                    title: '压缩包',
                    children: [
                        List.Item({
                            id: 'archive-client-required',
                            title: NOT_IN_CLIENT_MESSAGE,
                            subtitle: '读取和解压压缩包由 Windows 版 ZTools 客户端完成',
                            icon: { source: Icon.Info }
                        })
                    ]
                })
            ]
        });
    }
    const categoryCounts = new Map();
    for (const grp of ARCHIVE_CATEGORY_GROUPS) {
        categoryCounts.set(grp.id, { count: 0, bytes: 0 });
    }
    for (const e of entries) {
        const allStat = categoryCounts.get('ALL');
        allStat.count += 1;
        allStat.bytes += e.uncompressedSize;
        const catStat = categoryCounts.get(e.category) ?? { count: 0, bytes: 0 };
        catStat.count += 1;
        catStat.bytes += e.uncompressedSize;
        categoryCounts.set(e.category, catStat);
    }
    const q = searchText.trim().toLowerCase();
    const filteredEntries = entries.filter((e) => {
        if (selectedCategory !== 'ALL' && e.category !== selectedCategory)
            return false;
        if (!q)
            return true;
        return (e.name.toLowerCase().includes(q) ||
            e.entryName.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q) ||
            e.crc32.toLowerCase().includes(q));
    });
    const maxEntryBytes = Math.max(1, filteredEntries[0]?.uncompressedSize || 1);
    const hasChecked = checkedEntries.length > 0;
    const rightSubListItems = filteredEntries.map((entry) => {
        const isChecked = checkedSet.has(entry.id);
        const volRatio = Math.max(8, Math.min(100, Math.round((entry.uncompressedSize / maxEntryBytes) * 100)));
        const panelChildren = [
            hasChecked
                ? Action({
                    title: `提取已勾选的 ${checkedEntries.length} 个文件`,
                    icon: Icon.Download,
                    onAction: () => handleExtractSelectedEntries(checkedEntries)
                })
                : Action({
                    title: '解压全部',
                    icon: Icon.Download,
                    onAction: handleExtractAll
                }),
            Action({
                title: '在资源管理器中定位压缩包',
                icon: Icon.Folder,
                onAction: handleRevealArchive
            }),
            Action({
                title: `只提取这个文件（${entry.name}）`,
                icon: Icon.Document,
                shortcut: { modifiers: ['ctrl'], key: 's' },
                onAction: () => handleExtractSelectedEntries([entry])
            })
        ];
        if (hasChecked) {
            panelChildren.push(Action({
                title: '解压全部',
                icon: Icon.Download,
                shortcut: { modifiers: ['ctrl'], key: 'e' },
                onAction: handleExtractAll
            }));
        }
        panelChildren.push(Action({
            title: '校验压缩包（目录、越界路径与 SHA-256）',
            icon: Icon.CheckCircle,
            shortcut: { modifiers: ['ctrl'], key: 't' },
            onAction: handleVerifyArchive
        }), Action({
            title: '复制包内路径与 CRC32',
            icon: Icon.CopyClipboard,
            shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
            onAction: async () => {
                const info = `${entry.entryName} (CRC32: ${entry.crc32}, ${formatBytes(entry.uncompressedSize)})`;
                try {
                    await Clipboard.copy(info);
                }
                catch (err) {
                    await showToast({ style: Toast.Style.Failure, title: '复制失败', message: errorText(err) });
                    return;
                }
                await showToast({ style: Toast.Style.Success, title: '已复制包内路径', message: info });
            }
        }), Action({
            title: filteredEntries.length > 0 && filteredEntries.every((item) => checkedSet.has(item.id))
                ? '取消全选'
                : '全选当前列表',
            icon: Icon.CheckCircle,
            shortcut: { modifiers: ['ctrl'], key: 'a' },
            onAction: () => {
                const safeItems = filteredEntries.filter((item) => !item.hasPathTraversalRisk);
                const allChecked = safeItems.length > 0 && safeItems.every((item) => checkedSet.has(item.id));
                setCheckedEntryIds(allChecked ? [] : safeItems.map((item) => item.id));
            }
        }), Action({
            title: '将原压缩包移入回收站',
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            shortcut: { modifiers: [], key: 'delete' },
            onAction: handleTrashArchive
        }));
        return List.Item({
            id: entry.id,
            title: entry.name,
            subtitle: `${entry.entryName} · CRC32: ${entry.crc32}`,
            checkable: !entry.hasPathTraversalRisk,
            checked: isChecked,
            onCheckChange: (checked) => {
                if (entry.hasPathTraversalRisk)
                    return;
                if (checked) {
                    setCheckedEntryIds(Array.from(new Set([...checkedEntryIds, entry.id])));
                }
                else {
                    setCheckedEntryIds(checkedEntryIds.filter((id) => id !== entry.id));
                }
            },
            icon: {
                source: entry.hasPathTraversalRisk ? Icon.ExclamationMark : Icon.Document,
                tintColor: entry.hasPathTraversalRisk ? Color.Red : Color.SecondaryText
            },
            accessories: [
                { progress: { value: volRatio } },
                entry.hasPathTraversalRisk
                    ? { tag: { value: '越界路径，不提取', color: Color.Red } }
                    : { tag: { value: `${entry.category} -${entry.compressionRatio}%` } },
                { text: formatBytes(entry.uncompressedSize) }
            ],
            actions: ActionPanel({ title: entry.name, children: panelChildren })
        });
    });
    const currentArchiveName = archives.find((a) => a.path === selectedArchivePath)?.name ||
        selectedArchivePath.split(/[\\/]/).pop() ||
        '未选择压缩包';
    const summaryText = !hasScanned
        ? '正在扫描下载、桌面、文档目录中的 ZIP 压缩包…'
        : archives.length === 0
            ? '下载、桌面、文档目录中没有找到 ZIP 压缩包，或无法读取这些目录'
            : inspectError
                ? `${currentArchiveName} · 读取失败：${inspectError}`
                : `${currentArchiveName} (${formatBytes(archiveMeta.archiveSizeBytes)}) · ${entries.length} 个文件 · 解压后 ${formatBytes(archiveMeta.totalUncompressedBytes)}${hasChecked ? ` · 已勾选 ${checkedEntries.length} 个` : ''}`;
    const emptyText = !hasScanned
        ? '正在扫描…'
        : archives.length === 0
            ? '没有找到 ZIP 压缩包，或无法读取下载、桌面、文档目录'
            : inspectError
                ? `读取压缩包失败：${inspectError}`
                : '当前分类下没有匹配的文件';
    const diagnosticItems = entries.length > 0
        ? [
            List.Item({
                id: 'diag-root-mode',
                title: '解压位置',
                subtitle: archiveMeta.hasSingleRootFolder
                    ? '包内只有一个顶层文件夹：解压到压缩包所在目录'
                    : '解压到压缩包旁的同名文件夹',
                icon: { source: Icon.Folder, tintColor: Color.SecondaryText },
                accessories: [{ tag: { value: archiveMeta.hasSingleRootFolder ? '单个顶层文件夹' : '同名文件夹' } }],
                actions: ActionPanel({
                    title: '解压位置',
                    children: [Action({ title: '解压全部', icon: Icon.Download, onAction: handleExtractAll })]
                })
            }),
            List.Item({
                id: 'diag-security',
                title: '越界路径与加密检查',
                subtitle: archiveMeta.traversalRiskCount > 0
                    ? `${archiveMeta.traversalRiskCount} 个条目含 ../ 或绝对路径，不会被提取`
                    : archiveMeta.isEncrypted
                        ? '没有越界路径；含加密条目，暂不支持解压'
                        : '没有越界路径',
                icon: {
                    source: archiveMeta.traversalRiskCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                    tintColor: archiveMeta.traversalRiskCount > 0 ? Color.Red : Color.SecondaryText
                },
                accessories: [
                    archiveMeta.traversalRiskCount > 0
                        ? { tag: { value: `${archiveMeta.traversalRiskCount} 个越界`, color: Color.Red } }
                        : { tag: { value: archiveMeta.isEncrypted ? '含加密条目' : '无越界' } }
                ],
                actions: ActionPanel({
                    title: '校验',
                    children: [
                        Action({
                            title: '校验压缩包（目录、越界路径与 SHA-256）',
                            icon: Icon.CheckCircle,
                            onAction: handleVerifyArchive
                        })
                    ]
                })
            })
        ]
        : [];
    return List({
        searchBarPlaceholder: '搜索包内文件名、后缀或路径',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '切换压缩包 (.zip)',
            value: selectedArchivePath,
            onChange: (val) => handleSelectArchive(val),
            children: archives.map((arc) => List.Dropdown.Item({
                title: `${arc.name} (${formatBytes(arc.sizeBytes)})`,
                value: arc.path
            }))
        }),
        filterBar: FilterBar({
            summaryText,
            actions: [
                {
                    id: 'verify-archive-btn',
                    label: '校验',
                    style: 'secondary',
                    onAction: handleVerifyArchive
                },
                {
                    id: 'rescan-archives-btn',
                    label: '重新扫描',
                    style: 'secondary',
                    onAction: () => refreshArchivesList(true)
                }
            ]
        }),
        subList: {
            title: hasChecked
                ? `包内文件（已勾选 ${checkedEntries.length} 个，按 ↵ 提取所选文件）`
                : '包内文件（按解压后大小排列，按 ↵ 解压全部，或勾选后只提取所选文件）',
            subtitle: `${filteredEntries.length} 个 · 解压后共 ${formatBytes(archiveMeta.totalUncompressedBytes)}`,
            checkable: filteredEntries.length > 0,
            checked: filteredEntries.length > 0 && filteredEntries.every((e) => checkedSet.has(e.id))
                ? true
                : filteredEntries.some((e) => checkedSet.has(e.id))
                    ? 'indeterminate'
                    : false,
            onCheckChange: (checked) => {
                const safeIds = filteredEntries.filter((e) => !e.hasPathTraversalRisk).map((e) => e.id);
                setCheckedEntryIds(checked ? safeIds : []);
            },
            emptyText,
            items: rightSubListItems
        },
        children: [
            List.Section({
                title: '按文件类型筛选',
                children: ARCHIVE_CATEGORY_GROUPS.map((grp) => {
                    const stat = categoryCounts.get(grp.id) || { count: 0, bytes: 0 };
                    const isSelected = selectedCategory === grp.id;
                    return List.Item({
                        id: `nav-cat-${grp.id}`,
                        title: grp.name,
                        subtitle: formatBytes(stat.bytes),
                        icon: {
                            source: isSelected ? Icon.CheckCircle : Icon.Folder,
                            tintColor: Color.SecondaryText
                        },
                        accessories: [{ text: `${stat.count} 项` }],
                        actions: ActionPanel({
                            title: grp.name,
                            children: [
                                Action({
                                    title: `筛选查看「${grp.name}」`,
                                    icon: Icon.Filter,
                                    onAction: () => setSelectedCategory(grp.id)
                                }),
                                Action({
                                    title: '解压全部',
                                    icon: Icon.Download,
                                    onAction: handleExtractAll
                                })
                            ]
                        })
                    });
                })
            }),
            ...(diagnosticItems.length > 0 ? [List.Section({ title: '解压前检查', children: diagnosticItems })] : [])
        ]
    });
}
export default ArchiveManagerCommand;
