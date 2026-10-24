import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { ARCHIVE_CATEGORY_GROUPS, formatBytes, fetchRealArchiveCandidates, inspectArchiveEntries, extractArchiveEntries, invokeNativeCapability, openArchiveLocation, trashArchiveFile } from './logic.js';
import { isRealElectronHost } from './native-ipc.js';
export * from './logic.js';
const SAMPLE_ARCHIVES = [
    {
        id: 'arc-sample-1',
        name: '2026Q3_华东区客户招标商务全套资料.zip',
        path: 'D:\\Downloads\\2026Q3_华东区客户招标商务全套资料.zip',
        parentDir: 'D:\\Downloads',
        extension: '.zip',
        sizeBytes: Math.round(48.6 * 1024 * 1024),
        mtime: 1729500000
    },
    {
        id: 'arc-sample-2',
        name: 'ZTools_Enterprise_Deployment_Bundle.zip',
        path: 'C:\\Users\\Geek\\Desktop\\ZTools_Enterprise_Deployment_Bundle.zip',
        parentDir: 'C:\\Users\\Geek\\Desktop',
        extension: '.zip',
        sizeBytes: Math.round(19.4 * 1024 * 1024),
        mtime: 1729400000
    }
];
const SAMPLE_ENTRIES = [
    {
        id: 'entry-sample-1',
        entryName: '01_商务标书与报价/2026Q3_技术架构与商务标书终版.pdf',
        name: '2026Q3_技术架构与商务标书终版.pdf',
        category: '办公文档',
        uncompressedSize: Math.round(18.4 * 1024 * 1024),
        compressedSize: Math.round(11.2 * 1024 * 1024),
        compressionRatio: 39,
        crc32: '8F4A2C91',
        isDirectory: false,
        isEncrypted: false,
        hasPathTraversalRisk: false,
        lastModified: '2026-10-20T09:30:00.000Z'
    },
    {
        id: 'entry-sample-2',
        entryName: '02_产品演示录屏/核心模块现场演示高清截图集.png',
        name: '核心模块现场演示高清截图集.png',
        category: '图片与媒体',
        uncompressedSize: Math.round(14.2 * 1024 * 1024),
        compressedSize: Math.round(9.8 * 1024 * 1024),
        compressionRatio: 31,
        crc32: '3C71E04B',
        isDirectory: false,
        isEncrypted: false,
        hasPathTraversalRisk: false,
        lastModified: '2026-10-20T10:15:00.000Z'
    },
    {
        id: 'entry-sample-3',
        entryName: '01_商务标书与报价/分项BOM报价明细表_含税.xlsx',
        name: '分项BOM报价明细表_含税.xlsx',
        category: '办公文档',
        uncompressedSize: Math.round(6.8 * 1024 * 1024),
        compressedSize: Math.round(2.4 * 1024 * 1024),
        compressionRatio: 65,
        crc32: 'A19D44E2',
        isDirectory: false,
        isEncrypted: false,
        hasPathTraversalRisk: false,
        lastModified: '2026-10-20T11:00:00.000Z'
    },
    {
        id: 'entry-sample-4',
        entryName: '03_私有化部署配置/cluster-production-config.json',
        name: 'cluster-production-config.json',
        category: '源码与配置',
        uncompressedSize: Math.round(420 * 1024),
        compressedSize: Math.round(96 * 1024),
        compressionRatio: 77,
        crc32: '77B09E12',
        isDirectory: false,
        isEncrypted: false,
        hasPathTraversalRisk: false,
        lastModified: '2026-10-20T11:20:00.000Z'
    },
    {
        id: 'entry-sample-5',
        entryName: '04_资质附件/ISO27001信息安全管理体系认证副本.pdf',
        name: 'ISO27001信息安全管理体系认证副本.pdf',
        category: '办公文档',
        uncompressedSize: Math.round(5.6 * 1024 * 1024),
        compressedSize: Math.round(4.1 * 1024 * 1024),
        compressionRatio: 27,
        crc32: 'D4508A33',
        isDirectory: false,
        isEncrypted: false,
        hasPathTraversalRisk: false,
        lastModified: '2026-10-20T11:45:00.000Z'
    }
];
export function ArchiveManagerCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'archive-manager') ? String(launchCtx.featureCode || '').trim() : '';
    const initialCategory = initialFeature === 'archive-docs' ? '办公文档' : 'ALL';
    const [searchText, setSearchText] = useState('');
    const isRealHost = isRealElectronHost();
    const [archives, setArchives] = useState(isRealHost ? [] : SAMPLE_ARCHIVES);
    const [selectedArchivePath, setSelectedArchivePath] = useState(isRealHost ? '' : SAMPLE_ARCHIVES[0].path);
    const [selectedCategory, setSelectedCategory] = useState(initialCategory);
    const [entries, setEntries] = useState(isRealHost ? [] : SAMPLE_ENTRIES);
    const [checkedEntryIds, setCheckedEntryIds] = useState([]);
    const [archiveMeta, setArchiveMeta] = useState({
        archiveSizeBytes: isRealHost ? 0 : SAMPLE_ARCHIVES[0].sizeBytes,
        totalUncompressedBytes: isRealHost
            ? 0
            : SAMPLE_ENTRIES.reduce((s, e) => s + e.uncompressedSize, 0),
        compressionRatio: 39,
        isEncrypted: false,
        traversalRiskCount: 0,
        hasSingleRootFolder: false
    });
    const [isLoading, setIsLoading] = useState(false);
    const inspectingRef = useRef(false);
    const extractingRef = useRef(false);
    async function loadArchiveInspection(targetPath, showIndicator = false) {
        if (!targetPath || inspectingRef.current)
            return;
        inspectingRef.current = true;
        setIsLoading(true);
        let progressToast = null;
        try {
            if (showIndicator) {
                progressToast = await showToast({
                    style: Toast.Style.Animated,
                    title: '正在透视压缩包内部目录树...',
                    message: targetPath.split(/[\\/]/).pop() || targetPath
                });
            }
            const res = await inspectArchiveEntries(targetPath);
            await progressToast?.hide();
            if (!res.ok) {
                if (!isRealElectronHost() && SAMPLE_ARCHIVES.some((a) => a.path === targetPath)) {
                    setEntries(SAMPLE_ENTRIES);
                    setCheckedEntryIds([]);
                    return;
                }
                await showToast({
                    style: Toast.Style.Failure,
                    title: '透视压缩包失败',
                    message: res.error || '文件可能已损坏或格式不受支持'
                });
                return;
            }
            setEntries(res.entries);
            setCheckedEntryIds([]);
            setArchiveMeta({
                archiveSizeBytes: res.archiveSizeBytes,
                totalUncompressedBytes: res.totalUncompressedBytes,
                compressionRatio: res.compressionRatio,
                isEncrypted: res.isEncrypted,
                traversalRiskCount: res.traversalRiskCount,
                hasSingleRootFolder: res.hasSingleRootFolder
            });
            if (showIndicator) {
                await showToast({
                    style: Toast.Style.Success,
                    title: '压缩包透视完成',
                    message: `共发现 ${res.entries.length} 个文件 · 解压后 ${formatBytes(res.totalUncompressedBytes)}`
                });
            }
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '读取压缩包异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            inspectingRef.current = false;
            setIsLoading(false);
        }
    }
    async function refreshArchivesList(showIndicator = false) {
        setIsLoading(true);
        try {
            const scanned = await fetchRealArchiveCandidates();
            const nextArchives = isRealElectronHost()
                ? scanned
                : scanned.length > 0
                    ? scanned
                    : SAMPLE_ARCHIVES;
            setArchives(nextArchives);
            const activePath = selectedArchivePath && nextArchives.some((a) => a.path === selectedArchivePath)
                ? selectedArchivePath
                : nextArchives[0]?.path || '';
            if (activePath) {
                setSelectedArchivePath(activePath);
                await loadArchiveInspection(activePath, showIndicator);
            }
            else {
                setEntries([]);
                setCheckedEntryIds([]);
            }
        }
        finally {
            setIsLoading(false);
        }
    }
    useEffect(() => {
        refreshArchivesList(false);
    }, []);
    async function handleSelectArchive(nextPath) {
        setSelectedArchivePath(nextPath);
        setSelectedCategory('ALL');
        await loadArchiveInspection(nextPath, true);
    }
    const checkedSet = new Set(checkedEntryIds);
    const checkedEntries = entries.filter((e) => checkedSet.has(e.id) && !e.hasPathTraversalRisk);
    async function handleSmartExtractAll() {
        if (!selectedArchivePath || extractingRef.current)
            return;
        extractingRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: '正在执行智能防套娃解压...',
                message: selectedArchivePath.split(/[\\/]/).pop() || ''
            });
            const res = await extractArchiveEntries(selectedArchivePath, { smartUnwrap: true });
            await progressToast?.hide();
            if (!res.ok) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: '智能解压未成功',
                    message: res.error || '解压被拦截'
                });
                return;
            }
            await showToast({
                style: Toast.Style.Success,
                title: `已智能解压 ${res.extractedCount} 个文件`,
                message: res.targetDir || '已输出至同级目录'
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '解压执行异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            extractingRef.current = false;
        }
    }
    async function handleExtractSelectedEntries(targetEntries) {
        if (!selectedArchivePath || extractingRef.current)
            return;
        const safeTargets = targetEntries.filter((e) => !e.hasPathTraversalRisk);
        if (safeTargets.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '无可提取的安全条目',
                message: '所选条目为空或包含非法路径越界风险'
            });
            return;
        }
        extractingRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: `正在按需提取 ${safeTargets.length} 个包内文件...`,
                message: safeTargets.map((e) => e.name).slice(0, 3).join('、')
            });
            const res = await extractArchiveEntries(selectedArchivePath, {
                entryNames: safeTargets.map((e) => e.entryName),
                smartUnwrap: false
            });
            await progressToast?.hide();
            if (!res.ok) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: '按需提取失败',
                    message: res.error || '提取失败'
                });
                return;
            }
            await showToast({
                style: Toast.Style.Success,
                title: `已精准提取 ${res.extractedCount || safeTargets.length} 个文件`,
                message: res.targetDir || '已提取到同级目录'
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '按需提取异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            extractingRef.current = false;
        }
    }
    async function handleVerifyArchive() {
        if (!selectedArchivePath)
            return;
        const res = await invokeNativeCapability('VerifyArchive', { archivePath: selectedArchivePath });
        if (!res.ok) {
            await showToast({
                style: Toast.Style.Failure,
                title: '压缩包完整性校验未通过',
                message: res.error || '发现损坏或越界条目'
            });
            return;
        }
        const data = (res.data ?? {});
        const sha = typeof data.sha256 === 'string' ? data.sha256.slice(0, 16) : 'OK';
        await showToast({
            style: Toast.Style.Success,
            title: '压缩包 CRC32 与安全校验通过',
            message: `SHA-256 前缀: ${sha}... · 越界风险: ${Number(data.traversalRiskCount ?? 0)} 项`
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
                {
                    progress: {
                        value: volRatio
                    }
                },
                entry.hasPathTraversalRisk
                    ? {
                        tag: {
                            value: '路径越界拦截',
                            color: Color.Red
                        }
                    }
                    : {
                        tag: {
                            value: `${entry.category} -${entry.compressionRatio}%`
                        }
                    },
                { text: formatBytes(entry.uncompressedSize) }
            ],
            actions: ActionPanel({
                title: entry.name,
                children: [
                    hasChecked
                        ? Action({
                            title: `仅提取已勾选条目 (${checkedEntries.length}项)`,
                            icon: Icon.Download,
                            onAction: () => handleExtractSelectedEntries(checkedEntries)
                        })
                        : Action({
                            title: '智能解压全部 (自动防套娃)',
                            icon: Icon.Bolt,
                            onAction: handleSmartExtractAll
                        }),
                    Action({
                        title: '在资源管理器定位压缩包',
                        icon: Icon.Folder,
                        shortcut: { modifiers: ['ctrl'], key: 'enter' },
                        onAction: async () => {
                            await openArchiveLocation(selectedArchivePath);
                        }
                    }),
                    Action({
                        title: `仅提取当前聚焦文件 (${entry.name})`,
                        icon: Icon.Document,
                        shortcut: { modifiers: ['ctrl'], key: 's' },
                        onAction: () => handleExtractSelectedEntries([entry])
                    }),
                    Action({
                        title: '智能解压全部到同级目录',
                        icon: Icon.Download,
                        shortcut: { modifiers: ['ctrl'], key: 'e' },
                        onAction: handleSmartExtractAll
                    }),
                    Action({
                        title: '校验压缩包完整性与 SHA-256',
                        icon: Icon.CheckCircle,
                        shortcut: { modifiers: ['ctrl'], key: 't' },
                        onAction: handleVerifyArchive
                    }),
                    Action({
                        title: '复制包内相对路径与 CRC32',
                        icon: Icon.CopyClipboard,
                        shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                        onAction: async () => {
                            const info = `${entry.entryName} (CRC32: ${entry.crc32}, Size: ${formatBytes(entry.uncompressedSize)})`;
                            await Clipboard.copy(info);
                            await showToast({ style: Toast.Style.Success, title: '已复制包内条目信息', message: info });
                        }
                    }),
                    Action({
                        title: filteredEntries.length > 0 && filteredEntries.every((item) => checkedSet.has(item.id))
                            ? '取消全选包内条目'
                            : '全选当前包内条目',
                        icon: Icon.CheckCircle,
                        shortcut: { modifiers: ['ctrl'], key: 'a' },
                        onAction: () => {
                            const safeItems = filteredEntries.filter((item) => !item.hasPathTraversalRisk);
                            const allChecked = safeItems.length > 0 && safeItems.every((item) => checkedSet.has(item.id));
                            setCheckedEntryIds(allChecked ? [] : safeItems.map((item) => item.id));
                        }
                    }),
                    Action({
                        title: '将原压缩包移入系统回收站',
                        icon: Icon.Trash,
                        style: Action.Style.Destructive,
                        shortcut: { modifiers: [], key: 'delete' },
                        onAction: async () => {
                            if (!selectedArchivePath)
                                return;
                            const ok = await confirmAlert({
                                title: '确认将原压缩包移入回收站？',
                                message: `压缩包路径: ${selectedArchivePath}\n将安全移入系统回收站。`,
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
                                    title: '移除失败',
                                    message: tr.error || '压缩包可能正被占用'
                                });
                            }
                        }
                    })
                ]
            })
        });
    });
    const currentArchiveName = archives.find((a) => a.path === selectedArchivePath)?.name ||
        selectedArchivePath.split(/[\\/]/).pop() ||
        '未选择压缩包';
    return List({
        searchBarPlaceholder: '搜索包内文件名、后缀或路径 (免解压秒级透视 / 支持勾选单个文件提取)...',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '切换待透视的本机压缩包 (.zip)',
            value: selectedArchivePath,
            onChange: (val) => handleSelectArchive(val),
            children: archives.map((arc) => List.Dropdown.Item({
                title: `${arc.name} (${formatBytes(arc.sizeBytes)})`,
                value: arc.path
            }))
        }),
        filterBar: FilterBar({
            summaryText: `当前归档: ${currentArchiveName} (${formatBytes(archiveMeta.archiveSizeBytes)}) · 包内共 ${entries.length} 项 (解压后 ${formatBytes(archiveMeta.totalUncompressedBytes)} / 压缩率 -${archiveMeta.compressionRatio}%)${hasChecked ? ` · 已勾选 ${checkedEntries.length} 项` : ''}`,
            actions: [
                {
                    id: 'verify-archive-btn',
                    label: '完整性校验',
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
                ? `包内文件明细 (已勾选 ${checkedEntries.length} 项，按 ↵ 仅提取所选文件)`
                : '包内文件明细 (按体积降序，直接按 ↵ 智能解压全部，或勾选提取单个文件)',
            subtitle: `${filteredEntries.length} 项 · 解压后总计 ${formatBytes(archiveMeta.totalUncompressedBytes)}`,
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
            emptyText: '当前压缩包分类下无匹配文件',
            items: rightSubListItems
        },
        children: [
            List.Section({
                title: '包内文件类型透视导航',
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
                                    title: '智能解压全部 (防套娃)',
                                    icon: Icon.Bolt,
                                    onAction: handleSmartExtractAll
                                })
                            ]
                        })
                    });
                })
            }),
            List.Section({
                title: '归档安全与结构诊断',
                children: [
                    List.Item({
                        id: 'diag-root-mode',
                        title: '根目录防散落策略',
                        subtitle: archiveMeta.hasSingleRootFolder
                            ? '单根目录归档：解压时自动剥离多余外层目录'
                            : '多散落文件归档：自动创建同名独立文件夹防桌面散落',
                        icon: { source: Icon.Folder, tintColor: Color.SecondaryText },
                        accessories: [{ tag: { value: archiveMeta.hasSingleRootFolder ? '单根目录' : '自动建夹' } }],
                        actions: ActionPanel({
                            title: '根目录防散落策略',
                            children: [
                                Action({
                                    title: '智能解压全部 (防套娃)',
                                    icon: Icon.Bolt,
                                    onAction: handleSmartExtractAll
                                })
                            ]
                        })
                    }),
                    List.Item({
                        id: 'diag-security',
                        title: 'Zip Slip 越界与加密预检',
                        subtitle: archiveMeta.traversalRiskCount > 0
                            ? `发现 ${archiveMeta.traversalRiskCount} 个包含 ../ 的危险条目，已强制拦截`
                            : '全量包内条目路径合规，无越界覆盖风险',
                        icon: {
                            source: archiveMeta.traversalRiskCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                            tintColor: archiveMeta.traversalRiskCount > 0 ? Color.Red : Color.SecondaryText
                        },
                        accessories: [
                            archiveMeta.traversalRiskCount > 0
                                ? { tag: { value: `拦截 ${archiveMeta.traversalRiskCount} 项`, color: Color.Red } }
                                : { tag: { value: archiveMeta.isEncrypted ? '含加密流' : '安全合规' } }
                        ],
                        actions: ActionPanel({
                            title: '安全校验',
                            children: [
                                Action({
                                    title: '执行完整 SHA-256 与 CRC32 校验',
                                    icon: Icon.CheckCircle,
                                    onAction: handleVerifyArchive
                                })
                            ]
                        })
                    })
                ]
            })
        ]
    });
}
export default ArchiveManagerCommand;
