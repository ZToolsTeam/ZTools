import React, {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import { buildAllConversionTargets, detectAndParse } from './table-service.js'

export * from './types.js'
export * from './table-service.js'

export interface TableConverterCommandProps {
  featureCode?: string
  initialRawText?: string
  initialHeaderMode?: 'first-row-header' | 'no-header'
  initialSqlTableName?: string
}

const DEFAULT_SAMPLE_TSV = [
  '服务模块\tQPS峰值\tP99延迟(ms)\t核心状态',
  'ztools-indexer\t48500\t1.8\ttrue',
  'declarative-reconciler\t19200\t3.2\ttrue',
  'host-ipc-bridge\t12800\t2.4\ttrue'
].join('\n')

export function TableConverterCommand(props: TableConverterCommandProps = {}) {
  const [rawText, setRawText] = useState<string>(props.initialRawText ?? DEFAULT_SAMPLE_TSV)
  const [headerMode, setHeaderMode] = useState<'first-row-header' | 'no-header'>(
    props.initialHeaderMode ?? 'first-row-header'
  )
  const [sqlTableName] = useState<string>(props.initialSqlTableName ?? 'my_table')
  const [searchText, setSearchText] = useState<string>('')
  const [isConverting, setIsConverting] = useState<boolean>(false)

  const handleReadClipboard = async () => {
    setIsConverting(true)
    try {
      const clipText = await Clipboard.readText()
      if (clipText && clipText.trim()) {
        setRawText(clipText)
        await showToast({
          style: Toast.Style.Success,
          title: '已从剪贴板读取表格数据'
        })
      }
    } catch {
      // Keep current text if clipboard is empty or unavailable
    } finally {
      setIsConverting(false)
    }
  }

  useEffect(() => {
    if (props.initialRawText === undefined) {
      void handleReadClipboard()
    }
  }, [props.featureCode])

  const parsed = useMemo(
    () => detectAndParse(rawText, headerMode === 'first-row-header'),
    [rawText, headerMode]
  )

  const conversionTargets = useMemo(() => {
    const targets = buildAllConversionTargets(parsed.grid, sqlTableName)
    const q = searchText.trim().toLowerCase()
    if (!q) return targets
    return targets.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.subtitle.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
    )
  }, [parsed.grid, sqlTableName, searchText])

  const rowCount = parsed.grid.rows.length
  const colCount = parsed.grid.headers.length

  return (
    <List
      navigationTitle="表格互转"
      isLoading={isConverting}
      isShowingDetail={true}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="切换目标转换格式（Markdown / JSON / SQL / HTML / CSV）..."
      searchBarAccessory={
        <List.Dropdown
          value={headerMode}
          onChange={(val) => setHeaderMode(val as 'first-row-header' | 'no-header')}
          tooltip="表头识别模式"
        >
          <List.Dropdown.Item
            title="第一行为列标题（首行表头）"
            value="first-row-header"
            icon={Icon.List}
          />
          <List.Dropdown.Item
            title="纯数据无表头（自动分配 col_1, col_2...）"
            value="no-header"
            icon={Icon.Code}
          />
        </List.Dropdown>
      }
      filterBar={{
        summaryText:
          parsed.format === 'empty'
            ? '等待输入或从剪贴板粘贴表格数据'
            : `识别源格式: ${parsed.format.toUpperCase()} · 共 ${rowCount} 行 × ${colCount} 列`,
        actions: [
          {
            id: 'read-clipboard',
            title: '读取剪贴板',
            onAction: () => {
              void handleReadClipboard()
            }
          }
        ]
      }}
    >
      {conversionTargets.map((target) => (
        <List.Item
          key={target.id}
          id={target.id}
          title={target.title}
          subtitle={target.subtitle}
          icon={target.id === 'markdown' ? Icon.Document : Icon.Code}
          accessories={[{ tag: target.badge }]}
          detail={
            <List.Item.Detail
              markdown={`\`\`\`${target.language}\n${target.previewText}\n\`\`\``}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="输出格式" text={target.title} />
                  <List.Item.Detail.Metadata.Label
                    title="行数 / 列数"
                    text={`${rowCount} 行 × ${colCount} 列`}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="输出字符数"
                    text={`${target.fullText.length} 字符`}
                  />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label title="推断列类型" text={target.typeSummary} />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action.CopyToClipboard
                title="复制转换结果"
                content={target.fullText}
                icon={Icon.Clipboard}
              />
              <Action.Paste
                title="直接上屏粘贴"
                content={target.fullText}
                icon={Icon.Text}
                shortcut={{ modifiers: ['cmd'], key: 'enter' }}
              />
              <Action
                title="重新读取剪贴板"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={handleReadClipboard}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default TableConverterCommand
