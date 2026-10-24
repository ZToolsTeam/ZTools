import { List, Form, ActionPanel, Action, Icon, showToast, Toast, useNavigation, useState, useEffect, useRef, LocalStorage } from "@ztools/declarative-ui";
import { createTodo, deleteTodoItem, clearCompletedTodos, filterAndSearchTodos, sanitizeStoredTodos, isBlankQuery, quickAddTitle, TODOS_STORAGE_KEY } from "./logic.js";
import { updateStorageItem } from "./host-compat.js";
/**
 * 新建待办事项 Form 表单
 */
export function CreateTodoForm({ onCreated }) {
    const { pop } = useNavigation();
    const [title, setTitle] = useState("");
    const [priority, setPriority] = useState("medium");
    const [error, setError] = useState(undefined);
    const handleSubmit = async (values) => {
        const todoTitle = values.title || title;
        const todoPriority = (values.priority || priority);
        if (!todoTitle || !todoTitle.trim()) {
            setError("待办标题不能为空");
            await showToast(Toast.Style.Failure, "请输入待办标题");
            return;
        }
        try {
            const newTodo = createTodo(todoTitle, todoPriority);
            if (!(await onCreated(newTodo)))
                return;
            await showToast(Toast.Style.Success, "待办事项创建成功");
            pop();
        }
        catch (err) {
            setError(err.message);
            await showToast(Toast.Style.Failure, "创建失败", err.message);
        }
    };
    return Form({
        navigationTitle: "新建待办事项",
        actions: ActionPanel({ title: "表单操作" }, [
            Action.SubmitForm({
                title: "保存待办",
                icon: Icon.Check,
                onSubmit: handleSubmit
            }),
            Action({
                title: "取消返回",
                icon: Icon.ArrowLeft,
                onAction: () => pop()
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
function readTodos(raw) {
    const items = sanitizeStoredTodos(raw);
    if (raw !== undefined && (!Array.isArray(raw) || items.length !== raw.length)) {
        throw new Error("已保存的待办数据损坏，为保护原数据已暂停修改");
    }
    return items;
}
/**
 * 待办事项主列表视图
 */
export default function TodoCommand() {
    const [todos, setTodos] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState("");
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
        setLoadError("");
        LocalStorage.getItem(TODOS_STORAGE_KEY)
            .then((raw) => {
            if (cancelled)
                return;
            setTodos(readTodos(raw));
            writable.current = true;
        })
            .catch((err) => {
            if (cancelled)
                return;
            const message = err instanceof Error ? err.message : String(err);
            setLoadError(message);
            showToast(Toast.Style.Failure, "读取待办失败", message);
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
            const next = await updateStorageItem(LocalStorage, TODOS_STORAGE_KEY, raw => mutate(readTodos(raw)));
            setTodos(next);
            return true;
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "保存失败", err?.message || String(err));
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
        try {
            const item = createTodo(title, "medium");
            if (await commit(current => [item, ...current])) {
                setSearchText("");
                await showToast(Toast.Style.Success, "已添加待办");
            }
        }
        catch (err) {
            await showToast(Toast.Style.Failure, "添加失败", err?.message || String(err));
        }
    };
    const handleOpenCreateForm = () => {
        if (!writable.current) {
            showToast(Toast.Style.Failure, "暂不能修改待办", "请先成功读取已有数据");
            return;
        }
        push(() => CreateTodoForm({
            onCreated: (newTodo) => commit(current => [newTodo, ...current])
        }));
    };
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
        actions: ActionPanel({ title: "全局操作" }, [
            ...(loadError ? [Action({ title: "重新读取待办", icon: Icon.Repeat, onAction: () => setReloadSeq(n => n + 1) })] : []),
            Action({
                title: "新建待办事项",
                icon: Icon.Plus,
                onAction: handleOpenCreateForm
            }),
            Action({
                title: "清空已完成待办",
                icon: Icon.Trash,
                onAction: handleClearCompleted
            })
        ])
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
                            Action({ title: "填写详情后添加…", icon: Icon.Pencil, onAction: handleOpenCreateForm })
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
                    {
                        text: new Date(item.createdAt).toLocaleDateString([], { month: "2-digit", day: "2-digit" })
                    }
                ],
                actions: ActionPanel({ title: "待办操作" }, [
                    Action({
                        title: item.completed ? "标为未完成" : "标为已完成",
                        icon: item.completed ? Icon.Circle : Icon.Check,
                        onAction: () => handleToggle(item.id)
                    }),
                    Action({
                        title: "新建待办事项",
                        icon: Icon.Plus,
                        onAction: handleOpenCreateForm
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
                    }),
                    Action({
                        title: "清空所有已完成待办",
                        icon: Icon.Trash,
                        onAction: handleClearCompleted
                    })
                ])
            })),
            ...(!quickTitle && filtered.length === 0
                ? [
                    List.Item({
                        id: "empty-item",
                        title: loadError ? "读取待办失败，已暂停修改" : blankQuery
                            ? "请输入待办内容"
                            : !loaded
                                ? "正在读取待办…"
                                : todos.length === 0
                                    ? "还没有待办"
                                    : "这个分类下没有待办",
                        subtitle: loadError ? loadError : blankQuery ? "只输入空格不会添加或修改待办" : "在上方输入内容后按回车即可添加",
                        icon: Icon.Document,
                        actions: ActionPanel({ title: "操作" }, [
                            ...(loadError ? [Action({ title: "重新读取待办", icon: Icon.Repeat, onAction: () => setReloadSeq(n => n + 1) })] : []),
                            Action({
                                title: "新建待办",
                                icon: Icon.Plus,
                                onAction: handleOpenCreateForm
                            })
                        ])
                    })
                ]
                : [])
        ])
    ]);
}
