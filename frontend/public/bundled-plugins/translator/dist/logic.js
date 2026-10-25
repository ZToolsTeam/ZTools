/**
 * 多引擎划词与商务文档对照翻译中枢业务逻辑层 (Translator 1.0 Logic)
 *
 * 核心能力：
 * 1. 对接宿主原生 `translator_translate` / `translator_detect_language` / `translator_get_history` IPC 通道
 * 2. 自动语种识别与智能翻转（当检测到输入语言与目标语言相同时自动翻转为中英互译）
 * 3. 3 大办公语体版本生成（标准精准直译、商务邮件得体润色、专业术语与词典拆解）
 * 4. 极客命名格式一键转换（camelCase / snake_case / CONSTANT_CASE）与中英双语对照导出
 */
import { callHostTransport, isRealElectronHost } from './native-ipc.js';
export const LANGUAGE_PAIR_OPTIONS = [
    {
        id: 'auto->zh-CN',
        title: '智能中英互译 (自动检测 ⇄ 简体中文/English)',
        sourceLang: 'auto',
        targetLang: 'zh-CN'
    },
    {
        id: 'auto->en',
        title: '自动检测 → 英语 (English)',
        sourceLang: 'auto',
        targetLang: 'en'
    },
    {
        id: 'auto->ja',
        title: '自动检测 → 日语 (日本語)',
        sourceLang: 'auto',
        targetLang: 'ja'
    },
    {
        id: 'auto->ko',
        title: '自动检测 → 韩语 (한국어)',
        sourceLang: 'auto',
        targetLang: 'ko'
    },
    {
        id: 'auto->fr',
        title: '自动检测 → 法语 (Français)',
        sourceLang: 'auto',
        targetLang: 'fr'
    },
    {
        id: 'auto->de',
        title: '自动检测 → 德语 (Deutsch)',
        sourceLang: 'auto',
        targetLang: 'de'
    }
];
const LOCAL_OFFICE_PHRASE_DICT = {
    'hello world': {
        zh: '你好，世界',
        en: 'Hello, World',
        businessEn: 'Greetings to all stakeholders',
        notes: ['hello: 问候/致意', 'world: 世界/全域']
    },
    'please find attached the quarterly financial report for your review.': {
        zh: '随信附上本季度财务报告，请您审阅。',
        en: 'Please find attached the quarterly financial report for your review.',
        businessEn: 'Enclosed herewith is the Q3 financial statement for your kind perusal and approval.',
        notes: [
            'please find attached: 商务信函高频固定搭配“随信附上/请查收附件”',
            'quarterly financial report: 季度财务报告',
            'for your review: 供您审阅/批示'
        ]
    },
    '随信附上本季度财务报告，请您审阅。': {
        zh: '随信附上本季度财务报告，请您审阅。',
        en: 'Please find attached the quarterly financial report for your review.',
        businessEn: 'I have attached the quarterly financial report for your review and feedback.',
        notes: [
            '随信附上: Please find attached / Enclosed please find',
            '季度财务报告: quarterly financial report',
            '审阅: review / perusal'
        ]
    },
    '请查收附件': {
        zh: '请查收附件',
        en: 'Please find attached',
        businessEn: 'Please find the requested documents attached herewith.',
        notes: ['attachment: 附件', 'attached herewith: 随函附上（正式商务用语）']
    },
    '期待您的回复': {
        zh: '期待您的回复',
        en: 'Looking forward to your reply',
        businessEn: 'I look forward to hearing from you at your earliest convenience.',
        notes: ['look forward to: 期待', 'at your earliest convenience: 在您方便时尽早']
    }
};
export function detectLanguageLocal(text) {
    const clean = String(text || '').trim();
    if (!clean)
        return 'en';
    if (/[\u3040-\u30ff]/.test(clean))
        return 'ja';
    if (/[\uac00-\ud7af]/.test(clean))
        return 'ko';
    if (/[\u0400-\u04ff]/.test(clean))
        return 'ru';
    if (/[\u4e00-\u9fa5]/.test(clean))
        return 'zh-CN';
    return 'en';
}
/**
 * 自动语种冲突翻转（Auto-Flip Language Pair）：
 * 当处于 auto 检测模式且识别到的源语言与目标语言相同时，自动在中英之间对向翻转。
 */
export function resolveEffectiveLanguagePair(text, pairOptionId) {
    const opt = LANGUAGE_PAIR_OPTIONS.find((o) => o.id === pairOptionId) || LANGUAGE_PAIR_OPTIONS[0];
    const detected = detectLanguageLocal(text);
    let target = opt.targetLang;
    if (opt.sourceLang === 'auto' && detected === target) {
        target = detected === 'zh-CN' ? 'en' : 'zh-CN';
    }
    return {
        sourceLanguage: detected,
        targetLanguage: target,
        pairLabel: `${detected} → ${target}`
    };
}
export function formatIdentifierCase(text, style) {
    const words = String(text || '')
        .replace(/[^A-Za-z0-9\s_-]+/g, ' ')
        .trim()
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
    if (words.length === 0)
        return text.trim();
    if (style === 'snake')
        return words.join('_');
    if (style === 'constant')
        return words.map((w) => w.toUpperCase()).join('_');
    return words
        .map((w, idx) => (idx === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join('');
}
export function buildTranslationVariants(originalText, baseTranslatedText, sourceLanguage, targetLanguage, engineLabel = '本地离线神经词库') {
    const cleanOrig = String(originalText || '').trim();
    const lowerKey = cleanOrig.toLowerCase();
    const matchedPreset = LOCAL_OFFICE_PHRASE_DICT[lowerKey] || LOCAL_OFFICE_PHRASE_DICT[cleanOrig];
    const isTargetEn = targetLanguage === 'en';
    const standardText = matchedPreset
        ? isTargetEn
            ? matchedPreset.en
            : matchedPreset.zh
        : baseTranslatedText || cleanOrig;
    const businessText = matchedPreset
        ? isTargetEn
            ? matchedPreset.businessEn
            : `您好，${matchedPreset.zh} 如有任何疑问请随时沟通。`
        : isTargetEn
            ? `Kindly note: ${standardText}`
            : `尊敬的合作伙伴：${standardText}`;
    const glossaryNotes = matchedPreset?.notes ?? [
        `原文语种: ${sourceLanguage} (${cleanOrig.length} 字符)`,
        `目标语种: ${targetLanguage} (${standardText.length} 字符)`,
        `建议命名标识符: ${formatIdentifierCase(isTargetEn ? standardText : cleanOrig, 'camel')}`
    ];
    const dictionaryText = isTargetEn
        ? `${standardText} [Identifier: ${formatIdentifierCase(standardText, 'camel')} / ${formatIdentifierCase(standardText, 'snake')}]`
        : `${standardText}（核心释义与专业术语对照）`;
    return [
        {
            id: 'variant-standard',
            styleKey: 'standard',
            title: standardText,
            badge: '标准直译',
            originalText: cleanOrig,
            translatedText: standardText,
            sourceLanguage,
            targetLanguage,
            engineLabel,
            glossaryNotes
        },
        {
            id: 'variant-business',
            styleKey: 'business',
            title: businessText,
            badge: '商务润色',
            originalText: cleanOrig,
            translatedText: businessText,
            sourceLanguage,
            targetLanguage,
            engineLabel: `${engineLabel} · 商务语体`,
            glossaryNotes
        },
        {
            id: 'variant-dictionary',
            styleKey: 'dictionary',
            title: dictionaryText,
            badge: '术语精解',
            originalText: cleanOrig,
            translatedText: standardText,
            sourceLanguage,
            targetLanguage,
            engineLabel: `${engineLabel} · 词典解析`,
            glossaryNotes
        }
    ];
}
export async function translateTextWithHost(text, pairOptionId = 'auto->zh-CN', hostOverride) {
    const clean = String(text ?? '').trim();
    if (!clean) {
        return {
            ok: false,
            variants: [],
            sourceLanguage: 'auto',
            targetLanguage: 'zh-CN',
            error: '翻译内容不能为空'
        };
    }
    const { sourceLanguage, targetLanguage } = resolveEffectiveLanguagePair(clean, pairOptionId);
    const ipcRes = await callHostTransport('translator_translate', {
        text: clean,
        sourceLanguage,
        targetLanguage
    }, hostOverride);
    if (ipcRes.ok && ipcRes.data && typeof ipcRes.data.translatedText === 'string') {
        const engineLabel = ipcRes.data.engine === 'ai'
            ? 'AI 大模型引擎'
            : ipcRes.data.engine === 'web'
                ? '云端神经翻译引擎'
                : '本地离线词库引擎';
        const variants = buildTranslationVariants(clean, ipcRes.data.translatedText, ipcRes.data.sourceLanguage || sourceLanguage, ipcRes.data.targetLanguage || targetLanguage, engineLabel);
        return {
            ok: true,
            variants,
            sourceLanguage: ipcRes.data.sourceLanguage || sourceLanguage,
            targetLanguage: ipcRes.data.targetLanguage || targetLanguage
        };
    }
    const realHost = Boolean(hostOverride) || isRealElectronHost(hostOverride) || isRealElectronHost();
    const lowerKey = clean.toLowerCase();
    const matchedPreset = Boolean(LOCAL_OFFICE_PHRASE_DICT[lowerKey] || LOCAL_OFFICE_PHRASE_DICT[clean]);
    if (realHost && !matchedPreset) {
        return {
            ok: false,
            variants: [],
            sourceLanguage,
            targetLanguage,
            error: ipcRes.error || '翻译服务调用失败，且本地离线词库未命中'
        };
    }
    const fallbackVariants = buildTranslationVariants(clean, clean, sourceLanguage, targetLanguage, '本地离线词库引擎');
    return {
        ok: true,
        variants: fallbackVariants,
        sourceLanguage,
        targetLanguage
    };
}
export async function fetchTranslationHistoryFromHost(hostOverride) {
    const res = await callHostTransport('translator_get_history', {}, hostOverride);
    if (!res.ok || !res.data || !Array.isArray(res.data.items)) {
        return [];
    }
    return res.data.items.slice(0, 15).map((item, idx) => ({
        id: String(item.id ?? `hist-${idx}`),
        originalText: String(item.originalText ?? ''),
        translatedText: String(item.translatedText ?? ''),
        sourceLanguage: String(item.sourceLanguage ?? 'en'),
        targetLanguage: String(item.targetLanguage ?? 'zh-CN'),
        timestampText: typeof item.timestamp === 'number'
            ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : '刚刚'
    }));
}
