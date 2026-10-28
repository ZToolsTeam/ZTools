/**
 * 电子发票识别与报销归集业务逻辑
 *
 * 核心能力：
 * 1. 扫描下载 / 桌面 / 文档目录中的 PDF、XML 电子发票，交给宿主识别发票号码、开票日期、销售方、购买方、价税合计与税额
 * 2. 识别不到的字段保持为空并标为「未识别」，补全前不能勾选导出，也不参与按字段生成文件名
 * 3. 发票号查重与个人抬头提示
 * 4. 按模板复制出规范命名的发票副本（不改动原文件），生成 UTF-8 BOM 报销明细 CSV 与可直接粘贴到表格的 TSV 文本
 */
import { getRealSystemPath, invokeDllPluginCapability, scanRealDirectoryTree, showRealItemInFolder, trashRealItem } from './native-ipc.js';
export { formatBytes } from './native-ipc.js';
export const INVOICE_FIELD_ORDER = [
    'invoiceNo',
    'issueDate',
    'sellerName',
    'buyerName',
    'totalAmount',
    'taxAmount'
];
export const INVOICE_FIELD_LABELS = {
    invoiceNo: '发票号码',
    issueDate: '开票日期',
    sellerName: '销售方',
    buyerName: '购买方',
    totalAmount: '价税合计',
    taxAmount: '税额'
};
/** 字段未识别时在界面与表格文本里显示的文字 */
export const UNRECOGNIZED_TEXT = '未识别';
export const DLL_PLUGIN_NAME = 'InvoiceAssistantPlugin';
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i');
export const FORBIDDEN_REASON = '发票归档输出目录不可指向系统受保护路径或包含路径穿越';
/** 导出目录的上级目录名（位于第一张发票所在目录下），扫描时跳过其中的副本 */
export const EXPORT_ROOT_DIR_NAME = 'ZTools_Reimbursement_Export';
export const INVOICE_RENAME_TEMPLATES = [
    {
        id: 'tpl-standard',
        title: '模板 1: [分类]_[日期]_[销方]_[金额]元_[尾号]',
        patternDesc: '[餐饮招待]_2026-10-18_星巴克咖啡_68.00元_8921.pdf'
    },
    {
        id: 'tpl-date-first',
        title: '模板 2: [日期]_[分类]_[金额]元_[销方]',
        patternDesc: '2026-10-18_[餐饮招待]_68.00元_星巴克咖啡.pdf'
    },
    {
        id: 'tpl-amount-first',
        title: '模板 3: [分类]_[金额]元_[销方]_[尾号]',
        patternDesc: '[餐饮招待]_68.00元_星巴克咖啡_8921.pdf'
    },
    {
        id: 'tpl-tax-audit',
        title: '模板 4: [发票全号]_[日期]_[销方]_[金额]元',
        patternDesc: '24312000000048298921_2026-10-18_星巴克咖啡_68.00元.pdf'
    }
];
export const INVOICE_CATEGORY_GROUPS = [
    { id: 'ALL', name: '全部电子发票' },
    { id: 'TRAVEL', name: '差旅 (交通出行 + 住宿)' },
    { id: '交通出行', name: '交通出行 (滴滴/高铁/打车)' },
    { id: '差旅住宿', name: '差旅住宿 (酒店/机票)' },
    { id: '餐饮招待', name: '餐饮招待 (餐饮/咖啡)' },
    { id: '办公采购', name: '办公采购与云服务' },
    { id: '其他费用', name: '其他费用' }
];
export const EXPENSE_CATEGORY_CYCLE = [
    '餐饮招待',
    '交通出行',
    '差旅住宿',
    '办公采购',
    '其他费用'
];
/** 宿主识别返回的分类名与插件分类的对应关系 */
export const HOST_CATEGORY_ALIASES = {
    差旅交通: '交通出行',
    酒店住宿: '差旅住宿',
    办公设备: '办公采购',
    技术与云服务: '办公采购'
};
/** 宿主识别不到销售方 / 购买方时填入的占位文字，不能当作识别结果 */
const PLACEHOLDER_PARTY_NAMES = new Set(['未知销售商户', '未知商户', '未知开票商户', '默认企业抬头']);
export function normalizeInvoiceCategory(raw) {
    const text = String(raw ?? '').trim();
    if (EXPENSE_CATEGORY_CYCLE.includes(text))
        return text;
    return HOST_CATEGORY_ALIASES[text] ?? '其他费用';
}
/** 发票号码：传统发票 8 位、数电发票 20 位数字；全 0 是宿主读到 PDF 内部偏移量等无关数字 */
export function normalizeInvoiceNo(raw) {
    const text = String(raw ?? '').replace(/\s+/g, '');
    if (!/^(?:\d{8}|\d{20})$/.test(text))
        return '';
    if (/^0+$/.test(text))
        return '';
    return text;
}
function pad2(n) {
    return String(n).padStart(2, '0');
}
export function formatLocalDateKey(now) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
/** 开票日期规范为 YYYY-MM-DD；不是真实日期、早于 2000 年或晚于今天时返回空字符串 */
export function normalizeIssueDate(raw, now = new Date()) {
    const text = String(raw ?? '').trim();
    const m = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/);
    if (!m)
        return '';
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31)
        return '';
    const probe = new Date(year, month - 1, day);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day)
        return '';
    const key = `${year}-${pad2(month)}-${pad2(day)}`;
    if (key > formatLocalDateKey(now))
        return '';
    return key;
}
/** 日期与今天（本地或 UTC）相同：可能是宿主识别不到日期时填入的当天日期 */
export function isPossibleFallbackDate(date, now = new Date()) {
    if (!date)
        return false;
    return date === formatLocalDateKey(now) || date === now.toISOString().slice(0, 10);
}
/** 金额：非负有限数，保留两位小数；allowZero 为 false 时 0 也视为未识别 */
export function normalizeAmount(raw, allowZero) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === 'string' && raw.trim() === '')
        return null;
    const num = typeof raw === 'number' ? raw : Number(String(raw).replace(/[¥￥,，\s]/g, ''));
    if (!Number.isFinite(num) || num < 0)
        return null;
    if (!allowZero && num === 0)
        return null;
    return Math.round(num * 100) / 100;
}
function normalizePartyName(raw) {
    const text = String(raw ?? '').trim();
    if (!text || PLACEHOLDER_PARTY_NAMES.has(text))
        return '';
    return text;
}
function computeNetAmount(total, tax) {
    if (total === null || tax === null || tax > total)
        return null;
    return Math.round((total - tax) * 100) / 100;
}
function extOfFileName(fileName) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}
/**
 * 把宿主返回的一条识别结果整理成插件数据；识别不到的字段一律留空，不填默认值。
 * 缺少文件路径的结果无法导出或定位，返回 null。
 */
export function normalizeParsedInvoice(raw, idx, now = new Date()) {
    const filePath = String(raw.path ?? '').trim();
    if (!filePath)
        return null;
    const fileName = String(raw.fileName ?? '').trim() || filePath.split(/[\\/]/).pop() || filePath;
    const issueDate = normalizeIssueDate(raw.issueDate, now);
    const totalAmount = normalizeAmount(raw.totalAmount, false);
    // 宿主识别不到税额时填 0；价税合计都没识别到时，这个 0 不可信
    let taxAmount = normalizeAmount(raw.taxAmount, true);
    if (taxAmount !== null && totalAmount !== null && taxAmount > totalAmount)
        taxAmount = null;
    if (totalAmount === null && taxAmount === 0)
        taxAmount = null;
    const sizeBytes = Number(raw.sizeBytes);
    return {
        id: String(raw.id ?? `inv-${idx}-${filePath}`),
        path: filePath,
        fileName,
        extension: extOfFileName(fileName),
        sizeBytes: Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : 0,
        invoiceNo: normalizeInvoiceNo(raw.invoiceNo),
        issueDate,
        issueDateNeedsReview: isPossibleFallbackDate(issueDate, now),
        sellerName: normalizePartyName(raw.sellerName),
        buyerName: normalizePartyName(raw.buyerName),
        buyerTaxId: String(raw.buyerTaxId ?? '').trim(),
        totalAmount,
        taxAmount,
        netAmount: computeNetAmount(totalAmount, taxAmount),
        category: normalizeInvoiceCategory(raw.category),
        isDuplicate: false,
        isHeaderAbnormal: false
    };
}
export function getInvoiceFieldIssues(item) {
    const missing = [];
    if (!item.invoiceNo)
        missing.push('invoiceNo');
    if (!item.issueDate)
        missing.push('issueDate');
    if (!item.sellerName)
        missing.push('sellerName');
    if (!item.buyerName)
        missing.push('buyerName');
    if (item.totalAmount === null || !Number.isFinite(item.totalAmount))
        missing.push('totalAmount');
    if (item.taxAmount === null || !Number.isFinite(item.taxAmount))
        missing.push('taxAmount');
    const needsReview = item.issueDate && item.issueDateNeedsReview ? ['issueDate'] : [];
    return { missing, needsReview };
}
export function isInvoiceComplete(item) {
    const issues = getInvoiceFieldIssues(item);
    return issues.missing.length === 0 && issues.needsReview.length === 0;
}
/** 例如「未识别：价税合计、税额；开票日期待核对」；字段完整时返回空字符串 */
export function describeInvoiceIssues(item) {
    const { missing, needsReview } = getInvoiceFieldIssues(item);
    const parts = [];
    if (missing.length > 0)
        parts.push(`未识别：${missing.map((f) => INVOICE_FIELD_LABELS[f]).join('、')}`);
    if (needsReview.length > 0)
        parts.push(`${needsReview.map((f) => INVOICE_FIELD_LABELS[f]).join('、')}待核对`);
    return parts.join('；');
}
/** 可以勾选导出：字段完整且不是重复发票 */
export function isInvoiceSelectable(item) {
    return isInvoiceComplete(item) && !item.isDuplicate;
}
/** 默认勾选：可导出且抬头正常 */
export function defaultCheckedInvoiceIds(items) {
    return items.filter((i) => isInvoiceSelectable(i) && !i.isHeaderAbnormal).map((i) => i.id);
}
export function formatCurrency(amount) {
    if (amount === null || amount === undefined)
        return UNRECOGNIZED_TEXT;
    const num = Number(amount);
    if (!Number.isFinite(num))
        return UNRECOGNIZED_TEXT;
    return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/**
 * 按模板生成归档文件名；发票有未识别或待核对的字段时返回 null（不能用占位值拼文件名）
 */
export function buildTargetInvoiceFileName(item, templateId) {
    if (!isInvoiceComplete(item))
        return null;
    const ext = item.extension || extOfFileName(item.fileName);
    const safeSeller = item.sellerName.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24);
    const tailNo = item.invoiceNo.slice(-4);
    const amt = item.totalAmount.toFixed(2);
    const date = item.issueDate;
    const cat = item.category || '其他费用';
    if (templateId === 'tpl-date-first') {
        return `${date}_[${cat}]_${amt}元_${safeSeller}${ext}`;
    }
    if (templateId === 'tpl-amount-first') {
        return `[${cat}]_${amt}元_${safeSeller}_${tailNo}${ext}`;
    }
    if (templateId === 'tpl-tax-audit') {
        return `${item.invoiceNo}_${date}_${safeSeller}_${amt}元${ext}`;
    }
    return `[${cat}]_${date}_${safeSeller}_${amt}元_${tailNo}${ext}`;
}
/**
 * 为一批发票生成互不重名的归档文件名（不区分大小写，重名的依次加 _2、_3），
 * 避免复制副本时后一份覆盖前一份。字段不完整的发票不分配文件名。
 */
export function buildUniqueTargetNames(items, templateId) {
    const used = new Set();
    const out = new Map();
    for (const item of items) {
        const base = buildTargetInvoiceFileName(item, templateId);
        if (!base)
            continue;
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        let name = base;
        let n = 2;
        while (used.has(name.toLowerCase())) {
            name = `${stem}_${n}${ext}`;
            n++;
        }
        used.add(name.toLowerCase());
        out.set(item.id, name);
    }
    return out;
}
function displayText(value) {
    return value || UNRECOGNIZED_TEXT;
}
function displayAmount(value) {
    return value === null || !Number.isFinite(value) ? UNRECOGNIZED_TEXT : value.toFixed(2);
}
function displayDate(item) {
    if (!item.issueDate)
        return UNRECOGNIZED_TEXT;
    return item.issueDateNeedsReview ? `${item.issueDate}(待核对)` : item.issueDate;
}
/**
 * 生成可直接粘贴到 Excel / 飞书表格的 TSV（制表符分隔）报销明细文本；
 * 未识别的字段写「未识别」，字段不完整的发票不生成归档文件名
 */
export function buildInvoiceTsvTable(items, templateId = 'tpl-standard') {
    const header = [
        '序号',
        '发票号码',
        '开票日期',
        '费用分类',
        '销方名称',
        '购方抬头',
        '价税合计(元)',
        '税额(元)',
        '不含税金额(元)',
        '归档文件名'
    ].join('\t');
    const names = buildUniqueTargetNames(items, templateId);
    const clean = (value) => value.replace(/[\t\r\n]+/g, ' ');
    const rows = items.map((item, idx) => [
        idx + 1,
        clean(displayText(item.invoiceNo)),
        displayDate(item),
        item.category,
        clean(displayText(item.sellerName)),
        clean(displayText(item.buyerName)),
        displayAmount(item.totalAmount),
        displayAmount(item.taxAmount),
        displayAmount(item.netAmount),
        names.get(item.id) ?? ''
    ].join('\t'));
    return [header, ...rows].join('\n');
}
/** 单张发票的文字摘要（复制用），未识别的字段写「未识别」 */
export function buildInvoiceSummaryText(item) {
    return [
        `发票号码: ${displayText(item.invoiceNo)}`,
        `开票日期: ${displayDate(item)}`,
        `销方名称: ${displayText(item.sellerName)}`,
        `购方名称: ${displayText(item.buyerName)}`,
        `价税合计: ${displayAmount(item.totalAmount)}元 (税额: ${displayAmount(item.taxAmount)}元)`
    ].join('\n');
}
/**
 * 执行发票号查重与购方抬头异常预检（按当前字段重新计算，修改发票信息后可再次调用）
 */
export function detectInvoiceAnomalies(items, expectedBuyerKeyword = '') {
    const seenNo = new Set();
    const kw = expectedBuyerKeyword.trim();
    return items.map((item) => {
        const normNo = String(item.invoiceNo || '').trim();
        const isDuplicate = normNo.length > 0 && seenNo.has(normNo);
        if (normNo.length > 0)
            seenNo.add(normNo);
        const buyer = String(item.buyerName || '').trim();
        // 购买方未识别时归入「未识别字段」，这里只判断已识别的抬头
        const isPersonalHeader = buyer.length > 0 && /个人|先生|女士|^[^一-龥]*$/.test(buyer);
        const isMismatch = kw && buyer.length > 0 ? !buyer.includes(kw) && !String(item.buyerTaxId || '').includes(kw) : false;
        return {
            ...item,
            isDuplicate,
            isHeaderAbnormal: Boolean(isPersonalHeader || isMismatch)
        };
    });
}
/** 列表筛选与左侧导航计数共用的匹配规则 */
export function matchesInvoiceFilter(item, key) {
    switch (key) {
        case 'ALL':
            return true;
        case 'DUPLICATE':
            return item.isDuplicate;
        case 'ABNORMAL':
            return item.isHeaderAbnormal;
        case 'INCOMPLETE':
            return !isInvoiceComplete(item);
        case 'TRAVEL':
            return item.category === '交通出行' || item.category === '差旅住宿';
        default:
            return item.category === key;
    }
}
const AMOUNT_TEXT_PATTERN = /^\d+(?:\.\d{1,2})?$/;
function parseAmountText(text) {
    const cleaned = String(text ?? '').replace(/[¥￥,，\s]/g, '');
    if (!AMOUNT_TEXT_PATTERN.test(cleaned))
        return null;
    return Math.round(Number(cleaned) * 100) / 100;
}
/** 校验用户补全 / 修改的发票字段 */
export function validateInvoiceEdits(input, now = new Date()) {
    const errors = {};
    const invoiceNo = normalizeInvoiceNo(input.invoiceNo);
    if (!invoiceNo)
        errors.invoiceNo = '发票号码应为 8 位（传统发票）或 20 位（数电发票）数字';
    const issueDate = normalizeIssueDate(input.issueDate, now);
    if (!issueDate)
        errors.issueDate = '请按 YYYY-MM-DD 填写真实的开票日期，且不能晚于今天';
    const sellerName = String(input.sellerName ?? '').trim();
    if (!sellerName)
        errors.sellerName = '请填写销售方名称';
    else if (sellerName.length > 100)
        errors.sellerName = '销售方名称不能超过 100 个字符';
    const buyerName = String(input.buyerName ?? '').trim();
    if (!buyerName)
        errors.buyerName = '请填写购买方名称（发票抬头）';
    else if (buyerName.length > 100)
        errors.buyerName = '购买方名称不能超过 100 个字符';
    const totalAmount = parseAmountText(input.totalAmount);
    if (totalAmount === null || totalAmount <= 0)
        errors.totalAmount = '价税合计应为大于 0 的金额，最多两位小数';
    else if (totalAmount > 100_000_000)
        errors.totalAmount = '价税合计超出范围';
    const taxAmount = parseAmountText(input.taxAmount);
    if (taxAmount === null)
        errors.taxAmount = '税额应为不小于 0 的金额，最多两位小数（免税填 0）';
    else if (totalAmount !== null && taxAmount > totalAmount)
        errors.taxAmount = '税额不能大于价税合计';
    if (Object.keys(errors).length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        values: {
            invoiceNo,
            issueDate,
            sellerName,
            buyerName,
            totalAmount: totalAmount,
            taxAmount: taxAmount,
            netAmount: Math.round((totalAmount - taxAmount) * 100) / 100
        }
    };
}
/** 把用户确认过的字段写回发票（日期视为已核对），并重新计算查重与抬头检查 */
export function applyInvoiceEdits(items, id, values, expectedBuyer = '') {
    const next = items.map((item) => item.id === id ? { ...item, ...values, issueDateNeedsReview: false } : item);
    return detectInvoiceAnomalies(next, expectedBuyer);
}
export function validateInvocationPayload(method, params) {
    if (typeof method !== 'string' || method.trim().length === 0) {
        return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' };
    }
    if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
        return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' };
    }
    if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
        return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' };
    }
    const record = params;
    for (const [key, val] of Object.entries(record)) {
        if (typeof val === 'string') {
            if (val.length > 4096) {
                return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` };
            }
            if ((key === 'outputDir' || key === 'targetDir') && FORBIDDEN_TARGET_PATTERN.test(val)) {
                return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` };
            }
        }
    }
    return { valid: true };
}
export async function invokeNativeCapability(method, params, hostBridge) {
    const check = validateInvocationPayload(method, params);
    if (!check.valid) {
        throw new Error(check.error || '参数校验失败');
    }
    const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge);
    return {
        ok: res.ok,
        pluginName: DLL_PLUGIN_NAME,
        method: method.trim(),
        data: res.data ?? undefined,
        error: res.error,
        fromFallback: res.fromFallback
    };
}
const INVOICE_FILE_REGEX = /\.(?:pdf|xml)$/i;
const INVOICE_NAME_HINT = /发票|fapiao|invoice|电子票|通行费|行程单|滴滴|高铁|酒店|餐饮|报销|\d{8,20}/i;
/** 本插件以前导出的汇总文件，不是发票 */
const EXPORTED_FILE_NAMES = /合并报销打印件|报销台账|报销发票明细汇总表|报销发票合并打印版/;
/** 扫描时每个目录最多检查的文件数（宿主限制） */
export const SCAN_FILES_PER_DIR = 200;
export function isInsideExportDirectory(filePath) {
    return filePath
        .split(/[\\/]/)
        .some((segment) => segment.toLowerCase() === EXPORT_ROOT_DIR_NAME.toLowerCase());
}
function readParseErrors(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.map((entry) => {
        const rec = (entry && typeof entry === 'object' ? entry : {});
        return {
            file: String(rec.file ?? rec.path ?? ''),
            error: String(rec.error ?? rec.message ?? '未知错误')
        };
    });
}
export async function fetchRealInvoicesWorkspace(expectedBuyer = '', hostOverride, now = new Date()) {
    const [downloadsDir, desktopDir, documentsDir] = await Promise.all([
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('desktop', hostOverride),
        getRealSystemPath('documents', hostOverride)
    ]);
    const dirs = [downloadsDir, desktopDir, documentsDir].filter(Boolean);
    if (dirs.length === 0) {
        return {
            ok: false,
            invoices: [],
            scannedFilesCount: 0,
            parseErrors: [],
            scannedDirs: [],
            error: '无法获取下载、桌面、文档目录的路径，请确认客户端已正常启动'
        };
    }
    const candidatePaths = [];
    const seen = new Set();
    for (const dir of dirs) {
        const scan = await scanRealDirectoryTree(dir, {
            maxDepth: 2,
            maxFiles: SCAN_FILES_PER_DIR,
            collectTopN: 45,
            filterExt: INVOICE_FILE_REGEX,
            hostOverride
        });
        for (const f of scan.files) {
            if (f.sizeBytes <= 0)
                continue;
            if (!INVOICE_FILE_REGEX.test(f.name))
                continue;
            if (EXPORTED_FILE_NAMES.test(f.name))
                continue;
            if (isInsideExportDirectory(f.path))
                continue;
            if (!INVOICE_NAME_HINT.test(f.name) && candidatePaths.length >= 12)
                continue;
            const norm = f.path.toLowerCase();
            if (seen.has(norm))
                continue;
            seen.add(norm);
            candidatePaths.push(f.path);
        }
    }
    if (candidatePaths.length === 0) {
        return { ok: true, invoices: [], scannedFilesCount: 0, parseErrors: [], scannedDirs: dirs };
    }
    const res = await invokeNativeCapability('ParseInvoices', {
        files: candidatePaths,
        ...(expectedBuyer ? { expectedBuyer } : {})
    }, hostOverride);
    if (!res.ok || !res.data || typeof res.data !== 'object') {
        return {
            ok: false,
            invoices: [],
            scannedFilesCount: candidatePaths.length,
            parseErrors: [],
            scannedDirs: dirs,
            error: res.error || '宿主没有返回发票识别结果'
        };
    }
    const payload = res.data;
    const rawList = Array.isArray(payload.invoices)
        ? payload.invoices
        : [];
    const parseErrors = readParseErrors(payload.errors);
    const parsed = [];
    rawList.forEach((raw, idx) => {
        const item = normalizeParsedInvoice(raw && typeof raw === 'object' ? raw : {}, idx, now);
        if (item) {
            parsed.push(item);
        }
        else {
            parseErrors.push({ file: String(raw?.fileName ?? `第 ${idx + 1} 条结果`), error: '识别结果缺少文件路径' });
        }
    });
    return {
        ok: true,
        invoices: detectInvoiceAnomalies(parsed, expectedBuyer),
        scannedFilesCount: candidatePaths.length,
        parseErrors,
        scannedDirs: dirs
    };
}
/**
 * 本次导出的输出目录：第一张发票所在目录下的 ZTools_Reimbursement_Export\报销归档_<时间>。
 * 每次导出用新目录，宿主写副本与 CSV 时不会覆盖上次导出的文件。
 */
export function buildExportOutputDir(firstInvoicePath, now = new Date()) {
    const p = String(firstInvoicePath || '').trim();
    const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    if (idx <= 0)
        throw new Error(`无法确定发票所在目录: ${p || '(空路径)'}`);
    const sep = p[idx];
    const dir = p.slice(0, idx);
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_` +
        `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}_` +
        String(now.getMilliseconds()).padStart(3, '0');
    return `${dir}${sep}${EXPORT_ROOT_DIR_NAME}${sep}报销归档_${stamp}`;
}
/**
 * 导出报销材料：
 * - bundle：复制规范命名副本（BatchRenameInvoices）+ 生成报销明细 CSV（ExportInvoicesCsv）
 * - csv：只生成报销明细 CSV
 * 只接受字段完整、非重复的发票；按宿主返回的文件列表与路径确认结果，确认不了就报失败。
 */
export async function exportInvoices(mode, items, templateId, hostOverride, now = new Date()) {
    const fail = (error, extra = {}) => ({
        ok: false,
        outputDir: '',
        copiedCount: 0,
        csvPath: '',
        error,
        ...extra
    });
    if (items.length === 0)
        return fail('请先勾选至少 1 张需要报销的电子发票');
    const incomplete = items.filter((i) => !isInvoiceComplete(i));
    if (incomplete.length > 0) {
        return fail(`${incomplete.length} 张发票有未识别或待核对的字段（如 ${incomplete[0].fileName}），请先补全`);
    }
    const duplicates = items.filter((i) => i.isDuplicate);
    if (duplicates.length > 0) {
        return fail(`${duplicates.length} 张发票与其他发票号码重复（如 ${duplicates[0].fileName}），不能重复报销`);
    }
    let outputDir;
    try {
        outputDir = buildExportOutputDir(items[0].path, now);
    }
    catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
    }
    const names = buildUniqueTargetNames(items, templateId);
    const params = {
        invoices: items.map((inv) => ({ ...inv, targetFileName: names.get(inv.id) })),
        files: items.map((inv) => inv.path),
        templateId,
        outputDir
    };
    let copiedCount = 0;
    if (mode === 'bundle') {
        const copyRes = await invokeNativeCapability('BatchRenameInvoices', params, hostOverride);
        if (!copyRes.ok) {
            return fail(`复制规范命名副本失败：${copyRes.error || '宿主未说明原因'}（${outputDir} 中可能已有部分副本）`, { outputDir });
        }
        const data = (copyRes.data ?? {});
        const renamed = Array.isArray(data.renamedFiles) ? data.renamedFiles : null;
        if (!renamed) {
            return fail('宿主没有返回已复制的文件列表，无法确认副本已生成', { outputDir });
        }
        copiedCount = renamed.length;
        if (copiedCount !== items.length) {
            return fail(`只复制了 ${copiedCount}/${items.length} 份副本，未生成报销明细 CSV`, { outputDir, copiedCount });
        }
    }
    const csvRes = await invokeNativeCapability('ExportInvoicesCsv', params, hostOverride);
    const copiedNote = copiedCount > 0 ? `已复制 ${copiedCount} 份副本，但` : '';
    if (!csvRes.ok) {
        return fail(`${copiedNote}生成报销明细 CSV 失败：${csvRes.error || '宿主未说明原因'}`, { outputDir, copiedCount });
    }
    const csvData = (csvRes.data ?? {});
    const csvPath = typeof csvData.csvOutputPath === 'string' ? csvData.csvOutputPath.trim() : '';
    if (!csvPath) {
        return fail(`${copiedNote}宿主没有返回 CSV 文件路径，无法确认报销明细已生成`, { outputDir, copiedCount });
    }
    const hostOutDir = typeof csvData.outputDir === 'string' && csvData.outputDir.trim() ? csvData.outputDir.trim() : outputDir;
    return { ok: true, outputDir: hostOutDir, copiedCount, csvPath };
}
export async function openInvoiceLocation(filePath, hostOverride) {
    return showRealItemInFolder(filePath, hostOverride);
}
export async function trashInvoiceFile(filePath, hostOverride) {
    if (!filePath || FORBIDDEN_TARGET_PATTERN.test(filePath)) {
        return { ok: false, error: FORBIDDEN_REASON };
    }
    return trashRealItem(filePath, hostOverride);
}
