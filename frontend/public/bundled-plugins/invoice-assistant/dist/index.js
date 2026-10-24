import { List, ActionPanel, Action, Icon, Color, Clipboard, useState, useEffect, useRef, showToast, Toast, confirmAlert, FilterBar } from '@ztools/declarative-ui';
import { INVOICE_RENAME_TEMPLATES, INVOICE_CATEGORY_GROUPS, EXPENSE_CATEGORY_CYCLE, formatCurrency, buildTargetInvoiceFileName, buildInvoiceTsvTable, fetchRealInvoicesWorkspace, invokeNativeCapability, openInvoiceLocation, trashInvoiceFile } from './logic.js';
import { isRealElectronHost } from './native-ipc.js';
export * from './logic.js';
const SAMPLE_INVOICES = [
    {
        id: 'inv-sample-1',
        path: 'D:\\Downloads\\电子发票_华住酒店集团_20261018.pdf',
        fileName: '电子发票_华住酒店集团_20261018.pdf',
        extension: '.pdf',
        sizeBytes: 186 * 1024,
        invoiceNo: '24312000000048291902',
        issueDate: '2026-10-18',
        sellerName: '华住酒店管理有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 1280.0,
        taxAmount: 72.45,
        netAmount: 1207.55,
        category: '差旅住宿',
        isDuplicate: false,
        isHeaderAbnormal: false
    },
    {
        id: 'inv-sample-2',
        path: 'D:\\Downloads\\中国铁路电子客票_G12_上海虹桥至北京南.pdf',
        fileName: '中国铁路电子客票_G12_上海虹桥至北京南.pdf',
        extension: '.pdf',
        sizeBytes: 142 * 1024,
        invoiceNo: '24312000000048293310',
        issueDate: '2026-10-17',
        sellerName: '中国铁路上海局集团有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 662.0,
        taxAmount: 54.66,
        netAmount: 607.34,
        category: '交通出行',
        isDuplicate: false,
        isHeaderAbnormal: false
    },
    {
        id: 'inv-sample-3',
        path: 'C:\\Users\\Geek\\Desktop\\阿里云计算有限公司_数电发票_10月.pdf',
        fileName: '阿里云计算有限公司_数电发票_10月.pdf',
        extension: '.pdf',
        sizeBytes: 215 * 1024,
        invoiceNo: '24332000000091827741',
        issueDate: '2026-10-15',
        sellerName: '阿里云计算有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 2450.0,
        taxAmount: 138.68,
        netAmount: 2311.32,
        category: '办公采购',
        isDuplicate: false,
        isHeaderAbnormal: false
    },
    {
        id: 'inv-sample-4',
        path: 'D:\\Downloads\\滴滴出行科技有限公司_电子发票_行程单.pdf',
        fileName: '滴滴出行科技有限公司_电子发票_行程单.pdf',
        extension: '.pdf',
        sizeBytes: 128 * 1024,
        invoiceNo: '24112000000033914815',
        issueDate: '2026-10-19',
        sellerName: '滴滴出行科技有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 148.5,
        taxAmount: 4.33,
        netAmount: 144.17,
        category: '交通出行',
        isDuplicate: false,
        isHeaderAbnormal: false
    },
    {
        id: 'inv-sample-5',
        path: 'D:\\Downloads\\星巴克企业管理_餐饮电子发票.pdf',
        fileName: '星巴克企业管理_餐饮电子发票.pdf',
        extension: '.pdf',
        sizeBytes: 154 * 1024,
        invoiceNo: '24312000000048298921',
        issueDate: '2026-10-20',
        sellerName: '星巴克企业管理(中国)有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 268.0,
        taxAmount: 15.17,
        netAmount: 252.83,
        category: '餐饮招待',
        isDuplicate: false,
        isHeaderAbnormal: false
    },
    {
        id: 'inv-sample-6',
        path: 'C:\\Users\\Geek\\Downloads\\滴滴出行科技有限公司_副本_重复下载.pdf',
        fileName: '滴滴出行科技有限公司_副本_重复下载.pdf',
        extension: '.pdf',
        sizeBytes: 128 * 1024,
        invoiceNo: '24112000000033914815',
        issueDate: '2026-10-19',
        sellerName: '滴滴出行科技有限公司',
        buyerName: '上海极客效率科技有限公司',
        buyerTaxId: '91310000MA1FL8890X',
        totalAmount: 148.5,
        taxAmount: 4.33,
        netAmount: 144.17,
        category: '交通出行',
        isDuplicate: true,
        isHeaderAbnormal: false
    }
];
export function InvoiceAssistantCommand() {
    const launchCtx = (globalThis.window || globalThis).__ztoolsLaunchContext;
    const initialFeature = launchCtx && (!launchCtx.pluginId || launchCtx.pluginId === 'invoice-assistant') ? String(launchCtx.featureCode || '').trim() : '';
    const initialTemplateId = initialFeature === 'invoice-rename' && INVOICE_RENAME_TEMPLATES[1]
        ? INVOICE_RENAME_TEMPLATES[1].id
        : INVOICE_RENAME_TEMPLATES[0].id;
    const initialFilterKey = initialFeature === 'invoice-travel' ? '交通出行' : 'ALL';
    const [searchText, setSearchText] = useState('');
    const [activeTemplateId, setActiveTemplateId] = useState(initialTemplateId);
    const [selectedFilterKey, setSelectedFilterKey] = useState(initialFilterKey);
    const isRealHost = isRealElectronHost();
    const initialList = isRealHost ? [] : SAMPLE_INVOICES;
    const [invoices, setInvoices] = useState(initialList);
    // 默认只勾选非重复且抬头正常的合规发票，从源头防止把重复发票打入报销单
    const [checkedIds, setCheckedIds] = useState(initialList.filter((i) => !i.isDuplicate && !i.isHeaderAbnormal).map((i) => i.id));
    const [isLoading, setIsLoading] = useState(false);
    const scanningRef = useRef(false);
    const exportingRef = useRef(false);
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
                    title: '正在扫描并解析电子发票四要素...',
                    message: '检索 PDF / XML 数电发票与查重校验'
                });
            }
            const res = await fetchRealInvoicesWorkspace();
            await progressToast?.hide();
            const nextInvoices = isRealElectronHost()
                ? res.invoices
                : res.invoices.length > 0
                    ? res.invoices
                    : SAMPLE_INVOICES;
            setInvoices(nextInvoices);
            setCheckedIds(nextInvoices.filter((i) => !i.isDuplicate && !i.isHeaderAbnormal).map((i) => i.id));
            if (showIndicator) {
                await showToast({
                    style: Toast.Style.Success,
                    title: '电子发票解析与查重完成',
                    message: `共解析 ${nextInvoices.length} 张发票，发现重复票 ${nextInvoices.filter((i) => i.isDuplicate).length} 张`
                });
            }
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '扫描电子发票失败',
                message: err instanceof Error ? err.message : String(err)
            });
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
    const totalAmountSum = selectedInvoices.reduce((acc, i) => acc + i.totalAmount, 0);
    const totalTaxSum = selectedInvoices.reduce((acc, i) => acc + i.taxAmount, 0);
    const duplicateCount = invoices.filter((i) => i.isDuplicate).length;
    const abnormalHeaderCount = invoices.filter((i) => i.isHeaderAbnormal).length;
    async function handleExportReimbursementBundle(methodName = 'ExportReimbursementBundle') {
        if (exportingRef.current)
            return;
        if (selectedInvoices.length === 0) {
            await showToast({
                style: Toast.Style.Failure,
                title: '请先勾选至少 1 张需要报销的电子发票'
            });
            return;
        }
        exportingRef.current = true;
        let progressToast = null;
        try {
            progressToast = await showToast({
                style: Toast.Style.Animated,
                title: `正在生成 ${selectedInvoices.length} 张发票报销归档包...`,
                message: `总额 ${formatCurrency(totalAmountSum)} · 含规范化副本、CSV 台账与合并打印 PDF`
            });
            const payloadInvoices = selectedInvoices.map((inv) => ({
                ...inv,
                targetFileName: buildTargetInvoiceFileName(inv, activeTemplateId)
            }));
            const res = await invokeNativeCapability(methodName, {
                invoices: payloadInvoices,
                files: selectedInvoices.map((inv) => inv.path),
                templateId: activeTemplateId
            });
            await progressToast?.hide();
            if (!res.ok) {
                await showToast({
                    style: Toast.Style.Failure,
                    title: '生成报销归档包失败',
                    message: res.error || '宿主文件系统写入错误'
                });
                return;
            }
            const data = (res.data ?? {});
            const outDir = typeof data.outputDir === 'string' ? data.outputDir : '发票同级报销归档目录';
            await showToast({
                style: Toast.Style.Success,
                title: `已生成 ${selectedInvoices.length} 张发票报销归档包 (${formatCurrency(totalAmountSum)})`,
                message: `输出目录: ${outDir}`
            });
        }
        catch (err) {
            await progressToast?.hide();
            await showToast({
                style: Toast.Style.Failure,
                title: '导出报销归档包异常',
                message: err instanceof Error ? err.message : String(err)
            });
        }
        finally {
            await progressToast?.hide();
            exportingRef.current = false;
        }
    }
    async function handleCopyExcelTsv() {
        const targets = selectedInvoices.length > 0 ? selectedInvoices : invoices;
        if (targets.length === 0) {
            await showToast({ style: Toast.Style.Failure, title: '当前无可复制的发票明细' });
            return;
        }
        const tsv = buildInvoiceTsvTable(targets, activeTemplateId);
        await Clipboard.copy(tsv);
        await showToast({
            style: Toast.Style.Success,
            title: `已复制 ${targets.length} 条报销台账明细 (Excel TSV)`,
            message: '现在可直接在 Excel / WPS / 飞书表格中按 Ctrl+V 粘贴成表'
        });
    }
    function handleCycleCategory(targetId) {
        setInvoices((prev) => prev.map((inv) => {
            if (inv.id !== targetId)
                return inv;
            const idx = EXPENSE_CATEGORY_CYCLE.indexOf(inv.category);
            const nextCat = EXPENSE_CATEGORY_CYCLE[(idx + 1) % EXPENSE_CATEGORY_CYCLE.length];
            return { ...inv, category: nextCat };
        }));
    }
    const q = searchText.trim().toLowerCase();
    const filteredInvoices = invoices.filter((inv) => {
        if (selectedFilterKey === 'DUPLICATE' && !inv.isDuplicate)
            return false;
        if (selectedFilterKey === 'ABNORMAL' && !inv.isHeaderAbnormal)
            return false;
        if (selectedFilterKey !== 'ALL' &&
            selectedFilterKey !== 'DUPLICATE' &&
            selectedFilterKey !== 'ABNORMAL' &&
            inv.category !== selectedFilterKey) {
            return false;
        }
        if (!q)
            return true;
        return (inv.sellerName.toLowerCase().includes(q) ||
            inv.invoiceNo.toLowerCase().includes(q) ||
            inv.issueDate.toLowerCase().includes(q) ||
            inv.category.toLowerCase().includes(q) ||
            inv.fileName.toLowerCase().includes(q) ||
            String(inv.totalAmount).includes(q));
    });
    const maxAmount = Math.max(1, ...filteredInvoices.map((i) => i.totalAmount));
    const rightInvoiceItems = filteredInvoices.map((inv) => {
        const isChecked = checkedSet.has(inv.id);
        const targetRename = buildTargetInvoiceFileName(inv, activeTemplateId);
        const ratio = Math.max(8, Math.min(100, Math.round((inv.totalAmount / maxAmount) * 100)));
        return List.Item({
            id: inv.id,
            title: targetRename,
            subtitle: `发票号: ${inv.invoiceNo} · 购方: ${inv.buyerName} · 税额: ${formatCurrency(inv.taxAmount)}`,
            checkable: true,
            checked: isChecked,
            onCheckChange: (checked) => {
                if (checked) {
                    setCheckedIds(Array.from(new Set([...checkedIds, inv.id])));
                }
                else {
                    setCheckedIds(checkedIds.filter((id) => id !== inv.id));
                }
            },
            icon: {
                source: inv.isDuplicate || inv.isHeaderAbnormal ? Icon.ExclamationMark : Icon.Document,
                tintColor: inv.isDuplicate || inv.isHeaderAbnormal ? Color.Red : Color.SecondaryText
            },
            accessories: [
                {
                    progress: {
                        value: ratio
                    }
                },
                inv.isDuplicate
                    ? {
                        tag: {
                            value: '重复发票号',
                            color: Color.Red
                        }
                    }
                    : inv.isHeaderAbnormal
                        ? {
                            tag: {
                                value: '抬头异常',
                                color: Color.Red
                            }
                        }
                        : {
                            tag: {
                                value: inv.category
                            }
                        },
                { text: formatCurrency(inv.totalAmount) }
            ],
            actions: ActionPanel({
                title: inv.sellerName,
                children: [
                    Action({
                        title: `一键生成报销归档包 (${selectedInvoices.length}张 · ${formatCurrency(totalAmountSum)})`,
                        icon: Icon.Bolt,
                        onAction: () => handleExportReimbursementBundle('ExportReimbursementBundle')
                    }),
                    Action({
                        title: '复制报销明细表 (Excel TSV 直接粘贴)',
                        icon: Icon.CopyClipboard,
                        shortcut: { modifiers: ['ctrl'], key: 'enter' },
                        onAction: handleCopyExcelTsv
                    }),
                    Action({
                        title: '仅导出 UTF-8 BOM 财务报销台账 (.csv)',
                        icon: Icon.Download,
                        shortcut: { modifiers: ['ctrl'], key: 'e' },
                        onAction: () => handleExportReimbursementBundle('ExportInvoicesCsv')
                    }),
                    Action({
                        title: '合并已选发票为单份 A4 打印 PDF',
                        icon: Icon.Document,
                        shortcut: { modifiers: ['ctrl'], key: 'm' },
                        onAction: () => handleExportReimbursementBundle('MergeInvoicesPdf')
                    }),
                    Action({
                        title: `手动切换当前发票费用分类 (当前: ${inv.category})`,
                        icon: Icon.Tag,
                        shortcut: { modifiers: ['ctrl'], key: 't' },
                        onAction: () => handleCycleCategory(inv.id)
                    }),
                    Action({
                        title: '复制当前发票四要素文本',
                        icon: Icon.Clipboard,
                        shortcut: { modifiers: ['ctrl', 'shift'], key: 'c' },
                        onAction: async () => {
                            const summary = `发票号码: ${inv.invoiceNo}\n开票日期: ${inv.issueDate}\n销方名称: ${inv.sellerName}\n购方名称: ${inv.buyerName}\n价税合计: ${inv.totalAmount.toFixed(2)}元 (税额: ${inv.taxAmount.toFixed(2)}元)`;
                            await Clipboard.copy(summary);
                            await showToast({ style: Toast.Style.Success, title: '已复制发票四要素' });
                        }
                    }),
                    Action({
                        title: '在资源管理器定位原发票',
                        icon: Icon.Folder,
                        shortcut: { modifiers: ['ctrl'], key: 'o' },
                        onAction: async () => {
                            await openInvoiceLocation(inv.path);
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
                                message: `文件名: ${inv.fileName}\n发票号: ${inv.invoiceNo}\n金额: ${formatCurrency(inv.totalAmount)}`,
                                primaryAction: { title: '移入回收站', style: 'destructive' }
                            });
                            if (!ok)
                                return;
                            const tr = await trashInvoiceFile(inv.path);
                            if (tr.ok) {
                                setInvoices((prev) => prev.filter((item) => item.id !== inv.id));
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
                ]
            })
        });
    });
    return List({
        searchBarPlaceholder: '搜索开票商户、发票号码、开票日期、金额或费用分类...',
        onSearchTextChange: setSearchText,
        isShowingDetail: false,
        isLoading,
        searchBarAccessory: List.Dropdown({
            tooltip: '选择财务规范化重命名模板',
            value: activeTemplateId,
            onChange: (val) => setActiveTemplateId(val),
            children: INVOICE_RENAME_TEMPLATES.map((tpl) => List.Dropdown.Item({
                title: tpl.title,
                value: tpl.id
            }))
        }),
        filterBar: FilterBar({
            summaryText: `已选 ${selectedInvoices.length}/${invoices.length} 张合规发票 · 报销总额 ${formatCurrency(totalAmountSum)} (含税额 ${formatCurrency(totalTaxSum)}) · 重复票 ${duplicateCount} 张`,
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
            title: '电子发票解析与重命名预览 (按 ↵ 一键生成重命名副本 + CSV 台账 + 合并打印 PDF)',
            subtitle: `${filteredInvoices.length} 张发票 · 已选报销合计 ${formatCurrency(totalAmountSum)}`,
            checkable: filteredInvoices.length > 0,
            checked: filteredInvoices.length > 0 && filteredInvoices.every((i) => checkedSet.has(i.id))
                ? true
                : filteredInvoices.some((i) => checkedSet.has(i.id))
                    ? 'indeterminate'
                    : false,
            onCheckChange: (checked) => {
                setCheckedIds(checked ? filteredInvoices.filter((i) => !i.isDuplicate).map((i) => i.id) : []);
            },
            emptyText: '当前分类下未找到匹配的电子发票 (.pdf / .xml)',
            items: rightInvoiceItems
        },
        children: [
            List.Section({
                title: '费用科目与报销分类导航',
                children: INVOICE_CATEGORY_GROUPS.map((grp) => {
                    const matched = grp.id === 'ALL' ? invoices : invoices.filter((i) => i.category === grp.id);
                    const sum = matched.reduce((acc, i) => acc + i.totalAmount, 0);
                    const isSelected = selectedFilterKey === grp.id;
                    return List.Item({
                        id: `inv-cat-${grp.id}`,
                        title: grp.name,
                        subtitle: formatCurrency(sum),
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
                                    title: '一键生成报销归档包',
                                    icon: Icon.Bolt,
                                    onAction: () => handleExportReimbursementBundle('ExportReimbursementBundle')
                                })
                            ]
                        })
                    });
                })
            }),
            List.Section({
                title: '报销合规智能预检',
                children: [
                    List.Item({
                        id: 'audit-duplicate',
                        title: '重复发票号防重拦截',
                        subtitle: duplicateCount > 0
                            ? `检测到 ${duplicateCount} 张发票号码完全相同，已自动取消勾选防退单`
                            : '全部发票号码唯一，无重复报销风险',
                        icon: {
                            source: duplicateCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                            tintColor: duplicateCount > 0 ? Color.Red : Color.SecondaryText
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
                        title: '购方抬头与税号校验',
                        subtitle: abnormalHeaderCount > 0
                            ? `发现 ${abnormalHeaderCount} 张个人抬头或税号缺失发票`
                            : '购方企业抬头与纳税人识别号全部合规',
                        icon: {
                            source: abnormalHeaderCount > 0 ? Icon.ExclamationMark : Icon.CheckCircle,
                            tintColor: abnormalHeaderCount > 0 ? Color.Red : Color.SecondaryText
                        },
                        accessories: [
                            abnormalHeaderCount > 0
                                ? { tag: { value: `${abnormalHeaderCount} 张异常`, color: Color.Red } }
                                : { tag: { value: '全部合规' } }
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
                    })
                ]
            })
        ]
    });
}
export default InvoiceAssistantCommand;
