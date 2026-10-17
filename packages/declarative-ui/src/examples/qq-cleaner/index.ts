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
  openQQFileDefault
} from './logic.js'

type TimeRangeFilter = 'all' | '7d' | '30d' | '180d'
type ViewTab = 'categories' | 'files' | 'accounts'

export default function QQCleanerCommand() {
  const [searchText, setSearchText] = useState('')
  const [tab, setTab] = useState<ViewTab>('categories')
  const [selectedAccount, setSelectedAccount] = useState<string>('ALL')
  const [timeRange, setTimeRange] = useState<TimeRangeFilter>('all')
  const [selectedGroupId, setSelectedGroupId] = useState<number>(0)
  const [filePage, setFilePage] = useState<number>(1)

  const [categories, setCategories] = useState<QQCleanCategoryItem[]>([])
  const [allFiles, setAllFiles] = useState<QQScannedFileEntry[]>([])
  const [accounts, setAccounts] = useState<string[]>([])
  const [accountStats, setAccountStats] = useState<QQAccountStat[]>([])
  const [baseDirs, setBaseDirs] = useState<string[]>([])
  const [protectedDbBytes, setProtectedDbBytes] = useState(0)
  const [diskFree, setDiskFree] = useState(0)
  const [diskTotal, setDiskTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4>(2)

  // 文件级勾选集合
  const [checkedFilePaths, setCheckedFilePaths] = useState<string[]>([])

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
      setCategories(snap.categories)
      setAllFiles(snap.allFiles)
      setAccounts(snap.detectedAccounts)
      setAccountStats(snap.accountStats)
      setBaseDirs(snap.baseDirectories)
      setProtectedDbBytes(snap.protectedDbBytes)
      setDiskFree(snap.systemDiskFreeBytes)
      setDiskTotal(snap.systemDiskTotalBytes)

      // 默认勾选安全推荐分类下的所有非保护文件
      const defaultCheckedGroupIds = new Set(
        snap.categories.filter(c => c.checked && c.groupId !== 999).map(c => c.groupId)
      )
      const initialCheckedFiles = snap.allFiles
        .filter(f => !f.isProtected && defaultCheckedGroupIds.has(f.groupId))
        .map(f => f.path)
      setCheckedFilePaths(initialCheckedFiles)
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

  // 根据时间筛选 (minModifiedDate: 0=all, 1=7d, 2=30d, 3=180d) 判断文件是否匹配
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
  const filteredFiles = allFiles.filter(f => {
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

  const checkedSet = new Set(checkedFilePaths)

  // 三态勾选计算：分类级 (Group 201~213)
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

  function toggleCategoryCheck(cat: QQCleanCategoryItem, nextChecked?: boolean) {
    if (cat.groupId === 999) {
      showToast({
        style: Toast.Style.Failure,
        title: '核心聊天记录库受保护',
        message: FORBIDDEN_REASON
      })
      return
    }
    const currentState = getCategoryCheckState(cat)
    const target = typeof nextChecked === 'boolean' ? nextChecked : currentState !== true

    setCategories(prev =>
      prev.map(c => (c.id === cat.id ? { ...c, checked: target } : c))
    )
    const catPaths = new Set(cat.files.filter(f => !f.isProtected).map(f => f.path))
    setCheckedFilePaths(prev => {
      const next = new Set(prev)
      for (const p of catPaths) {
        if (target) next.add(p)
        else next.delete(p)
      }
      return Array.from(next)
    })
    setWizardStep(3)
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

  function selectAllRecommended() {
    const recGroups = new Set<QQGroupId>([201, 202, 203, 205, 206, 207, 208, 209, 211])
    setCategories(prev =>
      prev.map(c => ({
        ...c,
        checked: recGroups.has(c.groupId) && c.totalSizeBytes > 0
      }))
    )
    const nextPaths = allFiles
      .filter(f => !f.isProtected && recGroups.has(f.groupId))
      .map(f => f.path)
    setCheckedFilePaths(nextPaths)
    setWizardStep(3)
    showToast({
      style: Toast.Style.Success,
      title: '已勾选全部安全与推荐清理项',
      message: '聊天接收文件、收藏表情与核心聊天数据库保持安全锁定未选'
    })
  }

  function deselectAll() {
    setCategories(prev => prev.map(c => ({ ...c, checked: false })))
    setCheckedFilePaths([])
  }

  // 计算当前已选总容量
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
      )}）安全移入 Windows 回收站。\n\n🛡️ 铁律承诺：${FORBIDDEN_REASON}`,
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

  function renderCategoryDetailMarkdown(item: QQCleanCategoryItem): string {
    const checkState = getCategoryCheckState(item)
    const stateLabel =
      item.groupId === 999
        ? '🔒 硬件级防误删锁定 (严禁清理)'
        : checkState === true
        ? '☑️ 已全选纳入清理'
        : checkState === 'indeterminate'
        ? '▣ 部分文件已勾选'
        : '⬜ 未勾选'

    const samplesMd =
      item.sampleFiles.length > 0
        ? item.sampleFiles
            .slice(0, 10)
            .map(
              (s, idx) =>
                `${idx + 1}. \`${s.path.split(/[\\/]/).pop() || s.path}\` — **${formatBytes(s.sizeBytes)}** · \`${
                  s.accountId || '公共组件'
                }\` · _${formatDateTime(s.mtime || 0)}_`
            )
            .join('\n')
        : '_当前本机该分组下暂无冗余文件_'

    return `# ${item.name}

**官方规则分组 ID**: \`Group #${item.groupId}\` · **安全等级**: \`${
      item.riskLevel === 'safe'
        ? '🟢 100% 安全可清理'
        : item.riskLevel === 'recommended'
        ? '🔵 推荐清理 (按需自动重下)'
        : item.riskLevel === 'caution'
        ? '🟠 谨慎确认 (接收文件/收藏表情/登录态)'
        : '🔒 核心聊天记录数据库 (禁止清理)'
    }\`  
**本机真实路径**: \`${item.targetDir}\`  
**勾选状态**: **${stateLabel}**

---

### 📊 本机实测容量画像
- **真实扫描文件数**: \`${item.fileCount.toLocaleString()} 个文件\`
- **真实磁盘占用量**: **${formatBytes(item.totalSizeBytes)}** (${
      totalScannable > 0 && item.groupId !== 999
        ? `${Math.max(1, Math.round((item.totalSizeBytes / totalScannable) * 100))}%`
        : '受保护'
    })
- **规则说明**: ${item.description}

### 📄 本机实测 Top 大文件清单 (按体积降序)
${samplesMd}

---

> [!IMPORTANT]
> **聊天记录加密库防误删锁**：${FORBIDDEN_REASON}
`
  }

  // 1. 顶部 12 大官方分组彩色分段占比条 (DistributionBar)
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

  const PAGE_SIZE = 30
  const maxPage = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE))
  const safePage = Math.min(filePage, maxPage)
  const pagedFiles = filteredFiles.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // 构建章节列表
  const sections: any[] = []

  if (tab === 'categories') {
    const visibleCategories = categories.filter(c => {
      if (selectedGroupId !== 0 && c.groupId !== selectedGroupId) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.shortName.toLowerCase().includes(q) ||
        c.targetDir.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      )
    })

    sections.push(
      List.Section({
        title: `🐧 QQ / NTQQ / TIM 12 大官方专项分组 + 聊天记录保护区 (${visibleCategories.length})`,
        subtitle: `本机识别 ${accounts.length} 个登录 QQ 号 (${accounts.join(', ') || '默认'}) · 已选 ${formatBytes(
          checkedCategoryBytes
        )}`,
        children: visibleCategories.map(item => {
          const checkState = getCategoryCheckState(item)
          const isProtected = item.groupId === 999
          return List.Item({
            id: item.id,
            title: item.name,
            subtitle: `${item.targetDir}`,
            checkable: !isProtected,
            checked: checkState,
            onCheckChange: (next: boolean) => toggleCategoryCheck(item, next),
            icon: {
              source: isProtected
                ? Icon.Lock
                : item.existsOnDisk
                ? Icon.CheckCircle
                : Icon.Circle,
              tintColor: isProtected
                ? Color.Orange
                : checkState === true
                ? Color.Green
                : checkState === 'indeterminate'
                ? Color.Blue
                : Color.SecondaryText
            },
            accessories: [
              {
                tag: {
                  value: isProtected
                    ? '🔒 保护锁定'
                    : item.riskLevel === 'safe'
                    ? '安全清理'
                    : item.riskLevel === 'recommended'
                    ? '推荐清理'
                    : '谨慎确认',
                  color: isProtected
                    ? Color.Orange
                    : item.riskLevel === 'safe'
                    ? Color.Green
                    : item.riskLevel === 'recommended'
                    ? Color.Blue
                    : Color.Yellow
                }
              },
              {
                tag: {
                  value: `${item.fileCount} 项`,
                  color: item.existsOnDisk ? Color.Purple : Color.SecondaryText
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
                ...(!isProtected
                  ? [
                      Action({
                        title: checkState === true ? '取消勾选此专项' : '勾选此专项纳入清理',
                        icon: Icon.CheckCircle,
                        onAction: () => toggleCategoryCheck(item)
                      })
                    ]
                  : []),
                Action({
                  title: '下钻查看该专项内全部真实文件',
                  icon: Icon.List,
                  onAction: () => {
                    setSelectedGroupId(item.groupId)
                    setTab('files')
                    setFilePage(1)
                  }
                }),
                Action({
                  title: `立即清理已选缓存 (${formatBytes(checkedCategoryBytes)})`,
                  icon: Icon.Trash,
                  style: Action.Style.Destructive,
                  onAction: () => handleCleanChecked()
                }),
                Action({
                  title: '在资源管理器中打开目录',
                  icon: Icon.Folder,
                  onAction: () => {
                    openQQDirectory(item.targetDir)
                  }
                }),
                Action({
                  title: '重新深度扫描 QQ 存储',
                  icon: Icon.ArrowClockwise,
                  onAction: () => refreshScan(true)
                }),
                Action({
                  title: '复制真实目录路径',
                  icon: Icon.Clipboard,
                  onAction: async () => {
                    await Clipboard.copy(item.targetDir)
                    showToast({ style: Toast.Style.Success, title: '路径已复制', message: item.targetDir })
                  }
                })
              ]
            })
          })
        })
      })
    )
  } else if (tab === 'files') {
    const activeGroup = categories.find(c => c.groupId === selectedGroupId)
    const sectionCheckState: boolean | 'indeterminate' = (() => {
      const selectable = pagedFiles.filter(f => !f.isProtected)
      if (selectable.length === 0) return false
      let c = 0
      for (const f of selectable) {
        if (checkedSet.has(f.path)) c++
      }
      if (c === 0) return false
      if (c === selectable.length) return true
      return 'indeterminate'
    })()

    sections.push(
      List.Section({
        title: `${activeGroup ? activeGroup.name : '📄 全部 QQ / TIM 真实文件明细'} (第 ${safePage}/${maxPage} 页 · 共 ${
          filteredFiles.length
        } 项)`,
        subtitle: `账号: ${selectedAccount === 'ALL' ? '全部 QQ 号' : selectedAccount} · 时间: ${
          timeRange === 'all'
            ? '全部时间'
            : timeRange === '7d'
            ? '7天前'
            : timeRange === '30d'
            ? '30天前'
            : '180天前'
        }`,
        checkable: true,
        checked: sectionCheckState,
        onCheckChange: (next: boolean) => {
          const selectablePaths = pagedFiles.filter(f => !f.isProtected).map(f => f.path)
          setCheckedFilePaths(prev => {
            const set = new Set(prev)
            for (const p of selectablePaths) {
              if (next) set.add(p)
              else set.delete(p)
            }
            return Array.from(set)
          })
        },
        children: pagedFiles.map(file => {
          const isChecked = checkedSet.has(file.path)
          return List.Item({
            id: file.id,
            title: file.name,
            subtitle: file.parentDir,
            checkable: !file.isProtected,
            checked: file.isProtected ? false : isChecked,
            onCheckChange: (next: boolean) => toggleSingleFileCheck(file, next),
            icon: {
              source: file.isProtected ? Icon.Lock : Icon.Document,
              tintColor: file.isProtected
                ? Color.Orange
                : isChecked
                ? Color.Green
                : Color.SecondaryText
            },
            accessories: [
              {
                tag: {
                  value: file.isProtected ? '🔒 聊天库锁定' : file.groupName,
                  color: file.isProtected ? Color.Orange : Color.Blue
                }
              },
              {
                tag: {
                  value: file.accountId,
                  color: Color.Purple
                }
              },
              { text: `${formatDateTime(file.mtime)} · ${formatBytes(file.sizeBytes)}` }
            ],
            detail: List.Item.Detail({
              markdown: `# 📄 ${file.name}

**完整物理路径**: \`${file.path}\`  
**所属专项分组**: \`Group #${file.groupId} (${file.groupName})\`  
**所属 QQ 号 (UIN)**: \`${file.accountId}\` (\`${file.clientType}\`)  
**实测文件大小**: **${formatBytes(file.sizeBytes)}** (${file.sizeBytes.toLocaleString()} Bytes)  
**最后修改日期**: \`${formatDateTime(file.mtime)}\`  
**安全状态**: \`${file.isProtected ? '🔒 核心聊天记录数据库 (禁止删除)' : isChecked ? '☑️ 已勾选待清理' : '⬜ 未勾选'}\`
`
            }),
            actions: ActionPanel({
              title: file.name,
              children: [
                ...(!file.isProtected
                  ? [
                      Action({
                        title: isChecked ? '取消勾选此文件' : '勾选此文件',
                        icon: Icon.CheckCircle,
                        onAction: () => toggleSingleFileCheck(file)
                      })
                    ]
                  : []),
                Action({
                  title: '在资源管理器中定位文件',
                  icon: Icon.Folder,
                  onAction: () => {
                    openQQDirectory(file.path)
                  }
                }),
                Action({
                  title: '使用默认程序打开文件',
                  icon: Icon.Window,
                  onAction: () => {
                    openQQFileDefault(file.path)
                  }
                }),
                ...(safePage < maxPage
                  ? [
                      Action({
                        title: `下一页 (${safePage + 1}/${maxPage})`,
                        icon: Icon.ArrowRight,
                        onAction: () => setFilePage(safePage + 1)
                      })
                    ]
                  : []),
                ...(safePage > 1
                  ? [
                      Action({
                        title: `上一页 (${safePage - 1}/${maxPage})`,
                        icon: Icon.ArrowLeft,
                        onAction: () => setFilePage(safePage - 1)
                      })
                    ]
                  : []),
                Action({
                  title: '返回 12 大专项分类总览',
                  icon: Icon.ArrowLeft,
                  onAction: () => {
                    setSelectedGroupId(0)
                    setTab('categories')
                  }
                })
              ]
            })
          })
        })
      })
    )
  } else {
    // 按 QQ 号 (UIN) 汇总视图
    sections.push(
      List.Section({
        title: `🐧 本机识别到的 QQ 账号 (UIN) 与公共存储目录 (${accountStats.length})`,
        subtitle: `扫描根目录: ${baseDirs.slice(0, 2).join(' · ')}`,
        children: accountStats.map(acc =>
          List.Item({
            id: `qq-acc-${acc.accountId}`,
            title: acc.label,
            subtitle: acc.rootDir,
            icon: {
              source: Icon.Person,
              tintColor: selectedAccount === acc.accountId ? Color.Green : Color.Blue
            },
            accessories: [
              {
                tag: {
                  value: acc.clientType,
                  color: Color.Purple
                }
              },
              {
                tag: {
                  value: `${acc.fileCount} 个文件`,
                  color: Color.Blue
                }
              },
              { text: formatBytes(acc.totalBytes) }
            ],
            detail: List.Item.Detail({
              markdown: `# ${acc.label}

**账号标识 (UIN)**: \`${acc.accountId}\`  
**客户端架构**: \`${acc.clientType}\`  
**主数据存储路径**: \`${acc.rootDir}\`  
**采样文件数量**: \`${acc.fileCount} 个\`  
**采样占用体积**: **${formatBytes(acc.totalBytes)}**

---

### 💡 操作提示
- 按 \`Enter\` 仅筛选查看该 QQ 号下的缓存与接收文件明细
- 按 \`Ctrl+K\` 可在资源管理器中直接打开该 QQ 号的本地数据目录
`
            }),
            actions: ActionPanel({
              title: acc.label,
              children: [
                Action({
                  title: `仅查看该账号 (${acc.accountId}) 的文件明细`,
                  icon: Icon.Filter,
                  onAction: () => {
                    setSelectedAccount(acc.accountId)
                    setTab('files')
                    setFilePage(1)
                  }
                }),
                Action({
                  title: '在资源管理器中打开账号目录',
                  icon: Icon.Folder,
                  onAction: () => {
                    openQQDirectory(acc.rootDir)
                  }
                }),
                Action({
                  title: '重置账号筛选 (查看全部账号)',
                  icon: Icon.ArrowCounterClockwise,
                  onAction: () => {
                    setSelectedAccount('ALL')
                  }
                })
              ]
            })
          })
        )
      })
    )
  }

  return List({
    searchBarPlaceholder: '搜索 QQ / TIM 12大专项分类、QQ号(UIN)、.tlg日志或文件路径...',
    onSearchTextChange: (val: string) => {
      setSearchText(val)
      setFilePage(1)
    },
    isShowingDetail: true,
    isLoading,
    metricGrid: MetricGrid({
      columns: 4,
      items: [
        {
          id: 'qq-total',
          label: '可清理 QQ/TIM 缓存',
          value: formatBytes(totalScannable),
          subValue: `${categories
            .filter(c => c.groupId !== 999)
            .reduce((s, c) => s + c.fileCount, 0)
            .toLocaleString()} 个真实文件`,
          status: 'normal'
        },
        {
          id: 'qq-checked',
          label: '已勾选待释放空间',
          value: formatBytes(checkedCategoryBytes),
          subValue: `${checkedFilePaths.length} 个采样项已选`,
          status: 'success'
        },
        {
          id: 'qq-accounts',
          label: '识别登录 QQ 号 (UIN)',
          value: `${accounts.length} 个账号`,
          subValue: accounts.length > 0 ? accounts.slice(0, 3).join(', ') : '默认 Tencent Files',
          status: 'normal'
        },
        {
          id: 'qq-protected-db',
          label: '聊天记录库保护 (Msg3.0)',
          value: formatBytes(protectedDbBytes),
          subValue: `🔒 硬件级防误删锁定 · C:余 ${formatBytes(diskFree)}`,
          status: 'warning'
        }
      ]
    }),
    distributionBar: {
      title: '📊 QQ / NTQQ / TIM 12 大官方专项空间分布 (点击图例可按专项过滤)',
      totalLabel: `可清理总计 ${formatBytes(totalScannable)} · 聊天记录库保护 ${formatBytes(protectedDbBytes)}`,
      segments: distributionSegments,
      onSegmentClick: segId => {
        const gid = Number(segId.replace('qq-seg-', ''))
        if (selectedGroupId === gid) {
          setSelectedGroupId(0)
        } else {
          setSelectedGroupId(gid)
        }
        setFilePage(1)
      }
    },
    filterBar: {
      wizardSteps: [
        { step: 1, label: '1. 识别 QQ/TIM 路径', status: 'done' },
        { step: 2, label: '2. 12大专项扫描', status: wizardStep >= 2 ? 'done' : 'active' },
        { step: 3, label: '3. 账号/时间/文件勾选', status: wizardStep === 3 ? 'active' : wizardStep > 3 ? 'done' : 'pending' },
        { step: 4, label: '4. 安全移入回收站', status: wizardStep === 4 ? 'active' : 'pending' }
      ],
      summaryText: `已选 ${formatBytes(checkedCategoryBytes)} (${checkedFilePaths.length} 个文件)`,
      groups: [
        {
          id: 'qq-account-filter',
          label: 'QQ号(UIN)',
          value: selectedAccount,
          onChange: val => {
            setSelectedAccount(val)
            setFilePage(1)
          },
          options: [
            { value: 'ALL', label: '全部账号', count: allFiles.length },
            ...accountStats.map(a => ({
              value: a.accountId,
              label: a.accountId === '公共组件 (Shared)' ? '公共组件' : a.accountId,
              count: a.fileCount
            }))
          ]
        },
        {
          id: 'qq-time-filter',
          label: '修改时间',
          value: timeRange,
          onChange: val => {
            setTimeRange(val as TimeRangeFilter)
            setFilePage(1)
          },
          options: [
            { value: 'all', label: '全部时间 (0)' },
            { value: '7d', label: '7天前 (1)' },
            { value: '30d', label: '30天前 (2)' },
            { value: '180d', label: '180天前 (3)' }
          ]
        },
        {
          id: 'qq-group-filter',
          label: '12大专项',
          value: String(selectedGroupId),
          onChange: val => {
            setSelectedGroupId(Number(val))
            setFilePage(1)
          },
          options: [
            { value: '0', label: '全部专项', count: categories.length },
            ...categories
              .filter(c => c.totalSizeBytes > 0)
              .map(c => ({
                value: String(c.groupId),
                label: c.shortName,
                count: c.fileCount
              }))
          ]
        }
      ],
      actions: [
        {
          id: 'qq-clean-now',
          label: `🧹 立即清理选中 (${formatBytes(checkedCategoryBytes)})`,
          style: 'danger',
          disabled: checkedCategoryBytes <= 0 && checkedFilePaths.length === 0,
          onAction: () => handleCleanChecked()
        },
        {
          id: 'qq-select-rec',
          label: '☑️ 全选推荐项',
          style: 'primary',
          onAction: () => selectAllRecommended()
        },
        {
          id: 'qq-deselect-all',
          label: '⬜ 取消全选',
          style: 'secondary',
          onAction: () => deselectAll()
        },
        {
          id: 'qq-rescan',
          label: '🔄 重新扫描',
          style: 'secondary',
          onAction: () => refreshScan(true)
        }
      ]
    },
    segmentedControl: SegmentedControl({
      value: tab,
      onChange: v => setTab(v as ViewTab),
      options: [
        { value: 'categories', label: '12 大专项总览', badge: categories.length },
        { value: 'files', label: '逐文件精细勾选', badge: filteredFiles.length },
        { value: 'accounts', label: '按 QQ 号 (UIN) 汇总', badge: accountStats.length }
      ]
    }),
    children: sections
  })
}
