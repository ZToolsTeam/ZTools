/**
 * ZTools 2.0 标杆原生插件视图: 军工级文件粉碎机 (Shredder 2.0 - 布局二：左 32% 分类树 + 右 68% 可勾选粉碎列表)
 * - 初始列表为空 []，不扫描任何本机目录
 * - 新导入的文件默认不勾选（防止误粉碎）
 */

import { Action, ActionPanel, Icon, List, Toast, confirmAlert, showToast, useRef, useState } from '../../index.js'
import { buildImportEmptyActionPanel, buildListManagementSection, useExampleImportQueue } from '../shared/import-ui.js'
import {
  SHREDDER_IMPORT_RULES,
  SHRED_CATEGORIES,
  SHRED_STANDARDS,
  executeSecureShred,
  formatBytes,
  openShredCandidateLocation,
  toShredCandidateItem,
  type ShredCandidateItem,
  type ShredCategory,
  type ShredStandardId
} from './logic.js'

export function ShredderCommand() {
  const [selectedCategory, setSelectedCategory] = useState<ShredCategory>('all')
  const [standardId, setStandardId] = useState<ShredStandardId>('dod_3pass')
  const [searchText, setSearchText] = useState<string>('')
  const [statusBanner, setStatusBanner] = useState<string>('')
  const [isRunning, setIsRunning] = useState<boolean>(false)
  const runningRef = useRef(false)

  const queue = useExampleImportQueue<ShredCandidateItem>({
    rules: SHREDDER_IMPORT_RULES,
    toItem: (file, idx) => toShredCandidateItem(file, idx),
    pathOf: item => item.path,
    idOf: item => item.id,
    fileTitle: '选择要粉碎的文件',
    folderTitle: '选择包含待粉碎文件的文件夹',
    filterName: '所有文件',
    // 安全铁律：粉碎机新导入的文件默认不勾选，必须由用户主动确认勾选
    defaultChecked: false,
    isBusy: () => runningRef.current,
    dropTitle: '拖入待粉碎的文件或文件夹',
    dropSubtitle: '新导入文件默认不勾选，需手动勾选后执行粉碎',
    onCleared: () => setStatusBanner('')
  })

  const currentStandard = SHRED_STANDARDS.find(s => s.id === standardId) || SHRED_STANDARDS[0]

  const keyword = searchText.trim().toLowerCase()
  const visibleItems = queue.items.filter(item => {
    if (selectedCategory !== 'all' && item.category !== selectedCategory) return false
    if (keyword) {
      const hay = `${item.name} ${item.path} ${item.categoryName}`.toLowerCase()
      if (!hay.includes(keyword)) return false
    }
    return true
  })

  const checkedSet = new Set(queue.checkedIds)
  const selectedSafeItems = queue.items.filter(item => !item.isSystemLocked && checkedSet.has(item.id))
  const selectedBytes = selectedSafeItems.reduce((acc, item) => acc + item.sizeBytes, 0)
  const totalShreddableBytes = queue.items.filter(c => !c.isSystemLocked).reduce((acc, c) => acc + c.sizeBytes, 0)

  const checkableVisible = visibleItems.filter(i => !i.isSystemLocked)
  const allChecked = checkableVisible.length > 0 && checkableVisible.every(i => checkedSet.has(i.id))
  const someChecked = checkableVisible.some(i => checkedSet.has(i.id))

  const handleBatchShred = async () => {
    if (selectedSafeItems.length === 0) {
      await showToast({ style: Toast.Style.Failure, title: '请先勾选待粉碎的文件' })
      return
    }
    const confirmed = await confirmAlert({
      title: `确认不可逆粉碎 ${selectedSafeItems.length} 个文件？`,
      message: `标准: ${currentStandard.name} · 总计 ${formatBytes(selectedBytes)}，粉碎后无法通过回收站恢复`,
      primaryAction: { title: '彻底粉碎', style: 'destructive' }
    })
    if (!confirmed) return

    runningRef.current = true
    setIsRunning(true)
    try {
      const res = await executeSecureShred(selectedSafeItems, standardId)
      setStatusBanner(res.message)
      if (res.ok) {
        const doneSet = new Set(selectedSafeItems.map(i => i.id))
        queue.setItems(prev => prev.filter(i => !doneSet.has(i.id)))
        queue.setCheckedIds(prev => prev.filter(id => !doneSet.has(id)))
        await showToast({ style: Toast.Style.Success, title: '文件粉碎完成', message: res.message })
      } else {
        await showToast({ style: Toast.Style.Failure, title: '文件粉碎失败', message: res.message })
      }
    } finally {
      runningRef.current = false
      setIsRunning(false)
    }
  }

  const maxItemBytes = Math.max(1, ...visibleItems.map(i => i.sizeBytes))
  const summaryText = queue.importStatusText
    ? queue.importStatusText
    : queue.items.length === 0
      ? '尚未添加文件 · 可选择文件、文件夹，或直接拖入（导入后默认不勾选）'
      : statusBanner ||
        `算法: ${currentStandard.name} · 已勾选 ${selectedSafeItems.length}/${queue.items.length} 项 (${formatBytes(selectedBytes)}) · 清空列表 Ctrl+Shift+Backspace`

  const leftNavNodes = [
    List.Item({
      id: 'nav-shred-all',
      title: '全部待粉碎文件',
      subtitle: `共 ${queue.items.length} 项`,
      icon: Icon.Trash,
      onSelect: () => setSelectedCategory('all'),
      accessories: [
        { progress: queue.items.length > 0 ? 1 : 0 },
        { tag: { value: `${queue.items.length} 项` } },
        { text: formatBytes(totalShreddableBytes) }
      ],
      actions: ActionPanel({
        children: [
          Action({ title: `彻底粉碎已选文件 [${currentStandard.badge}]`, icon: Icon.Trash, style: Action.Style.Destructive, onAction: handleBatchShred }),
          buildListManagementSection({
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(checkableVisible),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    }),
    ...SHRED_CATEGORIES.map(cat => {
      const catItems = queue.items.filter(i => i.category === cat.id)
      const catBytes = catItems.reduce((s, i) => s + i.sizeBytes, 0)
      const ratio = totalShreddableBytes > 0 ? Math.min(1, catBytes / totalShreddableBytes) : 0
      return List.Item({
        id: `nav-shred-${cat.id}`,
        title: cat.name,
        subtitle: cat.subtitle,
        icon: Icon.Folder,
        onSelect: () => setSelectedCategory(cat.id),
        accessories: [{ progress: ratio }, { tag: { value: `${catItems.length} 项` } }, { text: formatBytes(catBytes) }],
        actions: ActionPanel({
          children: [
            Action({ title: `查看「${cat.name}」明细`, icon: Icon.Filter, onAction: () => setSelectedCategory(cat.id) }),
            Action({
              title: `粉碎已勾选文件 (${selectedSafeItems.length} 项)`,
              icon: Icon.Trash,
              style: Action.Style.Destructive,
              shortcut: { modifiers: ['ctrl'], key: 'return' },
              onAction: handleBatchShred
            }),
            buildListManagementSection({
              onPickFiles: queue.handlePickFiles,
              onPickFolder: queue.handlePickFolder,
              onClear: queue.clearQueue
            })
          ]
        })
      })
    })
  ]

  const subListItems = visibleItems.map(item => {
    const isChecked = !item.isSystemLocked && checkedSet.has(item.id)
    const ratio = item.sizeBytes > 0 ? Math.min(1, item.sizeBytes / maxItemBytes) : 0
    return List.Item({
      id: `shred-item-${item.id}`,
      title: item.name,
      subtitle: item.isSystemLocked ? `${item.path} · ${item.lockedReason}` : `${item.path} · 预设 ${currentStandard.passes} 轮扇区覆写`,
      icon: item.isSystemLocked ? Icon.Lock : Icon.Document,
      checkable: !item.isSystemLocked,
      checked: isChecked,
      onCheckChange: checked => {
        if (!item.isSystemLocked) queue.toggleCheck(item.id, checked)
      },
      onToggleCheck: checked => {
        if (!item.isSystemLocked) queue.toggleCheck(item.id, checked)
      },
      accessories: [
        { progress: ratio },
        { tag: { value: item.isSystemLocked ? '系统保护' : currentStandard.badge } },
        { text: item.sizeBytes > 0 ? formatBytes(item.sizeBytes) : '大小未识别' }
      ],
      actions: ActionPanel({
        children: [
          Action({
            title: `彻底粉碎已勾选文件 (${selectedSafeItems.length} 项 / ${formatBytes(selectedBytes)})`,
            icon: Icon.Trash,
            style: Action.Style.Destructive,
            onAction: handleBatchShred
          }),
          Action({
            title: '在资源管理器中定位此文件',
            icon: Icon.Folder,
            shortcut: { modifiers: ['ctrl'], key: 'return' },
            onAction: () => { void openShredCandidateLocation(item.path) }
          }),
          ...(!item.isSystemLocked
            ? [
                Action({
                  title: isChecked ? '取消勾选此文件' : '勾选此文件待粉碎',
                  icon: Icon.CheckCircle,
                  onAction: () => queue.toggleCheck(item.id)
                })
              ]
            : []),
          buildListManagementSection({
            canRemove: !isRunning,
            onRemove: () => queue.removeItem(item.id),
            onPickFiles: queue.handlePickFiles,
            onPickFolder: queue.handlePickFolder,
            onToggleAll: () => queue.toggleAllVisible(checkableVisible),
            allSelected: allChecked,
            onClear: queue.clearQueue
          })
        ]
      })
    })
  })

  return List({
    ...queue.fileInputProps,
    isLoading: isRunning || queue.isImporting,
    searchBarPlaceholder: '搜索待粉碎文件名或路径...',
    onSearchTextChange: setSearchText,
    isShowingDetail: false,
    searchBarAccessory: List.Dropdown({
      tooltip: '选择国际安全扇区覆写标准',
      value: standardId,
      onChange: val => setStandardId(val as ShredStandardId),
      children: SHRED_STANDARDS.map(std => List.Dropdown.Item({ title: std.name, value: std.id }))
    }),
    filterBar: { summaryText, actions: queue.topBarActions },
    actions: buildImportEmptyActionPanel(queue.handlePickFiles, queue.handlePickFolder),
    subList: {
      title: `待粉碎文件明细队列 (${visibleItems.length} 项 · 已选 ${formatBytes(selectedBytes)})`,
      subtitle: currentStandard.name,
      emptyText: '尚未添加待粉碎文件，按 Ctrl+O 选择文件或 Ctrl+Shift+O 选择文件夹',
      checkable: checkableVisible.length > 0,
      checked: allChecked ? true : someChecked ? 'indeterminate' : false,
      onCheckChange: () => queue.toggleAllVisible(checkableVisible),
      items: subListItems
    },
    children: [
      List.Section({
        title: '文件分类导航树 (32%)',
        subtitle: '导入后需手动勾选确认粉碎',
        children: leftNavNodes
      })
    ]
  })
}

export default ShredderCommand
