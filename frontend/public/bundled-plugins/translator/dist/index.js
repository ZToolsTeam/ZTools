import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, FilterBar } from '@ztools/declarative-ui';
import { LANGUAGE_PAIR_OPTIONS, buildTranslationVariants, formatIdentifierCase, translateTextWithHost, fetchTranslationHistoryFromHost } from './logic.js';
import { readRealClipboardText } from './native-ipc.js';
export * from './logic.js';
const DEFAULT_SAMPLE_TEXT = 'Please find attached the quarterly financial report for your review.';
const INITIAL_HISTORY = [
    {
        id: 'hist-init-1',
        originalText: 'Please find attached the quarterly financial report for your review.',
        translatedText: '随信附上本季度财务报告，请您审阅。',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        timestampText: '10:30'
    },
    {
        id: 'hist-init-2',
        originalText: '期待您的回复',
        translatedText: 'Looking forward to your reply',
        sourceLanguage: 'zh-CN',
        targetLanguage: 'en',
        timestampText: '09:45'
    }
];
function buildDetailMarkdown(variant) {
    const glossaryLines = variant.glossaryNotes.map((n) => `- ${n}`).join('\n');
    return [
        `### 译文结果 (${variant.badge})`,
        '',
        `> ${variant.translatedText}`,
        '',
        '---',
        '',
        `### 原文对照 (${variant.sourceLanguage} → ${variant.targetLanguage})`,
        '',
        `${variant.originalText}`,
        '',
        '---',
        '',
        '### 专业术语与表达拆解',
        '',
        glossaryLines
    ].join('\n');
}
function reorderVariantsForFeature(list, featureCode) {
    if (!featureCode || list.length <= 1)
        return list;
    const preferredId = featureCode === 'translate-business'
        ? 'variant-business'
        : featureCode === 'translate-dict' || featureCode === 'translate-naming'
            ? 'variant-concise'
            : 'variant-standard';
    const idx = list.findIndex((item) => item.id === preferredId);
    if (idx <= 0)
        return list;
    const picked = list[idx];
    return [picked, ...list.slice(0, idx), ...list.slice(idx + 1)];
}
export function TranslatorCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'translator') ? String(launchCtx.featureCode || '').trim() : '';
    const initialPairId = initialFeature === 'translate-naming' ? 'zh-CN->en' : LANGUAGE_PAIR_OPTIONS[0].id;
    const [searchText, setSearchText] = useState('');
    const [pairOptionId, setPairOptionId] = useState(initialPairId);
    const [variants, setVariants] = useState(() => reorderVariantsForFeature(buildTranslationVariants(DEFAULT_SAMPLE_TEXT, '随信附上本季度财务报告，请您审阅。', 'en', 'zh-CN', '本地离线神经词库'), initialFeature));
    const [history, setHistory] = useState(INITIAL_HISTORY);
    const [isLoading, setIsLoading] = useState(false);
    const translatingRef = useRef(false);
    async function runTranslate(inputText, pairId, showToastOnDone = false) {
        const targetText = inputText.trim() || DEFAULT_SAMPLE_TEXT;
        if (translatingRef.current)
            return;
        translatingRef.current = true;
        setIsLoading(true);
        try {
            const res = await translateTextWithHost(targetText, pairId);
            if (res.ok && res.variants.length > 0) {
                const ordered = reorderVariantsForFeature(res.variants, initialFeature);
                setVariants(ordered);
                const primary = ordered[0];
                if (inputText.trim()) {
                    setHistory((prev) => {
                        const filtered = prev.filter((h) => h.originalText !== primary.originalText);
                        return [
                            {
                                id: `hist-${Date.now()}`,
                                originalText: primary.originalText,
                                translatedText: primary.translatedText,
                                sourceLanguage: primary.sourceLanguage,
                                targetLanguage: primary.targetLanguage,
                                timestampText: '刚刚'
                            },
                            ...filtered
                        ].slice(0, 15);
                    });
                }
                if (showToastOnDone) {
                    await showToast({
                        style: Toast.Style.Success,
                        title: '已完成多语体精译',
                        message: `${primary.sourceLanguage} → ${primary.targetLanguage}`
                    });
                }
            }
        }
        finally {
            translatingRef.current = false;
            setIsLoading(false);
        }
    }
    useEffect(() => {
        ;
        (async () => {
            const hostHist = await fetchTranslationHistoryFromHost();
            if (hostHist.length > 0) {
                setHistory(hostHist);
            }
        })();
    }, []);
    useEffect(() => {
        runTranslate(searchText, pairOptionId, false);
    }, [searchText, pairOptionId]);
    async function handlePasteAndTranslate() {
        const clip = (await readRealClipboardText()).trim();
        if (!clip) {
            await showToast({
                style: Toast.Style.Failure,
                title: '剪贴板为空',
                message: '请先复制需要翻译的单词或段落'
            });
            return;
        }
        setSearchText(clip);
        await runTranslate(clip, pairOptionId, true);
    }
    function handleSwapLanguageDirection() {
        const nextId = pairOptionId === 'auto->en' ? 'auto->zh-CN' : 'auto->en';
        setPairOptionId(nextId);
    }
    const activeSource = variants[0]?.sourceLanguage || 'en';
    const activeTarget = variants[0]?.targetLanguage || 'zh-CN';
    const activeOriginal = variants[0]?.originalText || DEFAULT_SAMPLE_TEXT;
    return List({
        searchBarPlaceholder: '输入或粘贴待翻译单词、外贸邮件、技术文档段落 (自动检测中英日韩互译)...',
        onSearchTextChange: setSearchText,
        isShowingDetail: true,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '选择源语言与目标语言方向',
            value: pairOptionId,
            onChange: (val) => setPairOptionId(val),
            children: LANGUAGE_PAIR_OPTIONS.map((opt) => List.Dropdown.Item({
                title: opt.title,
                value: opt.id
            }))
        }),
        filterBar: FilterBar({
            summaryText: `识别语种: ${activeSource} → ${activeTarget} · 原文 ${activeOriginal.length} 字符 · 提供 3 种办公语体对照`,
            actions: [
                {
                    id: 'paste-translate-btn',
                    label: '翻译剪贴板',
                    style: 'secondary',
                    onAction: handlePasteAndTranslate
                },
                {
                    id: 'swap-lang-btn',
                    label: '反转语种',
                    style: 'secondary',
                    onAction: handleSwapLanguageDirection
                }
            ]
        }),
        children: [
            List.Section({
                title: '多语体精译与专业词典版本 (3)',
                children: variants.map((v) => List.Item({
                    id: v.id,
                    title: v.title,
                    subtitle: `${v.sourceLanguage} → ${v.targetLanguage} · ${v.engineLabel}`,
                    icon: {
                        source: Icon.Text,
                        tintColor: Color.SecondaryText
                    },
                    accessories: [{ tag: { value: v.badge } }],
                    detail: List.Item.Detail({
                        markdown: buildDetailMarkdown(v),
                        metadata: List.Item.Detail.Metadata({
                            children: [
                                List.Item.Detail.Metadata.Label({
                                    title: '语体风格',
                                    text: v.badge
                                }),
                                List.Item.Detail.Metadata.Label({
                                    title: '语种方向',
                                    text: `${v.sourceLanguage} → ${v.targetLanguage}`
                                }),
                                List.Item.Detail.Metadata.Label({
                                    title: '翻译引擎',
                                    text: v.engineLabel
                                }),
                                List.Item.Detail.Metadata.Separator(),
                                List.Item.Detail.Metadata.Label({
                                    title: 'camelCase 命名',
                                    text: formatIdentifierCase(v.translatedText, 'camel')
                                }),
                                List.Item.Detail.Metadata.Label({
                                    title: 'snake_case 命名',
                                    text: formatIdentifierCase(v.translatedText, 'snake')
                                })
                            ]
                        })
                    }),
                    actions: ActionPanel({
                        title: v.badge,
                        children: [
                            Action({
                                title: '复制当前译文到剪贴板',
                                icon: Icon.CopyClipboard,
                                onAction: async () => {
                                    await Clipboard.copy(v.translatedText);
                                    await showToast({
                                        style: Toast.Style.Success,
                                        title: `已复制「${v.badge}」译文`,
                                        message: v.translatedText
                                    });
                                }
                            }),
                            Action({
                                title: '复制双语对照文本 (原文 + 译文)',
                                icon: Icon.Clipboard,
                                shortcut: { modifiers: ['ctrl'], key: 'enter' },
                                onAction: async () => {
                                    const bilingual = `${v.originalText}\n${v.translatedText}`;
                                    await Clipboard.copy(bilingual);
                                    await showToast({
                                        style: Toast.Style.Success,
                                        title: '已复制双语对照段落'
                                    });
                                }
                            }),
                            Action({
                                title: '粘贴并翻译剪贴板文本',
                                icon: Icon.Clipboard,
                                shortcut: { modifiers: ['ctrl'], key: 'v' },
                                onAction: handlePasteAndTranslate
                            }),
                            Action({
                                title: '反转源语言与目标语言方向',
                                icon: Icon.ArrowRight,
                                shortcut: { modifiers: ['ctrl'], key: 's' },
                                onAction: handleSwapLanguageDirection
                            }),
                            Action({
                                title: '复制为 camelCase 编程标识符',
                                icon: Icon.Code,
                                shortcut: { modifiers: ['ctrl'], key: 'u' },
                                onAction: async () => {
                                    const idStr = formatIdentifierCase(v.translatedText, 'camel');
                                    await Clipboard.copy(idStr);
                                    await showToast({
                                        style: Toast.Style.Success,
                                        title: '已复制 camelCase 变量名',
                                        message: idStr
                                    });
                                }
                            })
                        ]
                    })
                }))
            }),
            List.Section({
                title: `最近翻译历史记录 (${history.length})`,
                children: history.map((h) => List.Item({
                    id: h.id,
                    title: h.translatedText,
                    subtitle: h.originalText,
                    icon: {
                        source: Icon.Clock,
                        tintColor: Color.SecondaryText
                    },
                    accessories: [
                        { tag: { value: `${h.sourceLanguage}→${h.targetLanguage}` } },
                        { text: h.timestampText }
                    ],
                    detail: List.Item.Detail({
                        markdown: [
                            '### 历史译文',
                            '',
                            `> ${h.translatedText}`,
                            '',
                            '---',
                            '',
                            '### 历史原文',
                            '',
                            h.originalText
                        ].join('\n')
                    }),
                    actions: ActionPanel({
                        title: '历史记录操作',
                        children: [
                            Action({
                                title: '复制历史译文',
                                icon: Icon.CopyClipboard,
                                onAction: async () => {
                                    await Clipboard.copy(h.translatedText);
                                    await showToast({ style: Toast.Style.Success, title: '已复制历史译文' });
                                }
                            }),
                            Action({
                                title: '复制双语对照 (原文 + 译文)',
                                icon: Icon.Clipboard,
                                shortcut: { modifiers: ['ctrl'], key: 'enter' },
                                onAction: async () => {
                                    await Clipboard.copy(`${h.originalText}\n${h.translatedText}`);
                                    await showToast({ style: Toast.Style.Success, title: '已复制双语对照' });
                                }
                            }),
                            Action({
                                title: '清空翻译历史记录',
                                icon: Icon.Trash,
                                style: Action.Style.Destructive,
                                shortcut: { modifiers: [], key: 'delete' },
                                onAction: async () => {
                                    setHistory([]);
                                    await showToast({ style: Toast.Style.Success, title: '已清空翻译历史记录' });
                                }
                            })
                        ]
                    })
                }))
            })
        ]
    });
}
export default TranslatorCommand;
