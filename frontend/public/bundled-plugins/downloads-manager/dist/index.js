import React, { Action, ActionPanel, Color, Detail, Form, Icon, List, Toast, confirmAlert, showToast, useEffect, useMemo, useNavigation, useState, useRef } from '@ztools/declarative-ui';
import { addCustomDownloadDirectory, cleanExpiredDownloads, cleanRedundantInstallers, computeDashboardSummary, copyDownloadFileEntity, copyDownloadFilePath, filterDownloadEntries, getDownloadCategoryLabel, getCustomDownloadDirectories, openDownloadItem, removeCustomDownloadDirectory, revealDownloadItem, scanDownloadsDirectory, selectDownloadDirectory, togglePinEntry, trashDownloadItem } from './downloads-service.js';
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
    const [selectedDir, setSelectedDir] = useState('');
    const busy = useRef(false);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    return (React.createElement(Form, { navigationTitle: "\u7BA1\u7406\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76D1\u63A7\u76EE\u5F55", actions: React.createElement(ActionPanel, null,
            React.createElement(Action.SubmitForm, { title: "\u9009\u62E9\u5E76\u6DFB\u52A0\u76EE\u5F55", icon: Icon.Plus, onSubmit: async () => {
                    if (busy.current || !alive.current)
                        return;
                    busy.current = true;
                    try {
                        const selected = await selectDownloadDirectory();
                        if (!selected || !alive.current)
                            return;
                        setSelectedDir(selected);
                        const res = await addCustomDownloadDirectory(selected, undefined, () => alive.current);
                        if (!alive.current)
                            return;
                        if (!res.ok || !res.path)
                            throw new Error(res.error || '目录未能保存');
                        await showToast({ style: Toast.Style.Success, title: '已添加自定义目录', message: res.path });
                        if (alive.current) {
                            props.onAdded(res.path);
                            pop();
                        }
                    }
                    catch (error) {
                        if (alive.current)
                            await showToast({ style: Toast.Style.Failure, title: '添加目录失败', message: error instanceof Error ? error.message : String(error) });
                    }
                    finally {
                        busy.current = false;
                    }
                } }),
            props.customDirs.map((customDir) => (React.createElement(Action, { key: `rm-${customDir}`, title: `移除自定义目录: ${customDir}`, icon: Icon.Trash, style: Action.Style.Destructive, onAction: async () => {
                    if (busy.current || !alive.current)
                        return;
                    busy.current = true;
                    try {
                        await removeCustomDownloadDirectory(customDir);
                        if (!alive.current)
                            return;
                        props.onRemoved(customDir);
                        await showToast({ style: Toast.Style.Success, title: '已移除目录配置', message: '文件保持原样' });
                        pop();
                    }
                    catch (error) {
                        if (alive.current)
                            await showToast({ style: Toast.Style.Failure, title: '未能保存目录配置', message: error instanceof Error ? error.message : String(error) });
                    }
                    finally {
                        busy.current = false;
                    }
                } })))) },
        React.createElement(Form.Description, { title: "\u8BF4\u660E", text: "\u901A\u8FC7\u7CFB\u7EDF\u7A97\u53E3\u9009\u62E9\u8981\u805A\u5408\u7684\u6587\u4EF6\u5939\uFF0C\u6388\u4E88\u8BBF\u95EE\u6743\u9650\u540E\u4FDD\u5B58\uFF1B\u76EE\u5F55\u53D8\u5316\u540E\u6267\u884C\u5237\u65B0\u3002\u79FB\u9664\u914D\u7F6E\u4E0D\u4F1A\u5220\u9664\u6587\u4EF6\u3002" }),
        selectedDir && React.createElement(Form.Description, { title: "\u4E0A\u6B21\u9009\u62E9\u7684\u76EE\u5F55", text: selectedDir })));
}
export function DownloadFileDetailView({ entry }) {
    const content = `文件：${entry.name}
来源：${entry.sourceLabel}
类型：${getDownloadCategoryLabel(entry.category)}
大小：${entry.sizeFormatted}
修改时间：${entry.modifiedAt}
路径：${entry.path}`;
    let size = 3;
    for (const run of content.matchAll(/`+/g))
        size = Math.max(size, run[0].length + 1);
    const fence = '`'.repeat(size);
    const markdown = `${fence}text\n${content.replace(/\r\n?/g, '\n')}\n${fence}`;
    return React.createElement(Detail, { navigationTitle: entry.name, markdown: markdown });
}
export default function DownloadsManagerCommand(props) {
    const { push } = useNavigation();
    const activeFeatureCode = props?.launchContext?.featureCode || props?.featureCode;
    const [summary, setSummary] = useState(() => computeDashboardSummary('', [], []));
    const [filterValue, setFilterValue] = useState(() => resolveInitialFilterFromFeature(activeFeatureCode));
    const [searchQuery, setSearchQuery] = useState('');
    const [isLoading, setIsLoading] = useState(true);
    const [customDirs, setCustomDirs] = useState([]);
    const [loadError, setLoadError] = useState('');
    const generation = useRef(0), alive = useRef(true), busy = useRef(false);
    useEffect(() => () => { alive.current = false; generation.current++; }, []);
    const reloadDownloads = async (nextCustomDirs) => {
        if (busy.current)
            return;
        const request = ++generation.current;
        setIsLoading(true);
        setLoadError('');
        try {
            const directories = nextCustomDirs ?? await getCustomDownloadDirectories();
            const result = await scanDownloadsDirectory({ customDirs: directories, maxFilesPerSource: 100, shouldContinue: () => alive.current && request === generation.current });
            if (!alive.current || request !== generation.current)
                return;
            setCustomDirs(directories);
            setSummary(result);
        }
        catch (error) {
            if (!alive.current || request !== generation.current)
                return;
            const message = error instanceof Error ? error.message : String(error);
            setLoadError(message);
            await showToast({ style: Toast.Style.Failure, title: '下载列表未更新', message });
        }
        finally {
            if (alive.current && request === generation.current)
                setIsLoading(false);
        }
    };
    useEffect(() => { void reloadDownloads(); }, []);
    useEffect(() => { setFilterValue(resolveInitialFilterFromFeature(activeFeatureCode)); }, [activeFeatureCode]);
    const runMutation = async (operation) => {
        if (busy.current || !alive.current)
            return;
        busy.current = true;
        generation.current++;
        setIsLoading(true);
        try {
            await operation();
        }
        catch (error) {
            if (alive.current)
                await showToast({ style: Toast.Style.Failure, title: '操作未完成', message: error instanceof Error ? error.message : String(error) });
        }
        finally {
            busy.current = false;
            if (alive.current)
                setIsLoading(false);
        }
    };
    const isInstallerCleanMode = filterValue === 'type:installer';
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
            if (item.ageDays !== null && item.ageDays <= 0) {
                todayItems.push(item);
            }
            else if (item.ageDays !== null && item.ageDays <= 7) {
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
    const cleanVisible = async (installers) => runMutation(async () => {
        const candidates = filteredEntries.filter(item => !item.isPinned && (installers ? item.category === 'installer' : item.ageDays !== null && item.ageDays >= 30 && item.sizeBytes >= 100 * 1024 * 1024));
        if (!candidates.length) {
            await showToast({ style: Toast.Style.Failure, title: '当前列表没有符合条件的未保护文件' });
            return;
        }
        const confirmed = await confirmAlert({ title: `将当前列表中 ${candidates.length} 个文件移入回收站？`,
            message: candidates.map(item => item.path).join('\n') + '\n仅处理这些文件；保护项会跳过。移入回收站不会立即释放磁盘空间。' });
        if (!confirmed || !alive.current)
            return;
        const result = installers ? await cleanRedundantInstallers(candidates, undefined, () => alive.current) : await cleanExpiredDownloads(candidates, 30, 100 * 1024 * 1024, undefined, () => alive.current);
        const remaining = new Set(result.remainingEntries.map(item => item.id)), targets = new Set(candidates.map(item => item.id));
        if (!alive.current)
            return;
        setSummary(current => computeDashboardSummary(current.downloadDir, current.entries.filter(item => !targets.has(item.id) || remaining.has(item.id)), current.sources, current));
        const failures = result.failedPaths?.length ?? 0;
        await showToast({ style: failures || !result.cleanedCount ? Toast.Style.Failure : Toast.Style.Success,
            title: `已移入回收站 ${result.cleanedCount} 个${failures ? `，失败 ${failures} 个` : ''}`,
            message: result.error || `移动文件合计 ${result.freedFormatted}；回收站保留原文件。` });
    });
    const handleCleanInstallers = () => cleanVisible(true);
    const handleCleanLargeOldFiles = () => cleanVisible(false);
    const openCustomDirManager = () => {
        push(React.createElement(AddCustomDownloadDirectoryForm, { customDirs: customDirs, onAdded: (added) => {
                if (alive.current)
                    void reloadDownloads();
            }, onRemoved: (removed) => {
                if (alive.current)
                    void reloadDownloads();
            } }));
    };
    const renderGlobalActions = () => (React.createElement(ActionPanel.Section, { title: "\u6279\u91CF\u6E05\u7406\u4E0E\u6E20\u9053\u914D\u7F6E" },
        React.createElement(Action, { title: "\u6E05\u7406\u5F53\u524D\u5217\u8868\u7684\u672A\u4FDD\u62A4\u5B89\u88C5\u5305", icon: Icon.Trash, style: Action.Style.Destructive, shortcut: { modifiers: ['ctrl', 'shift'], key: 'backspace' }, onAction: handleCleanInstallers }),
        React.createElement(Action, { title: "\u6E05\u7406\u5F53\u524D\u5217\u8868\u4E2D 30 \u5929\u524D\u7684\u5927\u6587\u4EF6 (\u2265 100 MB)", icon: Icon.Trash, style: Action.Style.Destructive, onAction: handleCleanLargeOldFiles }),
        React.createElement(Action, { title: "\u6DFB\u52A0/\u7BA1\u7406\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76D1\u63A7\u76EE\u5F55...", icon: Icon.Plus, shortcut: { modifiers: ['ctrl'], key: 'n' }, onAction: openCustomDirManager }),
        React.createElement(Action, { title: "\u5237\u65B0\u5168\u6E20\u9053\u626B\u63CF", icon: Icon.ArrowClockwise, shortcut: { modifiers: ['ctrl'], key: 'r' }, onAction: () => reloadDownloads(customDirs) })));
    return (React.createElement(List, { navigationTitle: "\u4E0B\u8F7D\u7BA1\u7406", searchBarPlaceholder: "\u68C0\u7D22\u6587\u4EF6\u540D\u3001\u540E\u7F00(.exe/.pdf/.zip)\u6216\u6765\u6E90(\u5FAE\u4FE1/\u767E\u5EA6\u7F51\u76D8/\u5938\u514B/QQ)...", isLoading: isLoading, isShowingDetail: false, searchText: searchQuery, onSearchTextChange: (q) => setSearchQuery(q), filterBar: {
            summaryText: loadError ? '读取失败，旧结果保留，请刷新重试' : `已显示 ${summary.totalCount} 个文件 · ${summary.sources.length} 个目录${summary.partial ? ' · 仅部分结果' : ''}${summary.scanIssues.length ? ` · ${summary.scanIssues.length} 项读取异常` : ''}`
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
                React.createElement(List.Dropdown.Item, { title: "\u4EE3\u7801\u4E0E\u6570\u636E (.json / .sql / .ts / .py)", value: "type:code" }))) },
        filteredEntries.length === 0 ? (React.createElement(List.Section, { title: "\u5F53\u524D\u7B5B\u9009\u72B6\u6001" },
            React.createElement(List.Item, { id: "downloads-empty", icon: { source: Icon.Folder, tintColor: Color.SecondaryText }, title: isLoading ? '正在扫描下载与接收目录...' : loadError || summary.scanIssues.length ? '读取未完成，不能判断目录是否为空' : '当前筛选条件下暂无下载文件', subtitle: "\u53EF\u5207\u6362\u53F3\u4E0A\u89D2\u6E20\u9053\u7B5B\u9009\uFF08\u5168\u6E20\u9053 / \u529E\u516C IM / \u7F51\u76D8\u4E0B\u8F7D / \u5B89\u88C5\u5305\uFF09\uFF0C\u6216\u901A\u8FC7\u52A8\u4F5C\u9762\u677F\u6DFB\u52A0\u81EA\u5B9A\u4E49\u4E0B\u8F7D\u76EE\u5F55", actions: React.createElement(ActionPanel, null,
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
                { text: item.ageDays === null ? '修改时间未知' : item.ageDays === 0 ? `今天 ${item.modifiedAt.slice(11)}` : `${item.ageDays} 天前` }
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
                                title: ok ? '已在文件管理器中定位文件' : '无法定位文件',
                                message: item.path
                            });
                        } }),
                    React.createElement(Action, { title: "\u590D\u5236\u6587\u4EF6\u5B9E\u4F53\uFF08\u53EF\u76F4\u63A5\u7C98\u8D34\u5230\u5FAE\u4FE1/\u684C\u9762\uFF09", icon: Icon.Clipboard, shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' }, onAction: async () => {
                            const res = await copyDownloadFileEntity(item.path);
                            await showToast({
                                style: res.ok ? Toast.Style.Success : Toast.Style.Failure,
                                title: res.ok ? `已复制文件实体: ${item.name}` : '复制文件实体失败',
                                message: res.ok ? '可粘贴到支持文件粘贴的应用或文件夹' : res.error
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
                    React.createElement(Action, { title: item.isPinned ? '取消置顶保护' : '置顶并保护（跳过自动清理）', icon: Icon.Pin, shortcut: { modifiers: ['ctrl'], key: 'p' }, onAction: () => runMutation(async () => {
                            const next = await togglePinEntry(summary.entries, item.id);
                            if (alive.current)
                                setSummary(current => computeDashboardSummary(current.downloadDir, next, current.sources, current));
                        }) }),
                    React.createElement(Action, { title: "\u79FB\u5165\u56DE\u6536\u7AD9", icon: Icon.Trash, style: Action.Style.Destructive, shortcut: { modifiers: ['ctrl'], key: 'backspace' }, onAction: () => runMutation(async () => {
                            const confirmed = await confirmAlert({
                                title: `确认将「${item.name}」移入回收站？`,
                                message: `文件大小: ${item.sizeFormatted}\n来源: ${item.path}`
                            });
                            if (!confirmed || !alive.current)
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
                            if (!alive.current)
                                return;
                            setSummary(current => computeDashboardSummary(current.downloadDir, current.entries.filter(entry => entry.id !== item.id), current.sources, current));
                            await showToast({
                                style: Toast.Style.Success,
                                title: `已移入回收站: ${item.name}`,
                                message: `文件大小 ${item.sizeFormatted}，仍保留在回收站`
                            });
                        }) })),
                renderGlobalActions()) }))))))),
        (loadError || summary.scanIssues.length > 0) && React.createElement(List.Section, { title: "\u8BFB\u53D6\u5F02\u5E38" },
            loadError && React.createElement(List.Item, { id: "downloads-load-error", title: "\u8BFB\u53D6\u6216\u4FDD\u62A4\u8BBE\u7F6E\u5931\u8D25", subtitle: loadError, actions: React.createElement(ActionPanel, null, renderGlobalActions()) }),
            summary.scanIssues.map((issue, index) => React.createElement(List.Item, { key: index, id: `scan-issue-${index}`, title: issue.path, subtitle: issue.message, actions: React.createElement(ActionPanel, null,
                    React.createElement(Action, { title: "\u5237\u65B0\u4E0B\u8F7D\u5217\u8868", icon: Icon.ArrowClockwise, onAction: () => reloadDownloads() })) })))));
}
export const commands = {
    'downloads-all': DownloadsManagerCommand,
    'downloads-netdisk': () => DownloadsManagerCommand({ featureCode: 'downloads-netdisk' }),
    'downloads-im': () => DownloadsManagerCommand({ featureCode: 'downloads-im' }),
    'downloads-clean-installers': () => DownloadsManagerCommand({ featureCode: 'downloads-clean-installers' })
};
