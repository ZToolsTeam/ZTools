import { List, Form, ActionPanel, Action, Icon, Clipboard, showToast, Toast, useState, useEffect, useRef, useMemo, useNavigation, useLocale } from '@ztools/declarative-ui';
import { t, isDefaultSideName } from './i18n.js';
import { diffText, formatHunk, formatUnifiedDiff, describeHunk, hunkPreviewMarkdown, splitLines, MAX_DIFF_LINES } from './logic.js';
import { createCompatFileInputProps, isDeclarativeFileInputSupported } from './host-compat.js';
import { pickTextFile, readTextFileByPath, extractDroppedFilePaths } from './host.js';
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
const displaySideName = (side, fallbackKey) => {
    if (side.source === 'file')
        return side.name;
    if (side.source === 'clipboard')
        return t('clipboardName');
    if (isDefaultSideName(side.name))
        return t(fallbackKey);
    return side.name;
};
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
    useLocale();
    const { pop } = useNavigation();
    const [a, setA] = useState(left.text);
    const [b, setB] = useState(right.text);
    return Form({
        navigationTitle: t('editFormNavTitle'),
        actions: ActionPanel({ title: t('editFormPanelTitle') }, [
            Action.SubmitForm({
                title: t('startCompareAction'),
                icon: Icon.Check,
                onSubmit: () => {
                    onSave(a === left.text && left.source ? left : { name: t('sideLeft'), text: a, source: 'text' }, b === right.text && right.source ? right : { name: t('sideRight'), text: b, source: 'text' });
                    pop();
                }
            })
        ])
    }, [
        Form.TextArea({ id: 'left', title: t('sideLeftFull'), placeholder: t('leftPlaceholder'), value: a, onChange: (v) => setA(v) }),
        Form.TextArea({ id: 'right', title: t('sideRightFull'), placeholder: t('rightPlaceholder'), value: b, onChange: (v) => setB(v) })
    ]);
}
export function FileCompareCommand() {
    const locale = useLocale();
    // 两侧内容与「忽略空白」随独立窗口带走；文件内容已读成文本，不需要转交路径授权
    const [left, setLeft] = usePopoutValue('left', () => emptySide(t('sideLeft')), isSide);
    const [right, setRight] = usePopoutValue('right', () => emptySide(t('sideRight')), isSide);
    const [ignoreWhitespace, setIgnoreWhitespace] = usePopoutValue('ignoreWhitespace', () => false, isFlag);
    const { push } = useNavigation();
    const leftName = displaySideName(left, 'sideLeft');
    const rightName = displaySideName(right, 'sideRight');
    // 两侧都有内容才对比；只有一侧时进入「待选另一侧」状态，不拿空文本做整篇删除的假差异
    const hasLeft = left.source !== undefined || left.text.length > 0;
    const hasRight = right.source !== undefined || right.text.length > 0;
    const hasLeftRef = useRef(hasLeft);
    hasLeftRef.current = hasLeft;
    const hasRightRef = useRef(hasRight);
    hasRightRef.current = hasRight;
    const ready = hasLeft && hasRight;
    const resolveTargetSide = (targetFieldId) => {
        if (!targetFieldId)
            return null;
        const id = targetFieldId.trim();
        if (!id)
            return null;
        if (/(?:right|target|fileb|^b$|[-_:]b$)/i.test(id))
            return 'right';
        if (/(?:left|source|filea|^a$|[-_:]a$)/i.test(id))
            return 'left';
        return null;
    };
    const handleInputFiles = async (paths, payload) => {
        if (paths.length === 0)
            return;
        try {
            const targetSide = resolveTargetSide(payload?.targetFieldId);
            if (targetSide === 'right') {
                const file = await readTextFileByPath(paths[0]);
                setRight({ name: file.name, text: file.text, source: 'file' });
                await showToast(Toast.Style.Success, t('setAsRightToast'));
            }
            else if (targetSide === 'left') {
                const file = await readTextFileByPath(paths[0]);
                setLeft({ name: file.name, text: file.text, source: 'file' });
                await showToast(Toast.Style.Success, t('setAsLeftToast'));
            }
            else if (paths.length >= 2) {
                const [first, second] = await Promise.all([
                    readTextFileByPath(paths[0]),
                    readTextFileByPath(paths[1])
                ]);
                setLeft({ name: first.name, text: first.text, source: 'file' });
                setRight({ name: second.name, text: second.text, source: 'file' });
                await showToast(Toast.Style.Success, t('loadedTwoFilesToast'));
            }
            else {
                const file = await readTextFileByPath(paths[0]);
                if (!hasLeftRef.current || hasRightRef.current) {
                    setLeft({ name: file.name, text: file.text, source: 'file' });
                    await showToast(Toast.Style.Success, t('setAsLeftToast'));
                }
                else {
                    setRight({ name: file.name, text: file.text, source: 'file' });
                    await showToast(Toast.Style.Success, t('setAsRightToast'));
                }
            }
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('readFileFailed'), err instanceof Error ? err.message : String(err));
        }
    };
    const fileInputProps = createCompatFileInputProps((files, payload) => handleInputFiles(files, payload), {
        onTextPaste: async (text) => {
            if (!text) {
                await showToast(Toast.Style.Failure, t('clipboardEmptyToast'));
                return;
            }
            if (!hasLeftRef.current || hasRightRef.current) {
                setLeft({ name: t('clipboardName'), text, source: 'clipboard' });
                await showToast(Toast.Style.Success, t('setAsLeftToast'));
            }
            else {
                setRight({ name: t('clipboardName'), text, source: 'clipboard' });
                await showToast(Toast.Style.Success, t('setAsRightToast'));
            }
        }
    });
    useEffect(() => {
        if (isDeclarativeFileInputSupported())
            return;
        const ztools = globalThis.window?.ztools;
        if (typeof ztools?.events?.on !== 'function')
            return;
        const handler = (envelopeOrPayload) => {
            const paths = extractDroppedFilePaths(envelopeOrPayload);
            const record = envelopeOrPayload && typeof envelopeOrPayload === 'object' ? envelopeOrPayload : {};
            const inner = record.payload && typeof record.payload === 'object' ? record.payload : record;
            const targetFieldId = typeof inner.targetFieldId === 'string' ? inner.targetFieldId : undefined;
            void handleInputFiles(paths, { files: paths, source: 'drop', ...(targetFieldId ? { targetFieldId } : {}) });
        };
        const off = ztools.events.on('plugin_files_dropped', handler);
        return () => {
            if (typeof off === 'function')
                off();
            else
                ztools?.events?.off?.('plugin_files_dropped', handler);
        };
    }, []);
    // 只在输入变化时重新计算（交换、忽略空白、载入新内容、切换语言），其余重渲染直接复用结果
    const { result, error, report } = useMemo(() => {
        if (!ready)
            return { result: null, error: '', report: '' };
        try {
            const r = diffText(left.text, right.text, { ignoreWhitespace });
            return { result: r, error: '', report: formatUnifiedDiff(r, leftName, rightName) };
        }
        catch (err) {
            return { result: null, error: err instanceof Error ? err.message : String(err), report: '' };
        }
    }, [ready, left.text, right.text, leftName, rightName, ignoreWhitespace, locale]);
    const openEditor = () => push(() => EditTextsForm({ left, right, onSave: (l, r) => { setLeft(l); setRight(r); } }));
    const pasteInto = async (side) => {
        let text;
        try {
            text = await Clipboard.readText();
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('readClipboardFailed'), err instanceof Error ? err.message : String(err));
            return;
        }
        if (!text) {
            await showToast(Toast.Style.Failure, t('clipboardEmptyToast'));
            return;
        }
        side === 'left' ? setLeft({ name: t('clipboardName'), text, source: 'clipboard' }) : setRight({ name: t('clipboardName'), text, source: 'clipboard' });
        await showToast(Toast.Style.Success, side === 'left' ? t('setAsLeftToast') : t('setAsRightToast'));
    };
    const pickFile = async (side) => {
        try {
            const file = await pickTextFile(side === 'left' ? t('pickLeftFileTitle') : t('pickRightFileTitle'));
            if (!file)
                return;
            side === 'left' ? setLeft({ name: file.name, text: file.text, source: 'file' }) : setRight({ name: file.name, text: file.text, source: 'file' });
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('readFileFailed'), err instanceof Error ? err.message : String(err));
        }
    };
    const sourceActions = [
        Action({ title: t('actionEditTexts'), icon: Icon.Pencil, onAction: openEditor }),
        Action({ title: t('actionPasteLeft'), icon: Icon.CopyClipboard, onAction: () => pasteInto('left') }),
        Action({ title: t('actionPasteRight'), icon: Icon.CopyClipboard, onAction: () => pasteInto('right') }),
        Action({ title: t('actionPickLeft'), icon: Icon.Document, onAction: () => pickFile('left') }),
        Action({ title: t('actionPickRight'), icon: Icon.Document, onAction: () => pickFile('right') }),
        Action({ title: t('actionSwap'), icon: Icon.Repeat, onAction: () => { const l = left; setLeft(right); setRight(l); } }),
        Action({ title: ignoreWhitespace ? t('actionRestoreWhitespace') : t('actionIgnoreWhitespace'), icon: Icon.Text, onAction: () => setIgnoreWhitespace(!ignoreWhitespace) }),
        Action({ title: t('actionClear'), icon: Icon.Trash, onAction: () => { setLeft(emptySide(t('sideLeft'))); setRight(emptySide(t('sideRight'))); } })
    ];
    /** 复制失败如实提示，不在失败后显示「已复制」 */
    const copyText = async (text, success) => {
        try {
            await Clipboard.copy(text);
        }
        catch (err) {
            await showToast(Toast.Style.Failure, t('copyFailed'), err instanceof Error ? err.message : String(err));
            return;
        }
        await showToast(Toast.Style.Success, success);
    };
    const reportActions = report
        ? [Action({ title: t('actionCopyReport'), icon: Icon.CopyClipboard, onAction: () => copyText(report, t('copiedReportToast')) })]
        : [];
    let sections;
    if (hasLeft !== hasRight) {
        // 只载入了一侧：主动作沿用已载入一侧的来源补另一侧，次动作换另一种来源，其余收进 ⌘K
        const loaded = hasLeft ? left : right;
        const loadedName = hasLeft ? leftName : rightName;
        const missing = hasLeft ? 'right' : 'left';
        const missingLabel = missing === 'left' ? t('sideLeftFull') : t('sideRightFull');
        const pickOther = missing === 'left' ? sourceActions[3] : sourceActions[4];
        const pasteOther = missing === 'left' ? sourceActions[1] : sourceActions[2];
        const ordered = loaded.source === 'file' ? [pickOther, pasteOther, sourceActions[0]]
            : loaded.source === 'clipboard' ? [pasteOther, pickOther, sourceActions[0]]
                : [sourceActions[0], pickOther, pasteOther];
        const rest = sourceActions.filter((a) => !ordered.includes(a));
        const loadedLines = splitLines(loaded.text).length;
        sections = loadedLines > MAX_DIFF_LINES
            ? [List.Section({ title: t('sectionCannotCompare') }, [List.Item({ id: 'error', title: t('fileMaxLinesExceeded', { name: loadedName, max: MAX_DIFF_LINES }), icon: Icon.ExclamationMark, actions: ActionPanel({ title: t('panelActions') }, sourceActions) })])]
            : [
                List.Section({ title: t('sectionLoadedSide', { side: hasLeft ? t('sideLeft') : t('sideRight'), name: loadedName, lines: loadedLines }) }, [
                    List.Item({
                        id: 'need-other',
                        title: t('needOtherSideTitle', { side: missingLabel }),
                        subtitle: t('needOtherSideSubtitle'),
                        icon: Icon.Document,
                        actions: ActionPanel({ title: t('panelFillOtherSide') }, [...ordered, ...rest])
                    })
                ])
            ];
    }
    else if (!ready) {
        sections = [
            List.Section({ title: t('sectionStart') }, [
                List.Item({ id: 'start-edit', title: t('startEditTitle'), subtitle: t('startEditSubtitle'), icon: Icon.Pencil, actions: ActionPanel({ title: t('sectionStart') }, sourceActions) }),
                List.Item({ id: 'start-file', title: t('startFileTitle'), subtitle: t('startFileSubtitle'), icon: Icon.Document, actions: ActionPanel({ title: t('sectionStart') }, [sourceActions[3], sourceActions[4], sourceActions[0]]) }),
                List.Item({ id: 'start-clip', title: t('startClipTitle'), subtitle: t('startClipSubtitle'), icon: Icon.CopyClipboard, actions: ActionPanel({ title: t('sectionStart') }, [sourceActions[1], sourceActions[2], sourceActions[0]]) })
            ])
        ];
    }
    else if (error) {
        sections = [List.Section({ title: t('sectionCannotCompare') }, [List.Item({ id: 'error', title: error, icon: Icon.ExclamationMark, actions: ActionPanel({ title: t('panelActions') }, sourceActions) })])];
    }
    else if (result && result.identical) {
        sections = [
            List.Section({ title: `${leftName} ↔ ${rightName}` }, [
                List.Item({
                    id: 'identical',
                    title: ignoreWhitespace ? t('identicalIgnoreWs') : left.text === right.text ? t('identicalExact') : t('identicalLineEndingOnly'),
                    subtitle: t('totalLinesSubtitle', { count: result.leftLines }),
                    icon: Icon.Checkmark,
                    detail: List.Item.Detail({ markdown: ignoreWhitespace || left.text === right.text ? t('identicalDetailExact') : t('identicalDetailLineEnding') }),
                    actions: ActionPanel({ title: t('panelActions') }, sourceActions)
                })
            ])
        ];
    }
    else if (result) {
        sections = [
            List.Section({
                title: t('diffSummarySection', {
                    left: leftName,
                    right: rightName,
                    approx: result.approximate ? t('approximatePrefix') : '',
                    removed: result.removed,
                    added: result.added,
                    hunks: result.hunks.length
                })
            }, result.hunks.map((h, i) => List.Item({
                id: `hunk-${i}`,
                title: t('hunkLineTitle', { line: Math.max(h.rightStart, 1) }),
                subtitle: describeHunk(h),
                icon: Icon.Document,
                detail: List.Item.Detail({ markdown: hunkPreviewMarkdown(h) }),
                actions: ActionPanel({ title: t('panelDiff') }, [
                    ...reportActions,
                    Action({ title: t('actionCopyHunk'), icon: Icon.CopyClipboard, onAction: () => copyText(formatHunk(h), t('copiedHunkToast')) }),
                    ...sourceActions
                ])
            })))
        ];
    }
    else {
        sections = [];
    }
    return List({
        ...fileInputProps,
        navigationTitle: t('navTitle'),
        isShowingDetail: Boolean(result && result.hunks.length > 0) || Boolean(result?.identical),
        searchBarPlaceholder: result && result.hunks.length > 0
            ? t('searchPlaceholderResult', { key: actionPanelKey() })
            : t('searchPlaceholderIdle', { key: actionPanelKey() }),
        actions: ActionPanel({ title: t('panelGlobalActions') }, [...reportActions, ...sourceActions])
    }, sections);
}
export default FileCompareCommand;
