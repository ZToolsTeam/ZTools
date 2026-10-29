import { List, Form, ActionPanel, Action, Icon, Clipboard, useState, useEffect, useRef, useNavigation, showToast, Toast, LocalStorage, confirmAlert } from '@ztools/declarative-ui';
import { createMemo, applyMemoMutation, isWritableMemoStore, filterMemos, sanitizeStoredMemos, readLegacyMemos, readLegacyNotes, formatListDate, MEMOS_STORAGE_KEY } from './logic.js';
const CORRUPT_MESSAGE = '存储的便签数据已损坏，为避免覆盖原数据已停止保存';
function requireAtomicStorage() {
    if (typeof LocalStorage.updateItem !== 'function' || typeof LocalStorage.compareAndSet !== 'function') {
        throw new Error('当前客户端不支持原子存储，请升级 ZTools 后再保存便签');
    }
}
/**
 * 新建 / 编辑便签表单
 */
export function MemoForm({ memo, initialTitle = '', onSave }) {
    const { pop } = useNavigation();
    const [title, setTitle] = useState(memo?.title ?? initialTitle);
    const [content, setContent] = useState(memo?.content ?? '');
    const [tag, setTag] = useState(memo?.tag ?? '');
    const [error, setError] = useState(undefined);
    const submitting = useRef(false);
    const submit = async () => {
        if (!title.trim() && !content.trim()) {
            setError('标题和正文不能都为空');
            return;
        }
        if (submitting.current)
            return;
        submitting.current = true;
        try {
            if (await onSave(title, content, tag))
                pop();
        }
        finally {
            submitting.current = false;
        }
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
                    if (cancelled)
                        return;
                    requireAtomicStorage();
                    if (!await LocalStorage.compareAndSet(MEMOS_STORAGE_KEY, undefined, legacy)) {
                        const current = await LocalStorage.getItem(MEMOS_STORAGE_KEY);
                        if (!isWritableMemoStore(current)) {
                            if (!cancelled)
                                setLoadError({ message: CORRUPT_MESSAGE, resettable: true, raw: current });
                        }
                        else if (!cancelled)
                            setMemos(sanitizeStoredMemos(current));
                        return;
                    }
                    if (!cancelled)
                        await showToast(Toast.Style.Success, `已迁移 ${legacy.length} 条旧便签`);
                }
                if (!cancelled)
                    setMemos(legacy);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!cancelled)
                    setLoadError({ message, resettable: false });
                await showToast(Toast.Style.Failure, '读取便签失败', message);
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
    const commit = async (mutation) => {
        let damaged;
        try {
            requireAtomicStorage();
            const next = await LocalStorage.updateItem(MEMOS_STORAGE_KEY, latest => {
                if (!isWritableMemoStore(latest)) {
                    damaged = { message: CORRUPT_MESSAGE, resettable: true, raw: latest };
                    throw new Error(CORRUPT_MESSAGE);
                }
                return applyMemoMutation(latest, mutation);
            });
            setMemos(sanitizeStoredMemos(next));
            return true;
        }
        catch (err) {
            if (damaged)
                setLoadError(damaged);
            await showToast(Toast.Style.Failure, '保存失败', err instanceof Error ? err.message : String(err));
            return false;
        }
    };
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
        try {
            requireAtomicStorage();
            const current = await LocalStorage.getItem(MEMOS_STORAGE_KEY);
            if (JSON.stringify(current) !== JSON.stringify(error.raw))
                throw new Error('便签数据已变化，请重试读取；不会覆盖新数据');
            const backupKey = `${MEMOS_STORAGE_KEY}.backup-${Date.now()}-${globalThis.crypto.randomUUID()}`;
            await LocalStorage.setItem(backupKey, current);
            if (JSON.stringify(await LocalStorage.getItem(backupKey)) !== JSON.stringify(current))
                throw new Error('备份读回核验失败');
            if (!await LocalStorage.compareAndSet(MEMOS_STORAGE_KEY, current, []))
                throw new Error('备份期间便签数据已变化，请重试读取；不会覆盖新数据');
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '备份或重置失败，原数据未改动', err instanceof Error ? err.message : String(err));
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
                            icon: Icon.ExclamationMark
                            // 不传 actions：客户端回退到 List 级动作，避免同名动作在动作面板里出现两次
                        })
                    ]
                })
            ]
        });
    }
    const openCreate = (initialTitle = '') => push(() => MemoForm({
        initialTitle,
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
                expected: memo,
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
        if (await commit({ type: 'delete', expected: memo }))
            await showToast(Toast.Style.Success, '已删除便签');
    };
    // 复制失败（内容为空、剪贴板被占用）如实提示，不显示「已复制」
    const copyText = async (text, emptyMessage, successTitle) => {
        try {
            if (!text)
                throw new Error(emptyMessage);
            await Clipboard.copy(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '复制失败', err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, successTitle);
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
            accessories: item.updateTime > 0 ? [{ text: formatListDate(item.updateTime) }] : [],
            detail: List.Item.Detail({ markdown: item.content || '*（无正文）*' }),
            actions: ActionPanel({ title: item.title }, [
                Action({ title: '复制正文', icon: Icon.Clipboard, onAction: () => copyText(item.content, '这条便签没有正文', '已复制正文') }),
                Action({ title: '编辑便签', icon: Icon.Pencil, onAction: () => openEdit(item) }),
                // 「新建便签」只放在 List 级：客户端会以「全局操作」附在每条便签的动作后面，这里不再重复
                Action({ title: '复制标题', icon: Icon.Clipboard, onAction: () => copyText(item.title, '这条便签没有标题', '已复制标题') }),
                Action({ title: '删除便签', icon: Icon.Trash, onAction: () => remove(item) })
            ])
        }))
        : [
            List.Item({
                id: 'empty',
                title: loading ? '正在读取便签…' : query ? `新建便签「${query}」` : '还没有便签',
                subtitle: query ? '按回车用这段文字作为标题新建' : '按回车新建第一条便签',
                icon: Icon.Plus,
                detail: List.Item.Detail({ markdown: '' })
                // 不传 actions：客户端回退到 List 级动作，避免同名动作在动作面板里出现两次
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
