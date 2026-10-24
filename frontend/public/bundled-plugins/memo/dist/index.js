import { List, Form, ActionPanel, Action, Icon, Clipboard, useState, useEffect, useNavigation, showToast, Toast, LocalStorage, confirmAlert } from '@ztools/declarative-ui';
import { createMemo, applyMemoMutation, isWritableMemoStore, filterMemos, sanitizeStoredMemos, readLegacyMemos, readLegacyNotes, MEMOS_STORAGE_KEY } from './logic.js';
const CORRUPT_MESSAGE = '存储的便签数据已损坏，为避免覆盖原数据已停止保存';
// 同一窗口内的写入排队执行，避免两次保存交错读写
let writeQueue = Promise.resolve();
function enqueueWrite(task) {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => undefined);
    return run;
}
/**
 * 新建 / 编辑便签表单
 */
export function MemoForm({ memo, onSave }) {
    const { pop } = useNavigation();
    const [title, setTitle] = useState(memo?.title ?? '');
    const [content, setContent] = useState(memo?.content ?? '');
    const [tag, setTag] = useState(memo?.tag ?? '');
    const [error, setError] = useState(undefined);
    const submit = async () => {
        if (!title.trim() && !content.trim()) {
            setError('标题和正文不能都为空');
            return;
        }
        if (await onSave(title, content, tag))
            pop();
    };
    return Form({
        navigationTitle: memo ? '编辑便签' : '新建便签',
        actions: ActionPanel({ title: '便签' }, [
            // 只保留「保存」：返回用 Esc，表单里 ⌘↵ 也是保存
            Action.SubmitForm({ title: '保存', icon: Icon.Check, onSubmit: submit })
        ])
    }, [
        Form.TextField({ id: 'title', title: '标题', placeholder: '可留空，保存为「无标题便签」', value: title, error, onChange: (v) => { setTitle(v); setError(undefined); } }),
        Form.TextArea({ id: 'content', title: '正文', placeholder: '支持 Markdown', value: content, onChange: (v) => { setContent(v); setError(undefined); } }),
        Form.TextField({ id: 'tag', title: '标签', placeholder: '例如 工作、生活；可留空', value: tag, onChange: (v) => setTag(v) })
    ]);
}
export default function MemoCommand() {
    const [searchText, setSearchText] = useState('');
    const [memos, setMemos] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(undefined);
    const [reloadKey, setReloadKey] = useState(0);
    const { push } = useNavigation();
    // 读取宿主插件存储；首次使用时把旧版存在浏览器缓存里的便签迁移过来。
    // 读取失败或数据损坏时进入错误状态：不提供新建/编辑/删除，绝不覆盖原数据
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setLoadError(undefined);
        (async () => {
            try {
                const raw = await LocalStorage.getItem(MEMOS_STORAGE_KEY);
                if (raw !== undefined) {
                    if (!Array.isArray(raw)) {
                        if (!cancelled)
                            setLoadError({ message: CORRUPT_MESSAGE, resettable: true, raw });
                        return;
                    }
                    const list = sanitizeStoredMemos(raw);
                    if (!cancelled)
                        setMemos(list);
                    const unreadable = raw.length - list.length;
                    if (unreadable > 0)
                        await showToast(Toast.Style.Failure, `有 ${unreadable} 条便签格式无法识别`, '未显示，保存时会原样保留');
                    return;
                }
                // 旧便签 + 已合并进来的旧「轻量便签记事」(notes) 笔记，按 id 去重
                const seen = new Set();
                const legacy = [...readLegacyMemos(), ...readLegacyNotes()].filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
                if (legacy.length > 0) {
                    await LocalStorage.setItem(MEMOS_STORAGE_KEY, legacy);
                    await showToast(Toast.Style.Success, `已迁移 ${legacy.length} 条旧便签`);
                }
                if (!cancelled)
                    setMemos(legacy);
            }
            catch (err) {
                if (!cancelled)
                    setLoadError({ message: err?.message || String(err), resettable: false });
                await showToast(Toast.Style.Failure, '读取便签失败', err?.message || String(err));
            }
            finally {
                if (!cancelled)
                    setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);
    // 保存时先读存储里的最新列表，只套用本次这一条改动再写回：
    // 另一个窗口（独立窗口 / 主窗口）刚写入的便签不会被本窗口的旧快照覆盖。
    // 最新值读不出来或已损坏时不写入。写入成功后才更新界面
    const commit = (mutation) => enqueueWrite(async () => {
        let latest;
        try {
            latest = await LocalStorage.getItem(MEMOS_STORAGE_KEY);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '保存失败', `读取最新便签失败：${err?.message || String(err)}`);
            return false;
        }
        if (!isWritableMemoStore(latest)) {
            setLoadError({ message: CORRUPT_MESSAGE, resettable: true, raw: latest });
            await showToast(Toast.Style.Failure, '保存失败', CORRUPT_MESSAGE);
            return false;
        }
        const next = applyMemoMutation(latest, mutation);
        try {
            await LocalStorage.setItem(MEMOS_STORAGE_KEY, next);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '保存失败', err?.message || String(err));
            return false;
        }
        setMemos(sanitizeStoredMemos(next));
        return true;
    });
    const retry = () => setReloadKey(reloadKey + 1);
    // 数据损坏时：先把原值完整备份到新键，再从空列表重新开始（需确认）
    const backupAndReset = async (error) => {
        const confirmed = await confirmAlert({
            title: '备份损坏的数据并重新开始？',
            message: '原数据会完整备份到插件存储的备份项中，然后便签列表从空开始。',
            primaryAction: { title: '备份并重新开始', style: 'destructive' },
            dismissAction: { title: '取消' }
        });
        if (!confirmed)
            return;
        const backupKey = `${MEMOS_STORAGE_KEY}.backup-${Date.now()}`;
        try {
            await enqueueWrite(async () => {
                await LocalStorage.setItem(backupKey, error.raw);
                await LocalStorage.setItem(MEMOS_STORAGE_KEY, []);
            });
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '备份失败，原数据未改动', err?.message || String(err));
            return;
        }
        await showToast(Toast.Style.Success, '已备份原数据，便签已重新开始');
        retry();
    };
    if (loadError) {
        const errorActions = ActionPanel({ title: '便签' }, [
            Action({ title: '重试', icon: Icon.ArrowClockwise, onAction: retry }),
            ...(loadError.resettable ? [Action({ title: '备份原数据并重新开始', icon: Icon.Download, onAction: () => backupAndReset(loadError) })] : [])
        ]);
        return List({
            isLoading: loading,
            isShowingDetail: false,
            searchBarPlaceholder: '搜索便签标题、正文或标签...',
            searchText,
            onSearchTextChange: setSearchText,
            actions: errorActions,
            children: [
                List.Section({
                    title: '便签',
                    children: [
                        List.Item({
                            id: 'load-error',
                            title: '读取便签失败，原数据未改动',
                            subtitle: `${loadError.message}；按回车重试`,
                            icon: Icon.ExclamationMark,
                            actions: errorActions
                        })
                    ]
                })
            ]
        });
    }
    const openCreate = (initialTitle = '') => push(() => MemoForm({
        memo: initialTitle ? { title: initialTitle, content: '', tag: '' } : undefined,
        onSave: async (title, content, tag) => {
            const ok = await commit({ type: 'create', item: createMemo([], title, content, tag)[0] });
            if (ok)
                await showToast(Toast.Style.Success, '已保存便签');
            return ok;
        }
    }));
    const openEdit = (memo) => push(() => MemoForm({
        memo,
        onSave: async (title, content, tag) => {
            const ok = await commit({
                type: 'update',
                id: memo.id,
                fallback: memo,
                updates: { title: title.trim() || '无标题便签', content: content.trim(), tag: tag.trim() }
            });
            if (ok)
                await showToast(Toast.Style.Success, '已更新便签');
            return ok;
        }
    }));
    const remove = async (memo) => {
        const confirmed = await confirmAlert({
            title: `删除便签「${memo.title}」？`,
            message: '删除后无法恢复。',
            primaryAction: { title: '删除', style: 'destructive' },
            dismissAction: { title: '取消' }
        });
        if (!confirmed)
            return;
        if (await commit({ type: 'delete', id: memo.id }))
            await showToast(Toast.Style.Success, '已删除便签');
    };
    const filtered = filterMemos(memos, searchText);
    const query = searchText.trim();
    const globalActions = ActionPanel({ title: '便签' }, [
        Action({ title: '新建便签', icon: Icon.Plus, onAction: () => openCreate(query) })
    ]);
    const items = filtered.length > 0
        ? filtered.map((item) => List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.tag || undefined,
            icon: Icon.Document,
            accessories: [{ text: new Date(item.updateTime).toLocaleDateString([], { month: '2-digit', day: '2-digit' }) }],
            detail: List.Item.Detail({ markdown: item.content || '*（无正文）*' }),
            actions: ActionPanel({ title: item.title }, [
                Action({ title: '复制正文', icon: Icon.Clipboard, onAction: async () => { await Clipboard.copy(item.content); await showToast(Toast.Style.Success, '已复制正文'); } }),
                Action({ title: '编辑便签', icon: Icon.Pencil, onAction: () => openEdit(item) }),
                Action({ title: '新建便签', icon: Icon.Plus, onAction: () => openCreate() }),
                Action({ title: '复制标题', icon: Icon.Clipboard, onAction: async () => { await Clipboard.copy(item.title); await showToast(Toast.Style.Success, '已复制标题'); } }),
                Action({ title: '删除便签', icon: Icon.Trash, onAction: () => remove(item) })
            ])
        }))
        : [
            List.Item({
                id: 'empty',
                title: loading ? '正在读取便签…' : query ? `新建便签「${query}」` : '还没有便签',
                subtitle: query ? '按回车用这段文字作为标题新建' : '按回车新建第一条便签',
                icon: Icon.Plus,
                detail: List.Item.Detail({ markdown: '' }),
                actions: globalActions
            })
        ];
    return List({
        isLoading: loading,
        isShowingDetail: filtered.length > 0,
        searchBarPlaceholder: '搜索便签标题、正文或标签...',
        searchText,
        onSearchTextChange: setSearchText,
        actions: globalActions,
        children: [
            List.Section({
                title: `便签（${filtered.length}/${memos.length}）`,
                children: items
            })
        ]
    });
}
