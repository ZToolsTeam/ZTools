/**
 * 声明式插件通用错误本地化解析器（R7 双轨平滑迁移共享底座）。
 *
 * 规则：
 * 1. 优先按结构化错误码（errorDetails.hostCode / details.hostCode / errorCode / code）查表：
 *    先查插件传入的 codeMap，再查标准宿主错误码双语表；
 * 2. 对称展示规则：中文模式（zh-CN）原文含 CJK 才直接展示，英文模式（en-US）原文不含 CJK 才直接展示，
 *    既保留宿主精确本地化消息，又拦截英文技术原文裸露到中文界面、拦截中文原文裸露到英文界面；
 * 3. 原文语言不匹配时优先使用标准宿主错误码译文，否则回退到插件本地 t(...) 兜底文案。
 */
import { getLocale } from '@ztools/declarative-ui';
const CJK_REGEX = /[\u4e00-\u9fa5]/;
const HOST_ERROR_CODE_MESSAGES = {
    'zh-CN': {
        INVALID_REQUEST: '请求参数无效',
        METHOD_NOT_FOUND: '当前 ZTools 版本过低或不支持此接口，请升级客户端后重试',
        METHOD_NOT_AVAILABLE: '当前 ZTools 版本过低或不支持此接口，请升级客户端后重试',
        PERMISSION_DENIED: '权限不足，无法执行该操作',
        REQUEST_TIMEOUT: '请求执行超时，请稍后重试',
        CALLER_DESTROYED: '调用窗口已关闭，操作已中止',
        APP_STOPPING: '应用正在退出，操作已取消',
        CANCELLED: '操作已取消',
        OPERATION_CANCELLED: '操作已取消',
        NOT_SUPPORTED: '当前环境不支持此操作',
        PLATFORM_NOT_SUPPORTED: '当前操作系统不支持此功能',
        NETWORK_ERROR: '网络请求失败，请检查网络连接',
        RESPONSE_TOO_LARGE: '响应数据超出大小限制',
        FILE_ERROR: '文件操作失败',
        FILE_NOT_FOUND: '目标文件或目录不存在',
        FILE_TOO_LARGE: '文件大小超出限制',
        FILE_ALREADY_EXISTS: '目标文件已存在',
        DISK_FULL: '磁盘空间不足',
        SHELL_ERROR: '系统命令或外部应用启动失败',
        PROCESS_ERROR: '进程操作失败',
        PROCESS_PROTECTED: '目标进程受系统保护，无法操作',
        PROCESS_NOT_FOUND: '未找到目标进程',
        PROCESS_ACCESS_DENIED: '无权访问或操作目标进程',
        SCREEN_ERROR: '屏幕或窗口操作失败',
        CLIPBOARD_ERROR: '剪贴板读写失败',
        DATABASE_LOCKED: '本地数据库正被占用，请稍后重试',
        DATABASE_KEY_NOT_FOUND: '未找到指定的数据项',
        DATA_CORRUPT: '本地数据格式损坏或校验失败',
        STORAGE_ERROR: '本地存储读写失败',
        PLUGIN_BUSY: '插件正忙，请稍后重试',
        PLUGIN_PERMISSION_REQUIRED: '插件缺少所需权限声明',
        DLL_ERROR: '原生组件执行失败',
        NATIVE_HOST_UNAVAILABLE: '原生宿主组件不可用',
        NATIVE_HOST_ERROR: '原生宿主执行失败',
        SERVICE_UNAVAILABLE: '系统提权服务不可用',
        INTERNAL_ERROR: '宿主内部错误'
    },
    'en-US': {
        INVALID_REQUEST: 'Invalid request parameters',
        METHOD_NOT_FOUND: 'Your ZTools version is too old or does not support this API. Please upgrade and try again.',
        METHOD_NOT_AVAILABLE: 'Your ZTools version is too old or does not support this API. Please upgrade and try again.',
        PERMISSION_DENIED: 'Permission denied',
        REQUEST_TIMEOUT: 'Request timed out. Please try again later.',
        CALLER_DESTROYED: 'The caller window was closed and the operation was aborted',
        APP_STOPPING: 'Application is exiting; operation cancelled',
        CANCELLED: 'Operation cancelled',
        OPERATION_CANCELLED: 'Operation cancelled',
        NOT_SUPPORTED: 'This operation is not supported in the current environment',
        PLATFORM_NOT_SUPPORTED: 'This feature is not supported on the current operating system',
        NETWORK_ERROR: 'Network request failed. Please check your connection.',
        RESPONSE_TOO_LARGE: 'Response payload exceeds size limit',
        FILE_ERROR: 'File operation failed',
        FILE_NOT_FOUND: 'Target file or directory not found',
        FILE_TOO_LARGE: 'File size exceeds limit',
        FILE_ALREADY_EXISTS: 'Target file already exists',
        DISK_FULL: 'Insufficient disk space',
        SHELL_ERROR: 'Failed to launch system command or external application',
        PROCESS_ERROR: 'Process operation failed',
        PROCESS_PROTECTED: 'Target process is protected by the system',
        PROCESS_NOT_FOUND: 'Target process not found',
        PROCESS_ACCESS_DENIED: 'Access denied for target process',
        SCREEN_ERROR: 'Screen or window operation failed',
        CLIPBOARD_ERROR: 'Failed to read or write clipboard',
        DATABASE_LOCKED: 'Local database is locked. Please try again later.',
        DATABASE_KEY_NOT_FOUND: 'Requested item was not found',
        DATA_CORRUPT: 'Local data is corrupted or failed validation',
        STORAGE_ERROR: 'Local storage operation failed',
        PLUGIN_BUSY: 'Plugin is busy. Please try again later.',
        PLUGIN_PERMISSION_REQUIRED: 'Plugin is missing required permission declaration',
        DLL_ERROR: 'Native component execution failed',
        NATIVE_HOST_UNAVAILABLE: 'Native host component is unavailable',
        NATIVE_HOST_ERROR: 'Native host execution failed',
        SERVICE_UNAVAILABLE: 'Elevated system service is unavailable',
        INTERNAL_ERROR: 'Internal host error'
    }
};
function asObj(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function pickNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}
/** 从错误对象或宿主响应信封中提取结构化错误码（优先 errorCode，再 code） */
export function extractErrorCode(source) {
    const rec = asObj(source);
    if (!rec)
        return '';
    const direct = pickNonEmptyString(rec.errorCode) || pickNonEmptyString(rec.code);
    if (direct)
        return direct;
    const nestedErr = asObj(rec.error);
    if (nestedErr) {
        return pickNonEmptyString(nestedErr.errorCode) || pickNonEmptyString(nestedErr.code);
    }
    const nestedData = asObj(rec.data);
    if (nestedData) {
        return pickNonEmptyString(nestedData.errorCode) || pickNonEmptyString(nestedData.code);
    }
    return '';
}
/** 从错误对象或宿主响应信封中提取 details.hostCode */
export function extractHostCode(source) {
    const rec = asObj(source);
    if (!rec)
        return '';
    const directDetails = asObj(rec.errorDetails) || asObj(rec.details);
    const fromDirect = directDetails ? pickNonEmptyString(directDetails.hostCode) : '';
    if (fromDirect)
        return fromDirect;
    const nestedErr = asObj(rec.error);
    if (nestedErr) {
        const nestedDetails = asObj(nestedErr.errorDetails) || asObj(nestedErr.details);
        const fromNested = nestedDetails ? pickNonEmptyString(nestedDetails.hostCode) : '';
        if (fromNested)
            return fromNested;
    }
    return '';
}
/** 从错误对象、宿主响应或字符串中提取原始错误文案 */
export function extractRawErrorText(source) {
    if (typeof source === 'string')
        return source.trim();
    if (source instanceof Error)
        return source.message.trim();
    const rec = asObj(source);
    if (!rec)
        return '';
    if ('error' in rec) {
        if (typeof rec.error === 'string')
            return rec.error.trim();
        const nestedErr = asObj(rec.error);
        if (nestedErr) {
            return pickNonEmptyString(nestedErr.message) || pickNonEmptyString(nestedErr.error);
        }
        return '';
    }
    return pickNonEmptyString(rec.message);
}
/** 判断某段文本在当前 locale 下是否可直接展示给用户（对称规则：zh-CN 需含 CJK，en-US 需不含 CJK） */
export function isDisplayableInCurrentLocale(text) {
    if (!text)
        return false;
    const locale = getLocale();
    if (locale === 'zh-CN')
        return CJK_REGEX.test(text);
    return !CJK_REGEX.test(text);
}
/**
 * 将宿主响应、异常对象或原始错误字符串安全解析为当前语言的提示文案：
 * 1. 若对象属于成功响应且无 error，直接返回 fallback（避免误读成功态 message/code）；
 * 2. 优先按 hostCode / errorCode / code 查插件自定义 codeMap；
 * 3. 若存在标准宿主错误码且无原文或原文语言不匹配，按当前语言查标准词典；
 * 4. 若原始文案非空且符合当前语种（中文模式含 CJK，英文模式不含 CJK），保留原始文案；
 * 5. 其余情况一律回退到插件本地传入的 fallback（即 t('...')）。
 */
export function resolveErrorMessage(source, fallback, codeMap) {
    if (source === null || source === undefined || source === '') {
        return fallback;
    }
    const rec = asObj(source);
    if (rec && 'error' in rec && rec.ok === true && !rec.error) {
        return fallback;
    }
    const hostCode = extractHostCode(source);
    const code = extractErrorCode(source);
    const rawText = extractRawErrorText(source);
    // 非失败响应容器若既无 error 文案也无 errorCode，直接返回 fallback（如 snapshot.error || t('empty')）
    if (rec && 'error' in rec && !rawText && !rec.errorCode && rec.ok !== false && rec.success !== false) {
        return fallback;
    }
    const locale = getLocale();
    const dict = HOST_ERROR_CODE_MESSAGES[locale] ?? HOST_ERROR_CODE_MESSAGES['en-US'];
    if (codeMap) {
        if (hostCode && codeMap[hostCode])
            return codeMap[hostCode];
        if (code && codeMap[code])
            return codeMap[code];
    }
    if (hostCode && dict[hostCode]) {
        if (!rawText || !isDisplayableInCurrentLocale(rawText))
            return dict[hostCode];
    }
    if (code && dict[code]) {
        if (!rawText || !isDisplayableInCurrentLocale(rawText))
            return dict[code];
    }
    if (rawText && isDisplayableInCurrentLocale(rawText)) {
        return rawText;
    }
    return fallback;
}
