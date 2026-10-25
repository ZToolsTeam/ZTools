import React, {
  List,
  Form,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  LocalStorage,
  showToast,
  Toast,
  useNavigation,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from '../../index.js'
import type { SnippetCategory, SnippetFormInput, SnippetItem } from './types.js'
import {
  getSnippetCategoryLabel,
  resolveMacroTemplate,
  validateSnippetInput
} from './macro-engine.js'

export * from './types.js'
export * from './macro-engine.js'

const SNIPPETS_STORAGE_KEY = 'ztools.snippets.items.v1'

function getCategoryIcon(category: SnippetCategory): Icon {
  switch (category) {
    case 'invoice':
      return Icon.Document
    case 'address':
      return Icon.Pin
    case 'customer_service':
      return Icon.Text
    case 'code':
      return Icon.Code
    default:
      return Icon.List
  }
}

export interface SnippetEditFormProps {
  initialData?: SnippetItem
  onSave: (input: SnippetFormInput) => Promise<void>
}

export function SnippetEditForm({ initialData, onSave }: SnippetEditFormProps) {
  const { pop } = useNavigation()
  const [title, setTitle] = useState(initialData?.title || '')
  const [category, setCategory] = useState<SnippetCategory>(initialData?.category || 'general')
  const [keyword, setKeyword] = useState(initialData?.keyword || '')
  const [content, setContent] = useState(initialData?.content || '')

  const handleSubmit = useCallback(async () => {
    const payload: SnippetFormInput = {
      id: initialData?.id,
      title,
      category,
      keyword,
      content
    }
    const check = validateSnippetInput(payload)
    if (!check.valid) {
      await showToast({
        style: Toast.Style.Failure,
        title: '无法保存短语',
        message: check.error
      })
      return
    }
    await onSave(payload)
    pop()
  }, [initialData, title, category, keyword, content, onSave, pop])

  return (
    <Form
      navigationTitle={initialData ? '编辑快捷短语' : '新建快捷短语'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存短语" icon={Icon.CheckCircle} onSubmit={handleSubmit} />
          <Action title="取消返回" onAction={pop} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="短语标题"
        value={title}
        onChange={setTitle}
        placeholder="如：公司开票抬头、北京办公地址"
      />
      <Form.Dropdown
        id="category"
        title="所属分类"
        value={category}
        onChange={(v: string) => setCategory(v as SnippetCategory)}
      >
        <Form.Dropdown.Item title="通用短语" value="general" />
        <Form.Dropdown.Item title="发票与开票信息" value="invoice" />
        <Form.Dropdown.Item title="常用地址与联系人" value="address" />
        <Form.Dropdown.Item title="客服与商务话术" value="customer_service" />
        <Form.Dropdown.Item title="开发与代码片段" value="code" />
      </Form.Dropdown>
      <Form.TextField
        id="keyword"
        title="触发缩写（可选）"
        value={keyword}
        onChange={setKeyword}
        placeholder="如：!shuihao、!addr"
      />
      <Form.TextArea
        id="content"
        title="短语模板内容"
        value={content}
        onChange={setContent}
        placeholder="支持宏变量：{date}、{time}、{clipboard}、{cursor}..."
      />
      <Form.Description
        title="宏变量提示"
        text="{date}=年月日  {time}=时分秒  {clipboard}=当前剪贴板  {cursor}=上屏后光标停留位置"
      />
    </Form>
  )
}

export interface SnippetsProps {
  featureCode?: string
  initialSnippets?: SnippetItem[]
}

export function Snippets({ featureCode = 'snippets-all', initialSnippets }: SnippetsProps = {}) {
  const { push } = useNavigation()
  const [isLoading, setIsLoading] = useState<boolean>(!initialSnippets)
  const [snippets, setSnippets] = useState<SnippetItem[]>(initialSnippets || [])
  const [searchText, setSearchText] = useState<string>('')
  const [categoryFilter, setCategoryFilter] = useState<string>(() => {
    if (featureCode === 'snippets-invoice') return 'invoice'
    if (featureCode === 'snippets-address') return 'address'
    return 'all'
  })

  const mountedRef = useRef<boolean>(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (initialSnippets) {
      return
    }
    let active = true
    ;(async () => {
      try {
        const raw = await LocalStorage.getItem<string>(SNIPPETS_STORAGE_KEY)
        if (!active || !mountedRef.current) return
        if (raw) {
          const parsed = JSON.parse(raw) as SnippetItem[]
          if (Array.isArray(parsed)) {
            setSnippets(parsed)
          }
        }
      } catch {
        // Ignore storage read error
      } finally {
        if (active && mountedRef.current) {
          setIsLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [initialSnippets])

  const persistSnippets = useCallback(async (nextList: SnippetItem[]) => {
    await LocalStorage.setItem(SNIPPETS_STORAGE_KEY, JSON.stringify(nextList))
    if (mountedRef.current) {
      setSnippets(nextList)
    }
  }, [])

  const handleSaveSnippet = useCallback(
    async (input: SnippetFormInput) => {
      const check = validateSnippetInput(input)
      if (!check.valid) {
        throw new Error(check.error)
      }
      const now = Date.now()
      const content = input.content.trim()
      const previewText = content.replace(/\s+/g, ' ').slice(0, 72)
      let next: SnippetItem[]
      if (input.id) {
        next = snippets.map((s: SnippetItem) =>
          s.id === input.id
            ? {
                ...s,
                title: input.title.trim(),
                category: input.category,
                categoryLabel: getSnippetCategoryLabel(input.category),
                keyword: input.keyword?.trim() || undefined,
                content,
                previewText,
                updatedAt: now
              }
            : s
        )
      } else {
        const created: SnippetItem = {
          id: `snip-${now}`,
          title: input.title.trim(),
          category: input.category,
          categoryLabel: getSnippetCategoryLabel(input.category),
          keyword: input.keyword?.trim() || undefined,
          content,
          previewText,
          useCount: 0,
          updatedAt: now
        }
        next = [created, ...snippets]
      }
      await persistSnippets(next)
      await showToast({
        style: Toast.Style.Success,
        title: '短语已保存',
        message: input.title.trim()
      })
    },
    [snippets, persistSnippets]
  )

  const handleDeleteSnippet = useCallback(
    async (id: string) => {
      const next = snippets.filter((s: SnippetItem) => s.id !== id)
      await persistSnippets(next)
      await showToast({
        style: Toast.Style.Success,
        title: '已删除该快捷短语'
      })
    },
    [snippets, persistSnippets]
  )

  const handleInsertSnippet = useCallback(
    async (item: SnippetItem) => {
      const clipText = (await Clipboard.readText()) || ''
      const resolved = resolveMacroTemplate(item.content, clipText)
      await Clipboard.copy(resolved.text)
      try {
        const g = globalThis as Record<string, unknown>
        const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
        const electron = win.__ztoolsElectron as
          | { transport?: { invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown> } }
          | undefined
        if (typeof electron?.transport?.invoke === 'function') {
          await electron.transport.invoke('clipboard_hide_and_paste_text', {
            text: resolved.text
          })
        }
      } catch {
        // Fallback to clipboard copy already completed
      }
      const next = snippets.map((s: SnippetItem) =>
        s.id === item.id ? { ...s, useCount: (s.useCount || 0) + 1 } : s
      )
      await persistSnippets(next)
      await showToast({
        style: Toast.Style.Success,
        title: '已解析动态宏并上屏/写入剪贴板',
        message: resolved.text.slice(0, 48)
      })
    },
    [snippets, persistSnippets]
  )

  const filteredSnippets = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return snippets.filter((item: SnippetItem) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) {
        return false
      }
      if (!q) return true
      return (
        item.title.toLowerCase().includes(q) ||
        (item.keyword || '').toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
      )
    })
  }, [snippets, searchText, categoryFilter])

  if (featureCode === 'snippets-new') {
    return <SnippetEditForm onSave={handleSaveSnippet} />
  }

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索短语标题、触发词或内容（如：税号、地址、退款）..."
      searchBarAccessory={
        <List.Dropdown
          value={categoryFilter}
          onChange={setCategoryFilter}
          tooltip="按短语分类筛选"
        >
          <List.Dropdown.Item title="全部短语" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="发票与开票信息" value="invoice" icon={Icon.Document} />
          <List.Dropdown.Item title="常用地址与联系人" value="address" icon={Icon.Pin} />
          <List.Dropdown.Item
            title="客服与商务话术"
            value="customer_service"
            icon={Icon.Text}
          />
          <List.Dropdown.Item title="开发与代码片段" value="code" icon={Icon.Code} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共 ${filteredSnippets.length} 条快捷短语 · 支持 {date} / {clipboard} / {cursor} 动态宏变量`,
        actions: [
          {
            id: 'new-snippet',
            title: '新建短语',
            onAction: () => push(<SnippetEditForm onSave={handleSaveSnippet} />)
          }
        ]
      }}
    >
      {filteredSnippets.map((item: SnippetItem) => (
        <List.Item
          key={item.id}
          id={item.id}
          title={item.title}
          subtitle={item.previewText}
          icon={getCategoryIcon(item.category)}
          accessories={[
            { tag: item.keyword ? `缩写: ${item.keyword}` : item.categoryLabel },
            { text: `使用 ${item.useCount || 0} 次` }
          ]}
          actions={
            <ActionPanel>
              <Action
                title="直接上屏粘贴"
                icon={Icon.ArrowUp}
                onAction={() => handleInsertSnippet(item)}
              />
              <Action.CopyToClipboard
                title="复制解析后的文本"
                content={resolveMacroTemplate(item.content, '').text}
                shortcut={{ modifiers: ['cmd'], key: 'enter' }}
              />
              <Action
                title="编辑短语"
                icon={Icon.Pencil}
                shortcut={{ modifiers: ['cmd'], key: 'e' }}
                onAction={() =>
                  push(<SnippetEditForm initialData={item} onSave={handleSaveSnippet} />)
                }
              />
              <Action
                title="新建短语"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                onAction={() => push(<SnippetEditForm onSave={handleSaveSnippet} />)}
              />
              <Action
                title="删除短语"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                onAction={() => handleDeleteSnippet(item.id)}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export const SnippetsCommand = Snippets
export default Snippets

export function SnippetArgumentFormView({ snippet }: { snippet?: Record<string, unknown> }) {
  return (
    <Form navigationTitle="填写短语动态参数">
      <Form.TextField id="arg_text" title="文本参数" />
      <Form.Dropdown id="arg_dropdown" title="下拉选项">
        <Form.Dropdown.Item value="opt1" title="选项 1" />
      </Form.Dropdown>
      <Form.PasswordField id="arg_password" title="密码参数" />
    </Form>
  )
}

export const CreateSnippetForm = SnippetEditForm
export function SnippetDetailView({ snippet }: { snippet?: Record<string, unknown> }) {
  return (
    <Form navigationTitle="短语详情">
      <Form.TextField id="detail" title="短语内容" value={String(snippet?.content || '')} />
    </Form>
  )
}

export { expandSnippetTemplate, filterSnippets, SAMPLE_SNIPPETS } from './macro-engine.js'
