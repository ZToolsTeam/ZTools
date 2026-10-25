import React, {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState,
  useNavigation
} from '../../index.js'
import {
  cleanInvalidPathEntries,
  exportEnvSnapshot,
  filterEnvItems,
  loadAllEnvVariables,
  writeEnvVariable
} from './env-service.js'
import type { EnvFilterCategory, EnvItem, EnvScope } from './types.js'

export * from './types.js'
export * from './env-service.js'

export function EnvVarForm({
  initialItem,
  onSaved
}: {
  initialItem?: EnvItem
  onSaved: (item: EnvItem) => void
}) {
  const { pop } = useNavigation()
  const [key, setKey] = useState(initialItem?.key ?? '')
  const [value, setValue] = useState(initialItem?.value ?? '')
  const [scope, setScope] = useState<EnvScope>(initialItem?.scope ?? 'user')

  const handleSubmit = async () => {
    if (!key.trim()) {
      await showToast({ style: Toast.Style.Failure, title: '变量名不能为空' })
      return
    }
    onSaved({
      key: key.trim(),
      value: value.trim(),
      scope,
      isPathItem: initialItem?.isPathItem ?? false,
      index: initialItem?.index,
      isInvalid: false
    })
    await showToast({ style: Toast.Style.Success, title: `已保存变量 ${key.trim()}` })
    pop()
  }

  return (
    <Form
      navigationTitle={initialItem ? '编辑环境变量' : '新建环境变量'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存环境变量" icon={Icon.CheckCircle} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="key" title="变量名" placeholder="如：JAVA_HOME" value={key} onChange={setKey} />
      <Form.TextField id="value" title="变量值" placeholder="如：C:\Program Files\Java\jdk-21" value={value} onChange={setValue} />
      <Form.Dropdown id="scope" title="作用域" value={scope} onChange={(v: string) => setScope(v as EnvScope)}>
        <Form.Dropdown.Item title="当前用户变量 (HKCU\Environment)" value="user" />
        <Form.Dropdown.Item title="全局系统变量 (HKLM)" value="system" />
      </Form.Dropdown>
    </Form>
  )
}

export interface EnvManagerCommandProps {
  featureCode?: string
  initialItems?: EnvItem[]
  hostOverride?: unknown
}

export function EnvManagerCommand(props: EnvManagerCommandProps = {}) {
  const { push } = useNavigation()
  const defaultCategory: EnvFilterCategory =
    props.featureCode === 'env-path-clean' ? 'path-invalid' : 'all'

  const [envItems, setEnvItems] = useState<EnvItem[]>(props.initialItems ?? [])
  const [filterCategory, setFilterCategory] = useState<EnvFilterCategory>(defaultCategory)
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(!props.initialItems)

  useEffect(() => {
    if (!props.initialItems) {
      void (async () => {
        setIsLoading(true)
        try {
          const loaded = await loadAllEnvVariables(undefined, props.hostOverride)
          setEnvItems(loaded)
        } finally {
          setIsLoading(false)
        }
      })()
    }
  }, [])

  const invalidCount = useMemo(
    () => envItems.filter((x) => x.isPathItem && x.isInvalid).length,
    [envItems]
  )

  const filteredItems = useMemo(
    () => filterEnvItems(envItems, searchText, filterCategory),
    [envItems, searchText, filterCategory]
  )

  const handleCleanInvalidPaths = async () => {
    const rawPath = envItems
      .filter((x) => x.isPathItem)
      .map((x) => x.value)
      .join(';')
    const res = await cleanInvalidPathEntries({ rawPath }, props.hostOverride)
    const removed = res.removedCount || envItems.filter((x) => x.isPathItem && x.isInvalid).length
    setEnvItems((prev) => prev.filter((x) => !(x.isPathItem && x.isInvalid)))
    await showToast({
      style: Toast.Style.Success,
      title: `已清理 ${removed} 个失效的 PATH 幽灵路径`
    })
  }

  const handleExportBackup = async () => {
    const json = exportEnvSnapshot(envItems)
    await Clipboard.copy(json)
    await showToast({
      style: Toast.Style.Success,
      title: '环境变量 JSON 备份快照已复制到剪贴板'
    })
  }

  const handleOpenCreateForm = () => {
    push(
      <EnvVarForm
        onSaved={async (item) => {
          const res = await writeEnvVariable(item.key, item.value, item.scope, undefined, props.hostOverride)
          if (!res.ok) {
            await showToast({
              style: Toast.Style.Failure,
              title: '写入环境变量失败',
              message: res.error
            })
            return
          }
          setEnvItems((prev) => [item, ...prev.filter((x) => x.key !== item.key || x.isPathItem)])
        }}
      />
    )
  }

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索变量名、路径关键词 (如: JAVA_HOME、npm、python) ..."
      searchBarAccessory={
        <List.Dropdown
          value={filterCategory}
          onChange={(v: string) => setFilterCategory(v as EnvFilterCategory)}
          tooltip="筛选变量分类"
        >
          <List.Dropdown.Item title="全部变量与 PATH 拆解" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="PATH 明细 (含失效标红)" value="path" icon={Icon.Folder} />
          <List.Dropdown.Item
            title="仅查看失效 PATH 幽灵路径"
            value="path-invalid"
            icon={Icon.ExclamationMark}
          />
          <List.Dropdown.Item title="用户变量 (User)" value="user" icon={Icon.Key} />
          <List.Dropdown.Item title="系统变量 (System)" value="system" icon={Icon.Desktop} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共 ${envItems.length} 个条目 · 发现 ${invalidCount} 个已失效的 PATH 幽灵路径`,
        actions: [
          { id: 'clean-invalid', title: '一键清理失效 PATH', onAction: handleCleanInvalidPaths },
          { id: 'backup-env', title: '导出备份快照', onAction: handleExportBackup }
        ]
      }}
    >
      {filteredItems.map((item, idx) => (
        <List.Item
          key={`${item.scope}:${item.key}:${item.index ?? idx}`}
          id={`${item.scope}:${item.key}:${item.index ?? idx}`}
          title={item.isPathItem ? item.value : item.key}
          subtitle={item.isPathItem ? `[PATH #${(item.index ?? idx) + 1}] ${item.key}` : item.value}
          icon={item.isInvalid ? Icon.XMarkCircle : item.isPathItem ? Icon.Folder : Icon.Gear}
          accessories={[
            item.isInvalid
              ? { tag: { value: '失效路径', color: Color.Red } }
              : { tag: item.scope === 'system' ? '系统变量' : '用户变量' },
            { text: item.isInvalid ? '磁盘上不存在' : '' }
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="复制变量值 / 路径"
                content={item.value}
                icon={Icon.Clipboard}
              />
              {invalidCount > 0 ? (
                <Action
                  title="一键移除所有失效 PATH 项"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ['ctrl', 'shift'], key: 'backspace' }}
                  onAction={handleCleanInvalidPaths}
                />
              ) : null}
              <Action
                title="新建环境变量"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                onAction={handleOpenCreateForm}
              />
              <Action
                title="导出全量环境变量备份快照"
                icon={Icon.Download}
                shortcut={{ modifiers: ['cmd'], key: 's' }}
                onAction={handleExportBackup}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default EnvManagerCommand
