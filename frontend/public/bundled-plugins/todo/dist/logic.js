/**
 * ZTools 极简待办事项业务逻辑 (纯函数)
 */
export function createTodo(title, priority = "medium") {
    const trimmed = (title || "").trim();
    if (!trimmed) {
        throw new Error("待办事项标题不能为空");
    }
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new Error('无法生成唯一标识，请重启客户端后重试');
    }
    return {
        id: "todo_" + Date.now().toString(36) + "_" + globalThis.crypto.randomUUID(),
        title: trimmed,
        completed: false,
        priority,
        createdAt: Date.now()
    };
}
export function toggleTodoStatus(todos, id) {
    return todos.map((item) => {
        if (item.id === id) {
            const nextCompleted = !item.completed;
            return {
                ...item,
                completed: nextCompleted,
                completedAt: nextCompleted ? Date.now() : undefined
            };
        }
        return item;
    });
}
export function deleteTodoItem(todos, id) {
    return todos.filter((item) => item.id !== id);
}
export function clearCompletedTodos(todos) {
    return todos.filter((item) => !item.completed);
}
export function filterAndSearchTodos(todos, filter = "all", searchQuery = "") {
    let list = todos;
    // 1. 状态过滤
    if (filter === "active") {
        list = list.filter((item) => !item.completed);
    }
    else if (filter === "completed") {
        list = list.filter((item) => item.completed);
    }
    // 2. 关键词检索
    const q = (searchQuery || "").trim().toLowerCase();
    if (q) {
        list = list.filter((item) => item.title.toLowerCase().includes(q));
    }
    // 3. 排序：有关键词时标题完全相同的排最前；其余未完成在前（高优先级排前），已完成在后
    const priorityWeight = {
        high: 3,
        medium: 2,
        low: 1
    };
    return [...list].sort((a, b) => {
        if (q) {
            const aExact = isSameTitle(a.title, q);
            const bExact = isSameTitle(b.title, q);
            if (aExact !== bExact)
                return aExact ? -1 : 1;
        }
        if (a.completed !== b.completed) {
            return a.completed ? 1 : -1;
        }
        const diff = priorityWeight[b.priority] - priorityWeight[a.priority];
        if (diff !== 0)
            return diff;
        return b.createdAt - a.createdAt;
    });
}
function isSameTitle(title, query) {
    return title.trim().toLowerCase() === query.trim().toLowerCase();
}
/** 搜索框里只有空白字符：此时既不能添加，也不能让回车改动任何已有待办 */
export function isBlankQuery(searchText) {
    return typeof searchText === "string" && searchText.length > 0 && !searchText.trim();
}
/**
 * 回车快速添加的标题：输入非空、且当前可见列表里没有标题完全相同（忽略大小写）的待办时返回去空格后的标题，否则返回 null。
 * 只是部分匹配已有待办时照样可以添加，「添加待办」条目排在第一位，回车不会误改已有待办。
 */
export function quickAddTitle(visible, searchText) {
    const title = (searchText || "").trim();
    if (!title)
        return null;
    return visible.some((item) => isSameTitle(item.title, title)) ? null : title;
}
export const TODOS_STORAGE_KEY = "todo.items.v1";
/**
 * 校验从存储读回的待办列表：结构不对的条目直接丢弃，不让损坏数据导致整个列表崩溃
 */
export function sanitizeStoredTodos(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== "object")
            continue;
        const t = item;
        if (typeof t.id !== "string" || seen.has(t.id))
            continue;
        if (typeof t.title !== "string" || !t.title.trim())
            continue;
        seen.add(t.id);
        const priority = t.priority === "high" || t.priority === "low" ? t.priority : "medium";
        out.push({
            id: t.id,
            title: t.title,
            completed: t.completed === true,
            priority,
            createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
            ...(t.completed === true && typeof t.completedAt === "number" ? { completedAt: t.completedAt } : {})
        });
    }
    return out;
}
/** 已保存的待办数据结构不对：携带读回的原值，便于先完整备份再重新开始 */
export class CorruptTodosError extends Error {
    raw;
    constructor(raw) {
        super("已保存的待办数据损坏，为保护原数据已暂停修改");
        this.name = "CorruptTodosError";
        this.raw = raw;
    }
}
/**
 * 把存储读回的值转成待办列表；结构不对（不是数组或有无法识别的条目）时抛 CorruptTodosError，绝不在它上面写入
 */
export function readStoredTodos(raw) {
    const items = sanitizeStoredTodos(raw);
    if (raw !== undefined && (!Array.isArray(raw) || items.length !== raw.length)) {
        throw new CorruptTodosError(raw);
    }
    return items;
}
/**
 * 列表行右侧的日期：没有记录时间（旧数据为 0）时不显示；不是今年的带上年份，避免跨年后分不清
 */
export function formatListDate(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0)
        return "";
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString([], sameYear ? { month: "2-digit", day: "2-digit" } : { year: "numeric", month: "2-digit", day: "2-digit" });
}
