import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  useState,
  useEffect,
  showToast,
  Toast,
  confirmAlert,
  MetricGrid,
  SegmentedControl
} from '../../index.js'
import {
  WechatCleanCategoryItem,
  WechatScannedFileEntry,
  WechatAccountStat,
  FORBIDDEN_REASON,
  formatBytes,
  formatDateTime,
  fetchWechatCleanSnapshot,
  executeWechatCleanup,
  openWechatDirectory,
  openWechatFileDefault
} from './logic.js'

type TimeRangeFilter = 'ALL' | '7D' | '30D' | '180D'

export default function WechatCleanerCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'files' | 'accounts' | 'protected'>('all')
  const [wizardStep, setWizardStep] = useState<'scan' | 'filter' | 'review' | 'done'>('filter')

  const [selectedAccount, setSelectedAccount] = useState<string>('ALL')
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRangeFilter>('ALL')
  const [selectedOwnerId, setSelectedOwnerId] = useState<string>('ALL')

  const [categories, setCategories] = useState<WechatCleanCategoryItem[]>([])
  const [allFiles, setAllFiles] = useState<WechatScannedFileEntry[]>([])
  const [accountStats, setAccountStats] = useState<WechatAccountStat[]>([])
  const [accounts, setAccounts] = useState<string[]>([])
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([])
  const [lastCleanSummary, setLastCleanSummary] = useState<{
    deletedCount: number
    freedBytes: number
  } | null>(null)

  const [diskFree, setDiskFree] = useState(0)
  const [diskTotal, setDiskTotal] = useState(0)
  const [protectedDbBytes, setProtectedDbBytes] = useState(0)
  const [isLoading, setIsLoading] = useState(true)

  async function refreshScan(showIndicator = false) {
    if (showIndicator) {
      setIsLoading(true)
      setWizardStep('scan')
      showToast({
        style: Toast.Style.Animated,
        title: '正在执行微信 9 大专项深度扫描 (Owner 107~115)...',
        message: '穿透扫描 xwechat_files、AppData\\Roaming\\Tencent\\xwechat 与 WeType 日志，锁定保护 db_storage'
      })
    }
    try {
      const snap = await fetchWechatCleanSnapshot()
      setCategories(snap.categories)
      setAllFiles(snap.allFiles)
      setAccountStats(snap.accountStats)
      setAccounts(snap.detectedAccounts)
      setDiskFree(snap.systemDiskFreeBytes)
      setDiskTotal(snap.systemDiskTotalBytes)
      setProtectedDbBytes(snap.protectedDbBytes)

      // 默认勾选安全推荐分类 (defaultChecked === true) 下的全部非保护文件
      const defaultCheckedOwners = new Set(
        snap.categories.filter(c => c.checked && c.ownerId !== 999).map(c => c.ownerId)
      )
      const initialCheckedPaths = snap.allFiles
        .filter(f => !f.isProtected && defaultCheckedOwners.has(f.ownerId))
        .map(f => f.path)
      setSelectedFilePaths(initialCheckedPaths)
      setWizardStep('filter')

      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: '微信 9 大专项扫描完成',
          message: `发现可释放空间 ${formatBytes(snap.totalScannableBytes)}，已自动锁定保护聊天库 ${formatBytes(snap.protectedDbBytes)}`
        })
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    refreshScan(false)
  }, [])

  // 1. 时间范围阈值计算 (秒)
  const nowSec = Math.floor(Date.now() / 1000)
  const cutoffSec =
    selectedTimeRange === '7D'
      ? nowSec - 7 * 86400
      : selectedTimeRange === '30D'
      ? nowSec - 30 * 86400
      : selectedTimeRange === '180D'
      ? nowSec - 180 * 86400
      : 0

  // 2. 按 微信号账号 (wxid) + 修改时间范围 + 9大专项分类 + 搜索词 过滤文件
  const q = searchText.trim().toLowerCase()
  const matchAccountAndTime = (f: WechatScannedFileEntry): boolean => {
    if (selectedAccount !== 'ALL' && f.accountId !== selectedAccount) return false
    if (cutoffSec > 0 && f.mtime > cutoffSec) return false
    return true
  }

  const scopedFiles = allFiles.filter(matchAccountAndTime)
  const filteredFiles = scopedFiles.filter(f => {
    if (selectedOwnerId !== 'ALL' && String(f.ownerId) !== selectedOwnerId) return false
    if (!q) return true
    return (
      f.name.toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q) ||
      f.ownerName.toLowerCase().includes(q) ||
      f.accountId.toLowerCase().includes(q)
    )
  })

  // 3. 三级复选框状态管理 (全选推荐 / 分类级三态 / 单文件级)
  const selectedSet = new Set(selectedFilePaths)
  const selectableScopedFiles = filteredFiles.filter(f => !f.isProtected)
  const allScopedChecked =
    selectableScopedFiles.length > 0 && selectableScopedFiles.every(f => selectedSet.has(f.path))

  // 计算勾选的总可释放体积（当分类处于全选且无额外账号/时间收窄时，计入该分类全目录真实体积）
  const checkedCategoryBytes = categories
    .filter(c => c.ownerId !== 999)
    .reduce((acc, cat) => {
      const catSelectable = cat.files.filter(f => !f.isProtected && matchAccountAndTime(f))
      const catChecked = catSelectable.filter(f => selectedSet.has(f.path))
      if (catChecked.length === 0) return acc
      if (
        selectedAccount === 'ALL' &&
        selectedTimeRange === 'ALL' &&
        catChecked.length === catSelectable.length
      ) {
        return acc + cat.totalSizeBytes
      }
      return acc + catChecked.reduce((s, f) => s + f.sizeBytes, 0)
    }, 0)

  const checkedFileCount = allFiles.filter(
    f => !f.isProtected && matchAccountAndTime(f) && selectedSet.has(f.path)
  ).length

  function toggleSingleFile(filePath: string, nextChecked: boolean) {
    setSelectedFilePaths(prev => {
      const next = new Set(prev)
      if (nextChecked) next.add(filePath)
      else next.delete(filePath)
      return Array.from(next)
    })
  }

  function toggleCategoryCheck(cat: WechatCleanCategoryItem, nextChecked?: boolean) {
    if (cat.ownerId === 999) {
      showToast({
        style: Toast.Style.Failure,
        title: '🔒 聊天核心数据库受保护',
        message: FORBIDDEN_REASON
      })
      return
    }
    const catSelectable = cat.files.filter(f => !f.isProtected && matchAccountAndTime(f))
    const allCatChecked =
      catSelectable.length > 0 && catSelectable.every(f => selectedSet.has(f.path))
    const targetState = typeof nextChecked === 'boolean' ? nextChecked : !allCatChecked

    setSelectedFilePaths(prev => {
      const next = new Set(prev)
      for (const f of catSelectable) {
        if (targetState) next.add(f.path)
        else next.delete(f.path)
      }
      return Array.from(next)
    })
    setCategories(prev =>
      prev.map(c => (c.id === cat.id ? { ...c, checked: targetState } : c))
    )
  }

  function selectRecommendedSafeItems() {
    const safeOwners = new Set([107, 109, 111, 112, 113, 114, 115])
    const paths = scopedFiles
      .filter(f => !f.isProtected && safeOwners.has(f.ownerId))
      .map(f => f.path)
    setSelectedFilePaths(paths)
    setCategories(prev =>
      prev.map(c => ({ ...c, checked: safeOwners.has(c.ownerId) && c.totalSizeBytes > 0 }))
    )
    showToast({
      style: Toast.Style.Success,
      title: '已勾选 7 项安全推荐分类',
      message: '已自动排除聊天原图 (108)、接收文档 (110) 与核心聊天库 (db_storage)'
    })
  }

  function toggleAllFilteredFiles() {
    if (selectableScopedFiles.length === 0) return
    setSelectedFilePaths(prev => {
      const next = new Set(prev)
      if (allScopedChecked) {
        for (const f of selectableScopedFiles) next.delete(f.path)
      } else {
        for (const f of selectableScopedFiles) next.add(f.path)
      }
      return Array.from(next)
    })
  }

  async function handleCleanChecked() {
    const targetFiles = allFiles.filter(
      f => !f.isProtected && matchAccountAndTime(f) && selectedSet.has(f.path)
    )
    if (targetFiles.length === 0 && checkedCategoryBytes <= 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '暂无已勾选的待清理项',
        message: '请先勾选需要清理的 9 大专项分类或具体缓存文件'
      })
      return
    }

    setWizardStep('review')

    // 汇总各专项勾选情况供用户第 4 步核对
    const breakdownLines = categories
      .filter(c => c.ownerId !== 999)
      .map(c => {
        const cnt = c.files.filter(f => !f.isProtected && matchAccountAndTime(f) && selectedSet.has(f.path)).length
        if (cnt === 0) return null
        return `• ${c.shortName}: ${cnt} 个样本文件 (专项总计 ${formatBytes(c.totalSizeBytes)})`
      })
      .filter(Boolean)
      .join('\n')

    const confirmed = await confirmAlert({
      title: '🧹 步骤 4/4：微信专项清理核对确认',
      message: `当前筛选维度:\n• 微信账号: ${selectedAccount === 'ALL' ? '全部账号' : selectedAccount}\n• 时间范围: ${
        selectedTimeRange === 'ALL'
          ? '全部时间'
          : selectedTimeRange === '7D'
          ? '7天前文件'
          : selectedTimeRange === '30D'
          ? '30天前文件'
          : '半年前文件'
      }\n• 预计释放总空间: ${formatBytes(checkedCategoryBytes)} (涉及 ${targetFiles.length} 个已选文件)\n\n专项明细:\n${breakdownLines}\n\n🛡️ 硬件级安全锁：${FORBIDDEN_REASON}`,
      primaryAction: {
        title: `确认安全移入回收站 (${formatBytes(checkedCategoryBytes)})`,
        style: 'destructive'
      }
    })
    if (!confirmed) {
      setWizardStep('filter')
      return
    }

    const res = await executeWechatCleanup(
      categories,
      undefined,
      targetFiles.map(f => f.path)
    )
    setLastCleanSummary({
      deletedCount: res.deletedCount,
      freedBytes: res.freedBytes
    })
    setWizardStep('done')

    showToast({
      style: Toast.Style.Success,
      title: '🎉 微信专项清理完成！',
      message: `已安全移入回收站 ${res.deletedCount} 个文件，释放 ${formatBytes(res.freedBytes)}`
    })

    if (res.deletedPaths.length > 0) {
      const removed = new Set(res.deletedPaths)
      setAllFiles(prev => prev.filter(f => !removed.has(f.path)))
      setSelectedFilePaths(prev => prev.filter(p => !removed.has(p)))
    }
  }

  function renderCategoryDetailMarkdown(item: WechatCleanCategoryItem): string {
    const scopedCatFiles = item.files.filter(matchAccountAndTime)
    const checkedCatCount = scopedCatFiles.filter(f => selectedSet.has(f.path)).length
    const samplesMd =
      scopedCatFiles.length > 0
        ? scopedCatFiles
            .slice(0, 12)
            .map(
              (s, idx) =>
                `${idx + 1}. \`${s.name}\` — **${formatBytes(s.sizeBytes)}** · \`${s.accountId}\` · \`${formatDateTime(s.mtime)}\``
            )
            .join('\n')
        : '_当前账号/时间筛选条件下无匹配文件_'

    const riskBadge =
      item.riskLevel === 'protected'
        ? '🔒 **硬件级防误删锁定 (严禁清理)**'
        : item.riskLevel === 'safe'
        ? '🟢 **安全放心清理 (不影响任何聊天记录与收发文件)**'
        : item.riskLevel === 'recommended'
        ? '🔵 **推荐定期清理 (释放大量空间，按需自动重新加载)**'
        : '🟠 **谨慎确认清理 (建议展开下方文件列表逐项核对后再勾选)**'

    return `# ${item.name}

**本机真实路径**: \`${item.targetDir}\`  
**安全等级**: ${riskBadge}

---

### 📊 专项空间统计画像
- **专项全目录总文件数**: \`${item.fileCount.toLocaleString()} 项\`
- **专项全目录真实总占用**: \`${formatBytes(item.totalSizeBytes)}\` (\`${item.totalSizeBytes.toLocaleString()} Bytes\`)
- **当前筛选命中样本**: \`${scopedCatFiles.length} 项\` (已勾选 \`${checkedCatCount} 项\`)
- **功能说明**: ${item.description}

---

### 📄 本专项 Top 真实文件样本清单 (${scopedCatFiles.length} 项)
${samplesMd}

---

> [!IMPORTANT]
> **聊天记录防误删锁已开启**：${FORBIDDEN_REASON}
`
  }

  function renderFileDetailMarkdown(f: WechatScannedFileEntry): string {
    const isChecked = selectedSet.has(f.path)
    return `# 📄 ${f.name}

**完整物理路径**: \`${f.path}\`

---

### 📊 微信文件多维画像
- **文件真实大小**: \`${formatBytes(f.sizeBytes)}\` (\`${f.sizeBytes.toLocaleString()} Bytes\`)
- **所属 9 大专项**: **${f.ownerName}** (\`Owner #${f.ownerId}\`)
- **归属微信号 / 组件**: \`${f.accountId}\`
- **最后修改日期**: \`${formatDateTime(f.mtime)}\`
- **所在父目录**: \`${f.parentDir}\`
- **安全与勾选状态**: ${
      f.isProtected
        ? '🔒 核心聊天数据库文件 (受硬件级防误删锁保护)'
        : isChecked
        ? '☑️ 已勾选纳入待清理队列'
        : '⬜ 未勾选'
    }

---

> [!TIP]
> 点击列表左侧复选框可单独勾选或保留此文件；按 \`Enter\` 可直接在 Windows 资源管理器中高亮定位该文件。
`
  }

  const totalScannable = categories
    .filter(c => c.ownerId !== 999)
    .reduce((s, c) => s + c.totalSizeBytes, 0)

  // 构建 9 大专项彩色分段占比条
  const distributionSegments = categories
    .filter(c => c.ownerId !== 999 && c.totalSizeBytes > 0)
    .map(c => ({
      id: String(c.ownerId),
      label: c.shortName,
      color: c.color,
      sizeBytes: c.totalSizeBytes,
      formattedSize: formatBytes(c.totalSizeBytes),
      percent:
        totalScannable > 0
          ? Math.max(1, Math.round((c.totalSizeBytes / totalScannable) * 100))
          : 0,
      count: c.fileCount
    }))

  const filteredCategories = categories.filter(c => {
    if (selectedOwnerId !== 'ALL' && String(c.ownerId) !== selectedOwnerId) return false
    if (tab === 'protected') return c.ownerId === 999
    if (!q) return true
    return (
      c.name.toLowerCase().includes(q) ||
      c.shortName.toLowerCase().includes(q) ||
      c.targetDir.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q)
    )
  })

  return List({
    searchBarPlaceholder:
      '搜索微信 9 大专项 (朋友圈/小程序/XLog/崩溃Dmp/表情包)、微信号 (liaoguobo_7f67) 或文件名...',
    onSearchTextChange: setSearchText,
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'wx-total',
          label: '微信 9 大专项可扫描总量',
          value: formatBytes(totalScannable),
          subValue: `共 ${categories
            .filter(c => c.ownerId !== 999)
            .reduce((s, c) => s + c.fileCount, 0)
            .toLocaleString()} 个真实缓存文件`,
          status: 'normal'
        },
        {
          id: 'wx-checked',
          label: '已勾选待释放空间',
          value: formatBytes(checkedCategoryBytes),
          subValue: `已选 ${checkedFileCount} 个样本文件 · 可一键移入回收站`,
          status: 'success'
        },
        {
          id: 'wx-accounts',
          label: '已识别微信号与保护库',
          value: `${accounts.length} 个微信号`,
          subValue: `🔒 已锁定保护聊天库 ${formatBytes(protectedDbBytes)}`,
          status: 'normal'
        },
        {
          id: 'wx-c-free',
          label: lastCleanSummary ? '本次已成功释放空间' : '系统盘 (C:) 可用空间',
          value: lastCleanSummary
            ? formatBytes(lastCleanSummary.freedBytes)
            : formatBytes(diskFree),
          subValue: lastCleanSummary
            ? `已安全清理 ${lastCleanSummary.deletedCount} 个微信冗余文件`
            : `C: 总容量 ${formatBytes(diskTotal)}`,
          status:
            lastCleanSummary
              ? 'success'
              : diskFree > 0 && diskFree < 15 * 1024 * 1024 * 1024
              ? 'danger'
              : 'normal'
        }
      ]
    }),
    distributionBar: {
      title: '📊 微信 9 大官方专项 (Owner 107~115) 真实空间占比分布 (点击色块或图例可单独穿透该专项)',
      totalLabel: `可清理总量 ${formatBytes(totalScannable)} · 聊天库保护区 ${formatBytes(protectedDbBytes)}`,
      activeSegmentId: selectedOwnerId === 'ALL' ? undefined : selectedOwnerId,
      onSelectSegment: segId => {
        setSelectedOwnerId(segId || 'ALL')
      },
      segments: distributionSegments
    },
    filterBar: {
      wizardSteps: [
        {
          id: 'step-env',
          label: `1. 环境与微信号识别 (${accounts.length}个账号)`,
          status: 'done',
          onSelect: () => setTab('accounts')
        },
        {
          id: 'step-scan',
          label: `2. 9大专项深度扫描 (${formatBytes(totalScannable)})`,
          status: 'done',
          onSelect: () => setTab('all')
        },
        {
          id: 'step-filter',
          label: `3. 账号/时间筛选与三级勾选 (已选 ${formatBytes(checkedCategoryBytes)})`,
          status: wizardStep === 'filter' ? 'active' : 'done',
          onSelect: () => {
            setWizardStep('filter')
            setTab('files')
          }
        },
        {
          id: 'step-clean',
          label: lastCleanSummary
            ? `4. 清理完成 (已释放 ${formatBytes(lastCleanSummary.freedBytes)})`
            : '4. 清理核对确认',
          status: wizardStep === 'done' ? 'done' : wizardStep === 'review' ? 'active' : 'pending',
          onSelect: () => handleCleanChecked()
        }
      ],
      summaryText: `当前筛选: 账号 [${selectedAccount === 'ALL' ? '全部微信号' : selectedAccount}] · 时间 [${
        selectedTimeRange === 'ALL'
          ? '全部时间'
          : selectedTimeRange === '7D'
          ? '7天前'
          : selectedTimeRange === '30D'
          ? '30天前'
          : '半年前'
      }] · 匹配 ${filteredFiles.length} 个样本文件 · 已勾选待释放 ${formatBytes(checkedCategoryBytes)}`,
      groups: [
        {
          id: 'wx-account-filter',
          label: '微信账号',
          value: selectedAccount,
          onChange: val => setSelectedAccount(val),
          options: [
            { value: 'ALL', label: '👥 全部微信号与组件', badge: allFiles.length },
            ...accountStats.map(acc => ({
              value: acc.accountId,
              label:
                acc.accountId === '公共组件 (Shared)'
                  ? '🌐 公共引擎 (xplugin/log)'
                  : `👤 ${acc.accountId}`,
              badge: `${acc.fileCount} · ${formatBytes(acc.totalBytes)}`
            }))
          ]
        },
        {
          id: 'wx-time-filter',
          label: '时间范围',
          value: selectedTimeRange,
          onChange: val => setSelectedTimeRange(val as TimeRangeFilter),
          options: [
            { value: 'ALL', label: '🕒 全部时间', badge: allFiles.length },
            {
              value: '7D',
              label: '📅 7天前文件',
              badge: allFiles.filter(f => f.mtime <= nowSec - 7 * 86400).length
            },
            {
              value: '30D',
              label: '🗓️ 1个月前文件',
              badge: allFiles.filter(f => f.mtime <= nowSec - 30 * 86400).length
            },
            {
              value: '180D',
              label: '⏳ 半年前文件',
              badge: allFiles.filter(f => f.mtime <= nowSec - 180 * 86400).length
            }
          ]
        },
        {
          id: 'wx-owner-filter',
          label: '9大专项',
          value: selectedOwnerId,
          onChange: val => setSelectedOwnerId(val),
          options: [
            { value: 'ALL', label: '🗂️ 全部 9 大专项', badge: categories.length },
            ...categories
              .filter(c => c.totalSizeBytes > 0 || c.ownerId === 999)
              .map(c => ({
                value: String(c.ownerId),
                label: c.shortName,
                badge: formatBytes(c.totalSizeBytes)
              }))
          ]
        }
      ],
      actions: [
        {
          id: 'wx-act-safe',
          label: '☑️ 一键勾选安全推荐项',
          style: 'secondary',
          onAction: () => selectRecommendedSafeItems()
        },
        {
          id: 'wx-act-toggle-all',
          label: allScopedChecked
            ? `🔲 取消全选 (${selectableScopedFiles.length}项)`
            : `☑️ 全选当前筛选 (${selectableScopedFiles.length}项)`,
          style: 'secondary',
          onAction: () => toggleAllFilteredFiles()
        },
        {
          id: 'wx-act-clean',
          label: `🧹 立即安全清理已勾选项 (${formatBytes(checkedCategoryBytes)})`,
          style: 'danger',
          onAction: () => handleCleanChecked()
        },
        {
          id: 'wx-act-rescan',
          label: '🔄 重新深度扫描',
          style: 'secondary',
          onAction: () => refreshScan(true)
        }
      ]
    },
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as any),
      options: [
        { value: 'all', label: '9大专项总览与三级勾选', badge: categories.length },
        { value: 'files', label: '按专项展开单文件明细', badge: filteredFiles.length },
        { value: 'accounts', label: '本机微信号存储分布', badge: accountStats.length },
        {
          value: 'protected',
          label: '🔒 聊天数据库保护区',
          badge: categories.find(c => c.ownerId === 999)?.fileCount || 0
        }
      ]
    }),
    children: [
      ...(tab === 'all' || tab === 'protected'
        ? [
            List.Section({
              title: `微信 9 大专项清理分类与核心数据库保护区 (${filteredCategories.length})`,
              subtitle: '支持分类级三态勾选（全选 / 半选 / 不选）；点击任意专项可穿透查看并单独勾选内部文件',
              children: filteredCategories.map(item => {
                const catSelectable = item.files.filter(f => !f.isProtected && matchAccountAndTime(f))
                const catCheckedCount = catSelectable.filter(f => selectedSet.has(f.path)).length
                const checkState: boolean | 'indeterminate' =
                  item.ownerId === 999 || catSelectable.length === 0
                    ? false
                    : catCheckedCount === catSelectable.length
                    ? true
                    : catCheckedCount > 0
                    ? 'indeterminate'
                    : false

                return List.Item({
                  id: item.id,
                  title: item.name,
                  subtitle: `${item.targetDir} · ${
                    item.ownerId === 999
                      ? '🔒 硬件级防误删保护'
                      : `已选 ${catCheckedCount}/${catSelectable.length} 个样本`
                  }`,
                  checkable: item.ownerId !== 999 && item.totalSizeBytes > 0,
                  checked: checkState,
                  onCheckChange: nextChecked => toggleCategoryCheck(item, nextChecked),
                  icon: {
                    source:
                      item.ownerId === 999
                        ? Icon.Lock
                        : item.existsOnDisk
                        ? Icon.CheckCircle
                        : Icon.Circle,
                    tintColor:
                      item.ownerId === 999
                        ? Color.Orange
                        : checkState
                        ? Color.Green
                        : Color.SecondaryText
                  },
                  accessories: [
                    {
                      tag: {
                        value:
                          item.riskLevel === 'protected'
                            ? '🔒 核心保护'
                            : item.riskLevel === 'safe'
                            ? '安全推荐'
                            : item.riskLevel === 'recommended'
                            ? '推荐清理'
                            : '谨慎核对',
                        color:
                          item.riskLevel === 'protected'
                            ? Color.Orange
                            : item.riskLevel === 'safe'
                            ? Color.Green
                            : item.riskLevel === 'recommended'
                            ? Color.Blue
                            : Color.Red
                      }
                    },
                    {
                      tag: {
                        value: item.existsOnDisk ? `${item.fileCount.toLocaleString()} 项` : '未生成',
                        color: item.existsOnDisk ? Color.Blue : Color.SecondaryText
                      }
                    },
                    { text: formatBytes(item.totalSizeBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: renderCategoryDetailMarkdown(item)
                  }),
                  actions: ActionPanel({
                    title: item.name,
                    children: [
                      ...(item.ownerId !== 999
                        ? [
                            Action({
                              title: checkState ? '取消勾选此专项' : '勾选此专项全部可清理文件',
                              icon: Icon.CheckCircle,
                              onAction: () => toggleCategoryCheck(item)
                            })
                          ]
                        : []),
                      Action({
                        title: `穿透展开【${item.shortName}】单文件明细列表`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedOwnerId(String(item.ownerId))
                          setTab('files')
                        }
                      }),
                      Action({
                        title: `立即清理已勾选微信缓存 (${formatBytes(checkedCategoryBytes)})`,
                        icon: Icon.Trash,
                        style: Action.Style.Destructive,
                        onAction: () => handleCleanChecked()
                      }),
                      Action({
                        title: '在资源管理器中打开此目录',
                        icon: Icon.Folder,
                        onAction: () => {
                          openWechatDirectory(item.targetDir)
                        }
                      }),
                      Action({
                        title: '重新深度扫描微信存储',
                        icon: Icon.ArrowClockwise,
                        onAction: () => refreshScan(true)
                      }),
                      Action({
                        title: '复制目录完整路径',
                        icon: Icon.Clipboard,
                        onAction: async () => {
                          await Clipboard.copy(item.targetDir)
                          showToast({
                            style: Toast.Style.Success,
                            title: '路径已复制',
                            message: item.targetDir
                          })
                        }
                      })
                    ]
                  })
                })
              })
            })
          ]
        : []),
      ...(tab === 'all' || tab === 'files'
        ? categories
            .filter(cat => {
              if (selectedOwnerId !== 'ALL' && String(cat.ownerId) !== selectedOwnerId) return false
              const matching = filteredFiles.filter(f => f.ownerId === cat.ownerId)
              return matching.length > 0
            })
            .map(cat => {
              const catFiles = filteredFiles.filter(f => f.ownerId === cat.ownerId)
              const catSelectable = catFiles.filter(f => !f.isProtected)
              const catCheckedCount = catSelectable.filter(f => selectedSet.has(f.path)).length
              const checkState: boolean | 'indeterminate' =
                cat.ownerId === 999 || catSelectable.length === 0
                  ? false
                  : catCheckedCount === catSelectable.length
                  ? true
                  : catCheckedCount > 0
                  ? 'indeterminate'
                  : false

              return List.Section({
                title: `${cat.name} (匹配样本 ${catFiles.length} 项 · 专项总计 ${formatBytes(cat.totalSizeBytes)})`,
                subtitle:
                  cat.ownerId === 999
                    ? '🔒 微信核心聊天文字数据库，已开启防误删锁'
                    : `已勾选 ${catCheckedCount}/${catSelectable.length} 项 · 支持单文件独立勾选与排除`,
                checkable: cat.ownerId !== 999 && catSelectable.length > 0,
                checked: checkState,
                onCheckChange: nextChecked => toggleCategoryCheck(cat, nextChecked),
                children: catFiles.slice(0, 40).map(f => {
                  const isChecked = selectedSet.has(f.path)
                  return List.Item({
                    id: f.id,
                    title: f.name,
                    subtitle: `${f.accountId} · ${formatDateTime(f.mtime)} · ${f.parentDir}`,
                    checkable: !f.isProtected,
                    checked: isChecked,
                    onCheckChange: nextChecked => toggleSingleFile(f.path, nextChecked),
                    icon: {
                      source: f.isProtected ? Icon.Lock : Icon.Document,
                      tintColor: f.isProtected
                        ? Color.Orange
                        : isChecked
                        ? Color.Green
                        : Color.Blue
                    },
                    accessories: [
                      ...(f.isProtected
                        ? [{ tag: { value: '🔒 聊天库保护', color: Color.Orange } }]
                        : []),
                      { tag: { value: f.accountId, color: Color.SecondaryText } },
                      { text: formatBytes(f.sizeBytes) }
                    ],
                    detail: List.Item.Detail({
                      markdown: renderFileDetailMarkdown(f)
                    }),
                    actions: ActionPanel({
                      title: f.name,
                      children: [
                        Action({
                          title: '在资源管理器中定位此文件',
                          icon: Icon.Folder,
                          onAction: () => {
                            openWechatDirectory(f.path)
                          }
                        }),
                        ...(!f.isProtected
                          ? [
                              Action({
                                title: isChecked ? '取消勾选此文件' : '勾选此文件纳入清理',
                                icon: Icon.Checkmark,
                                onAction: () => toggleSingleFile(f.path, !isChecked)
                              })
                            ]
                          : []),
                        Action({
                          title: '使用默认程序打开文件',
                          icon: Icon.AppWindow,
                          onAction: () => {
                            openWechatFileDefault(f.path)
                          }
                        }),
                        Action({
                          title: `立即清理所有已勾选项 (${formatBytes(checkedCategoryBytes)})`,
                          icon: Icon.Trash,
                          style: Action.Style.Destructive,
                          onAction: () => handleCleanChecked()
                        }),
                        Action.CopyToClipboard({
                          title: '复制文件完整路径',
                          content: f.path
                        })
                      ]
                    })
                  })
                })
              })
            })
        : []),
      ...(tab === 'accounts'
        ? [
            List.Section({
              title: `本机已识别微信账号与公共引擎目录 (${accountStats.length})`,
              subtitle: '点击任意微信号可单独过滤并清理该账号下的缓存与接收文件',
              children: accountStats.map(acc =>
                List.Item({
                  id: `acc-${acc.accountId}`,
                  title: acc.label,
                  subtitle: `存储路径: ${acc.rootDir}`,
                  icon: { source: Icon.Person, tintColor: Color.Green },
                  accessories: [
                    { tag: { value: `${acc.fileCount} 个样本文件`, color: Color.Blue } },
                    { text: formatBytes(acc.totalBytes) }
                  ],
                  detail: List.Item.Detail({
                    markdown: `# ${acc.label}\n\n**根目录**: \`${acc.rootDir}\`\n\n- **已采样文件数**: \`${acc.fileCount} 项\`\n- **采样占用体积**: \`${formatBytes(acc.totalBytes)}\`\n\n> 点击回车可立即将该微信号设为当前筛选账号。`
                  }),
                  actions: ActionPanel({
                    title: acc.label,
                    children: [
                      Action({
                        title: `仅筛选【${acc.accountId}】下的微信文件`,
                        icon: Icon.MagnifyingGlass,
                        onAction: () => {
                          setSelectedAccount(acc.accountId)
                          setTab('files')
                        }
                      }),
                      Action({
                        title: '在资源管理器中打开账号目录',
                        icon: Icon.Folder,
                        onAction: () => {
                          openWechatDirectory(acc.rootDir)
                        }
                      })
                    ]
                  })
                })
              )
            })
          ]
        : [])
    ]
  })
}
