import React, { Action, ActionPanel, Color, Detail, Form, Icon, List, Toast, confirmAlert, showToast, useEffect, useMemo, useNavigation, useState } from '@ztools/declarative-ui';
import { addCustomDownloadDirectory, cleanExpiredDownloads, cleanRedundantInstallers, computeDashboardSummary, copyDownloadFileEntity, copyDownloadFilePath, filterDownloadEntries, getDownloadCategoryLabel, getDownloadChannelLabel, getCustomDownloadDirectories, openDownloadItem, removeCustomDownloadDirectory, revealDownloadItem, scanDownloadsDirectory, togglePinEntry, trashDownloadItem } from './downloads-service';
function getCategoryIcon(category) {
    switch (category) {
        case 'installer':
            return Icon.Download;
        case 'archive':
            return Icon.Folder;
        case 'document':
            return Icon.Document;
        case 'image':
            return Icon.Image;
        case 'media':
            return Icon.Video;
        case 'code':
            return Icon.Code;
        case 'other':
            return Icon.Document;
    }
}
function resolveInitialFilterFromFeature(featureCode) {
    switch (featureCode) {
        case 'downloads-netdisk':
            return 'netdisk';
        case 'downloads-im':
            return 'im';
        case 'downloads-clean-installers':
            return 'type:installer';
        default:
            return 'all';
    }
}
export function AddCustomDownloadDirectoryForm(props) {
    const { pop } = useNavigation();
    const [dirInput, setDirInput] = useState('');
    return (React.createElement(Form, { navigationTitle: "\u7BA1\u7406\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76D1\u63A7\u76EE\u5F55", actions: React.createElement(ActionPanel, null,
            React.createElement(Action.SubmitForm, { title: "\u6DFB\u52A0\u76D1\u63A7\u76EE\u5F55", icon: Icon.Plus, onSubmit: async (values) => {
                    const rawPath = String(values.dirPath ?? dirInput ?? '').trim();
                    const res = await addCustomDownloadDirectory(rawPath);
                    if (!res.ok || !res.path) {
                        await showToast({
                            style: Toast.Style.Failure,
                            title: '添加目录失败',
                            message: res.error || '请输入合法且可访问的绝对目录路径'
                        });
                        return;
                    }
                    await showToast({
                        style: Toast.Style.Success,
                        title: '已添加自定义监控目录',
                        message: res.path
                    });
                    props.onAdded(res.path);
                    pop();
                } }),
            props.customDirs.map((customDir) => (React.createElement(Action, { key: `rm-${customDir}`, title: `移除自定义目录: ${customDir}`, icon: Icon.Trash, style: Action.Style.Destructive, onAction: async () => {
                    removeCustomDownloadDirectory(customDir);
                    await showToast({
                        style: Toast.Style.Success,
                        title: '已移除监控目录',
                        message: customDir
                    });
                    props.onRemoved(customDir);
                } })))) },
        React.createElement(Form.Description, { title: "\u8BF4\u660E", text: "\u8F93\u5165\u672C\u5730\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u6587\u4EF6\u5939\u7684\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u5982 D:\\MyDownloads \u6216 /Users/name/MyDownloads\uFF09\uFF0C\u63D2\u4EF6\u5C06\u81EA\u52A8\u805A\u5408\u5E76\u5B9E\u65F6\u7D22\u5F15\u8BE5\u76EE\u5F55\u4E0B\u7684\u4E0B\u8F7D\u6587\u4EF6\u3002" }),
        React.createElement(Form.TextField, { id: "dirPath", title: "\u6587\u4EF6\u5939\u7EDD\u5BF9\u8DEF\u5F84", placeholder: "\u4F8B\u5982 D:\\Downloads_Custom", value: dirInput, onChange: (v) => setDirInput(v) })));
}
export function DownloadFileDetailView({ entry }) {
    const markdown = [
        `# ${entry.name}`,
        '',
        `- **来源渠道**: ${entry.sourceLabel} (${getDownloadChannelLabel(entry.channel)})`,
        `- **文件类型**: ${getDownloadCategoryLabel(entry.category)} (\`${entry.ext || '无扩展名'}\`)`,
        `- **文件大小**: \`${entry.sizeFormatted}\` (${entry.sizeBytes.toLocaleString()} Bytes)`,
        `- **修改时间**: \`${entry.modifiedAt}\` (${entry.ageDays === 0 ? '今天' : `${entry.ageDays} 天前`})`,
        `- **完整路径**: \`${entry.path}\``
    ].join('\n');
    return React.createElement(Detail, { navigationTitle: entry.name, markdown: markdown });
}
export default function DownloadsManagerCommand(props) {
    const { push } = useNavigation();
    const activeFeatureCode = props?.launchContext?.featureCode || props?.featureCode;
    const [summary, setSummary] = useState(() => computeDashboardSummary('', [], []));
    const [filterValue, setFilterValue] = useState(() => resolveInitialFilterFromFeature(activeFeatureCode));
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [customDirs, setCustomDirs] = useState(() => getCustomDownloadDirectories());
    const reloadDownloads = async (nextCustomDirs = customDirs) => {
        setIsLoading(true);
        try {
            const realSummary = await scanDownloadsDirectory({
                customDirs: nextCustomDirs,
                maxFilesPerSource: 100
            });
            setSummary(realSummary);
        }
        finally {
            setIsLoading(false);
        }
    };
    useEffect(() => {
        if (activeFeatureCode) {
            setFilterValue(resolveInitialFilterFromFeature(activeFeatureCode));
        }
    }, [activeFeatureCode]);
    useEffect(() => {
        let active = true;
        setIsLoading(true);
        scanDownloadsDirectory({ customDirs, maxFilesPerSource: 100 })
            .then((realSummary) => {
            if (active)
                setSummary(realSummary);
        })
            .finally(() => {
            if (active)
                setIsLoading(false);
        });
        return () => {
            active = false;
        };
    }, []);
    const isInstallerCleanMode = filterValue === 'type:installer' || activeFeatureCode === 'downloads-clean-installers';
    const filteredEntries = useMemo(() => filterDownloadEntries(summary.entries, {
        filterValue,
        query: searchQuery,
        sortBy: isInstallerCleanMode ? 'size' : 'mtime'
    }), [summary.entries, filterValue, searchQuery, isInstallerCleanMode]);
    const groupedSections = useMemo(() => {
        if (isInstallerCleanMode) {
            return [
                {
                    id: 'sec-installers',
                    title: '可清理安装包（按体积从大到小）',
                    subtitle: `${filteredEntries.length} 个安装包 · 共 ${summary.installerSizeFormatted}`,
                    items: filteredEntries
                }
            ];
        }
        const todayItems = [];
        const weekItems = [];
        const olderItems = [];
        for (const item of filteredEntries) {
            if (item.ageDays <= 0) {
                todayItems.push(item);
            }
            else if (item.ageDays <= 7) {
                weekItems.push(item);
            }
            else {
                olderItems.push(item);
            }
        }
        const sections = [];
        if (todayItems.length > 0) {
            sections.push({
                id: 'sec-today',
                title: '今日新增',
                subtitle: `${todayItems.length} 项`,
                items: todayItems
            });
        }
        if (weekItems.length > 0) {
            sections.push({
                id: 'sec-week',
                title: '近 7 天',
                subtitle: `${weekItems.length} 项`,
                items: weekItems
            });
        }
        if (olderItems.length > 0 || sections.length === 0) {
            sections.push({
                id: 'sec-older',
                title: sections.length === 0 ? '下载与接收记录' : '更早之前',
                subtitle: `${olderItems.length} 项`,
                items: olderItems
            });
        }
        return sections;
    }, [filteredEntries, isInstallerCleanMode, summary.installerSizeFormatted]);
    const handleCleanInstallers = async () => {
        if (summary.installerCount === 0) {
            await showToast({
                style: Toast.Style.Animated,
                title: '没有可清理的安装包',
                message: '所有渠道均未发现残留的 .exe / .msi / .dmg / .pkg 安装包'
            });
            return;
        }
        const confirmed = await confirmAlert({
            title: `确认将 ${summary.installerCount} 个安装包移入回收站？`,
            message: `预计可释放 ${summary.installerSizeFormatted} 磁盘空间（已置顶保护项将跳过）。`
        });
        if (!confirmed)
            return;
        const result = await cleanRedundantInstallers(summary.entries);
        setSummary(computeDashboardSummary(summary.downloadDir, result.remainingEntries, summary.sources));
        await showToast({
            style: result.cleanedCount > 0 ? Toast.Style.Success : Toast.Style.Failure,
            title: result.cleanedCount > 0
                ? `已清理 ${result.cleanedCount} 个安装包`
                : '清理安装包未生效',
            message: result.cleanedCount > 0
                ? `释放空间 ${result.freedFormatted}`
                : result.error || '文件可能正在被占用'
        });
    };
    const handleCleanLargeOldFiles = async () => {
        const candidates = summary.entries.filter((e) => e.ageDays >= 30 && e.sizeBytes >= 100 * 1024 * 1024 && !e.isPinned);
        if (candidates.length === 0) {
            await showToast({
                style: Toast.Style.Animated,
                title: '无需清理',
                message: '未发现超过 30 天且大于 100 MB 的未置顶大文件'
            });
            return;
        }
        const confirmed = await confirmAlert({
            title: `确认清理 ${candidates.length} 个 30 天前的大文件 (> 100 MB)？`,
            message: '文件将被安全移入系统回收站，可随时还原。'
        });
        if (!confirmed)
            return;
        const result = await cleanExpiredDownloads(summary.entries, 30, 100 * 1024 * 1024);
        setSummary(computeDashboardSummary(summary.downloadDir, result.remainingEntries, summary.sources));
        await showToast({
            style: result.cleanedCount > 0 ? Toast.Style.Success : Toast.Style.Failure,
            title: `已清理 ${result.cleanedCount} 个过期大文件`,
            message: `释放空间 ${result.freedFormatted}`
        });
    };
    const openCustomDirManager = () => {
        push(React.createElement(AddCustomDownloadDirectoryForm, { customDirs: customDirs, onAdded: (added) => {
                const next = Array.from(new Set([...customDirs, added]));
                setCustomDirs(next);
                void reloadDownloads(next);
            }, onRemoved: (removed) => {
                const next = customDirs.filter((d) => d !== removed);
                setCustomDirs(next);
                void reloadDownloads(next);
            } }));
    };
    const renderGlobalActions = () => (React.createElement(ActionPanel.Section, { title: "\u6279\u91CF\u6E05\u7406\u4E0E\u6E20\u9053\u914D\u7F6E" },
        React.createElement(Action, { title: `一键清理全部安装包 (${summary.installerCount} 个 · ${summary.installerSizeFormatted})`, icon: Icon.Trash, style: Action.Style.Destructive, shortcut: { modifiers: ['ctrl', 'shift'], key: 'backspace' }, onAction: handleCleanInstallers }),
        React.createElement(Action, { title: "\u6E05\u7406 30 \u5929\u524D\u5927\u6587\u4EF6 (> 100 MB)", icon: Icon.Trash, style: Action.Style.Destructive, onAction: handleCleanLargeOldFiles }),
        React.createElement(Action, { title: "\u6DFB\u52A0/\u7BA1\u7406\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76D1\u63A7\u76EE\u5F55...", icon: Icon.Plus, shortcut: { modifiers: ['ctrl'], key: 'n' }, onAction: openCustomDirManager }),
        React.createElement(Action, { title: "\u5237\u65B0\u5168\u6E20\u9053\u626B\u63CF", icon: Icon.ArrowClockwise, shortcut: { modifiers: ['ctrl'], key: 'r' }, onAction: () => reloadDownloads(customDirs) })));
    return (React.createElement(List, { navigationTitle: "\u4E0B\u8F7D\u7BA1\u7406", searchBarPlaceholder: "\u68C0\u7D22\u6587\u4EF6\u540D\u3001\u540E\u7F00(.exe/.pdf/.zip)\u6216\u6765\u6E90(\u5FAE\u4FE1/\u767E\u5EA6\u7F51\u76D8/\u5938\u514B/QQ)...", isLoading: isLoading, isShowingDetail: false, onSearchTextChange: (q) => setSearchQuery(q), filterBar: {
            summaryText: `已聚合 ${summary.sources.length || 1} 个渠道目录 · 共 ${summary.totalCount} 个文件 (${summary.totalSizeFormatted}) · 安装包 ${summary.installerCount} 个 (${summary.installerSizeFormatted})`
        }, searchBarAccessory: React.createElement(List.Dropdown, { tooltip: "\u6309\u6765\u6E90\u6E20\u9053\u6216\u6587\u4EF6\u7C7B\u578B\u7B5B\u9009", value: filterValue, onChange: (val) => setFilterValue(val) },
            React.createElement(List.Dropdown.Section, { title: "\u6309\u6765\u6E90\u6E20\u9053" },
                React.createElement(List.Dropdown.Item, { title: "\u5168\u6E20\u9053\u6C47\u603B", value: "all" }),
                React.createElement(List.Dropdown.Item, { title: "\u529E\u516C IM \u63A5\u6536 (\u5FAE\u4FE1 / \u4F01\u5FAE / QQ / \u98DE\u4E66 / \u9489\u9489)", value: "im" }),
                React.createElement(List.Dropdown.Item, { title: "\u7F51\u76D8\u4E0E\u4E0B\u8F7D\u5668 (\u767E\u5EA6 / \u5938\u514B / \u963F\u91CC / \u8FC5\u96F7 / IDM)", value: "netdisk" }),
                React.createElement(List.Dropdown.Item, { title: "\u6D4F\u89C8\u5668\u4E0E\u7CFB\u7EDF\u4E0B\u8F7D (Downloads)", value: "browser" }),
                React.createElement(List.Dropdown.Item, { title: "\u81EA\u5B9A\u4E49\u76D1\u63A7\u76EE\u5F55", value: "custom" })),
            React.createElement(List.Dropdown.Section, { title: "\u6309\u6587\u4EF6\u7C7B\u578B" },
                React.createElement(List.Dropdown.Item, { title: `安装包 (.exe / .msi / .dmg / .pkg) [${summary.installerCount}]`, value: "type:installer" }),
                React.createElement(List.Dropdown.Item, { title: "\u529E\u516C\u6587\u6863 (.pdf / .docx / .xlsx / .pptx)", value: "type:document" }),
                React.createElement(List.Dropdown.Item, { title: "\u538B\u7F29\u5F52\u6863 (.zip / .7z / .rar / .tar)", value: "type:archive" }),
                React.createElement(List.Dropdown.Item, { title: "\u56FE\u7247\u8BBE\u8BA1 (.png / .jpg / .webp / .svg)", value: "type:image" }),
                React.createElement(List.Dropdown.Item, { title: "\u97F3\u89C6\u9891\u5A92\u4F53 (.mp4 / .mkv / .mp3 / .wav)", value: "type:media" }),
                React.createElement(List.Dropdown.Item, { title: "\u4EE3\u7801\u4E0E\u6570\u636E (.json / .sql / .ts / .py)", value: "type:code" }))) }, filteredEntries.length === 0 ? (React.createElement(List.Section, { title: "\u5F53\u524D\u7B5B\u9009\u72B6\u6001" },
        React.createElement(List.Item, { id: "downloads-empty", icon: { source: Icon.Folder, tintColor: Color.SecondaryText }, title: isLoading ? '正在扫描全渠道下载与接收目录...' : '当前筛选条件下暂无下载文件', subtitle: "\u53EF\u5207\u6362\u53F3\u4E0A\u89D2\u6E20\u9053\u7B5B\u9009\uFF08\u5168\u6E20\u9053 / \u529E\u516C IM / \u7F51\u76D8\u4E0B\u8F7D / \u5B89\u88C5\u5305\uFF09\uFF0C\u6216\u6309 Ctrl+N \u6DFB\u52A0\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76D1\u63A7\u76EE\u5F55", actions: React.createElement(ActionPanel, null,
                React.createElement(Action, { title: "\u91CD\u7F6E\u4E3A\u5168\u6E20\u9053\u6C47\u603B", icon: Icon.ArrowClockwise, onAction: () => {
                        setFilterValue('all');
                        setSearchQuery('');
                    } }),
                renderGlobalActions()) }))) : (groupedSections.map((section) => (React.createElement(List.Section, { key: section.id, title: section.title, subtitle: section.subtitle }, section.items.map((item) => (React.createElement(List.Item, { key: item.id, id: item.id, icon: {
            source: getCategoryIcon(item.category),
            tintColor: Color.SecondaryText
        }, title: item.name, subtitle: `${item.sourceLabel} · ${getDownloadCategoryLabel(item.category)}`, keywords: [
            item.ext,
            item.category,
            item.channel,
            item.sourceLabel,
            item.appName,
            getDownloadCategoryLabel(item.category)
        ], accessories: [
            ...(item.isPinned ? [{ tag: { value: '已置顶', color: Color.SecondaryText } }] : []),
            { tag: { value: item.sourceLabel, color: Color.SecondaryText } },
            { text: item.sizeFormatted },
            { text: item.ageDays === 0 ? `今天 ${item.modifiedAt.slice(11)}` : `${item.ageDays} 天前` }
        ], actions: React.createElement(ActionPanel, null,
            React.createElement(ActionPanel.Section, { title: item.name },
                React.createElement(Action, { title: "\u6253\u5F00\u6587\u4EF6", icon: Icon.Document, onAction: async () => {
                        const ok = await openDownloadItem(item.path);
                        await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? `已打开: ${item.name}` : '无法打开文件',
                            message: item.path
                        });
                    } }),
                React.createElement(Action, { title: "\u6253\u5F00\u6240\u5728\u6587\u4EF6\u5939\u5E76\u9009\u4E2D", icon: Icon.Folder, shortcut: { modifiers: ['ctrl'], key: 'enter' }, onAction: async () => {
                        const ok = await revealDownloadItem(item.path);
                        await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? '已在资源管理器中定位文件' : '无法定位文件',
                            message: item.path
                        });
                    } }),
                React.createElement(Action, { title: "\u590D\u5236\u6587\u4EF6\u5B9E\u4F53\uFF08\u53EF\u76F4\u63A5\u7C98\u8D34\u5230\u5FAE\u4FE1/\u684C\u9762\uFF09", icon: Icon.Clipboard, shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' }, onAction: async () => {
                        const res = await copyDownloadFileEntity(item.path);
                        await showToast({
                            style: res.ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: res.ok ? `已复制文件实体: ${item.name}` : '复制文件实体失败',
                            message: res.ok ? '可直接按 Ctrl+V 粘贴到聊天窗口或文件夹' : res.error
                        });
                    } }),
                React.createElement(Action, { title: "\u590D\u5236\u5B8C\u6574\u8DEF\u5F84", icon: Icon.Clipboard, shortcut: { modifiers: ['ctrl'], key: 'c' }, onAction: async () => {
                        const ok = await copyDownloadFilePath(item.path);
                        await showToast({
                            style: ok ? Toast.Style.Success : Toast.Style.Failure,
                            title: ok ? '已复制完整路径' : '复制路径失败',
                            message: item.path
                        });
                    } }),
                React.createElement(Action, { title: item.isPinned ? '取消置顶保护' : '置顶并保护（跳过自动清理）', icon: Icon.Pin, shortcut: { modifiers: ['ctrl'], key: 'p' }, onAction: () => {
                        const next = togglePinEntry(summary.entries, item.id);
                        setSummary(computeDashboardSummary(summary.downloadDir, next, summary.sources));
                    } }),
                React.createElement(Action, { title: "\u79FB\u5165\u56DE\u6536\u7AD9", icon: Icon.Trash, style: Action.Style.Destructive, shortcut: { modifiers: ['ctrl'], key: 'backspace' }, onAction: async () => {
                        const confirmed = await confirmAlert({
                            title: `确认将「${item.name}」移入回收站？`,
                            message: `文件大小: ${item.sizeFormatted}\n来源: ${item.path}`
                        });
                        if (!confirmed)
                            return;
                        const res = await trashDownloadItem(summary.entries, item.id);
                        if (!res.ok) {
                            await showToast({
                                style: Toast.Style.Failure,
                                title: '移入回收站失败',
                                message: res.error || '文件可能正在被占用'
                            });
                            return;
                        }
                        setSummary(computeDashboardSummary(summary.downloadDir, res.remainingEntries, summary.sources));
                        await showToast({
                            style: Toast.Style.Success,
                            title: `已移入回收站: ${item.name}`,
                            message: `释放空间 ${item.sizeFormatted}`
                        });
                    } })),
            renderGlobalActions()) })))))))));
}
