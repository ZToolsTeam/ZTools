/**
 * 电子发票智能解析与报销归集助手业务逻辑层 (InvoiceAssistant 1.0 Logic)
 *
 * 核心能力：
 * 1. 自动扫描并解析 PDF / XML 电子发票四要素（发票号码、开票日期、销方/购方抬头、价税合计、税额）
 * 2. 发票号自动查重（防重复提交退单）与购方抬头/税号一致性预检（防开成个人抬头）
 * 3. 4 套财务规范化重命名模板（复制生成规范命名副本，绝不损毁原文件）
 * 4. 一键生成 UTF-8 BOM 财务报销台账 (.csv)、Excel TSV 剪贴板直粘与合并打印 PDF
 */
import { getRealSystemPath, invokeDllPluginCapability, scanRealDirectoryTree, showRealItemInFolder, trashRealItem } from './native-ipc.js';
export { formatBytes } from './native-ipc.js';
export const DLL_PLUGIN_NAME = 'InvoiceAssistantPlugin';
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i');
export const FORBIDDEN_REASON = '发票归档输出目录不可指向系统受保护路径或包含路径穿越';
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
export function formatCurrency(amount) {
    const num = Number(amount);
    if (!Number.isFinite(num))
        return '¥0.00';
    return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function buildTargetInvoiceFileName(item, templateId) {
    const ext = item.extension || '.pdf';
    const safeSeller = (item.sellerName || '未知商户').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24);
    const tailNo = (item.invoiceNo || '0000').slice(-4);
    const amt = (Number(item.totalAmount) || 0).toFixed(2);
    const date = item.issueDate || '2026-10-01';
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
 * 生成可直接粘贴到 Excel / 飞书表格的 TSV（制表符分隔）报销明细文本
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
    const rows = items.map((item, idx) => [
        idx + 1,
        item.invoiceNo,
        item.issueDate,
        item.category,
        item.sellerName,
        item.buyerName,
        item.totalAmount.toFixed(2),
        item.taxAmount.toFixed(2),
        item.netAmount.toFixed(2),
        buildTargetInvoiceFileName(item, templateId)
    ].join('\t'));
    return [header, ...rows].join('\n');
}
/**
 * 执行发票号查重与购方抬头异常预检
 */
export function detectInvoiceAnomalies(items, expectedBuyerKeyword = '') {
    const seenNo = new Set();
    const kw = expectedBuyerKeyword.trim();
    return items.map((item) => {
        const normNo = String(item.invoiceNo || '').trim();
        const isDuplicate = normNo.length > 0 && seenNo.has(normNo);
        if (normNo.length > 0)
            seenNo.add(normNo);
        const isPersonalHeader = /个人|先生|女士|^[^\u4e00-\u9fa5]*$/.test(item.buyerName);
        const isMismatch = kw ? !item.buyerName.includes(kw) && !item.buyerTaxId.includes(kw) : false;
        return {
            ...item,
            isDuplicate,
            isHeaderAbnormal: Boolean(item.isHeaderAbnormal || isPersonalHeader || isMismatch)
        };
    });
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
export async function fetchRealInvoicesWorkspace(expectedBuyer = '', hostOverride) {
    const [downloadsDir, desktopDir, documentsDir] = await Promise.all([
        getRealSystemPath('downloads', hostOverride),
        getRealSystemPath('desktop', hostOverride),
        getRealSystemPath('documents', hostOverride)
    ]);
    const dirs = [downloadsDir, desktopDir, documentsDir].filter(Boolean);
    const candidatePaths = [];
    const seen = new Set();
    for (const dir of dirs) {
        const scan = await scanRealDirectoryTree(dir, {
            maxDepth: 2,
            maxFiles: 200,
            collectTopN: 45,
            filterExt: INVOICE_FILE_REGEX,
            hostOverride
        });
        for (const f of scan.files) {
            if (f.sizeBytes <= 0)
                continue;
            if (!INVOICE_FILE_REGEX.test(f.name))
                continue;
            if (f.name.includes('合并报销打印件') || f.name.includes('报销台账'))
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
        return { ok: true, invoices: [], scannedFilesCount: 0 };
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
            error: res.error || '解析电子发票失败'
        };
    }
    const payload = res.data;
    const rawList = Array.isArray(payload.invoices)
        ? payload.invoices
        : [];
    const parsed = rawList.map((raw, idx) => {
        const filePath = String(raw.path ?? candidatePaths[idx] ?? '');
        const fileName = String(raw.fileName ?? (filePath.split(/[\\/]/).pop() || 'invoice.pdf'));
        const dot = fileName.lastIndexOf('.');
        const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '.pdf';
        const rawCat = String(raw.category ?? '其他费用');
        const category = EXPENSE_CATEGORY_CYCLE.includes(rawCat)
            ? rawCat
            : '其他费用';
        return {
            id: String(raw.id ?? `inv-${idx}-${filePath}`),
            path: filePath,
            fileName,
            extension: ext,
            sizeBytes: Number(raw.sizeBytes ?? 0),
            invoiceNo: String(raw.invoiceNo ?? ''),
            issueDate: String(raw.issueDate ?? '2026-10-01'),
            sellerName: String(raw.sellerName ?? '未知开票商户'),
            buyerName: String(raw.buyerName ?? '默认企业抬头'),
            buyerTaxId: String(raw.buyerTaxId ?? ''),
            totalAmount: Number(raw.totalAmount ?? 0),
            taxAmount: Number(raw.taxAmount ?? 0),
            netAmount: Number(raw.netAmount ?? 0),
            category,
            isDuplicate: Boolean(raw.isDuplicate),
            isHeaderAbnormal: Boolean(raw.isHeaderAbnormal)
        };
    });
    return {
        ok: true,
        invoices: detectInvoiceAnomalies(parsed, expectedBuyer),
        scannedFilesCount: candidatePaths.length
    };
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
