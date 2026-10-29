/**
 * 创建新便签
 */
export function createMemo(items, title, content, tag = '') {
    const cleanTitle = title.trim() || '无标题便签';
    const cleanContent = content.trim();
    const now = Date.now();
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new Error('无法生成唯一标识，请重启客户端后重试');
    }
    const newItem = {
        id: `memo-${now}-${globalThis.crypto.randomUUID()}`,
        title: cleanTitle,
        content: cleanContent,
        tag: tag.trim(),
        createTime: now,
        updateTime: now
    };
    return [newItem, ...items];
}
/**
 * 更新现有便签
 */
export function updateMemo(items, id, updates) {
    return items.map(item => {
        if (item.id === id) {
            return {
                ...item,
                ...updates,
                updateTime: Date.now()
            };
        }
        return item;
    });
}
/**
 * 删除便签
 */
export function deleteMemo(items, id) {
    return items.filter(item => item.id !== id);
}
/**
 * 按标题、正文、标签检索；最近更新的排在前面
 */
export function filterMemos(items, query) {
    const q = (query || '').trim().toLowerCase();
    const list = q
        ? items.filter(m => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q) || m.tag.toLowerCase().includes(q))
        : items;
    return [...list].sort((a, b) => b.updateTime - a.updateTime);
}
export const MEMOS_STORAGE_KEY = 'memo.items.v1';
/** 旧版本直接写在浏览器 localStorage 里的键 */
export const LEGACY_LOCALSTORAGE_KEY = 'ztools_memo_items';
/** 旧版本自带的 3 条示例便签，迁移时不带过来 */
const LEGACY_SAMPLE_IDS = new Set(['memo-1', 'memo-2', 'memo-3']);
/**
 * 校验从存储读回的便签：结构不对的条目直接丢弃
 */
export function sanitizeStoredMemos(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (!item || typeof item !== 'object')
            continue;
        const m = item;
        if (typeof m.id !== 'string' || seen.has(m.id))
            continue;
        if (typeof m.title !== 'string' || typeof m.content !== 'string')
            continue;
        seen.add(m.id);
        const createTime = typeof m.createTime === 'number' ? m.createTime : 0;
        out.push({
            id: m.id,
            title: m.title,
            content: m.content,
            tag: typeof m.tag === 'string' ? m.tag : '',
            createTime,
            updateTime: typeof m.updateTime === 'number' ? m.updateTime : createTime
        });
    }
    return out;
}
/** 已合并进便签的旧插件「轻量便签记事」(notes) 写在浏览器 localStorage 里的键 */
export const LEGACY_NOTES_LOCALSTORAGE_KEY = 'raycast_ztools-raycast-notes-v1';
/** 旧 notes 插件自带的 3 条示例笔记，迁移时不带过来 */
const LEGACY_NOTES_SAMPLE_IDS = new Set(['note-1', 'note-2', 'note-3']);
/**
 * 读取旧「轻量便签记事」(notes) 插件的笔记并转换成便签；读不到、已损坏或只有示例数据时返回空数组。
 * 旧插件把 JSON 字符串再序列化了一次存储，这里两种写法都兼容。
 */
export function readLegacyNotes(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(LEGACY_NOTES_LOCALSTORAGE_KEY);
        if (!raw)
            return [];
        let parsed = JSON.parse(raw);
        if (typeof parsed === 'string')
            parsed = JSON.parse(parsed);
        if (!Array.isArray(parsed))
            return [];
        const out = [];
        const seen = new Set();
        for (const item of parsed) {
            if (!item || typeof item !== 'object')
                continue;
            const n = item;
            if (typeof n.id !== 'string' || LEGACY_NOTES_SAMPLE_IDS.has(n.id))
                continue;
            if (typeof n.title !== 'string' || typeof n.content !== 'string')
                continue;
            const id = `notes-${n.id}`;
            if (seen.has(id))
                continue;
            seen.add(id);
            const createTime = typeof n.createdAt === 'number' ? n.createdAt : 0;
            const tags = Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
            out.push({
                id,
                title: n.title,
                content: n.content,
                tag: tags.join(' '),
                createTime,
                updateTime: typeof n.updatedAt === 'number' ? n.updatedAt : createTime
            });
        }
        return out;
    }
    catch {
        return [];
    }
}
/**
 * 读取旧版存在浏览器 localStorage 的便签（过滤掉示例数据）；读不到或已损坏时返回空数组
 */
export function readLegacyMemos(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(LEGACY_LOCALSTORAGE_KEY);
        if (!raw)
            return [];
        return sanitizeStoredMemos(JSON.parse(raw)).filter(m => !LEGACY_SAMPLE_IDS.has(m.id));
    }
    catch {
        return [];
    }
}
/**
 * 判断存储读回的值能否当作便签列表使用：
 * - undefined：还没有存过（可以迁移旧数据或从空列表开始）
 * - 数组：正常；无法识别的条目不显示，但写回时原样保留
 * - 其他（截断的 JSON 读回成字符串、null、对象等）：数据已损坏，不能在它上面写入，否则会覆盖原数据
 */
export function isWritableMemoStore(raw) {
    return raw === undefined || Array.isArray(raw);
}
/**
 * 把一次保存操作套用到存储里的最新列表（而不是本窗口内存里的旧快照），
 * 其他窗口刚写入的便签、以及本插件识别不了的条目都原样保留
 */
export function applyMemoMutation(latest, mutation) {
    const base = latest ?? [];
    const matches = (entry, id) => !!entry && typeof entry === 'object' && entry.id === id;
    if (mutation.type !== 'create') {
        const found = base.filter(entry => matches(entry, mutation.expected.id));
        const current = sanitizeStoredMemos(found)[0];
        const fields = ['title', 'content', 'tag', 'createTime', 'updateTime'];
        if (found.length !== 1 || !current || fields.some(field => current[field] !== mutation.expected[field])) {
            throw new Error('这条便签已在其他窗口修改或删除，原数据保留。请重新打开便签后再操作。');
        }
    }
    switch (mutation.type) {
        case 'create':
            if (base.some(entry => matches(entry, mutation.item.id)))
                throw new Error('便签标识已存在，请重试');
            return [mutation.item, ...base];
        case 'update':
            return base.map(entry => matches(entry, mutation.expected.id)
                ? { ...entry, ...mutation.updates, updateTime: Date.now() }
                : entry);
        case 'delete':
            return base.filter((entry) => !matches(entry, mutation.expected.id));
        default:
            return base;
    }
}
/**
 * 列表行右侧的日期：没有记录时间（旧数据为 0）时不显示；不是今年的带上年份，避免跨年后分不清
 */
export function formatListDate(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp) || timestamp <= 0)
        return '';
    const date = new Date(timestamp);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString([], sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' });
}
