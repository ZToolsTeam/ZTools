import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, FilterBar } from '@ztools/declarative-ui';
import { NOT_IN_CLIENT_MESSAGE, buildDirectNamingResult, describeTranslateError, englishTextOf, fetchTranslationHistoryFromHost, formatIdentifierCase, languageName, translateTextWithHost } from './logic.js';
import { isRealElectronHost } from './native-ipc.js';
export * from './logic.js';
function readLaunchFeature() {
    const scope = (globalThis.window || globalThis);
    const ctx = scope.__ztoolsLaunchContext;
    if (!ctx || (ctx.pluginId && ctx.pluginId !== 'translator'))
        return '';
    return String(ctx.featureCode || '').trim();
}
function quoteLines(text) {
    return text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
}
function buildDetailMarkdown(result) {
    return [
        '### 译文',
        '',
        quoteLines(result.translatedText),
        '',
        '---',
        '',
        `### 原文（${languageName(result.sourceLanguage)}）`,
        '',
        quoteLines(result.originalText)
    ].join('\n');
}
async function copyWithToast(text, successTitle, message) {
    try {
        await Clipboard.copy(text);
    }
    catch (err) {
        await showToast({
            style: Toast.Style.Failure,
            title: '复制失败',
            message: err instanceof Error ? err.message : String(err)
        });
        return;
    }
    await showToast({ style: Toast.Style.Success, title: successTitle, ...(message ? { message } : {}) });
}
function namingActions(english) {
    const camel = formatIdentifierCase(english, 'camel');
    const snake = formatIdentifierCase(english, 'snake');
    const constant = formatIdentifierCase(english, 'constant');
    return {
        camel: Action({
            title: '复制 camelCase 变量名',
            icon: Icon.Code,
            onAction: () => copyWithToast(camel, '已复制 camelCase 变量名', camel)
        }),
        snake: Action({
            title: '复制 snake_case 变量名',
            icon: Icon.Code,
            onAction: () => copyWithToast(snake, '已复制 snake_case 变量名', snake)
        }),
        constant: Action({
            title: '复制 CONSTANT_CASE 常量名',
            icon: Icon.Code,
            onAction: () => copyWithToast(constant, '已复制 CONSTANT_CASE 常量名', constant)
        })
    };
}
function buildResultItem(result, namingMode) {
    const english = englishTextOf(result);
    const hasIdentifier = Boolean(english && formatIdentifierCase(english, 'camel'));
    const isDirect = result.sourceLanguage === result.targetLanguage;
    const copyTranslation = Action({
        title: isDirect ? '复制原文' : '复制译文',
        icon: Icon.CopyClipboard,
        onAction: () => copyWithToast(result.translatedText, isDirect ? '已复制原文' : '已复制译文', result.translatedText)
    });
    const copyBilingual = Action({
        title: '复制原文与译文',
        icon: Icon.Clipboard,
        onAction: () => copyWithToast(`${result.originalText}\n${result.translatedText}`, '已复制原文与译文')
    });
    const children = [];
    if (hasIdentifier) {
        const naming = namingActions(english);
        if (namingMode) {
            children.push(naming.camel, naming.snake, naming.constant, copyTranslation);
            if (!isDirect)
                children.push(copyBilingual);
        }
        else {
            children.push(copyTranslation);
            if (!isDirect)
                children.push(copyBilingual);
            children.push(naming.camel, naming.snake);
        }
    }
    else {
        children.push(copyTranslation);
        if (!isDirect)
            children.push(copyBilingual);
    }
    const metadata = [
        List.Item.Detail.Metadata.Label({
            title: '方向',
            text: isDirect ? languageName(result.sourceLanguage) : `${languageName(result.sourceLanguage)} → ${languageName(result.targetLanguage)}`
        }),
        List.Item.Detail.Metadata.Label({ title: '来源', text: result.engineLabel })
    ];
    if (hasIdentifier) {
        metadata.push(List.Item.Detail.Metadata.Separator(), List.Item.Detail.Metadata.Label({ title: 'camelCase', text: formatIdentifierCase(english, 'camel') }), List.Item.Detail.Metadata.Label({ title: 'snake_case', text: formatIdentifierCase(english, 'snake') }));
    }
    return List.Item({
        id: 'translation-result',
        title: namingMode && hasIdentifier ? formatIdentifierCase(english, 'camel') : result.translatedText,
        subtitle: result.originalText,
        icon: { source: Icon.Text, tintColor: Color.SecondaryText },
        accessories: [{ tag: { value: isDirect ? '未翻译' : `${languageName(result.sourceLanguage)}→${languageName(result.targetLanguage)}` } }],
        detail: List.Item.Detail({
            markdown: buildDetailMarkdown(result),
            metadata: List.Item.Detail.Metadata({ children: metadata })
        }),
        actions: ActionPanel({ title: '译文', children })
    });
}
function buildHistoryItems(history, historyError) {
    return historyError
        ? [
            List.Item({
                id: 'history-failed',
                title: '读取翻译记录失败',
                subtitle: historyError,
                icon: { source: Icon.ExclamationMark, tintColor: Color.SecondaryText }
            })
        ]
        : history.map((h) => List.Item({
            id: h.id,
            title: h.translatedText,
            subtitle: h.originalText,
            icon: { source: Icon.Clock, tintColor: Color.SecondaryText },
            accessories: [
                { tag: { value: `${languageName(h.sourceLanguage)}→${languageName(h.targetLanguage)}` } },
                ...(h.timestampText ? [{ text: h.timestampText }] : [])
            ],
            detail: List.Item.Detail({
                markdown: ['### 译文', '', quoteLines(h.translatedText), '', '---', '', '### 原文', '', quoteLines(h.originalText)].join('\n')
            }),
            actions: ActionPanel({
                title: '翻译记录',
                children: [
                    Action({
                        title: '复制译文',
                        icon: Icon.CopyClipboard,
                        onAction: () => copyWithToast(h.translatedText, '已复制译文', h.translatedText)
                    }),
                    Action({
                        title: '复制原文与译文',
                        icon: Icon.Clipboard,
                        onAction: () => copyWithToast(`${h.originalText}\n${h.translatedText}`, '已复制原文与译文')
                    })
                ]
            })
        }));
}
export function TranslatorCommand() {
    const inClient = isRealElectronHost();
    const namingMode = readLaunchFeature() === 'translate-naming';
    const [searchText, setSearchText] = useState('');
    const [result, setResult] = useState(null);
    const [errorText, setErrorText] = useState('');
    const [history, setHistory] = useState([]);
    const [historyError, setHistoryError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    // 每次输入都会发起翻译；只采用最后一次请求的结果，避免较慢的旧请求覆盖新输入的译文
    const seqRef = useRef(0);
    function rememberHistory(r) {
        setHistory((prev) => [
            {
                id: `hist-${Date.now()}`,
                originalText: r.originalText,
                translatedText: r.translatedText,
                sourceLanguage: r.sourceLanguage,
                targetLanguage: r.targetLanguage,
                timestampText: '刚刚'
            },
            ...prev.filter((h) => h.originalText !== r.originalText)
        ].slice(0, 15));
    }
    async function runTranslate(inputText) {
        const text = inputText.trim();
        const seq = ++seqRef.current;
        if (!inClient || !text) {
            setResult(null);
            setErrorText('');
            setIsLoading(false);
            return;
        }
        if (namingMode) {
            const direct = buildDirectNamingResult(text);
            if (direct) {
                setResult(direct);
                setErrorText('');
                setIsLoading(false);
                return;
            }
        }
        setIsLoading(true);
        const outcome = await translateTextWithHost(text);
        if (seq !== seqRef.current)
            return;
        setIsLoading(false);
        if (outcome.ok) {
            setResult(outcome.result);
            setErrorText('');
            rememberHistory(outcome.result);
        }
        else {
            setResult(null);
            setErrorText(outcome.error);
        }
    }
    useEffect(() => {
        if (!inClient)
            return;
        (async () => {
            const res = await fetchTranslationHistoryFromHost();
            if (res.ok) {
                // 本次打开后新翻译的条目排在前面，客户端已有的记录接在后面，按原文去重
                setHistory((prev) => {
                    const seen = new Set(prev.map((h) => h.originalText));
                    const merged = [...prev];
                    for (const h of res.items) {
                        if (seen.has(h.originalText))
                            continue;
                        seen.add(h.originalText);
                        merged.push(h);
                    }
                    return merged.slice(0, 15);
                });
                setHistoryError('');
            }
            else {
                setHistoryError(res.error || '读取翻译记录失败');
            }
        })();
    }, []);
    useEffect(() => {
        runTranslate(searchText);
    }, [searchText]);
    async function handlePasteAndTranslate() {
        let clip = '';
        try {
            clip = String((await Clipboard.readText()) ?? '').trim();
        }
        catch (err) {
            await showToast({
                style: Toast.Style.Failure,
                title: '读取剪贴板失败',
                message: err instanceof Error ? err.message : String(err)
            });
            return;
        }
        if (!clip) {
            await showToast({ style: Toast.Style.Failure, title: '剪贴板里没有文字', message: '请先复制要翻译的文字' });
            return;
        }
        if (clip === searchText.trim()) {
            await runTranslate(clip);
            return;
        }
        setSearchText(clip);
    }
    const placeholder = namingMode ? '输入中文，翻译成英文变量名（英文原文直接转换）' : '输入要翻译的中文或英文';
    if (!inClient) {
        return List({
            searchBarPlaceholder: placeholder,
            children: [
                List.Section({
                    title: '翻译',
                    children: [
                        List.Item({
                            id: 'translator-client-required',
                            title: NOT_IN_CLIENT_MESSAGE,
                            subtitle: '翻译由 ZTools 客户端的翻译接口完成',
                            icon: { source: Icon.Info }
                        })
                    ]
                })
            ]
        });
    }
    let resultItem;
    if (result) {
        resultItem = buildResultItem(result, namingMode);
    }
    else if (errorText) {
        resultItem = List.Item({
            id: 'translation-failed',
            title: '未能翻译',
            subtitle: describeTranslateError(errorText),
            icon: { source: Icon.ExclamationMark, tintColor: Color.SecondaryText },
            detail: List.Item.Detail({ markdown: `### 未能翻译\n\n${describeTranslateError(errorText)}` })
        });
    }
    else {
        resultItem = List.Item({
            id: 'translation-empty',
            title: namingMode ? '输入中文，翻译成英文变量名' : '输入中文或英文开始翻译',
            subtitle: '只查客户端内置的少量中英常用词与办公短语，也可以点“翻译剪贴板”',
            icon: { source: Icon.Info, tintColor: Color.SecondaryText },
            detail: List.Item.Detail({
                markdown: '### 中英互译\n\n输入含中文时译为英语，其余译为中文。翻译只查客户端内置的离线词库，收录有限，未收录的内容会提示无法翻译。'
            })
        });
    }
    const historyChildren = buildHistoryItems(history, historyError);
    return List({
        searchText,
        searchBarPlaceholder: placeholder,
        onSearchTextChange: setSearchText,
        isShowingDetail: true,
        isLoading,
        filterBar: FilterBar({
            summaryText: result
                ? `${result.sourceLanguage === result.targetLanguage ? '原文已是英文' : `${languageName(result.sourceLanguage)} → ${languageName(result.targetLanguage)}`} · ${result.engineLabel}`
                : '中英互译 · 只查客户端内置的离线词库，收录有限',
            actions: [
                {
                    id: 'paste-translate-btn',
                    label: '翻译剪贴板',
                    style: 'secondary',
                    onAction: handlePasteAndTranslate
                }
            ]
        }),
        children: [
            List.Section({ title: namingMode ? '变量命名' : '翻译结果', children: [resultItem] }),
            ...(historyChildren.length > 0
                ? [List.Section({ title: historyError ? '最近翻译' : `最近翻译（${history.length}）`, children: historyChildren })]
                : [])
        ]
    });
}
export default TranslatorCommand;
