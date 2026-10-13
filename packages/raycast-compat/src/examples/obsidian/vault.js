import { LocalStorage } from "../../api/storage.js";
const STORAGE_KEY = "obsidian_vault_notes";
export const SAMPLE_OBSIDIAN_NOTES = [
    {
        id: "note-1",
        title: "ZTools 声明式架构设计决策",
        vault: "Engineering",
        folder: "Architecture",
        tags: ["architecture", "ztools", "raycast", "declarative"],
        content: `---
title: ZTools 声明式架构设计决策
date: 2026-10-10
status: approved
tags: [architecture, ztools, raycast]
---

# ZTools 声明式架构设计决策 (ADR-004)

## 背景
传统桌面与插件生态面临原生 Web DOM 的性能瓶颈与跨平台样式一致性问题。为实现极速启动与高度统一的 Fluent / Raycast 视觉规范，我们需要一套纯净的声明式虚拟视图描述符体系。

## 决策核心
1. **纯净声明式 Virtual View Descriptors**：组件只返回轻量 JSON 描述符，禁止注入原生 HTML/CSS。
2. **渐进式响应式微内核**：内置轻量 \`useState\` / \`useEffect\` / \`useMemo\`，与底层 Host 渲染完全解耦。
3. **平台安全与沙箱隔离**：NativeHost32 与认证 Service 双向验签，保障生产环境安全。

## 后续规划
- 支持全部经典生态应用无缝适配
- 完善 CI/CD 自动化门禁测试
`,
        wordCount: 380,
        createdAt: "2026-10-10 14:20",
        updatedAt: "2026-10-11 09:15"
    },
    {
        id: "note-2",
        title: "团队每周敏捷站会备忘",
        vault: "Personal",
        folder: "Meetings",
        tags: ["meeting", "agile", "weekly"],
        content: `---
title: 团队每周敏捷站会备忘
date: 2026-10-11
attendees: [@alice, @bob, @carol]
---

# 团队每周敏捷站会备忘

### 本周交付成果
- [x] 完成 Raycast 兼容运行时单元与契约测试
- [x] 优化 LocalStorage 与 Clipboard 双向同步机制
- [ ] 补全首批 10 款经典开源应用生态

### 风险与阻碍
- 无重大风险，各子模块测试覆盖率达标。
`,
        wordCount: 165,
        createdAt: "2026-10-11 10:00",
        updatedAt: "2026-10-11 11:30"
    },
    {
        id: "note-3",
        title: "TypeScript 高性能类型体操与技巧",
        vault: "Engineering",
        folder: "Knowledge",
        tags: ["typescript", "tips", "dev"],
        content: `---
title: TypeScript 高性能类型体操与技巧
tags: [typescript, dev]
---

# TypeScript 技巧集合

### 1. 递归类型深度限制规避
使用尾递归模式或元组计数器，避免触发 TS2589: Type instantiation is excessively deep.

### 2. 模式匹配推断
\`\`\`typescript
type UnwrapPromise<T> = T extends Promise<infer U> ? UnwrapPromise<U> : T;
\`\`\`

持续更新中...
`,
        wordCount: 210,
        createdAt: "2026-10-09 18:00",
        updatedAt: "2026-10-10 20:10"
    }
];
export async function getVaultNotes() {
    try {
        const list = await LocalStorage.getItem(STORAGE_KEY);
        if (list && list.length > 0) {
            return list;
        }
    }
    catch {
        // fallback
    }
    return SAMPLE_OBSIDIAN_NOTES;
}
export async function saveVaultNote(note) {
    const current = await getVaultNotes();
    const wordCount = note.content.trim().length;
    const now = new Date().toLocaleString();
    const newNote = {
        ...note,
        id: `obsidian_${Date.now()}`,
        wordCount,
        createdAt: now,
        updatedAt: now
    };
    const updated = [newNote, ...current];
    await LocalStorage.setItem(STORAGE_KEY, updated);
    return updated;
}
export async function deleteVaultNote(id) {
    const current = await getVaultNotes();
    const updated = current.filter((n) => n.id !== id);
    await LocalStorage.setItem(STORAGE_KEY, updated);
    return updated;
}
export function searchVaultNotes(notes, query) {
    if (!query || !query.trim())
        return notes;
    const q = query.toLowerCase().trim();
    return notes.filter((n) => n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.folder.toLowerCase().includes(q) ||
        n.vault.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)));
}
