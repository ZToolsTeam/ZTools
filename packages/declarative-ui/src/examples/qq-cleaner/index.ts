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
  OFFICIAL_QQ_GROUP_RULES,
  QQCleanCategoryItem,
  QQScannedFileEntry,
  QQAccountStat,
  QQGroupId,
  FORBIDDEN_REASON,
  formatBytes,
  formatDateTime,
  fetchQQCleanSnapshot,
  executeQQCleanup,
  openQQDirectory,
  openQQFileDefault,
  isRealElectronHost
} from './logic.js'

type TimeRangeFilter = 'all' | '7d' | '30d' | '180d'
type ViewTab = 'categories' | 'files' | 'accounts'

const INIT_QQ_FILES: QQScannedFileEntry[] = [
  {
    id: 'qq-init-203',
    name: 'QQ.tlg.1',
    path: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\Logs\\QQ.tlg.1',
    parentDir: 'C:\\Users\\Admin\\AppData\\Roaming\\Tencent\\Logs',
    groupId: 203,
    groupName: '运行跟踪日志 (.tlg/.log)',
    accountId: '公共组件 (Shared)',
    clientType: 'Shared',
    sizeBytes: 215 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'qq-init-201',
    name: 'GroupPic_Cache_8942.png',
    path: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507\\Image\\Group\\GroupPic_Cache_8942.png',
    parentDir: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507\\Image\\Group',
    groupId: 201,
    groupName: '聊天图片 (Image/Pic)',
    accountId: '19982507',
    clientType: 'ClassicQQ',
    sizeBytes: 168 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'qq-init-208',
    name: 'MiscHead.db',
    path: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507\\MiscHead.db',
    parentDir: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507',
    groupId: 208,
    groupName: '头像缓存 (Head/MiscHead)',
    accountId: '19982507',
    clientType: 'ClassicQQ',
    sizeBytes: 64 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: false
  },
  {
    id: 'qq-init-999',
    name: 'Msg3.0.db',
    path: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507\\Msg3.0.db',
    parentDir: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507',
    groupId: 999,
    groupName: '核心聊天数据库 (受保护)',
    accountId: '19982507',
    clientType: 'ClassicQQ',
    sizeBytes: 120 * 1024 * 1024,
    mtime: 1710000000,
    isProtected: true
  }
]

function buildInitialQQCategories(): QQCleanCategoryItem[] {
  const sourceFiles = isRealElectronHost() ? [] : INIT_QQ_FILES
  return OFFICIAL_QQ_GROUP_RULES.map(rule => {
    const catFiles = sourceFiles.filter(f => f.groupId === rule.groupId)
    const totalSizeBytes = catFiles.reduce((s, f) => s + f.sizeBytes, 0)
    const cleanName = rule.name.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim()
    return {
      id: rule.id,
      groupId: rule.groupId,
      name: cleanName || rule.name,
      shortName: rule.shortName,
      color: rule.color,
      category: rule.category,
      riskLevel: rule.riskLevel,
      safetyLevel: rule.riskLevel,
      targetDir: catFiles[0]?.parentDir || 'C:\\Users\\Admin\\Documents\\Tencent Files',
      existsOnDisk: catFiles.length > 0,
      fileCount: catFiles.length,
      totalSizeBytes,
      checked: rule.defaultChecked && rule.groupId !== 999 && totalSizeBytes > 0,
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

export default function QQCleanerCommand() {
  const inRealHost = isRealElectronHost()
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<ViewTab>('categories')
  const [selectedAccount, setSelectedAccount] = useState<string>('ALL')
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>('all')
  const [selectedGroupId, setSelectedGroupId] = useState<number>(0)

  const [categories, setCategories] = useState<QQCleanCategoryItem[]>(() => buildInitialQQCategories())
  const [allFiles, setAllFiles] = useState<QQScannedFileEntry[]>(() =>
    inRealHost ? [] : INIT_QQ_FILES
  )
  const [accounts, setAccounts] = useState<string[]>(() => (inRealHost ? [] : ['19982507']))
  const [accountStats, setAccountStats] = useState<QQAccountStat[]>(() =>
    inRealHost
      ? []
      : [
          {
            accountId: '19982507',
            label: 'QQ 号 (UIN): 19982507',
            clientType: 'ClassicQQ / TIM',
            rootDir: 'C:\\Users\\Admin\\Documents\\Tencent Files\\19982507',
            fileCount: 3,
            totalBytes: 352 * 1024 * 1024
          }
        ]
  )
  const [protectedDbBytes, setProtectedDbBytes] = useState(inRealHost ? 0 : 120 * 1024 * 1024)
  const [diskFree, setDiskFree] = useState(inRealHost ? 0 : 64 * 1024 * 1024 * 1024)
  const [isLoading, setIsLoading] = useState(true)
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(2)

  const [checkedFilePaths, setCheckedFilePaths] = useState<string[]>(() =>
    inRealHost ? [] : INIT_QQ_FILES.filter(f => !f.isProtected).map(f => f.path)
  )

  async function refreshScan(showIndicator = false) {
    setWizardStep(1)
    if (showIndicator) {
      setIsLoading(true)
      showToast({
        style: Toast.Style.Animated,
        title: '正在深度扫描本机 QQ / NTQQ / TIM 存储目录...',
        message: '穿透扫描 Tencent Files 与 Roaming\\Tencent，严格锁定保护 Msg3.0.db'
      })
    }
    try {
      const snap = await fetchQQCleanSnapshot()
      if (isRealElectronHost() || snap.allFiles.length > 0) {
        setCategories(
          snap.categories.map(c => ({
            ...c,
            name: c.name.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').trim() || c.name
          }))
        )
        setAllFiles(snap.allFiles)
        setAccounts(snap.detectedAccounts)
        setAccountStats(snap.accountStats)
        setProtectedDbBytes(snap.protectedDbBytes)
        setDiskFree(snap.systemDiskFreeBytes)

        const defaultCheckedGroupIds = new Set(
          snap.categories.filter(c => c.checked && c.groupId !== 999).map(c => c.groupId)
        )
        const initialCheckedFiles = snap.allFiles
          .filter(f => !f.isProtected && defaultCheckedGroupIds.has(f.groupId))
          .map(f => f.path)
        setCheckedFilePaths(initialCheckedFiles)
      }
      setWizardStep(2)

      if (showIndicator) {
        showToast({
          style: Toast.Style.Success,
          title: 'QQ / TIM 专项扫描完成',
          message: `识别 ${snap.detectedAccounts.length} 个 QQ 号，可清理缓存 ${formatBytes(snap.totalScannableBytes)}`
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
  function matchesTimeFilter(mtime: number): boolean {
    if (timeRange === 'all' || !mtime) return true
    const ageDays = (nowSec - (mtime > 1e12 ? mtime / 1000 : mtime)) / 86400
    if (timeRange === '7d') return ageDays >= 7
    if (timeRange === '30d') return ageDays >= 30
    if (timeRange === '180d') return ageDays >= 180
    return true
  }

  function matchesAccountFilter(accountId: string): boolean {
    if (selectedAccount === 'ALL') return true
    return accountId === selectedAccount
  }

  const q = searchText.trim().toLowerCase()
  const filteredFiles = allFiles
    .filter(f => {
      if (!matchesAccountFilter(f.accountId)) return false
      if (!matchesTimeFilter(f.mtime)) return false
      if (selectedGroupId !== 0 && f.groupId !== selectedGroupId) return false
      if (!q) return true
      return (
        f.name.toLowerCase().includes(q) ||
        f.path.toLowerCase().includes(q) ||
        f.groupName.toLowerCase().includes(q) ||
        f.accountId.toLowerCase().includes(q)
      )
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  const checkedSet = new Set(checkedFilePaths)
  const selectableFiltered = filteredFiles.filter(f => !f.isProtected && f.groupId !== 999)
  const allFilteredChecked =
    selectableFiltered.length > 0 && selectableFiltered.every(f => checkedSet.has(f.path))
  const someFilteredChecked =
    selectableFiltered.some(f => checkedSet.has(f.path)) && !allFilteredChecked

  function getCategoryCheckState(cat: QQCleanCategoryItem): boolean | 'indeterminate' {
    if (cat.groupId === 999) return false
    const catFiles = cat.files.filter(f => !f.isProtected)
    if (catFiles.length === 0) return cat.checked
    let count = 0
    for (const f of catFiles) {
      if (checkedSet.has(f.path)) count++
    }
    if (count === 0) return false
    if (count === catFiles.length) return true
    return 'indeterminate'
  }

  function toggleSingleFileCheck(file: QQScannedFileEntry, nextChecked?: boolean) {
    if (file.isProtected || file.groupId === 999) {
      showToast({
        style: Toast.Style.Failure,
        title: '核心聊天数据库严禁勾选',
        message: FORBIDDEN_REASON
      })
      return
    }
    setCheckedFilePaths(prev => {
      const next = new Set(prev)
      const target = typeof nextChecked === 'boolean' ? nextChecked : !next.has(file.path)
      if (target) next.add(file.path)
      else next.delete(file.path)
      return Array.from(next)
    })
    setWizardStep(3)
  }

  function toggleAllFilteredCheck() {
    if (selectableFiltered.length === 0) return
    setCheckedFilePaths(prev => {
      const next = new Set(prev)
      if (allFilteredChecked) {
        for (const f of selectableFiltered) next.delete(f.path)
      } else {
        for (const f of selectableFiltered) next.add(f.path)
      }
      return Array.from(next)
    })
    setWizardStep(3)
  }

  const totalScannable = categories
    .filter(c => c.groupId !== 999)
    .reduce((s, c) => s + c.totalSizeBytes, 0)

  const checkedCategoryBytes = categories
    .filter(c => c.groupId !== 999 && getCategoryCheckState(c) !== false)
    .reduce((s, c) => {
      const state = getCategoryCheckState(c)
      if (state === true) return s + c.totalSizeBytes
      const selectedInCat = c.files
        .filter(f => checkedSet.has(f.path))
        .reduce((acc, f) => acc + f.sizeBytes, 0)
      return s + selectedInCat
    }, 0)

  async function handleCleanChecked() {
    const activeCats = categories.filter(
      c => c.groupId !== 999 && getCategoryCheckState(c) !== false && c.totalSizeBytes > 0
    )
    if (activeCats.length === 0 && checkedFilePaths.length === 0) {
      showToast({
        style: Toast.Style.Failure,
        title: '当前未勾选任何可清理项',
        message: '请先勾选专项分类或具体缓存文件'
      })
      return
    }

    const confirmed = await confirmAlert({
      title: '确认执行 QQ / TIM 专项安全清理？',
      message: `即将把已选中的 ${activeCats.length} 个专项分类（共 ${checkedFilePaths.length} 个采样文件，涉及分类总体积 ${formatBytes(
        checkedCategoryBytes
      )}）安全移入 Windows 回收站。\n\n铁律承诺：${FORBIDDEN_REASON}`,
      primaryAction: { title: '安全移入回收站', style: 'destructive' }
    })
    if (!confirmed) return

    setWizardStep(4)
    const res = await executeQQCleanup(categories, undefined, checkedFilePaths)
    showToast({
      style: Toast.Style.Success,
      title: 'QQ / TIM 专项清理完成',
      message: `已将 ${res.deletedCount} 个文件移入回收站，释放 ${formatBytes(res.freedBytes)}`
    })
    await refreshScan(false)
  }

  const scannableWithData = categories.filter(c => c.groupId !== 999 && c.totalSizeBytes > 0)
  const distributionSegments = scannableWithData.map(c => ({
    id: `qq-seg-${c.groupId}`,
    label: c.shortName,
    valueBytes: c.totalSizeBytes,
    formattedValue: formatBytes(c.totalSizeBytes),
    percent:
      totalScannable > 0
        ? Math.max(1, Math.round((c.totalSizeBytes / totalScannable) * 100))
        : 0,
    color: c.color,
    count: c.fileCount,
    active: selectedGroupId === c.groupId
  }))

  const maxFileBytes = Math.max(1, filteredFiles[0]?.sizeBytes || 1)
  const rightSubListItems = filteredFiles.slice(0, 60).map(file => {
    const isProtected = file.isProtected || file.groupId === 999
    const isChecked = !isProtected && checkedSet.has(file.path)
    const volRatio = Math.max(10, Math.min(100, Math.round((file.sizeBytes / maxFileBytes) * 100)))

    return List.Item({
      id: file.id,
      title: file.name,
      subtitle: isProtected
        ? `${file.accountId} · QQ核心聊天记录数据库保护锁定 · ${file.parentDir}`
        : `${file.accountId} · ${formatDateTime(file.mtime)} · ${file.parentDir}`,
      checkable: !isProtected,
      checked: isChecked,
      lockedReason: isProtected ? 'QQ核心聊天记录数据库保护锁定' : undefined,
      onCheckChange: (next: boolean) => toggleSingleFileCheck(file, next),
      onToggleCheck: (next: boolean) => toggleSingleFileCheck(file, next),
      icon: {
        source: isProtected ? Icon.Lock : Icon.Document
      },
      accessories: [
        { progress: { value: volRatio } },
        { tag: { value: isProtected ? '聊天库锁定' : file.groupName } },
        { text: formatBytes(file.sizeBytes) }
      ],
      detail: List.Item.Detail({
        markdown: `# ${file.name}\n\n- **完整物理路径**: \`${file.path}\`\n- **所属专项分组**: \`Group #${file.groupId} (${file.groupName})\`\n- **所属 QQ 号 (UIN)**: \`${file.accountId}\`\n- **实测文件大小**: **${formatBytes(file.sizeBytes)}**\n- **最后修改日期**: \`${formatDateTime(file.mtime)}\`\n`
      }),
      actions: ActionPanel({
        title: file.name,
        children: [
          Action({
            title: `清理已勾选 QQ 缓存 (${formatBytes(checkedCategoryBytes)})`,
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            onAction: () => handleCleanChecked()
          }),
          Action({
            title: '在资源管理器定位',
            icon: Icon.Folder,
            onAction: () => {
              openQQDirectory(file.path)
            }
          }),
          ...(!isProtected
            ? [
                Action({
                  title: isChecked ? '取消勾选此文件' : '勾选此文件',
                  icon: Icon.Checkmark,
                  onAction: () => toggleSingleFileCheck(file, !isChecked)
                })
              ]
            : []),
          Action({
            title: '使用默认程序打开文件',
            icon: Icon.Window,
            onAction: () => {
              openQQFileDefault(file.path)
            }
          }),
          Action.CopyToClipboard({
            title: '复制文件完整路径',
            content: file.path
          })
        ]
      })
    } as any)
  })

  const activeCategory = categories.find(c => c.groupId === selectedGroupId)
  const rightTitle = activeCategory
    ? `${activeCategory.name} 文件明细 (按体积降序，直接勾选或按 ↵ 执行)`
    : '全部 QQ / TIM 专项缓存与保护库明细 (按体积降序，直接勾选或按 ↵ 执行)'

  return List({
    searchBarPlaceholder: '搜索 QQ / TIM 12大专项分类、QQ号(UIN)、.tlg日志或文件路径...',
    onSearchTextChange: (val: string) => {
      setSearchText(val)
    },
    isShowingDetail: false,
    isLoading,
    searchBarAccessory: List.Dropdown({
      tooltip: '切换 QQ 账号 (UIN)',
      value: selectedAccount,
      onChange: val => setSelectedAccount(val),
      children: [
        List.Dropdown.Item({
          title: `全部 QQ 账号 (${allFiles.length})`,
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
      summaryText: `QQ账号 [${selectedAccount === 'ALL' ? '全部UIN' : selectedAccount}] · 可清理 ${formatBytes(totalScannable)} · 已勾选 ${checkedFilePaths.length} 项 (${formatBytes(checkedCategoryBytes)}) · 聊天库已保护 ${formatBytes(protectedDbBytes)}`,
      actions: [
        {
          id: 'qq-act-rescan',
          label: '重新扫描',
          title: '重新扫描',
          style: 'secondary',
          onAction: () => refreshScan(true)
        }
      ]
    },
    subList: {
      title: rightTitle,
      subtitle: `${filteredFiles.length} 项 · 已选 ${checkedFilePaths.length} 项 (${formatBytes(checkedCategoryBytes)})`,
      checkable: selectableFiltered.length > 0,
      checked: allFilteredChecked ? true : someFilteredChecked ? 'indeterminate' : false,
      onCheckChange: () => toggleAllFilteredCheck(),
      emptyText: '当前选中的 QQ 账号与专项分组下暂无匹配文件',
      items: rightSubListItems
    },
    children: [
      List.Section({
        title: 'QQ 存储汇总',
        children: [
          List.Item({
            id: 'qq-nav-all',
            title: '全部 QQ 文件汇总',
            subtitle: `${allFiles.length} 项 · 可清理 ${formatBytes(totalScannable)}`,
            icon: { source: Icon.HardDrive },
            accessories: [{ text: formatBytes(totalScannable) }],
            onSelect: () => {
              setSelectedGroupId(0)
              setTab('categories')
            }
          })
        ]
      }),
      List.Section({
        title: '12 大官方 QQCleanGroup + 保护区',
        children: categories.map(cat => {
          const isProtected = cat.groupId === 999
          return List.Item({
            id: `qq-nav-group-${cat.groupId}`,
            title: cat.shortName,
            subtitle: isProtected
              ? 'Msg3.0.db / nt_msg.db (安全锁定)'
              : `Group #${cat.groupId} · ${cat.fileCount} 项`,
            icon: { source: isProtected ? Icon.Lock : Icon.Folder },
            accessories: [{ text: formatBytes(cat.totalSizeBytes) }],
            onSelect: () => {
              setSelectedGroupId(cat.groupId)
              setTab('files')
            }
          })
        })
      })
    ]
  })
}
