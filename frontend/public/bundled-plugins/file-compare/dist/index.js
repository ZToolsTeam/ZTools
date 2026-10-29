import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useMemo, useNavigation } from '@ztools/declarative-ui';
import { diffText, formatHunk, formatUnifiedDiff, describeHunk, hunkPreviewMarkdown, splitLines, MAX_DIFF_LINES } from './logic.js';
import { pickTextFile } from './host.js';
import { usePopoutValue } from './popout-state.js';
export * from './logic.js';
const emptySide = (name) => ({ name, text: '' });
// 独立窗口带来的值可能来自旧版本或被篡改：形状不对时整侧回落为空
const isSide = (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return false;
    const s = v;
    return typeof s.name === 'string' && typeof s.text === 'string' && (s.source === undefined || s.source === 'text' || s.source === 'clipboard' || s.source === 'file');
};
const isFlag = (v) => typeof v === 'boolean';
/**
 * 编辑左右两段文本的表单
 */
/** 动作面板快捷键文案：macOS 写 ⌘K，Windows 写 Ctrl+K */
export function actionPanelKey() {
    try {
        const nav = globalThis.navigator;
        return /Mac/i.test(nav?.platform || nav?.userAgent || '') ? '⌘K' : 'Ctrl+K';
    }
    catch {
        return 'Ctrl+K';
    }
}
export function EditTextsForm({ left, right, onSave }) {
    const { pop } = useNavigation();
    const [a, setA] = useState(left.text);
    const [b, setB] = useState(right.text);
    return Form({
        navigationTitle: '填写要对比的两段文本',
        actions: ActionPanel({ title: '对比' }, [
            Action.SubmitForm({
                title: '开始对比',
                icon: Icon.Check,
                onSubmit: () => {
                    onSave(a === left.text && left.source ? left : { name: '左侧', text: a, source: 'text' }, b === right.text && right.source ? right : { name: '右侧', text: b, source: 'text' });
                    pop();
                }
            })
        ])
    }, [
        Form.TextArea({ id: 'left', title: '左侧（原文）', placeholder: '粘贴原始文本', value: a, onChange: (v) => setA(v) }),
        Form.TextArea({ id: 'right', title: '右侧（新文）', placeholder: '粘贴修改后的文本', value: b, onChange: (v) => setB(v) })
    ]);
}
export function FileCompareCommand() {
    // 两侧内容与「忽略空白」随独立窗口带走；文件内容已读成文本，不需要转交路径授权
    const [left, setLeft] = usePopoutValue('left', () => emptySide('左侧'), isSide);
    const [right, setRight] = usePopoutValue('right', () => emptySide('右侧'), isSide);
    const [ignoreWhitespace, setIgnoreWhitespace] = usePopoutValue('ignoreWhitespace', () => false, isFlag);
    const { push } = useNavigation();
    // 两侧都有内容才对比；只有一侧时进入「待选另一侧」状态，不拿空文本做整篇删除的假差异
    const hasLeft = left.source !== undefined || left.text.length > 0;
    const hasRight = right.source !== undefined || right.text.length > 0;
    const ready = hasLeft && hasRight;
    // 只在输入变化时重新计算（交换、忽略空白、载入新内容），其余重渲染直接复用结果
    const { result, error, report } = useMemo(() => {
        if (!ready)
            return { result: null, error: '', report: '' };
        try {
            const r = diffText(left.text, right.text, { ignoreWhitespace });
            return { result: r, error: '', report: formatUnifiedDiff(r, left.name, right.name) };
        }
        catch (err) {
            return { result: null, error: err instanceof Error ? err.message : String(err), report: '' };
        }
    }, [ready, left.text, right.text, left.name, right.name, ignoreWhitespace]);
    const openEditor = () => push(() => EditTextsForm({ left, right, onSave: (l, r) => { setLeft(l); setRight(r); } }));
    const pasteInto = async (side) => {
        let text;
        try {
            text = await Clipboard.readText();
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '读取剪贴板失败', err instanceof Error ? err.message : String(err));
            return;
        }
        if (!text) {
            await showToast(Toast.Style.Failure, '剪贴板里没有文字');
            return;
        }
        side === 'left' ? setLeft({ name: '剪贴板', text, source: 'clipboard' }) : setRight({ name: '剪贴板', text, source: 'clipboard' });
        await showToast(Toast.Style.Success, side === 'left' ? '已设为左侧' : '已设为右侧');
    };
    const pickFile = async (side) => {
        try {
            const file = await pickTextFile(side === 'left' ? '选择左侧（原文）文件' : '选择右侧（新文）文件');
            if (!file)
                return;
            side === 'left' ? setLeft({ name: file.name, text: file.text, source: 'file' }) : setRight({ name: file.name, text: file.text, source: 'file' });
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '读取文件失败', err instanceof Error ? err.message : String(err));
        }
    };
    const sourceActions = [
        Action({ title: '编辑两段文本…', icon: Icon.Pencil, onAction: openEditor }),
        Action({ title: '剪贴板内容设为左侧', icon: Icon.CopyClipboard, onAction: () => pasteInto('left') }),
        Action({ title: '剪贴板内容设为右侧', icon: Icon.CopyClipboard, onAction: () => pasteInto('right') }),
        Action({ title: '选择文件作为左侧…', icon: Icon.Document, onAction: () => pickFile('left') }),
        Action({ title: '选择文件作为右侧…', icon: Icon.Document, onAction: () => pickFile('right') }),
        Action({ title: '交换左右', icon: Icon.Repeat, onAction: () => { const l = left; setLeft(right); setRight(l); } }),
        Action({ title: ignoreWhitespace ? '恢复比较空白字符' : '忽略空白差异', icon: Icon.Text, onAction: () => setIgnoreWhitespace(!ignoreWhitespace) }),
        Action({ title: '清空', icon: Icon.Trash, onAction: () => { setLeft(emptySide('左侧')); setRight(emptySide('右侧')); } })
    ];
    /** 复制失败如实提示，不在失败后显示「已复制」 */
    const copyText = async (text, success) => {
        try {
            await Clipboard.copy(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, '复制失败', err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, success);
    };
    const reportActions = report
        ? [Action({ title: '复制差异报告', icon: Icon.CopyClipboard, onAction: () => copyText(report, '已复制差异报告（unified diff）') })]
        : [];
    let sections;
    if (hasLeft !== hasRight) {
        // 只载入了一侧：主动作沿用已载入一侧的来源补另一侧，次动作换另一种来源，其余收进 ⌘K
        const loaded = hasLeft ? left : right;
        const missing = hasLeft ? 'right' : 'left';
        const missingLabel = missing === 'left' ? '左侧（原文）' : '右侧（新文）';
        const pickOther = missing === 'left' ? sourceActions[3] : sourceActions[4];
        const pasteOther = missing === 'left' ? sourceActions[1] : sourceActions[2];
        const ordered = loaded.source === 'file' ? [pickOther, pasteOther, sourceActions[0]]
            : loaded.source === 'clipboard' ? [pasteOther, pickOther, sourceActions[0]]
                : [sourceActions[0], pickOther, pasteOther];
        const rest = sourceActions.filter((a) => !ordered.includes(a));
        const loadedLines = splitLines(loaded.text).length;
        sections = loadedLines > MAX_DIFF_LINES
            ? [List.Section({ title: '无法对比' }, [List.Item({ id: 'error', title: `${loaded.name} 超过 ${MAX_DIFF_LINES} 行，暂不支持对比`, icon: Icon.ExclamationMark, actions: ActionPanel({ title: '操作' }, sourceActions) })])]
            : [
                List.Section({ title: `已载入${hasLeft ? '左侧' : '右侧'}：${loaded.name}（${loadedLines} 行）` }, [
                    List.Item({
                        id: 'need-other',
                        title: `还需要${missingLabel}才能对比`,
                        subtitle: '选择文件、使用剪贴板内容或编辑文本补上另一侧',
                        icon: Icon.Document,
                        actions: ActionPanel({ title: '补上另一侧' }, [...ordered, ...rest])
                    })
                ])
            ];
    }
    else if (!ready) {
        sections = [
            List.Section({ title: '开始' }, [
                List.Item({ id: 'start-edit', title: '粘贴两段文本进行对比', subtitle: '按回车打开编辑框', icon: Icon.Pencil, actions: ActionPanel({ title: '开始' }, sourceActions) }),
                List.Item({ id: 'start-file', title: '选择两个文件对比', subtitle: 'UTF-8 文本文件，单个不超过 4 MB', icon: Icon.Document, actions: ActionPanel({ title: '开始' }, [sourceActions[3], sourceActions[4], sourceActions[0]]) }),
                List.Item({ id: 'start-clip', title: '用剪贴板内容对比', subtitle: '先复制原文设为左侧，再复制新文设为右侧', icon: Icon.CopyClipboard, actions: ActionPanel({ title: '开始' }, [sourceActions[1], sourceActions[2], sourceActions[0]]) })
            ])
        ];
    }
    else if (error) {
        sections = [List.Section({ title: '无法对比' }, [List.Item({ id: 'error', title: error, icon: Icon.ExclamationMark, actions: ActionPanel({ title: '操作' }, sourceActions) })])];
    }
    else if (result && result.identical) {
        sections = [
            List.Section({ title: `${left.name} ↔ ${right.name}` }, [
                List.Item({
                    id: 'identical',
                    title: ignoreWhitespace ? '两段文本相同（已忽略空白差异）' : left.text === right.text ? '两段文本完全相同' : '逐行内容相同（换行符或末尾换行不同）',
                    subtitle: `共 ${result.leftLines} 行`,
                    icon: Icon.Checkmark,
                    detail: List.Item.Detail({ markdown: ignoreWhitespace || left.text === right.text ? '两侧内容一致，没有差异。' : '每一行的内容都相同，只有换行符（Windows CRLF 与 LF）或文件末尾是否有空行不同；逐行对比不把它们算作差异。' }),
                    actions: ActionPanel({ title: '操作' }, sourceActions)
                })
            ])
        ];
    }
    else if (result) {
        sections = [
            List.Section({ title: `${left.name} ↔ ${right.name} · ${result.approximate ? '改动过多，按近似结果显示 · ' : ''}删除 ${result.removed} 行，新增 ${result.added} 行 · ${result.hunks.length} 处差异` }, result.hunks.map((h, i) => List.Item({
                id: `hunk-${i}`,
                title: `第 ${Math.max(h.rightStart, 1)} 行附近`,
                subtitle: describeHunk(h),
                icon: Icon.Document,
                detail: List.Item.Detail({ markdown: hunkPreviewMarkdown(h) }),
                actions: ActionPanel({ title: '差异' }, [
                    ...reportActions,
                    Action({ title: '复制这一处差异', icon: Icon.CopyClipboard, onAction: () => copyText(formatHunk(h), '已复制这一处差异') }),
                    ...sourceActions
                ])
            })))
        ];
    }
    else {
        sections = [];
    }
    return List({
        navigationTitle: '文本对比',
        isShowingDetail: Boolean(result && result.hunks.length > 0) || Boolean(result?.identical),
        searchBarPlaceholder: result && result.hunks.length > 0 ? `按回车复制差异报告，${actionPanelKey()} 查看更多操作` : `按回车开始，${actionPanelKey()} 查看更多操作`,
        actions: ActionPanel({ title: '全局操作' }, [...reportActions, ...sourceActions])
    }, sections);
}
export default FileCompareCommand;
