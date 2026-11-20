import { List, Form, ActionPanel, Action, Icon, Clipboard, useState, useEffect, useRef, useNavigation, useLocale, showToast, Toast, LocalStorage, confirmAlert } from '@ztools/declarative-ui';
import { t } from './i18n.js';
import { createMemo, applyMemoMutation, isWritableMemoStore, filterMemos, sanitizeStoredMemos, readLegacyMemos, readLegacyNotes, formatListDate, MEMOS_STORAGE_KEY } from './logic.js';
function requireAtomicStorage() {
    if (typeof LocalStorage.updateItem !== 'function' || typeof LocalStorage.compareAndSet !== 'function') {
        throw new Error(t('atomicStorageRequired'));
    }
}
/**
 * 新建 / 编辑便签表单
 */
export function MemoForm({ memo, initialTitle = '', onSave }) {
    useLocale();
    const { pop } = useNavigation();
    const [title, setTitle] = useState(memo?.title ?? initialTitle);
    const [content, setContent] = useState(memo?.content ?? '');
    const [tag, setTag] = useState(memo?.tag ?? '');
    const [error, setError] = useState(undefined);
    const submitting = useRef(false);
    const submit = async () => {
        if (!title.trim() && !content.trim()) {
            setError(t('emptyTitleAndContentError'));
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
        navigationTitle: memo ? t('formEditNavTitle') : t('formCreateNavTitle'),
        actions: ActionPanel({ title: t('panelMemoTitle') }, [
            // 只保留「保存」：返回用 Esc，表单里 ⌘↵ 也是保存
            Action.SubmitForm({ title: t('saveAction'), icon: Icon.Check, onSubmit: submit })
        ])
    }, [
        Form.TextField({ id: 'title', title: t('fieldTitleLabel'), placeholder: t('fieldTitlePlaceholder'), value: title, error, onChange: (v) => { setTitle(v); setError(undefined); } }),
        Form.TextArea({ id: 'content', title: t('fieldContentLabel'), placeholder: t('fieldContentPlaceholder'), value: content, onChange: (v) => { setContent(v); setError(undefined); } }),
        Form.TextField({ id: 'tag', title: t('fieldTagLabel'), placeholder: t('fieldTagPlaceholder'), value: tag, onChange: (v) => setTag(v) })
    ]);
}
export default function MemoCommand() {
    useLocale();
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
                            setLoadError({ message: t('corruptMessage'), resettable: true, corrupt: true, raw });
                        return;
                    }
                    const list = sanitizeStoredMemos(raw);
                    if (!cancelled)
                        setMemos(list);
                    const unreadable = raw.length - list.length;
                    if (unreadable > 0)
                        await showToast(Toast.Style.Failure, t('unreadableMemosTitle', { count: unreadable }), t('unreadableMemosMessage'));
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
                                setLoadError({ message: t('corruptMessage'), resettable: true, corrupt: true, raw: current });
                        }
                        else if (!cancelled)
                            setMemos(sanitizeStoredMemos(current));
                        return;
                    }
                    if (!cancelled)
                        await showToast(Toast.Style.Success, t('migratedMemosToast', { count: legacy.length }));
                }
                if (!cancelled)
                    setMemos(legacy);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (!cancelled)
                    setLoadError({ message, resettable: false });
                await showToast(Toast.Style.Failure, t('readFailedTitle'), message);
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
                    const msg = t('corruptMessage');
                    damaged = { message: msg, resettable: true, corrupt: true, raw: latest };
                    throw new Error(msg);
                }
                return applyMemoMutation(latest, mutation);
            });
            setMemos(sanitizeStoredMemos(next));
            return true;
        }
        catch (err) {
            if (damaged)
                setLoadError(damaged);
            await showToast(Toast.Style.Failure, t('saveFailedTitle'), err instanceof Error ? err.message : String(err));
            return false;
        }
    };
    const retry = () => setReloadKey(reloadKey + 1);
    // 数据损坏时：先把原值完整备份到新键，再从空列表重新开始（需确认）
    const backupAndReset = async (error) => {
        const confirmed = await confirmAlert({
            title: t('backupConfirmTitle'),
            message: t('backupConfirmMessage'),
            primaryAction: { title: t('backupConfirmPrimary'), style: 'destructive' },
            dismissAction: { title: t('cancel') }
        });
        if (!confirmed)
            return;
        try {
            requireAtomicStorage();
            const current = await LocalStorage.getItem(MEMOS_STORAGE_KEY);
            if (JSON.stringify(current) !== JSON.stringify(error.raw))
                throw new Error(t('backupChangedError'));
            const backupKey = `${MEMOS_STORAGE_KEY}.backup-${Date.now()}-${globalThis.crypto.randomUUID()}`;
            await LocalStorage.setItem(backupKey, current);
            if (JSON.stringify(await LocalStorage.getItem(backupKey)) !== JSON.stringify(current))
                throw new Error(t('backupVerifyError'));
            if (!await LocalStorage.compareAndSet(MEMOS_STORAGE_KEY, current, []))
                throw new Error(t('backupRaceError'));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('backupFailedTitle'), err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, t('backupSuccessToast'));
        retry();
    };
    if (loadError) {
        const displayMessage = loadError.corrupt ? t('corruptMessage') : loadError.message;
        const errorActions = ActionPanel({ title: t('panelMemoTitle') }, [
            Action({ title: t('retryAction'), icon: Icon.ArrowClockwise, onAction: retry }),
            ...(loadError.resettable ? [Action({ title: t('backupAndResetAction'), icon: Icon.Download, onAction: () => backupAndReset(loadError) })] : [])
        ]);
        return List({
            isLoading: loading,
            isShowingDetail: false,
            searchBarPlaceholder: t('searchPlaceholder'),
            searchText,
            onSearchTextChange: setSearchText,
            actions: errorActions,
            children: [
                List.Section({
                    title: t('panelMemoTitle'),
                    children: [
                        List.Item({
                            id: 'load-error',
                            title: t('loadErrorTitle'),
                            subtitle: t('loadErrorSubtitle', { message: displayMessage }),
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
                await showToast(Toast.Style.Success, t('savedMemoToast'));
            return ok;
        }
    }));
    const openEdit = (memo) => push(() => MemoForm({
        memo,
        onSave: async (title, content, tag) => {
            const ok = await commit({
                type: 'update',
                expected: memo,
                updates: { title: title.trim() || t('untitledMemo'), content: content.trim(), tag: tag.trim() }
            });
            if (ok)
                await showToast(Toast.Style.Success, t('updatedMemoToast'));
            return ok;
        }
    }));
    const remove = async (memo) => {
        const confirmed = await confirmAlert({
            title: t('deleteConfirmTitle', { title: memo.title }),
            message: t('deleteConfirmMessage'),
            primaryAction: { title: t('deleteAction'), style: 'destructive' },
            dismissAction: { title: t('cancel') }
        });
        if (!confirmed)
            return;
        if (await commit({ type: 'delete', expected: memo }))
            await showToast(Toast.Style.Success, t('deletedMemoToast'));
    };
    // 复制失败（内容为空、剪贴板被占用）如实提示，不显示「已复制」
    const copyText = async (text, emptyMessage, successTitle) => {
        try {
            if (!text)
                throw new Error(emptyMessage);
            await Clipboard.copy(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('copyFailedTitle'), err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, successTitle);
    };
    const filtered = filterMemos(memos, searchText);
    const query = searchText.trim();
    const globalActions = ActionPanel({ title: t('panelMemoTitle') }, [
        Action({ title: t('newMemoAction'), icon: Icon.Plus, onAction: () => openCreate(query) })
    ]);
    const items = filtered.length > 0
        ? filtered.map((item) => List.Item({
            id: item.id,
            title: item.title,
            subtitle: item.tag || undefined,
            icon: Icon.Document,
            accessories: item.updateTime > 0 ? [{ text: formatListDate(item.updateTime) }] : [],
            detail: List.Item.Detail({ markdown: item.content || t('emptyContentMarkdown') }),
            actions: ActionPanel({ title: item.title }, [
                Action({ title: t('copyContentAction'), icon: Icon.Clipboard, onAction: () => copyText(item.content, t('noContentError'), t('copiedContentToast')) }),
                Action({ title: t('editMemoAction'), icon: Icon.Pencil, onAction: () => openEdit(item) }),
                // 「新建便签」只放在 List 级：客户端会以「全局操作」附在每条便签的动作后面，这里不再重复
                Action({ title: t('copyTitleAction'), icon: Icon.Clipboard, onAction: () => copyText(item.title, t('noTitleError'), t('copiedTitleToast')) }),
                Action({ title: t('deleteMemoAction'), icon: Icon.Trash, onAction: () => remove(item) })
            ])
        }))
        : [
            List.Item({
                id: 'empty',
                title: loading ? t('loadingTitle') : query ? t('createWithQueryTitle', { query }) : t('emptyTitle'),
                subtitle: query ? t('createWithQuerySubtitle') : t('emptySubtitle'),
                icon: Icon.Plus,
                detail: List.Item.Detail({ markdown: '' })
                // 不传 actions：客户端回退到 List 级动作，避免同名动作在动作面板里出现两次
            })
        ];
    return List({
        isLoading: loading,
        isShowingDetail: filtered.length > 0,
        searchBarPlaceholder: t('searchPlaceholder'),
        searchText,
        onSearchTextChange: setSearchText,
        actions: globalActions,
        children: [
            List.Section({
                title: t('sectionTitle', { filtered: filtered.length, total: memos.length }),
                children: items
            })
        ]
    });
}
