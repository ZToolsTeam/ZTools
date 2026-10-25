import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from '../../index.js'
import type { BookmarkItem, BrowserFilterValue, BrowserType } from './types.js'
import { scanAllBrowserBookmarksWithMeta, searchAndFilterBookmarks } from './bookmark-scanner.js'

export * from './types.js'
export * from './bookmark-scanner.js'

function getBrowserIcon(browser: BrowserType): Icon {
  switch (browser) {
    case 'edge':
    case 'safari':
      return Icon.Globe
    case 'chrome':
    case 'brave':
      return Icon.Globe
    case '360se':
    case '360chrome':
    case 'qqbrowser':
      return Icon.Shield
    case 'firefox':
      return Icon.Bolt
    default:
      return Icon.Globe
  }
}

function mapFeatureCodeToBrowserFilter(featureCode?: string): BrowserFilterValue {
  switch (featureCode) {
    case 'bookmarks-edge':
      return 'edge'
    case 'bookmarks-chrome':
      return 'chrome'
    case 'bookmarks-domestic':
      return 'domestic'
    case 'bookmarks-firefox':
      return 'firefox'
    default:
      return 'all'
  }
}

export interface BrowserBookmarksProps {
  featureCode?: string
  initialBookmarks?: BookmarkItem[]
  hostOverride?: unknown
}

export function BrowserBookmarks({
  featureCode = 'bookmarks-all',
  initialBookmarks,
  hostOverride
}: BrowserBookmarksProps = {}) {
  const [isLoading, setIsLoading] = useState<boolean>(!initialBookmarks)
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(initialBookmarks || [])
  const [searchText, setSearchText] = useState<string>('')
  const [browserFilter, setBrowserFilter] = useState<BrowserFilterValue>(() =>
    mapFeatureCodeToBrowserFilter(featureCode)
  )

  const mountedRef = useRef<boolean>(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleReloadBookmarks = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await scanAllBrowserBookmarksWithMeta({ hostOverride })
      if (!mountedRef.current) return
      setBookmarks(res.bookmarks)
    } catch (err) {
      if (!mountedRef.current) return
      await showToast({
        style: Toast.Style.Failure,
        title: '读取浏览器书签失败',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (mountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [hostOverride])

  useEffect(() => {
    if (initialBookmarks) {
      return
    }
    void handleReloadBookmarks()
  }, [initialBookmarks, handleReloadBookmarks])

  const filteredBookmarks = useMemo(
    () => searchAndFilterBookmarks(bookmarks, searchText, browserFilter),
    [bookmarks, searchText, browserFilter]
  )

  const activeBrowserCount = useMemo(() => {
    const set = new Set(bookmarks.map((b: BookmarkItem) => b.browser))
    return set.size
  }, [bookmarks])

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索书签标题、拼音首字母、URL或文件夹（如：bili、tb、github）..."
      searchBarAccessory={
        <List.Dropdown
          value={browserFilter}
          onChange={(v: string) => setBrowserFilter(v as BrowserFilterValue)}
          tooltip="按浏览器筛选"
        >
          <List.Dropdown.Item title="全部浏览器书签" value="all" icon={Icon.Globe} />
          <List.Dropdown.Item title="Microsoft Edge" value="edge" icon={Icon.Globe} />
          <List.Dropdown.Item title="Google Chrome" value="chrome" icon={Icon.Circle} />
          <List.Dropdown.Item title="国内浏览器（360 / QQ）" value="domestic" icon={Icon.Shield} />
          <List.Dropdown.Item title="Mozilla Firefox" value="firefox" icon={Icon.Bolt} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `已聚合 ${activeBrowserCount} 款浏览器 · 共 ${filteredBookmarks.length} 个书签`,
        actions: [{ id: 'refresh', title: '刷新书签库', onAction: handleReloadBookmarks }]
      }}
    >
      {filteredBookmarks.slice(0, 100).map((item: BookmarkItem) => (
        <List.Item
          key={`${item.browser}-${item.id}`}
          id={`${item.browser}-${item.id}`}
          title={item.title || item.url}
          subtitle={
            item.folderBreadcrumb
              ? `${item.folderBreadcrumb} · ${item.hostname}`
              : item.hostname
          }
          icon={getBrowserIcon(item.browser)}
          accessories={[{ tag: item.browserLabel }, { text: item.dateAddedFormatted }]}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser title="打开网页" url={item.url} />
              <Action.CopyToClipboard
                title="复制网页链接"
                content={item.url}
                shortcut={{ modifiers: ['cmd'], key: 'enter' }}
              />
              <Action.CopyToClipboard
                title="复制为 Markdown 链接"
                content={`[${item.title}](${item.url})`}
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
              />
              <Action.CopyToClipboard
                title="复制书签标题"
                content={item.title}
                shortcut={{ modifiers: ['cmd', 'alt'], key: 'c' }}
              />
              <Action
                title="刷新书签缓存"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={handleReloadBookmarks}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export const BrowserBookmarksCommand = BrowserBookmarks
export default BrowserBookmarks
