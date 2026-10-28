import { List, Form, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, useNavigation, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { INVOICE_RENAME_TEMPLATES, INVOICE_CATEGORY_GROUPS, INVOICE_FIELD_LABELS, EXPENSE_CATEGORY_CYCLE, SCAN_FILES_PER_DIR, formatCurrency, buildTargetInvoiceFileName, buildInvoiceTsvTable, buildInvoiceSummaryText, fetchRealInvoicesWorkspace, exportInvoices, openInvoiceLocation, trashInvoiceFile, detectInvoiceAnomalies, applyInvoiceEdits, validateInvoiceEdits, getInvoiceFieldIssues, describeInvoiceIssues, isInvoiceComplete, isInvoiceSelectable, defaultCheckedInvoiceIds, matchesInvoiceFilter } from './logic.js';
export * from './logic.js';
function overrideKey(filePath) {
    return filePath.toLowerCase();
}
function applyOverrides(items, overrides) {
    if (overrides.size === 0)
        return items;
    return detectInvoiceAnomalies(items.map((item) => {
        const ov = overrides.get(overrideKey(item.path));
        if (!ov)
            return item;
        const next = { ...item, ...ov };
        if (ov.issueDate)
            next.issueDateNeedsReview = false;
        return next;
    }));
}
function amountInputText(value) {
    return value === null || !Number.isFinite(value) ? '' : value.toFixed(2);
}
export function InvoiceEditForm(props) {
    const inv = props.invoice;
    const { pop } = useNavigation();
    const issues = getInvoiceFieldIssues(inv);
    const [invoiceNo, setInvoiceNo] = useState(inv.invoiceNo);
    const [issueDate, setIssueDate] = useState(inv.issueDate);
    const [sellerName, setSellerName] = useState(inv.sellerName);
    const [buyerName, setBuyerName] = useState(inv.buyerName);
    const [totalAmount, setTotalAmount] = useState(amountInputText(inv.totalAmount));
    const [taxAmount, setTaxAmount] = useState(amountInputText(inv.taxAmount));
    const [errors, setErrors] = useState({});
    const clearError = (field) => {
        setErrors((prev) => {
            if (!prev[field])
                return prev;
            const next = { ...prev };
            delete next[field];
            return next;
        });
    };
    async function handleSave() {
        const result = validateInvoiceEdits({ invoiceNo, issueDate, sellerName, buyerName, totalAmount, taxAmount });
        if (!result.ok) {
            setErrors(result.errors);
            await showToast({
                style: Toast.Style.Failure,
                title: '请先修正标红的字段',
                message: Object.values(result.errors)[0]
            });
            return;
        }
        if (!props.onSave(result.values)) {
            await showToast({
                style: Toast.Style.Failure,
                title: '保存失败：这张发票已不在列表中',
                message: inv.fileName
            });
            return;
        }
        await showToast({ style: Toast.Style.Success, title: '已保存发票信息', message: inv.fileName });
        pop();
    }
    const issueText = describeInvoiceIssues(inv);
    const field = (id, value, setter, placeholder, info) => Form.TextField({
        id,
        title: INVOICE_FIELD_LABELS[id],
        placeholder,
        value,
        error: errors[id],
        info,
        onChange: (v) => {
            setter(v);
            clearError(id);
        }
    });
    return Form({
        navigationTitle: `核对发票信息：${inv.fileName}`,
        actions: ActionPanel({
            children: [Action({ title: '保存发票信息', icon: Icon.Check, onAction: handleSave })]
        }),
        children: [
            Form.Description({
                title: '原发票文件',
                text: issueText ? `${inv.fileName}\n${issueText}，请对照发票原件填写。` : inv.fileName
            }),
            field('invoiceNo', invoiceNo, setInvoiceNo, '8 位或 20 位数字'),
            field('issueDate', issueDate, setIssueDate, 'YYYY-MM-DD', issues.needsReview.includes('issueDate')
                ? '识别结果与今天相同，可能是未识别到日期时的默认值，请对照发票核对'
                : undefined),
            field('sellerName', sellerName, setSellerName, '发票上的销售方名称'),
            field('buyerName', buyerName, setBuyerName, '发票抬头（购买方名称）'),
            field('totalAmount', totalAmount, setTotalAmount, '例如 128.50'),
            field('taxAmount', taxAmount, setTaxAmount, '免税或不含税额时填 0')
        ]
    });
}
export function InvoiceAssistantCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'invoice-assistant') ? String(launchCtx.featureCode || '').trim() : '';
    const initialTemplateId = initialFeature === 'invoice-rename' && INVOICE_RENAME_TEMPLATES[1]
        ? INVOICE_RENAME_TEMPLATES[1].id
        : INVOICE_RENAME_TEMPLATES[0].id;
    const initialFilterKey = initialFeature === 'invoice-travel' ? 'TRAVEL' : 'ALL';
    const [searchText, setSearchText] = useState('');
    const [activeTemplateId, setActiveTemplateId] = useState(initialTemplateId);
    const [selectedFilterKey, setSelectedFilterKey] = useState(initialFilterKey);
    const [invoices, setInvoices] = useState([]);
    // 默认只勾选字段完整、非重复且抬头正常的发票，从源头防止把重复或信息不全的发票打入报销单
    const [checkedIds, setCheckedIds] = useState([]);
    const [parseErrors, setParseErrors] = useState([]);
    const [loadError, setLoadError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const { push } = useNavigation();
    const scanningRef = useRef(false);
    const exportingRef = useRef(false);
    const overridesRef = useRef(new Map());
    // 表单保存回调在打开表单之后才执行，需读取最新列表而不是打开表单时的旧状态
    const latestRef = useRef({ invoices, checkedIds });
    latestRef.current = { invoices, checkedIds };
    async function refreshInvoices(showIndicator = false) {
        if (scanningRef.current)
            return;
        scanningRef.current = true;
        setIsLoading(true);
        let progressToast = null;
        try {
            if (showIndicator) {
                progressToast = await showToast({
                    style: Toast.Style.Animated,
                    title: '正在扫描并识别电子发票...',
                    message: '检索下载、桌面、文档目录中的 PDF / XML 发票'
                });
            }
            const res = await fetchRealInvoicesWorkspace();
            await progressToast?.hide();
            if (!res.ok) {
                // 保留上次的结果，如实提示本次扫描失败
                setLoadError(res.error || '扫描电子发票失败');
                await showToast({ style: Toast.Style.Failure, title: '扫描电子发票失败', message: res.error });
                return;
            }
            const nextInvoices = applyOverrides(res.invoices, overridesRef.current);
            setInvoices(nextInvoices);
            setCheckedIds(defaultCheckedInvoiceIds(nextInvoices));
            setParseErrors(res.parseErrors);
            setLoadError('');
            const incompleteCount = nextInvoices.filter((i) => !isInvoiceComplete(i)).length;
            if (res.parseErrors.length > 0) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: `${res.parseErrors.length} 个文件读取或识别失败`,
                    message: `${res.parseErrors[0].file}：${res.parseErrors[0].error}`
                });
            }
            else if (showIndicator) {
                await showToast({
                    style: Toast.Style.Success,
                    title: `已扫描 ${nextInvoices.length} 张发票`,
                    message: `重复票 ${nextInvoices.filter((i) => i.isDuplicate).length} 张 · 有未识别字段 ${incompleteCount} 张`
                });
            }
        }
        catch (err) {
            await progressToast?.hide();
            const message = err instanceof Error ? err.message : String(err);
            setLoadError(message);
            await showToast({ style: Toast.Style.Failure, title: '扫描电子发票失败', message });
        }
        finally {
            await progressToast?.hide();
            scanningRef.current = false;
            setIsLoading(false);
        }
    }
    useEffect(() => {
        refreshInvoices(false);
    }, []);
    const checkedSet = new Set(checkedIds);
    const selectedInvoices = invoices.filter((i) => checkedSet.has(i.id));
    const totalAmountSum = selectedInvoices.reduce((acc, i) => acc + (i.totalAmount ?? 0), 0);
    const totalTaxSum = selectedInvoices.reduce((acc, i) => acc + (i.taxAmount ?? 0), 0);
    const duplicateCount = invoices.filter((i) => i.isDuplicate).length;
    const abnormalHeaderCount = invoices.filter((i) => i.isHeaderAbnormal).length;
    const incompleteCount = invoices.filter((i) => !isInvoiceComplete(i)).length;
    async function handleExport(mode) {
        if (exportingRef.current)
            return;
        if (selectedInvoices.length === 0) {
            await showToast({ style: Toast.Style.Failure, title: '请先勾选至少 1 张需要报销的电子发票' });
            return;
        }
        exportingRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: mode === 'bundle'
                    ? `正在为 ${selectedInvoices.length} 张发票生成规范命名副本与报销明细...`
                    : `正在导出 ${selectedInvoices.length} 张发票的报销明细 CSV...`,
                message: `合计 ${formatCurrency(totalAmountSum)}`
            });
            const res = await exportInvoices(mode, selectedInvoices, activeTemplateId);
            await progressToast?.hide();
            if (!res.ok) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: mode === 'bundle' ? '生成报销归档失败' : '导出报销明细 CSV 失败',
                    message: res.error
                });
                return;
            }
            await showToast({
                style: Toast.Style.Success,
                title: mode === 'bundle'
                    ? `已复制 ${res.copiedCount} 份规范命名副本并生成报销明细 CSV (${formatCurrency(totalAmountSum)})`
                    : `已导出 ${selectedInvoices.length} 张发票的报销明细 CSV (${formatCurrency(totalAmountSum)})`,
                message: `输出目录: ${res.outputDir}`
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '导出报销材料异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            exportingRef.current = false;
        }
    }
    async function handleCopyExcelTsv() {
        if (selectedInvoices.length === 0) {
            await showToast({ style: Toast.Style.Failure, title: '请先勾选需要复制的发票' });
            return;
        }
        try {
            await Clipboard.copy(buildInvoiceTsvTable(selectedInvoices, activeTemplateId));
        }
        catch (err) {
            await showToast({
                style: Toast.Style.Failure,
                title: '复制报销明细失败',
                message: err instanceof Error ? err.message : String(err)
            });
            return;
        }
        await showToast({
            style: Toast.Style.Success,
            title: `已复制 ${selectedInvoices.length} 条报销明细 (Excel TSV)`,
            message: '可直接在 Excel / WPS / 飞书表格中粘贴成表'
        });
    }
    function rememberOverride(filePath, patch) {
        const key = overrideKey(filePath);
        overridesRef.current.set(key, { ...(overridesRef.current.get(key) ?? {}), ...patch });
    }
    function handleCycleCategory(target) {
        const idx = EXPENSE_CATEGORY_CYCLE.indexOf(target.category);
        const nextCat = EXPENSE_CATEGORY_CYCLE[(idx + 1) % EXPENSE_CATEGORY_CYCLE.length];
        rememberOverride(target.path, { category: nextCat });
        setInvoices((prev) => prev.map((inv) => (inv.id === target.id ? { ...inv, category: nextCat } : inv)));
    }
    function handleSaveEdits(target, values) {
        const { invoices: current, checkedIds: currentChecked } = latestRef.current;
        const key = overrideKey(target.path);
        const existing = current.find((i) => overrideKey(i.path) === key);
        if (!existing)
            return false;
        rememberOverride(target.path, values);
        const next = applyInvoiceEdits(current, existing.id, values);
        setInvoices(next);
        const selectable = new Set(next.filter(isInvoiceSelectable).map((i) => i.id));
        const edited = next.find((i) => i.id === existing.id);
        const kept = currentChecked.filter((id) => selectable.has(id));
        if (edited && selectable.has(edited.id) && !edited.isHeaderAbnormal && !kept.includes(edited.id)) {
            kept.push(edited.id);
        }
        setCheckedIds(kept);
        return true;
    }
    function openEditForm(inv) {
        push(() => InvoiceEditForm({ invoice: inv, onSave: (values) => handleSaveEdits(inv, values) }));
    }
    async function handleCheckChange(inv, checked) {
        if (!checked) {
            setCheckedIds(checkedIds.filter((id) => id !== inv.id));
            return;
        }
        if (!isInvoiceComplete(inv)) {
            await showToast({
                style: Toast.Style.Failure,
                title: '这张发票有未识别的字段，补全后才能勾选',
                message: describeInvoiceIssues(inv)
            });
            return;
        }
        if (inv.isDuplicate) {
            await showToast({
                style: Toast.Style.Failure,
                title: '发票号码与其他发票重复，不能重复报销',
                message: '如果识别有误，请先修改发票号码'
            });
            return;
        }
        setCheckedIds(Array.from(new Set([...checkedIds, inv.id])));
    }
    async function handleCopyParseErrors() {
        const text = parseErrors.map((e) => `${e.file}\t${e.error}`).join('\n');
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
        await showToast({ style: Toast.Style.Success, title: `已复制 ${parseErrors.length} 条读取失败记录` });
    }
    const q = searchText.trim().toLowerCase();
    const filteredInvoices = invoices.filter((inv) => {
        if (!matchesInvoiceFilter(inv, selectedFilterKey))
            return false;
        if (!q)
            return true;
        return (inv.sellerName.toLowerCase().includes(q) ||
            inv.invoiceNo.toLowerCase().includes(q) ||
            inv.issueDate.toLowerCase().includes(q) ||
            inv.category.toLowerCase().includes(q) ||
            inv.fileName.toLowerCase().includes(q) ||
            (inv.totalAmount !== null && String(inv.totalAmount).includes(q)));
    });
    const selectableFiltered = filteredInvoices.filter(isInvoiceSelectable);
    const maxAmount = Math.max(1, ...filteredInvoices.map((i) => i.totalAmount ?? 0));
    const exportBundleTitle = `生成报销归档：规范命名副本 + 明细 CSV (${selectedInvoices.length}张 · ${formatCurrency(totalAmountSum)})`;
    const rightInvoiceItems = filteredInvoices.map((inv) => {
        const isChecked = checkedSet.has(inv.id);
        const complete = isInvoiceComplete(inv);
        const targetRename = complete ? buildTargetInvoiceFileName(inv, activeTemplateId) : null;
        const issueText = describeInvoiceIssues(inv);
        const exportAction = Action({
            title: exportBundleTitle,
            icon: Icon.Bolt,
            onAction: () => handleExport('bundle')
        });
        const editAction = Action({
            title: complete ? '核对 / 修改发票信息' : '补全未识别的发票信息',
            icon: Icon.Pencil,
            shortcut: { modifiers: ['ctrl'], key: 'i' },
            onAction: () => openEditForm(inv)
        });
        const copyTsvAction = Action({
            title: '复制已选发票的报销明细 (Excel TSV)',
            icon: Icon.CopyClipboard,
            shortcut: { modifiers: ['ctrl'], key: 'enter' },
            onAction: handleCopyExcelTsv
        });
        const csvAction = Action({
            title: '仅导出已选发票的报销明细 (.csv)',
            icon: Icon.Download,
            shortcut: { modifiers: ['ctrl'], key: 'e' },
            onAction: () => handleExport('csv')
        });
        const otherActions = [
            Action({
                title: `切换费用分类 (当前: ${inv.category})`,
                icon: Icon.Tag,
                shortcut: { modifiers: ['ctrl'], key: 't' },
                onAction: () => handleCycleCategory(inv)
            }),
            Action({
                title: '复制当前发票信息文本',
                icon: Icon.Clipboard,
                shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                onAction: async () => {
                    await Clipboard.copy(buildInvoiceSummaryText(inv));
                    await showToast({ style: Toast.Style.Success, title: '已复制发票信息' });
                }
            }),
            Action({
                title: '在资源管理器定位原发票',
                icon: Icon.Folder,
                shortcut: { modifiers: ['ctrl'], key: 'o' },
                onAction: async () => {
                    const opened = await openInvoiceLocation(inv.path);
                    if (!opened) {
                        await showToast({ style: Toast.Style.Failure, title: '无法在资源管理器中定位该发票', message: inv.path });
                    }
                }
            }),
            Action({
                title: '将当前发票原件移入系统回收站',
                icon: Icon.Trash,
                style: Action.Style.Destructive,
                shortcut: { modifiers: [], key: 'delete' },
                onAction: async () => {
                    const ok = await confirmAlert({
                        title: '确认将该发票移入回收站？',
                        message: `文件名: ${inv.fileName}\n发票号: ${inv.invoiceNo || '未识别'}\n金额: ${formatCurrency(inv.totalAmount)}`,
                        primaryAction: { title: '移入回收站', style: 'destructive' }
                    });
                    if (!ok)
                        return;
                    const tr = await trashInvoiceFile(inv.path);
                    if (tr.ok) {
                        overridesRef.current.delete(overrideKey(inv.path));
                        setInvoices((prev) => detectInvoiceAnomalies(prev.filter((item) => item.id !== inv.id)));
                        setCheckedIds((prev) => prev.filter((id) => id !== inv.id));
                        await showToast({ style: Toast.Style.Success, title: '已移入系统回收站' });
                    }
                    else {
                        await showToast({
                            style: Toast.Style.Failure,
                            title: '移除失败',
                            message: tr.error || '文件可能被占用'
                        });
                    }
                }
            })
        ];
        // 信息不全的发票：回车先补全；其余动作顺序不变，次动作（⌘/Ctrl+Enter）始终是复制明细
        const actionList = complete
            ? [exportAction, copyTsvAction, csvAction, editAction, ...otherActions]
            : [editAction, copyTsvAction, exportAction, csvAction, ...otherActions];
        const flagged = !complete || inv.isDuplicate || inv.isHeaderAbnormal;
        // 灰阶为主：只有重复发票号（可能重复报销）用红色警示；信息不全、抬头异常用默认灰阶标签，靠文字区分
        const statusTag = !complete
            ? { tag: { value: '信息不全' } }
            : inv.isDuplicate
                ? { tag: { value: '重复发票号', color: Color.Red } }
                : inv.isHeaderAbnormal
                    ? { tag: { value: '抬头异常' } }
                    : { tag: { value: inv.category } };
        const accessories = [];
        if (inv.totalAmount !== null) {
            accessories.push({
                progress: { value: Math.max(8, Math.min(100, Math.round((inv.totalAmount / maxAmount) * 100))) }
            });
        }
        accessories.push(statusTag, { text: inv.totalAmount !== null ? formatCurrency(inv.totalAmount) : '金额未识别' });
        return List.Item({
            id: inv.id,
            title: targetRename ?? inv.fileName,
            subtitle: complete
                ? `发票号: ${inv.invoiceNo} · 购方: ${inv.buyerName} · 税额: ${formatCurrency(inv.taxAmount)}`
                : issueText,
            checkable: true,
            checked: isChecked,
            onCheckChange: (checked) => {
                void handleCheckChange(inv, checked);
            },
            icon: {
                source: flagged ? Icon.ExclamationMark : Icon.Document,
                tintColor: Color.SecondaryText
            },
            accessories,
            actions: ActionPanel({
                title: inv.sellerName || inv.fileName,
                children: actionList
            })
        });
    });
    const summaryParts = [
        `已选 ${selectedInvoices.length}/${invoices.length} 张发票 · 报销总额 ${formatCurrency(totalAmountSum)} (含税额 ${formatCurrency(totalTaxSum)})`,
        `重复票 ${duplicateCount} 张`
    ];
    if (incompleteCount > 0)
        summaryParts.push(`信息不全 ${incompleteCount} 张`);
    if (parseErrors.length > 0)
        summaryParts.push(`读取失败 ${parseErrors.length} 个文件`);
    if (loadError)
        summaryParts.push(`上次扫描失败：${loadError}`);
    const auditItems = [
        List.Item({
            id: 'audit-duplicate',
            title: '重复发票号防重拦截',
            subtitle: duplicateCount > 0
                ? `检测到 ${duplicateCount} 张发票号码与其他发票相同，已取消勾选防止重复报销`
                : '已识别的发票号码没有重复',
            icon: {
                source: duplicateCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                tintColor: Color.SecondaryText
            },
            accessories: [
                duplicateCount > 0
                    ? { tag: { value: `${duplicateCount} 张重复`, color: Color.Red } }
                    : { tag: { value: '无重复' } }
            ],
            actions: ActionPanel({
                title: '重复发票号筛查',
                children: [
                    Action({
                        title: '仅筛选查看重复发票',
                        icon: Icon.Filter,
                        onAction: () => setSelectedFilterKey(selectedFilterKey === 'DUPLICATE' ? 'ALL' : 'DUPLICATE')
                    })
                ]
            })
        }),
        List.Item({
            id: 'audit-header',
            title: '购方抬头检查',
            subtitle: abnormalHeaderCount > 0
                ? `发现 ${abnormalHeaderCount} 张个人或非企业抬头发票，默认不勾选`
                : '已识别的购方抬头中没有个人抬头',
            icon: {
                source: abnormalHeaderCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                tintColor: Color.SecondaryText
            },
            accessories: [
                abnormalHeaderCount > 0
                    ? { tag: { value: `${abnormalHeaderCount} 张异常` } }
                    : { tag: { value: '无异常' } }
            ],
            actions: ActionPanel({
                title: '抬头异常筛查',
                children: [
                    Action({
                        title: '仅筛选查看抬头异常发票',
                        icon: Icon.Filter,
                        onAction: () => setSelectedFilterKey(selectedFilterKey === 'ABNORMAL' ? 'ALL' : 'ABNORMAL')
                    })
                ]
            })
        }),
        List.Item({
            id: 'audit-incomplete',
            title: '未识别字段',
            subtitle: incompleteCount > 0
                ? `${incompleteCount} 张发票有未识别或待核对的字段，补全后才能勾选导出`
                : '全部发票的报销字段均已识别',
            icon: {
                source: incompleteCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                tintColor: Color.SecondaryText
            },
            accessories: [
                incompleteCount > 0
                    ? { tag: { value: `${incompleteCount} 张待补全` } }
                    : { tag: { value: '已完整' } }
            ],
            actions: ActionPanel({
                title: '未识别字段筛查',
                children: [
                    Action({
                        title: '仅筛选查看信息不全的发票',
                        icon: Icon.Filter,
                        onAction: () => setSelectedFilterKey(selectedFilterKey === 'INCOMPLETE' ? 'ALL' : 'INCOMPLETE')
                    })
                ]
            })
        })
    ];
    if (parseErrors.length > 0) {
        auditItems.push(List.Item({
            id: 'audit-parse-errors',
            title: '读取失败的文件',
            subtitle: `${parseErrors.length} 个文件无法读取或识别，未列入右侧`,
            icon: { source: Icon.ExclamationMark, tintColor: Color.SecondaryText },
            // 读取失败是真正的错误，标签保留红色
            accessories: [{ tag: { value: `${parseErrors.length} 个失败`, color: Color.Red } }],
            actions: ActionPanel({
                title: '读取失败的文件',
                children: [
                    Action({
                        title: '复制失败文件与原因',
                        icon: Icon.CopyClipboard,
                        onAction: handleCopyParseErrors
                    })
                ]
            })
        }));
    }
    const emptyText = loadError && invoices.length === 0
        ? `扫描失败：${loadError}`
        : invoices.length === 0
            ? `未在下载、桌面、文档目录找到 PDF / XML 电子发票（每个目录最多检查 ${SCAN_FILES_PER_DIR} 个文件，可能有遗漏）`
            : '当前分类下没有匹配的电子发票';
    return List({
        searchBarPlaceholder: '搜索开票商户、发票号码、开票日期、金额或费用分类...',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '选择归档文件命名模板',
            value: activeTemplateId,
            onChange: (val) => setActiveTemplateId(val),
            children: INVOICE_RENAME_TEMPLATES.map((tpl) => List.Dropdown.Item({
                title: tpl.title,
                value: tpl.id
            }))
        }),
        filterBar: FilterBar({
            summaryText: summaryParts.join(' · '),
            actions: [
                {
                    id: 'copy-excel-tsv-btn',
                    label: '复制 Excel 明细',
                    style: 'secondary',
                    onAction: handleCopyExcelTsv
                },
                {
                    id: 'rescan-invoices-btn',
                    label: '重新扫描目录',
                    style: 'secondary',
                    onAction: () => refreshInvoices(true)
                }
            ]
        }),
        subList: {
            title: '发票识别与归档命名预览 (勾选后按 ↵ 生成规范命名副本 + 报销明细 CSV)',
            subtitle: `${filteredInvoices.length} 张发票 · 已选报销合计 ${formatCurrency(totalAmountSum)}`,
            checkable: selectableFiltered.length > 0,
            checked: selectableFiltered.length > 0 && selectableFiltered.every((i) => checkedSet.has(i.id))
                ? true
                : filteredInvoices.some((i) => checkedSet.has(i.id))
                    ? 'indeterminate'
                    : false,
            onCheckChange: (checked) => {
                const ids = new Set(selectableFiltered.map((i) => i.id));
                setCheckedIds(checked
                    ? Array.from(new Set([...checkedIds, ...ids]))
                    : checkedIds.filter((id) => !filteredInvoices.some((i) => i.id === id)));
            },
            emptyText,
            items: rightInvoiceItems
        },
        children: [
            List.Section({
                title: '费用科目与报销分类导航',
                children: INVOICE_CATEGORY_GROUPS.map((grp) => {
                    const matched = invoices.filter((i) => matchesInvoiceFilter(i, grp.id));
                    const sum = matched.reduce((acc, i) => acc + (i.totalAmount ?? 0), 0);
                    const unknownAmountCount = matched.filter((i) => i.totalAmount === null).length;
                    const isSelected = selectedFilterKey === grp.id;
                    return List.Item({
                        id: `inv-cat-${grp.id}`,
                        title: grp.name,
                        subtitle: unknownAmountCount > 0
                            ? `${formatCurrency(sum)}（另有 ${unknownAmountCount} 张金额未识别）`
                            : formatCurrency(sum),
                        icon: {
                            source: isSelected ? Icon.CheckCircle : Icon.Folder,
                            tintColor: Color.SecondaryText
                        },
                        accessories: [{ text: `${matched.length} 张` }],
                        actions: ActionPanel({
                            title: grp.name,
                            children: [
                                Action({
                                    title: `筛选查看「${grp.name}」`,
                                    icon: Icon.Filter,
                                    onAction: () => setSelectedFilterKey(grp.id)
                                }),
                                Action({
                                    title: exportBundleTitle,
                                    icon: Icon.Bolt,
                                    onAction: () => handleExport('bundle')
                                })
                            ]
                        })
                    });
                })
            }),
            List.Section({
                title: '报销合规预检',
                children: auditItems
            })
        ]
    });
}
export default InvoiceAssistantCommand;
