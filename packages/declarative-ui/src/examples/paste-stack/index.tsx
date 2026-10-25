import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  Clipboard,
  showToast,
  Toast,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from '../../index.js'
import type { StackItem, StackPopMode } from './types.js'
import {
  cleanRichTextToPlain,
  fetchHostPasteStackState,
  readClipboardWithRetry
} from './stack-manager.js'

export * from './types.js'
export * from './stack-manager.js'

export interface PasteStackProps {
  featureCode?: string
  initialItems?: StackItem[]
  initialListening?: boolean
  hostOverride?: unknown
}

export function PasteStack({
  featureCode = 'paste-stack-queue',
  initialItems,
  initialListening = true,
  hostOverride
}: PasteStackProps = {}) {
  const [isLoading, setIsLoading] = useState<boolean>(!initialItems)
  const [isListening, setIsListening] = useState<boolean>(initialListening)
  const [stackMode, setStackMode] = useState<StackPopMode>(
    featureCode === 'paste-stack-lifo' ? 'lifo' : 'fifo'
  )
  const [stackItems, setStackItems] = useState<StackItem[]>(initialItems || [])
  const [searchText, setSearchText] = useState<string>('')

  const mountedRef = useRef<boolean>(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleCleanCurrentClipboard = useCallback(async () => {
    try {
      const raw = await readClipboardWithRetry(async () => (await Clipboard.readText()) || '')
      const cleaned = cleanRichTextToPlain(raw)
      if (!cleaned) {
        await showToast({
          style: Toast.Style.Failure,
          title: '剪贴板无可用文本'
        })
        return
      }
      await Clipboard.copy(cleaned)
      await showToast({
        style: Toast.Style.Success,
        title: '已洗净为纯文本',
        message: `剥离富文本样式，保留 ${cleaned.length} 字符`
      })
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: '清洗剪贴板失败',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }, [])

  useEffect(() => {
    if (featureCode === 'paste-clean-text') {
      void handleCleanCurrentClipboard()
    }
  }, [featureCode, handleCleanCurrentClipboard])

  useEffect(() => {
    if (initialItems) {
      return
    }
    let active = true
    ;(async () => {
      try {
        const state = await fetchHostPasteStackState(hostOverride)
        if (!active || !mountedRef.current) return
        setIsListening(state.isListening)
        setStackItems(state.items)
      } catch {
        // Keep empty initial state if host not connected
      } finally {
        if (active && mountedRef.current) {
          setIsLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [initialItems, hostOverride])

  useEffect(() => {
    if (!isListening || initialItems) return
    let lastSeen = ''
    let pollSeq = 0
    const timer = setInterval(async () => {
      if (!mountedRef.current) return
      try {
        const text = (await Clipboard.readText())?.trim() || ''
        if (!text || text === lastSeen) return
        lastSeen = text
        setStackItems((prev: StackItem[]) => {
          if (prev.length > 0 && prev[prev.length - 1]?.text === text) {
            return prev
          }
          const newItem: StackItem = {
            id: `stk-${Date.now()}-${++pollSeq}`,
            text,
            textPreview: text.replace(/\s+/g, ' ').slice(0, 60),
            charCount: text.length,
            timestamp: Date.now(),
            timeAgo: '刚刚',
            sourceApp: '系统剪贴板'
          }
          return [...prev, newItem]
        })
      } catch {
        // ignore clipboard polling error
      }
    }, 900)
    return () => {
      clearInterval(timer)
    }
  }, [isListening, initialItems])

  const handleToggleListening = useCallback(async () => {
    const next = !isListening
    setIsListening(next)
    await showToast({
      style: Toast.Style.Success,
      title: next ? '已开启连续复制入栈监听' : '已暂停连续复制入栈监听'
    })
  }, [isListening])

  const handleClearStack = useCallback(async () => {
    setStackItems([])
    await showToast({
      style: Toast.Style.Success,
      title: '粘贴栈已清空'
    })
  }, [])

  const popAndPasteItem = useCallback(
    async (itemId?: string) => {
      if (stackItems.length === 0) {
        await showToast({
          style: Toast.Style.Failure,
          title: '粘贴栈为空',
          message: '请先复制文本入栈后再执行出栈粘贴'
        })
        return
      }
      let target: StackItem | undefined
      let nextList: StackItem[] = []
      if (itemId) {
        target = stackItems.find((i: StackItem) => i.id === itemId)
        nextList = stackItems.filter((i: StackItem) => i.id !== itemId)
      } else if (stackMode === 'lifo') {
        target = stackItems[stackItems.length - 1]
        nextList = stackItems.slice(0, -1)
      } else {
        target = stackItems[0]
        nextList = stackItems.slice(1)
      }

      if (!target) return
      await Clipboard.copy(target.text)
      setStackItems(nextList)
      await showToast({
        style: Toast.Style.Success,
        title: `已出栈并写入剪贴板: ${target.textPreview}`,
        message: nextList.length > 0 ? `栈内剩余 ${nextList.length} 项` : '粘贴栈已全部出栈完毕'
      })
    },
    [stackItems, stackMode]
  )

  const moveItem = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (fromIdx < 0 || fromIdx >= stackItems.length || toIdx < 0 || toIdx >= stackItems.length) {
        return
      }
      const copy = [...stackItems]
      const [moved] = copy.splice(fromIdx, 1)
      if (moved) {
        copy.splice(toIdx, 0, moved)
        setStackItems(copy)
      }
    },
    [stackItems]
  )

  const removeItem = useCallback((id: string) => {
    setStackItems((prev: StackItem[]) => prev.filter((i: StackItem) => i.id !== id))
  }, [])

  const filteredItems = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return stackItems
    return stackItems.filter((i: StackItem) => i.text.toLowerCase().includes(q))
  }, [stackItems, searchText])

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索当前粘贴栈中的文本内容..."
      searchBarAccessory={
        <List.Dropdown
          value={stackMode}
          onChange={(v: string) => setStackMode(v as StackPopMode)}
          tooltip="切换出栈顺序"
        >
          <List.Dropdown.Item
            title="先进先出（FIFO 顺序填表）"
            value="fifo"
            icon={Icon.ArrowRight}
          />
          <List.Dropdown.Item
            title="后进先出（LIFO 倒序填表）"
            value="lifo"
            icon={Icon.ArrowLeft}
          />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: isListening
          ? `监听中 (${stackMode.toUpperCase()}) · 栈内共 ${stackItems.length} 项 · 按出栈键依次填入目标窗口`
          : `已暂停监听 · 栈内共 ${stackItems.length} 项`,
        actions: [
          {
            id: 'toggle-listen',
            title: isListening ? '暂停入栈监听' : '开启入栈监听',
            onAction: handleToggleListening
          },
          {
            id: 'clean-clipboard',
            title: '洗净剪贴板为纯文本',
            onAction: handleCleanCurrentClipboard
          }
        ]
      }}
    >
      {filteredItems.map((item: StackItem, index: number) => (
        <List.Item
          key={item.id}
          id={item.id}
          title={item.textPreview}
          subtitle={`字符数: ${item.charCount} · 复制时间: ${item.timeAgo}`}
          icon={Icon.Text}
          accessories={[
            {
              tag:
                stackMode === 'fifo'
                  ? `#${index + 1} 出栈`
                  : `#${stackItems.length - index} 出栈`
            },
            { text: item.sourceApp ? `来自: ${item.sourceApp}` : '' }
          ]}
          actions={
            <ActionPanel>
              <Action
                title="立即出栈并粘贴到上个窗口"
                icon={Icon.ArrowUp}
                onAction={() => popAndPasteItem(item.id)}
              />
              <Action.CopyToClipboard title="复制该项到剪贴板" content={item.text} />
              <Action
                title="上移一位"
                icon={Icon.ArrowUp}
                onAction={() => moveItem(index, index - 1)}
              />
              <Action
                title="下移一位"
                icon={Icon.ArrowDown}
                onAction={() => moveItem(index, index + 1)}
              />
              <Action
                title="从栈中移除"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                onAction={() => removeItem(item.id)}
              />
              <Action
                title="清空整个栈"
                icon={Icon.XMarkCircle}
                style={Action.Style.Destructive}
                onAction={handleClearStack}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export const PasteStackCommand = PasteStack
export default PasteStack
