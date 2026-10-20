import {
  List,
  ActionPanel,
  Action,
  Icon,
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
  OFFICIAL_WECHAT_OWNER_RULES,
  WechatCleanCategoryItem,
  WechatScannedFileEntry,
  WechatAccountStat,
  FORBIDDEN_REASON,
  formatBytes,
  formatDateTime,
  fetchWechatCleanSnapshot,
  executeWechatCleanup,
  openWechatDirectory,
  openWechatFileDefault,
  isRealElectronHost
} from './logic.js'

type TimeRangeFilter = 'ALL' | '7D' | '30D' | '180D'

const INIT_WECHAT_FILES: WechatScannedFileEntry[] = [
  {
    id: 'wx-init-107',
    name: 'sns_timeline_cache_01.data',
    path: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\radium\\web\\sns_timeline_cache_01.data',
    parentDir: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\radium\\web',
    ownerId: 107,
    ownerName: '朋友圈/网页缓存',
    accountId: 'wxid_geek001',
    sizeBytes: 320 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'wx-init-115',
    name: 'WeChatAppEx_Runtime_8555.pak',
    path: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\xplugin\\Plugins\\WeChatAppEx_Runtime_8555.pak',
    parentDir: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\xplugin\\Plugins',
    ownerId: 115,
    ownerName: '小程序/XPlugin',
    accountId: '公共组件 (Shared)',
    sizeBytes: 245 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'wx-init-113',
    name: 'mm_20261018.xlog',
    path: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\log\\mm_20261018.xlog',
    parentDir: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\xwechat\\log',
    ownerId: 113,
    ownerName: '运行跟踪日志 (.xlog)',
    accountId: '公共组件 (Shared)',
    sizeBytes: 128 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'wx-init-999',
    name: 'message_0.db',
    path: 'C:\\Users\\Admin\\Documents\\xwechat_files\\wxid_geek001\\db_storage\\message\\message_0.db',
    parentDir: 'C:\\Users\\Admin\\Documents\\xwechat_files\\wxid_geek001\\db_storage\\message',
    ownerId: 999,
    ownerName: '核心聊天数据库 (受保护)',
    accountId: 'wxid_geek001',
    sizeBytes: 96 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: true
  }
]

function buildInitialCategories(): WechatCleanCategoryItem[] {
  const sourceFiles = isRealElectronHost() ? [] : INIT_WECHAT_FILES
  return OFFICIAL_WECHAT_OWNER_RULES.map(rule => {
    const catFiles = sourceFiles.filter(f => f.ownerId === rule.ownerId)
    const totalSizeBytes = catFiles.reduce((s, f) => s + f.sizeBytes, 0)
    return {
      id: rule.id,
      ownerId: rule.ownerId,
      name: rule.name,
      shortName: rule.shortName,
      color: rule.color,
      category: rule.category,
      riskLevel: rule.riskLevel,
      safetyLevel: rule.riskLevel,
      targetDir: catFiles[0]?.parentDir || 'C:\\Users\\Admin\\Documents\\xwechat_files',
      existsOnDisk: catFiles.length > 0,
      fileCount: catFiles.length,
      totalSizeBytes,
      checked: rule.defaultChecked && rule.ownerId !== 999 && totalSizeBytes > 0,
      sampleFiles: catFiles.map(f => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
        mtime: f.mtime,
        accountId: f.accountId
      })),
      files: catFiles,
      description: rule.description
    }
  })
}

export default function WechatCleanerCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<'all' | 'files' | 'accounts' | 'protected'>('all')
  const [wizardStep, setWizardStep] = useState<'scan' | 'filter' | 'review' | 'done'>('filter')

  const [selectedAccount, setSelectedAccount] = useState<string>('ALL')
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRangeFilter>('ALL')
  const [selectedOwnerId, setSelectedOwnerId] = useState<string>('ALL')

  const [categories, setCategories] = useState<WechatCleanCategoryItem[]>(() => buildInitialCategories())
  const [allFiles, setAllFiles] = useState<WechatScannedFileEntry[]>(() =>
    inRealHost ? [] : INIT_WECHAT_FILES
  )
  const [accountStats, setAccountStats] = useState<WechatAccountStat[]>(() =>
    inRealHost
      ? []
      : [
          {
            accountId: 'wxid_geek001',
            label: '微信号: wxid_geek001',
            rootDir: 'C:\\Users\\Admin\\Documents\\xwechat_files\\wxid_geek001',
            fileCount: 2,
            totalBytes: 416 * 1024 * 1024
          }
        ]
  )
  const [accounts, setAccounts] = useState<string[]>(() => (inRealHost ? [] : ['wxid_geek001']))
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>(() =>
    inRealHost ? [] : INIT_WECHAT_FILES.filter(f => !f.isProtected).map(f => f.path)
  )
  const [lastCleanSummary, setLastCleanSummary] = useState<{
    deletedCount: number
    freedBytes: number
  } | null>(null)

  const [diskFree, setDiskFree] = useState(inRealHost ? 0 : 64 * 1024 * 1024 * 1024)
  const [diskTotal, setDiskTotal] = useState(inRealHost ? 0 : 256 * 1024 * 1024 * 1024)
  const [protectedDbBytes, setProtectedDbBytes] = useState(inRealHost ? 0 : 96 * 1024 * 1024)
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
      if (isRealElectronHost() || snap.allFiles.length > 0) {
        setCategories(snap.categories)
        setAllFiles(snap.allFiles)
        setAccountStats(snap.accountStats)
        setAccounts(snap.detectedAccounts)
        setDiskFree(snap.systemDiskFreeBytes)
        setDiskTotal(snap.systemDiskTotalBytes)
        setProtectedDbBytes(snap.protectedDbBytes)

        const defaultCheckedOwners = new Set(
          snap.categories.filter(c => c.checked && c.ownerId !== 999).map(c => c.ownerId)
        )
        const initialCheckedPaths = snap.allFiles
          .filter(f => !f.isProtected && defaultCheckedOwners.has(f.ownerId))
          .map(f => f.path)
        setSelectedFilePaths(initialCheckedPaths)
      }
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

  const nowSec = Math.floor(Date.now() / 1000)
  const cutoffSec =
    selectedTimeRange === '7D'
      ? nowSec - 7 * 86400
      : selectedTimeRange === '30D'
      ? nowSec - 30 * 86400
      : selectedTimeRange === '180D'
      ? nowSec - 180 * 86400
      : 0

  const q = searchText.trim().toLowerCase()
  const matchAccountAndTime = (f: WechatScannedFileEntry): boolean => {
    if (selectedAccount !== 'ALL' && f.accountId !== selectedAccount) return false
    if (cutoffSec > 0 && f.mtime > cutoffSec) return false
    return true
  }

  const scopedFiles = allFiles.filter(matchAccountAndTime)
  const filteredFiles = scopedFiles
    .filter(f => {
      if (selectedOwnerId !== 'ALL' && String(f.ownerId) !== selectedOwnerId) return false
      if (!q) return true
      return (
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q) ||
        f.ownerName.toLowerCase().includes(q) ||
        f.accountId.toLowerCase().includes(q)
      )
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  const selectedSet = new Set(selectedFilePaths)
  const selectableScopedFiles = filteredFiles.filter(f => !f.isProtected)
  const allScopedChecked =
    selectableScopedFiles.length > 0 && selectableScopedFiles.every(f => selectedSet.has(f.path))
  const someScopedChecked =
    selectableScopedFiles.some(f => selectedSet.has(f.path)) && !allScopedChecked

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

    const breakdownLines = categories
      .filter(c => c.ownerId !== 999)
      .map(c => {
        const cnt = c.files.filter(f => !f.isProtected && matchAccountAndTime(f) && selectedSet.has(f.path)).length
        if (cnt === 0) return null
        return `- ${c.shortName}: ${cnt} 个样本文件 (专项总计 ${formatBytes(c.totalSizeBytes)})`
      })
      .filter(Boolean)
      .join('\n')

    const confirmed = await confirmAlert({
      title: '步骤 4/4：微信专项清理核对确认',
      message: `当前筛选维度:\n- 微信账号: ${selectedAccount === 'ALL' ? '全部账号' : selectedAccount}\n- 预计释放总空间: ${formatBytes(checkedCategoryBytes)} (涉及 ${targetFiles.length} 个已选文件)\n\n专项明细:\n${breakdownLines}\n\n硬件级安全锁：${FORBIDDEN_REASON}`,
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
      title: '微信专项清理完成',
      message: `已安全移入回收站 ${res.deletedCount} 个文件，释放 ${formatBytes(res.freedBytes)}`
    })

    if (res.deletedPaths.length > 0) {
      const removed = new Set(res.deletedPaths)
      setAllFiles(prev => prev.filter(f => !removed.has(f.path)))
      setSelectedFilePaths(prev => prev.filter(p => !removed.has(p)))
    }
  }

  function renderFileDetailMarkdown(f: WechatScannedFileEntry): string {
    const isChecked = selectedSet.has(f.path)
    return `# ${f.name}

**完整物理路径**: \`${f.path}\`

---

### 微信文件多维画像
- **文件真实大小**: \`${formatBytes(f.sizeBytes)}\` (\`${f.sizeBytes.toLocaleString()} Bytes\`)
- **所属 9 大专项**: **${f.ownerName}** (\`Owner #${f.ownerId}\`)
- **归属微信号 / 组件**: \`${f.accountId}\`
- **最后修改日期**: \`${formatDateTime(f.mtime)}\`
- **所在父目录**: \`${f.parentDir}\`
- **安全与勾选状态**: ${
      f.isProtected
        ? '核心聊天数据库文件 (受硬件级防误删锁保护)'
        : isChecked
        ? '已勾选纳入待清理队列'
        : '未勾选'
    }
`
  }

  const totalScannable = categories
    .filter(c => c.ownerId !== 999)
    .reduce((s, c) => s + c.totalSizeBytes, 0)

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

  const maxFileBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightSubListItems = filteredFiles.slice(0, 60).map(f => {
    const isChecked = !f.isProtected && selectedSet.has(f.path)
    const volRatio = Math.max(10, Math.min(100, Math.round((f.sizeBytes / maxFileBytes) * 100)))
    const isDbProtected = f.isProtected || f.ownerId === 999

    return List.Item({
      id: f.id,
      title: f.name,
      subtitle: isDbProtected
        ? `${f.accountId} · 微信核心聊天记录数据库严禁清理 · ${f.parentDir}`
        : `${f.accountId} · ${formatDateTime(f.mtime)} · ${f.parentDir}`,
      checkable: !isDbProtected,
      checked: isChecked,
      lockedReason: isDbProtected ? '微信核心聊天记录数据库严禁清理' : undefined,
      onCheckChange: (c: boolean) => toggleSingleFile(f.path, c),
      onToggleCheck: (c: boolean) => toggleSingleFile(f.path, c),
      icon: {
        source: isDbProtected ? Icon.Lock : Icon.Document
      },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: isDbProtected ? '聊天库锁定' : f.ownerName } },
        { text: formatBytes(f.sizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: renderFileDetailMarkdown(f)
      }),
      actions: ActionPanel({
        title: f.name,
        children: [
          Action({
            title: `清理已勾选微信缓存 (${formatBytes(checkedCategoryBytes)})`,
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            onAction: () => handleCleanChecked()
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openWechatDirectory(f.path)
            }
          }),
          ...(!isDbProtected
            ? [
                Action({
                  title: isChecked ? '取消勾选此文件' : '勾选此文件',
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
          Action.CopyToClipboard({
            title: '复制文件完整路径',
            content: f.path
          })
        ]
      })
    } as any)
  })

  const activeCategory = categories.find(c => String(c.ownerId) === selectedOwnerId)
  const rightTitle = activeCategory
    ? `${activeCategory.name} 文件明细 (按体积降序，直接勾选或按 ↵ 执行)`
    : '全部微信专项缓存与保护库明细 (按体积降序，直接勾选或按 ↵ 执行)'

  return List({
    searchBarPlaceholder:
      '搜索微信 9 大专项 (朋友圈/小程序/XLog/崩溃Dmp/表情包)、微信号或文件名...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换微信账号 (wxid)',
      value: selectedAccount,
      onChange: val => setSelectedAccount(val),
      children: [
        List.Dropdown.Item({
          title: `全部微信账号 (${allFiles.length})`,
          value: 'ALL'
        }),
        ...accountStats.map(acc =>
          List.Dropdown.Item({
            title: `${acc.accountId} (${formatBytes(acc.totalBytes)})`,
            value: acc.accountId
          })
        )
      ]
    }),
    filterBar: {
      summaryText: `微信号 [${selectedAccount === 'ALL' ? '全部账号' : selectedAccount}] · 可释放 ${formatBytes(totalScannable)} · 已勾选 ${checkedFileCount} 项 (${formatBytes(checkedCategoryBytes)}) · 保护库已锁定 ${formatBytes(protectedDbBytes)}`,
      actions: [
        {
          id: 'wx-act-rescan',
          label: '重新扫描',
          title: '重新扫描',
          style: 'secondary',
          onAction: () => refreshScan(true)
        }
      ]
    },
    subList: {
      title: rightTitle,
      subtitle: `${filteredFiles.length} 项 · 已选 ${checkedFileCount} 项 (${formatBytes(checkedCategoryBytes)})`,
      checkable: selectableScopedFiles.length > 0,
      checked: allScopedChecked ? true : someScopedChecked ? 'indeterminate' : false,
      onCheckChange: () => toggleAllFilteredFiles(),
      emptyText: '当前选中的微信账号与专项分类下暂无匹配文件',
      items: rightSubListItems
    },
    children: [
      List.Section({
        title: '微信存储总览',
        children: [
          List.Item({
            id: 'wx-nav-all',
            title: '全部微信文件汇总',
            subtitle: `${allFiles.length} 个采样文件 · 可清理 ${formatBytes(totalScannable)}`,
            icon: { source: Icon.HardDrive },
            accessories: [{ text: formatBytes(totalScannable) }],
            onSelect: () => {
              setSelectedOwnerId('ALL')
              setTab('all')
            }
          })
        ]
      }),
      List.Section({
        title: '9 大官方专项分类 + 数据库保护区',
        children: categories.map(cat => {
          const isProtected = cat.ownerId === 999
          return List.Item({
            id: `wx-nav-owner-${cat.ownerId}`,
            title: cat.shortName,
            subtitle: isProtected
              ? '核心聊天记录库 (安全锁定)'
              : `Owner #${cat.ownerId} · ${cat.fileCount} 项`,
            icon: { source: isProtected ? Icon.Lock : Icon.Folder },
            accessories: [{ text: formatBytes(cat.totalSizeBytes) }],
            onSelect: () => {
              setSelectedOwnerId(String(cat.ownerId))
              setTab(isProtected ? 'protected' : 'files')
            }
          })
        })
      })
    ]
  })
}
