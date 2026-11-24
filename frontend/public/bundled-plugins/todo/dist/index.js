import { List, Form, ActionPanel, Action, Icon, showToast, Toast, useNavigation, useState, useEffect, useRef, useLocale, LocalStorage, confirmAlert } from "@ztools/declarative-ui";
import { t } from "./i18n.js";
import { createTodo, updateTodoItem, deleteTodoItem, clearCompletedTodos, filterAndSearchTodos, readStoredTodos, formatListDate, CorruptTodosError, isBlankQuery, quickAddTitle, TODOS_STORAGE_KEY } from "./logic.js";
import { updateStorageItem, hostUpgradeError } from "./host-compat.js";
function errorMessage(err) {
    return err instanceof Error && err.message ? err.message : String(err);
}
/**
 * 新建待办事项 Form 表单
 */
export function CreateTodoForm({ onCreated, initialTitle = "" }) {
    useLocale();
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
            setError(t("titleEmptyError"));
            await showToast(Toast.Style.Failure, t("titleEmptyToast"));
            return;
        }
        if (submitting.current)
            return;
        submitting.current = true;
        try {
            const newTodo = createTodo(todoTitle, todoPriority);
            if (!(await onCreated(newTodo)))
                return;
            await showToast(Toast.Style.Success, t("createSuccess"));
            pop();
        }
        catch (err) {
            const message = errorMessage(err);
            setError(message);
            await showToast(Toast.Style.Failure, t("createFailed"), message);
        }
        finally {
            submitting.current = false;
        }
    };
    return renderTodoFormView({
        navigationTitle: t("formNavTitle"),
        title,
        priority,
        error,
        onTitleChange: (val) => {
            setTitle(val);
            if (error)
                setError(undefined);
        },
        onPriorityChange: setPriority,
        onSubmit: handleSubmit
    });
}
function renderTodoFormView(options) {
    return Form({
        navigationTitle: options.navigationTitle,
        // 只保留「保存」：返回用 Esc，表单里 ⌘↵ 也是保存
        actions: ActionPanel({ title: t("formActionsTitle") }, [
            Action.SubmitForm({
                title: t("saveTodo"),
                icon: Icon.Check,
                onSubmit: options.onSubmit
            })
        ])
    }, [
        Form.TextField({
            id: "title",
            title: t("titleField"),
            placeholder: t("titlePlaceholder"),
            value: options.title,
            error: options.error,
            onChange: options.onTitleChange
        }),
        Form.Dropdown({
            id: "priority",
            title: t("priorityField"),
            value: options.priority,
            onChange: (val) => options.onPriorityChange(val)
        }, [
            Form.Dropdown.Item({ title: t("priorityHigh"), value: "high" }),
            Form.Dropdown.Item({ title: t("priorityMedium"), value: "medium" }),
            Form.Dropdown.Item({ title: t("priorityLow"), value: "low" })
        ])
    ]);
}
/**
 * 编辑已有待办事项 Form 表单（保留原完成状态与创建时间）
 */
export function EditTodoForm({ todo, onSaved }) {
    useLocale();
    const { pop } = useNavigation();
    const [title, setTitle] = useState(todo.title);
    const [priority, setPriority] = useState(todo.priority);
    const [error, setError] = useState(undefined);
    const submitting = useRef(false);
    const handleSubmit = async (values) => {
        const todoTitle = typeof values.title === "string" && values.title ? values.title : title;
        const todoPriority = (typeof values.priority === "string" && values.priority ? values.priority : priority);
        if (!todoTitle || !todoTitle.trim()) {
            setError(t("titleEmptyError"));
            await showToast(Toast.Style.Failure, t("titleEmptyToast"));
            return;
        }
        if (submitting.current)
            return;
        submitting.current = true;
        try {
            if (!(await onSaved({ title: todoTitle.trim(), priority: todoPriority })))
                return;
            await showToast(Toast.Style.Success, t("editSuccess"));
            pop();
        }
        catch (err) {
            const message = errorMessage(err);
            setError(message);
            await showToast(Toast.Style.Failure, t("editFailed"), message);
        }
        finally {
            submitting.current = false;
        }
    };
    return renderTodoFormView({
        navigationTitle: t("formEditNavTitle"),
        title,
        priority,
        error,
        onTitleChange: (val) => {
            setTitle(val);
            if (error)
                setError(undefined);
        },
        onPriorityChange: setPriority,
        onSubmit: handleSubmit
    });
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
    useLocale();
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
            showToast(Toast.Style.Failure, t("readFailed"), failure.message);
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
            await showToast(Toast.Style.Failure, t("cannotEditTitle"), t("cannotEditDesc"));
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
            await showToast(Toast.Style.Failure, t("saveFailed"), errorMessage(err));
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
                throw new Error(t("deletedByOtherWindow"));
            return current.map(item => item.id === id ? { ...item, completed, completedAt: completed ? (item.completedAt ?? completedAt) : undefined } : item);
        })))
            return;
        await showToast(Toast.Style.Success, completed ? t("markedCompleted") : t("markedIncomplete"));
    };
    const handleDelete = async (id) => {
        if (await commit(current => deleteTodoItem(current, id)))
            await showToast(Toast.Style.Success, t("todoDeleted"));
    };
    const handleClearCompleted = async () => {
        const completedCount = todos.filter((item) => item.completed).length;
        if (completedCount === 0) {
            await showToast(Toast.Style.Success, t("noCompletedTodos"));
            return;
        }
        const confirmed = await confirmAlert({
            title: t("clearCompletedConfirmTitle", { count: completedCount }),
            message: t("clearCompletedConfirmMsg"),
            primaryAction: { title: t("clearCompletedConfirmPrimary"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!confirmed)
            return;
        let count = 0;
        if (await commit((current) => {
            count = current.filter((t) => t.completed).length;
            return clearCompletedTodos(current);
        })) {
            await showToast(Toast.Style.Success, count > 0 ? t("clearedCompleted", { count }) : t("noCompletedTodos"));
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
                await showToast(Toast.Style.Success, t("todoAdded"));
            }
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("addFailed"), errorMessage(err));
        }
        finally {
            adding.current = false;
        }
    };
    const handleOpenCreateForm = (initialTitle = "") => {
        if (!writable.current) {
            showToast(Toast.Style.Failure, t("cannotEditTitle"), t("cannotEditDesc"));
            return;
        }
        push(() => CreateTodoForm({
            initialTitle,
            onCreated: (newTodo) => commit(current => [newTodo, ...current])
        }));
    };
    const handleOpenEditForm = (todo) => {
        if (!writable.current) {
            showToast(Toast.Style.Failure, t("cannotEditTitle"), t("cannotEditDesc"));
            return;
        }
        push(() => EditTodoForm({
            todo,
            onSaved: (updates) => commit((current) => {
                if (!current.some((item) => item.id === todo.id)) {
                    throw new Error(t("deletedByOtherWindow"));
                }
                return updateTodoItem(current, todo.id, updates);
            })
        }));
    };
    const reload = () => setReloadSeq(n => n + 1);
    // 数据损坏时：先把原值完整备份到新键并读回核验，再原子地从空列表重新开始（需确认）
    const backupAndReset = async (failure) => {
        const confirmed = await confirmAlert({
            title: t("backupConfirmTitle"),
            message: t("backupConfirmMsg"),
            primaryAction: { title: t("backupConfirmPrimary"), style: "destructive" },
            dismissAction: { title: t("cancel") }
        });
        if (!confirmed)
            return;
        try {
            if (typeof LocalStorage.compareAndSet !== "function")
                throw hostUpgradeError(t("backupConfirmPrimary"));
            const current = await LocalStorage.getItem(TODOS_STORAGE_KEY);
            if (JSON.stringify(current) !== JSON.stringify(failure.raw))
                throw new Error(t("backupChangedError"));
            const backupKey = `${TODOS_STORAGE_KEY}.backup-${Date.now()}`;
            await LocalStorage.setItem(backupKey, current);
            if (JSON.stringify(await LocalStorage.getItem(backupKey)) !== JSON.stringify(current))
                throw new Error(t("backupVerifyError"));
            if (!(await LocalStorage.compareAndSet(TODOS_STORAGE_KEY, current, [])))
                throw new Error(t("backupRaceError"));
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t("backupFailed"), err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, t("backupSuccess"));
        reload();
    };
    // 整个插件的动作只放在 List 级：客户端会把它们以「全局操作」附在每条待办的动作后面，单条待办里不再重复
    const globalActions = ActionPanel({ title: t("globalActions") }, [
        ...(loadError ? [Action({ title: t("reloadTodos"), icon: Icon.Repeat, onAction: reload })] : []),
        ...(loadError?.corrupt ? [Action({ title: t("backupAndRestart"), icon: Icon.Download, onAction: () => backupAndReset(loadError) })] : []),
        Action({
            title: t("newTodo"),
            icon: Icon.Plus,
            onAction: () => handleOpenCreateForm()
        }),
        // 没有已完成项时不提供「清空已完成」，避免空状态下次动作是无效操作
        ...(todos.some((item) => item.completed) ? [Action({
                title: t("clearCompleted"),
                icon: Icon.Trash,
                onAction: handleClearCompleted
            })] : [])
    ]);
    // 有输入且没有标题完全相同的待办时，「添加待办」始终排第一，回车即添加；
    // 部分匹配的已有待办排在后面，要操作它们用 ↓ 选中
    const quickTitle = loaded && !loadError ? quickAddTitle(filtered, searchText) : null;
    const emptyTitle = loadError ? (loadError.corrupt ? t("emptyCorrupt") : t("emptyLoadErr")) : blankQuery
        ? t("emptyBlankQuery")
        : !loaded
            ? t("emptyLoading")
            : todos.length === 0
                ? t("emptyNone")
                : t("emptyFilterNone");
    const emptyDescription = loadError ? (loadError.corrupt ? t("emptyLoadErrCorruptSub", { message: loadError.message }) : t("emptyLoadErrSub", { message: loadError.message })) : blankQuery ? t("emptyBlankQuerySub") : !loaded ? "" : t("emptyHintSub");
    return List({
        // 读取完成前交给客户端显示加载状态，不提前下「还没有待办」的结论
        isLoading: !loaded && !loadError,
        navigationTitle: t("navTitle"),
        searchBarPlaceholder: t("searchPlaceholder"),
        searchText,
        onSearchTextChange: (text) => setSearchText(text),
        searchBarAccessory: List.Dropdown({
            tooltip: t("filterTooltip"),
            value: filter,
            onChange: (val) => setFilter(val)
        }, [
            List.Dropdown.Item({ title: t("filterAll"), value: "all" }),
            List.Dropdown.Item({ title: t("filterActive"), value: "active" }),
            List.Dropdown.Item({ title: t("filterCompleted"), value: "completed" })
        ]),
        actions: globalActions
    }, [
        // 没有任何条目时不输出分组：否则空状态上方会多一个「全部待办 (0)」标题
        ...(quickTitle || filtered.length > 0 ? [List.Section({
                title: filter === "all" ? t("sectionAll", { count: filtered.length }) : filter === "active" ? t("sectionActive", { count: filtered.length }) : t("sectionCompleted", { count: filtered.length })
            }, [
                ...(quickTitle
                    ? [
                        List.Item({
                            id: "quick-add",
                            title: t("quickAddTitle", { title: quickTitle }),
                            subtitle: t("quickAddSubtitle"),
                            icon: Icon.Plus,
                            actions: ActionPanel({ title: t("actionsTitle") }, [
                                Action({ title: t("quickAddAction"), icon: Icon.Plus, onAction: () => handleQuickAdd(quickTitle) }),
                                Action({ title: t("addWithDetailsAction"), icon: Icon.Pencil, onAction: () => handleOpenCreateForm(quickTitle) })
                            ])
                        })
                    ]
                    : []),
                ...filtered.map((item) => List.Item({
                    id: item.id,
                    title: item.title,
                    subtitle: item.priority === "high" ? t("priorityHigh") : item.priority === "medium" ? t("priorityMedium") : t("priorityLow"),
                    icon: item.completed ? Icon.Check : Icon.Circle,
                    accessories: [
                        {
                            text: item.completed ? t("statusCompleted") : t("statusPending")
                        },
                        ...(item.createdAt > 0 ? [{ text: formatListDate(item.createdAt) }] : [])
                    ],
                    actions: ActionPanel({ title: t("todoActionsTitle") }, [
                        Action({
                            title: item.completed ? t("markIncomplete") : t("markCompleted"),
                            icon: item.completed ? Icon.Circle : Icon.Check,
                            onAction: () => handleToggle(item.id)
                        }),
                        Action({
                            title: t("editTodo"),
                            icon: Icon.Pencil,
                            onAction: () => handleOpenEditForm(item)
                        }),
                        Action.CopyToClipboard({
                            title: t("copyTitle"),
                            content: item.title,
                            icon: Icon.CopyClipboard
                        }),
                        Action({
                            title: t("deleteTodo"),
                            icon: Icon.Trash,
                            onAction: () => handleDelete(item.id)
                        })
                    ])
                }))
            ])] : []),
        // 没有可显示的待办时用空状态说明原因与下一步，不再塞一条可选中的占位行；
        // 空列表时回车、⌘K 由客户端回退到上面的 List 级动作（新建 / 重新读取）
        ...(!quickTitle && filtered.length === 0 ? [renderEmptyState(emptyTitle, emptyDescription, loadError ? Icon.ExclamationMark : Icon.CheckCircle)] : [])
    ]);
}
/**
 * 空列表时的空状态。客户端在运行时提供 SDK：新版客户端有 List.EmptyView，渲染成居中、不可选中的空状态；
 * 旧版客户端没有它，退回一条不带动作的占位条目（与旧版插件行为一致，回车仍走 List 级动作）。
 */
function renderEmptyState(title, description, icon) {
    const emptyView = List.EmptyView;
    if (typeof emptyView === "function") {
        return emptyView({ title, description: description || undefined, icon });
    }
    return List.Item({ id: "empty-item", title, subtitle: description || undefined, icon: Icon.Document });
}
