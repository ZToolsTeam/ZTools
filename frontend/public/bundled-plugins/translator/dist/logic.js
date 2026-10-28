/**
 * 翻译插件业务逻辑
 *
 * - 翻译只走客户端的 `translator_translate` 接口，插件自己不带词库、不编造译文
 * - 方向固定为中英互译：输入含中文时译为英语，其余译为中文
 * - 变量命名：把英文（原文或译文）转成 camelCase / snake_case / CONSTANT_CASE
 */
import { callHostTransport, isRealElectronHost } from './native-ipc.js';
export const NOT_IN_CLIENT_MESSAGE = '需要在 ZTools 客户端中使用';
const LANGUAGE_NAMES = {
    'zh-CN': '中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    ru: '俄语'
};
export function languageName(code) {
    return LANGUAGE_NAMES[code] || code;
}
export function detectLanguageLocal(text) {
    const clean = String(text || '').trim();
    if (!clean)
        return 'en';
    if (/[぀-ヿ]/.test(clean))
        return 'ja';
    if (/[가-힯]/.test(clean))
        return 'ko';
    if (/[Ѐ-ӿ]/.test(clean))
        return 'ru';
    if (/[一-龥]/.test(clean))
        return 'zh-CN';
    return 'en';
}
/**
 * 中英互译方向：输入是中文时译为英语，其余译为中文。
 */
export function resolveLanguagePair(text) {
    const sourceLanguage = detectLanguageLocal(text);
    return { sourceLanguage, targetLanguage: sourceLanguage === 'zh-CN' ? 'en' : 'zh-CN' };
}
export function formatIdentifierCase(text, style) {
    const words = String(text || '')
        .replace(/[^A-Za-z0-9\s_-]+/g, ' ')
        .trim()
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
    if (words.length === 0)
        return '';
    if (style === 'snake')
        return words.join('_');
    if (style === 'constant')
        return words.map((w) => w.toUpperCase()).join('_');
    return words.map((w, idx) => (idx === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}
/**
 * 结果里可用来生成变量名的英文：译文是英语时取译文，原文是英语时取原文，都不是返回空串。
 */
export function englishTextOf(result) {
    if (result.targetLanguage === 'en')
        return result.translatedText;
    if (result.sourceLanguage === 'en')
        return result.originalText;
    return '';
}
/**
 * 原文已经是英文时，变量命名不需要翻译，直接用原文生成。
 */
export function buildDirectNamingResult(text) {
    const clean = String(text ?? '').trim();
    if (!clean || detectLanguageLocal(clean) !== 'en' || !formatIdentifierCase(clean, 'camel'))
        return null;
    return {
        originalText: clean,
        translatedText: clean,
        sourceLanguage: 'en',
        targetLanguage: 'en',
        engineLabel: '原文已是英文，未翻译'
    };
}
function engineLabelOf(engine) {
    if (engine === 'offline')
        return '客户端离线词库';
    if (engine === 'web')
        return '在线翻译';
    if (engine === 'ai')
        return 'AI 翻译';
    return '客户端翻译接口';
}
export async function translateTextWithHost(text, hostOverride) {
    const clean = String(text ?? '').trim();
    if (!clean)
        return { ok: false, error: '翻译内容不能为空' };
    if (!hostOverride && !isRealElectronHost())
        return { ok: false, error: NOT_IN_CLIENT_MESSAGE };
    const { sourceLanguage, targetLanguage } = resolveLanguagePair(clean);
    const ipcRes = await callHostTransport('translator_translate', { text: clean, sourceLanguage, targetLanguage }, hostOverride);
    if (!ipcRes.ok)
        return { ok: false, error: ipcRes.error || '翻译接口调用失败' };
    const data = ipcRes.data;
    const translated = data && typeof data.translatedText === 'string' ? data.translatedText.trim() : '';
    if (!translated)
        return { ok: false, error: '客户端返回的翻译结果格式无法识别' };
    return {
        ok: true,
        result: {
            originalText: clean,
            translatedText: translated,
            sourceLanguage: typeof data.sourceLanguage === 'string' && data.sourceLanguage ? data.sourceLanguage : sourceLanguage,
            targetLanguage: typeof data.targetLanguage === 'string' && data.targetLanguage ? data.targetLanguage : targetLanguage,
            engineLabel: engineLabelOf(data.engine)
        }
    };
}
export async function fetchTranslationHistoryFromHost(hostOverride) {
    if (!hostOverride && !isRealElectronHost())
        return { ok: false, items: [], error: NOT_IN_CLIENT_MESSAGE };
    const res = await callHostTransport('translator_get_history', {}, hostOverride);
    if (!res.ok)
        return { ok: false, items: [], error: res.error || '读取翻译记录失败' };
    if (!res.data || !Array.isArray(res.data.items)) {
        return { ok: false, items: [], error: '客户端返回的翻译记录格式无法识别' };
    }
    const items = res.data.items
        .filter((item) => typeof item?.originalText === 'string' && typeof item?.translatedText === 'string')
        .slice(0, 15)
        .map((item, idx) => ({
        id: String(item.id ?? `hist-${idx}`),
        originalText: String(item.originalText),
        translatedText: String(item.translatedText),
        sourceLanguage: String(item.sourceLanguage ?? ''),
        targetLanguage: String(item.targetLanguage ?? ''),
        timestampText: typeof item.timestamp === 'number'
            ? new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : ''
    }));
    return { ok: true, items };
}
/**
 * 把客户端的报错整理成给用户看的说明。客户端离线词库查不到时只返回通用的内部错误，插件无法与其他失败区分，
 * 所以在原因后面说明词库收录有限。
 */
export function describeTranslateError(error) {
    const reason = String(error || '').trim() || '未知原因';
    if (reason === NOT_IN_CLIENT_MESSAGE || reason === '翻译内容不能为空')
        return reason;
    return `客户端返回：${reason}。当前只查客户端内置的少量中英词条，未收录的内容无法翻译`;
}
