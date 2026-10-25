import React, {
  Action,
  ActionPanel,
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
  DEFAULT_QUICKLINKS,
  filterQuicklinks,
  getQuicklinks,
  importQuicklinksJson,
  launchQuicklink,
  saveQuicklinks,
  validateQuicklinkUrlPattern
} from './quicklinks-storage.js'
import type { Quicklink, QuicklinkCategory } from './types.js'

export * from './types.js'
export * from './quicklinks-storage.js'

export function CreateQuicklinkForm({
  onCreated
}: {
  onCreated?: (item: Quicklink) => void
}) {
  const { pop } = useNavigation()
  const [title, setTitle] = useState('')
  const [link, setLink] = useState('')
  const [keyword, setKeyword] = useState('')
  const [description, setDescription] = useState('')

  const handleSubmit = async () => {
    if (!title.trim()) {
      await showToast({ style: Toast.Style.Failure, title: '请输入快捷链接标题' })
      return
    }
    const urlCheck = validateQuicklinkUrlPattern(link)
    if (!urlCheck.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: urlCheck.error || '请输入合法的 URL 地址'
      })
      return
    }

    const current = await getQuicklinks()
    const newItem: Quicklink = {
      id: `ql-${Date.now()}-${current.length + 1}`,
      title: title.trim(),
      link: urlCheck.normalizedUrl,
      urlPattern: urlCheck.normalizedUrl,
      keyword: keyword.trim() || undefined,
      alias: keyword.trim() || undefined,
      category: /\{(query|argument|arg)\}/i.test(urlCheck.normalizedUrl) ? 'search' : 'direct',
      isGroup: false,
      description: description.trim() || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const updated = [newItem, ...current]
    await saveQuicklinks(updated)
    await showToast({ style: Toast.Style.Success, title: '快捷链接创建成功' })
    onCreated?.(newItem)
    pop()
  }

  return (
    <Form
      navigationTitle="新建快捷链接"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存快捷链接" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="链接名称"
        placeholder="例如: GitHub 仓库搜索"
        value={title}
        onChange={setTitle}
      />
      <Form.TextField
        id="link"
        title="目标 URL 模板"
        placeholder="支持 {query} 变量，如: https://github.com/search?q={query}"
        value={link}
        onChange={setLink}
      />
      <Form.TextField
        id="keyword"
        title="触发别名 (Alias)"
        placeholder="例如: gh"
        value={keyword}
        onChange={setKeyword}
      />
      <Form.TextField
        id="description"
        title="备注说明"
        placeholder="选填描述"
        value={description}
        onChange={setDescription}
      />
    </Form>
  )
}

export function EditQuicklinkForm({
  item,
  onUpdated
}: {
  item: Quicklink
  onUpdated?: (updated: Quicklink) => void
}) {
  const { pop } = useNavigation()
  const [title, setTitle] = useState(item.title)
  const [link, setLink] = useState(item.link)
  const [keyword, setKeyword] = useState(item.alias || item.keyword || '')
  const [description, setDescription] = useState(item.description || '')

  const handleSubmit = async () => {
    const urlCheck = validateQuicklinkUrlPattern(link)
    if (!urlCheck.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: urlCheck.error || '请输入合法的 URL 地址'
      })
      return
    }
    const updatedItem: Quicklink = {
      ...item,
      title: title.trim() || item.title,
      link: urlCheck.normalizedUrl,
      urlPattern: urlCheck.normalizedUrl,
      keyword: keyword.trim() || undefined,
      alias: keyword.trim() || undefined,
      description: description.trim() || undefined,
      updatedAt: Date.now()
    }
    onUpdated?.(updatedItem)
    pop()
  }

  return (
    <Form
      navigationTitle="编辑快捷链接"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存修改" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField id="title" title="链接名称" value={title} onChange={setTitle} />
      <Form.TextField id="link" title="目标 URL" value={link} onChange={setLink} />
      <Form.TextField id="keyword" title="触发别名" value={keyword} onChange={setKeyword} />
      <Form.TextField
        id="description"
        title="备注说明"
        value={description}
        onChange={setDescription}
      />
    </Form>
  )
}

export function ImportQuicklinksForm({
  onImported
}: {
  onImported?: (items: Quicklink[]) => void
}) {
  const { pop } = useNavigation()
  const [jsonText, setJsonText] = useState('')

  const handleSubmit = async () => {
    const current = await getQuicklinks()
    const res = importQuicklinksJson(jsonText, current)
    if (!res.success) {
      await showToast({ style: Toast.Style.Failure, title: res.error || '导入失败' })
      return
    }
    await saveQuicklinks(res.result)
    onImported?.(res.result)
    pop()
  }

  return (
    <Form
      navigationTitle="导入快捷链接 JSON"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="确认导入" onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextArea id="json" title="JSON 内容" value={jsonText} onChange={setJsonText} />
    </Form>
  )
}

function getHostnameLabel(rawUrl: string): string {
  try {
    return new URL(rawUrl.replace(/\{(query|argument|arg)(?:\s+[^}]*)?\}/gi, 'q')).hostname
  } catch {
    return rawUrl.slice(0, 28)
  }
}

export interface QuicklinksCommandProps {
  featureCode?: string
  initialLinks?: Quicklink[]
}

export function QuicklinksCommand(props: QuicklinksCommandProps = {}) {
  const { push } = useNavigation()
  const [links, setLinks] = useState<Quicklink[]>(props.initialLinks ?? DEFAULT_QUICKLINKS)
  const [selectedCategory, setSelectedCategory] = useState<'all' | QuicklinkCategory>(() => {
    if (props.featureCode === 'quicklinks-search-engines') return 'search'
    if (props.featureCode === 'quicklinks-open-groups') return 'group'
    return 'all'
  })
  const [searchText, setSearchText] = useState<string>('')

  useEffect(() => {
    if (!props.initialLinks) {
      void getQuicklinks().then(setLinks)
    }
  }, [props.initialLinks])

  const filtered = useMemo(
    () => filterQuicklinks(links, searchText, selectedCategory),
    [links, searchText, selectedCategory]
  )

  const handleOpenLink = async (item: Quicklink) => {
    const queryArg = filtered.directMatch?.quicklink.id === item.id ? filtered.directMatch.queryArg : ''
    const urls = await launchQuicklink(item, queryArg)
    await showToast({
      style: Toast.Style.Success,
      title: item.isGroup ? `已并发打开 ${urls.length} 个工作流网页` : `已打开: ${urls[0]}`
    })
  }

  const handleResetDefaults = async () => {
    setLinks([...DEFAULT_QUICKLINKS])
    await saveQuicklinks([...DEFAULT_QUICKLINKS])
    await showToast({
      style: Toast.Style.Success,
      title: '已恢复默认预设快开列表'
    })
  }

  return (
    <List
      navigationTitle="网页快开"
      isLoading={false}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索快捷链接，或输入“别名 + 空格 + 关键词”（如：gh react）..."
      searchBarAccessory={
        <List.Dropdown
          value={selectedCategory}
          onChange={(val) => setSelectedCategory(val as 'all' | QuicklinkCategory)}
          tooltip="按类型筛选"
        >
          <List.Dropdown.Item title="全部快捷链接" value="all" icon={Icon.Globe} />
          <List.Dropdown.Item title="搜索平台（带参数）" value="search" icon={Icon.Globe} />
          <List.Dropdown.Item title="直达网页" value="direct" icon={Icon.ArrowRight} />
          <List.Dropdown.Item title="批量网址组" value="group" icon={Icon.Desktop} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共 ${filtered.matches.length} 个快开项 · 支持在搜索框输入别名快速带参检索`,
        actions: [
          {
            id: 'create',
            title: '新建快开',
            onAction: () =>
              push(
                <CreateQuicklinkForm
                  onCreated={(created) => setLinks((prev) => [created, ...prev])}
                />
              )
          },
          {
            id: 'reset-default',
            title: '恢复默认预设',
            onAction: () => {
              void handleResetDefaults()
            }
          }
        ]
      }}
    >
      {filtered.matches.map((item) => {
        const alias = item.alias || item.keyword
        const pattern = item.urlPattern || item.link
        const hasQuery = /\{(query|argument|arg)\}/i.test(pattern)
        return (
          <List.Item
            key={item.id}
            id={item.id}
            title={item.title}
            subtitle={item.description || pattern}
            icon={item.isGroup ? Icon.Desktop : Icon.Globe}
            accessories={[
              alias ? { tag: `别名: ${alias}` } : {},
              {
                text: item.isGroup
                  ? `含 ${item.urls?.length || 0} 个网页`
                  : getHostnameLabel(pattern)
              }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={hasQuery ? '带参搜索 / 访问' : '在浏览器中打开'}
                  icon={Icon.Globe}
                  onAction={() => handleOpenLink(item)}
                />
                <Action
                  title="编辑此快捷链接"
                  icon={Icon.Pencil}
                  onAction={() =>
                    push(
                      <EditQuicklinkForm
                        item={item}
                        onUpdated={(u) => {
                          setLinks((prev) => {
                            const next = prev.map((x) => (x.id === u.id ? u : x))
                            void saveQuicklinks(next)
                            return next
                          })
                        }}
                      />
                    )
                  }
                />
                <Action.CopyToClipboard title="复制目标网址" content={pattern} />
              </ActionPanel>
            }
          />
        )
      })}
    </List>
  )
}

export default QuicklinksCommand
