import { List, Form, ActionPanel, Action, Icon, showToast, Toast, useNavigation, useState, useEffect, useRef, LocalStorage, confirmAlert } from "@ztools/declarative-ui";
import { createTodo, deleteTodoItem, clearCompletedTodos, filterAndSearchTodos, readStoredTodos, formatListDate, CorruptTodosError, isBlankQuery, quickAddTitle, TODOS_STORAGE_KEY } from "./logic.js";
import { updateStorageItem, hostUpgradeError } from "./host-compat.js";
function errorMessage(err) {
    return err instanceof Error && err.message ? err.message : String(err);
}
/**
 * 新建待办事项 Form 表单
 */
export function CreateTodoForm({ onCreated, initialTitle = "" }) {
    const { pop } = useNavigation();
    const [title, setTitle] = useState(initialTitle);
    const [priority, setPriority] = useState("medium");
    const [error, setError] = useState(undefined);
    // 保存进行中再按 ⌘↵ 不会重复创建
    const submitting = useRef(false);
    const handleSubmit = async (values) => {
        const todoTitle = typeof values.title === "string" && values.title ? values.title : title;
        const todoPriority = (typeof values.priority === "string" && values.priority ? values.priority : priority);
        if (!todoTitle || !todoTitle.trim()) {
            setError("待办标题不能为空");
            await showToast(Toast.Style.Failure, "请输入待办标题");
            return;
        }
        if (submitting.current)
            return;
        submitting.current = true;
        try {
            const newTodo = createTodo(todoTitle, todoPriority);
            if (!(await onCreated(newTodo)))
                return;
            await showToast(Toast.Style.Success, "待办事项创建成功");
            pop();
        }
        catch (err) {
            const message = errorMessage(err);
            setError(message);
            await showToast(Toast.Style.Failure, "创建失败", message);
        }
        finally {
            submitting.current = false;
        }
    };
    return Form({
        navigationTitle: "新建待办事项",
        // 只保留「保存」：返回用 Esc，表单里 ⌘↵ 也是保存
        actions: ActionPanel({ title: "表单操作" }, [
            Action.SubmitForm({
                title: "保存待办",
                icon: Icon.Check,
                onSubmit: handleSubmit
            })
        ])
    }, [
        Form.TextField({
            id: "title",
            title: "待办标题",
            placeholder: "输入待办任务内容...",
            value: title,
            error,
            onChange: (val) => {
                setTitle(val);
                if (error)
                    setError(undefined);
            }
        }),
        Form.Dropdown({
            id: "priority",
            title: "优先级",
            value: priority,
            onChange: (val) => setPriority(val)
        }, [
            Form.Dropdown.Item({ title: "高优先级", value: "high" }),
            Form.Dropdown.Item({ title: "中优先级", value: "medium" }),
            Form.Dropdown.Item({ title: "低优先级", value: "low" })
        ])
    ]);
}
function toLoadError(err) {
    if (err instanceof CorruptTodosError)
        return { message: err.message, corrupt: true, raw: err.raw };
    return { message: err instanceof Error ? err.message : String(err), corrupt: false };
}
/**
 * 待办事项主列表视图
 */
export default function TodoCommand() {
    const [todos, setTodos] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(undefined);
    // 回车快速添加进行中：连按两次回车不会添加两条
    const adding = useRef(false);
    const [reloadSeq, setReloadSeq] = useState(0);
    const writable = useRef(false);
    const [filter, setFilter] = useState("all");
    const [searchText, setSearchText] = useState("");
    const { push } = useNavigation();
    // 首次打开时从宿主插件存储读回待办
    useEffect(() => {
        let cancelled = false;
        writable.current = false;
        setLoaded(false);
        setLoadError(undefined);
        LocalStorage.getItem(TODOS_STORAGE_KEY)
            .then((raw) => {
            if (cancelled)
                return;
            setTodos(readStoredTodos(raw));
            writable.current = true;
        })
            .catch((err) => {
            if (cancelled)
                return;
            const failure = toLoadError(err);
            setLoadError(failure);
            showToast(Toast.Style.Failure, "读取待办失败", failure.message);
        })
            .finally(() => {
            if (!cancelled)
                setLoaded(true);
        });
        return () => {
            cancelled = true;
        };
    }, [reloadSeq]);
    // 只输入了空白字符时不展示任何待办：否则回车会切换当前选中的那条
    const blankQuery = isBlankQuery(searchText);
    const filtered = blankQuery ? [] : filterAndSearchTodos(todos, filter, searchText);
    // 先写入存储再更新界面：写入失败时界面保持原样
    const commit = async (mutate) => {
        if (!writable.current) {
            await showToast(Toast.Style.Failure, "暂不能修改待办", "请先成功读取已有数据");
            return false;
        }
        try {
            const next = await updateStorageItem(LocalStorage, TODOS_STORAGE_KEY, raw => mutate(readStoredTodos(raw)));
            setTodos(next);
            return true;
        }
        catch (err) {
            // 其他窗口把数据写坏了：停止修改，进入可备份的错误状态
            if (err instanceof CorruptTodosError) {
                writable.current = false;
                setLoadError(toLoadError(err));
            }
            await showToast(Toast.Style.Failure, "保存失败", errorMessage(err));
            return false;
        }
    };
    const handleToggle = async (id) => {
        const target = todos.find((t) => t.id === id);
        if (!target)
            return;
        const completed = !target.completed;
        const completedAt = Date.now();
        if (!(await commit(current => {
            if (!current.some(item => item.id === id))
                throw new Error("该待办已被其他窗口删除，请重新读取");
            return current.map(item => item.id === id ? { ...item, completed, completedAt: completed ? (item.completedAt ?? completedAt) : undefined } : item);
        })))
            return;
        await showToast(Toast.Style.Success, completed ? "已标为完成" : "已标为未完成");
    };
    const handleDelete = async (id) => {
        if (await commit(current => deleteTodoItem(current, id)))
            await showToast(Toast.Style.Success, "待办已删除");
    };
    const handleClearCompleted = async () => {
        let count = 0;
        if (await commit((current) => {
            count = current.filter((t) => t.completed).length;
            return clearCompletedTodos(current);
        })) {
            await showToast(Toast.Style.Success, count > 0 ? `已清空 ${count} 条已完成待办` : "没有已完成的待办");
        }
    };
    const handleQuickAdd = async (title) => {
        if (adding.current)
            return;
        adding.current = true;
        try {
            const item = createTodo(title, "medium");
            if (await commit(current => [item, ...current])) {
                setSearchText("");
                await showToast(Toast.Style.Success, "已添加待办");
            }
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "添加失败", errorMessage(err));
        }
        finally {
            adding.current = false;
        }
    };
    const handleOpenCreateForm = (initialTitle = "") => {
        if (!writable.current) {
            showToast(Toast.Style.Failure, "暂不能修改待办", "请先成功读取已有数据");
            return;
        }
        push(() => CreateTodoForm({
            initialTitle,
            onCreated: (newTodo) => commit(current => [newTodo, ...current])
        }));
    };
    const reload = () => setReloadSeq(n => n + 1);
    // 数据损坏时：先把原值完整备份到新键并读回核验，再原子地从空列表重新开始（需确认）
    const backupAndReset = async (failure) => {
        const confirmed = await confirmAlert({
            title: "备份损坏的数据并重新开始？",
            message: "原数据会完整备份到插件存储的备份项中，然后待办列表从空开始。",
            primaryAction: { title: "备份并重新开始", style: "destructive" },
            dismissAction: { title: "取消" }
        });
        if (!confirmed)
            return;
        try {
            if (typeof LocalStorage.compareAndSet !== "function")
                throw hostUpgradeError("备份并重新开始");
            const current = await LocalStorage.getItem(TODOS_STORAGE_KEY);
            if (JSON.stringify(current) !== JSON.stringify(failure.raw))
                throw new Error("待办数据已变化，请重新读取；不会覆盖新数据");
            const backupKey = `${TODOS_STORAGE_KEY}.backup-${Date.now()}`;
            await LocalStorage.setItem(backupKey, current);
            if (JSON.stringify(await LocalStorage.getItem(backupKey)) !== JSON.stringify(current))
                throw new Error("备份读回核验失败");
            if (!(await LocalStorage.compareAndSet(TODOS_STORAGE_KEY, current, [])))
                throw new Error("备份期间待办数据已变化，请重新读取；不会覆盖新数据");
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "备份或重置失败，原数据未改动", err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, "已备份原数据，待办已重新开始");
        reload();
    };
    // 整个插件的动作只放在 List 级：客户端会把它们以「全局操作」附在每条待办的动作后面，单条待办里不再重复
    const globalActions = ActionPanel({ title: "全局操作" }, [
        ...(loadError ? [Action({ title: "重新读取待办", icon: Icon.Repeat, onAction: reload })] : []),
        ...(loadError?.corrupt ? [Action({ title: "备份原数据并重新开始", icon: Icon.Download, onAction: () => backupAndReset(loadError) })] : []),
        Action({
            title: "新建待办事项",
            icon: Icon.Plus,
            onAction: () => handleOpenCreateForm()
        }),
        // 没有已完成项时不提供「清空已完成」，避免空状态下次动作是无效操作
        ...(todos.some((item) => item.completed) ? [Action({
                title: "清空已完成待办",
                icon: Icon.Trash,
                onAction: handleClearCompleted
            })] : [])
    ]);
    // 有输入且没有标题完全相同的待办时，「添加待办」始终排第一，回车即添加；
    // 部分匹配的已有待办排在后面，要操作它们用 ↓ 选中
    const quickTitle = loaded && !loadError ? quickAddTitle(filtered, searchText) : null;
    return List({
        navigationTitle: "极简待办清单",
        searchBarPlaceholder: "搜索待办事项，或按回车快速添加...",
        searchText,
        onSearchTextChange: (text) => setSearchText(text),
        searchBarAccessory: List.Dropdown({
            tooltip: "筛选待办状态",
            value: filter,
            onChange: (val) => setFilter(val)
        }, [
            List.Dropdown.Item({ title: "全部待办", value: "all" }),
            List.Dropdown.Item({ title: "进行中", value: "active" }),
            List.Dropdown.Item({ title: "已完成", value: "completed" })
        ]),
        actions: globalActions
    }, [
        List.Section({
            title: filter === "all" ? `全部待办 (${filtered.length})` : filter === "active" ? `进行中 (${filtered.length})` : `已完成 (${filtered.length})`
        }, [
            ...(quickTitle
                ? [
                    List.Item({
                        id: "quick-add",
                        title: `添加待办「${quickTitle}」`,
                        subtitle: "按回车直接添加（中优先级）",
                        icon: Icon.Plus,
                        actions: ActionPanel({ title: "操作" }, [
                            Action({ title: "添加待办", icon: Icon.Plus, onAction: () => handleQuickAdd(quickTitle) }),
                            Action({ title: "填写详情后添加…", icon: Icon.Pencil, onAction: () => handleOpenCreateForm(quickTitle) })
                        ])
                    })
                ]
                : []),
            ...filtered.map((item) => List.Item({
                id: item.id,
                title: item.title,
                subtitle: item.priority === "high" ? "高优先级" : item.priority === "medium" ? "中优先级" : "低优先级",
                icon: item.completed ? Icon.Check : Icon.Circle,
                accessories: [
                    {
                        text: item.completed ? "已完成" : "待处理"
                    },
                    ...(item.createdAt > 0 ? [{ text: formatListDate(item.createdAt) }] : [])
                ],
                actions: ActionPanel({ title: "待办操作" }, [
                    Action({
                        title: item.completed ? "标为未完成" : "标为已完成",
                        icon: item.completed ? Icon.Circle : Icon.Check,
                        onAction: () => handleToggle(item.id)
                    }),
                    Action.CopyToClipboard({
                        title: "复制待办标题",
                        content: item.title,
                        icon: Icon.CopyClipboard
                    }),
                    Action({
                        title: "删除此待办",
                        icon: Icon.Trash,
                        onAction: () => handleDelete(item.id)
                    })
                ])
            })),
            ...(!quickTitle && filtered.length === 0
                ? [
                    List.Item({
                        id: "empty-item",
                        title: loadError ? (loadError.corrupt ? "待办数据已损坏，已暂停修改" : "读取待办失败，已暂停修改") : blankQuery
                            ? "请输入待办内容"
                            : !loaded
                                ? "正在读取待办…"
                                : todos.length === 0
                                    ? "还没有待办"
                                    : "这个分类下没有待办",
                        subtitle: loadError ? `${loadError.message}；按回车${loadError.corrupt ? "重新读取，⌘K 可备份后重新开始" : "重新读取"}` : blankQuery ? "只输入空格不会添加或修改待办" : "在上方输入内容后按回车即可添加",
                        icon: Icon.Document
                        // 不传 actions：客户端回退到 List 级动作，避免同名动作在动作面板里出现两次
                    })
                ]
                : [])
        ])
    ]);
}
