import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  useMemo,
  useState
} from '../../index.js'
import {
  generateMockBatchUsers,
  generateMockSingleItems
} from './mock-service.js'
import type { MockDataTab } from './types.js'

export * from './types.js'
export * from './mock-service.js'

export interface MockDataCommandProps {
  featureCode?: string
  initialTab?: MockDataTab
  initialSeed?: number
}

export function MockDataCommand(props: MockDataCommandProps = {}) {
  const defaultTab: MockDataTab =
    props.initialTab ?? (props.featureCode === 'mock-batch-json' ? 'batch' : 'single')

  const [tab, setTab] = useState<MockDataTab>(defaultTab)
  const [searchText, setSearchText] = useState<string>('')
  const [seed, setSeed] = useState<number>(props.initialSeed ?? 20261025)

  const singleItems = useMemo(() => {
    const all = generateMockSingleItems(seed)
    const q = searchText.trim().toLowerCase()
    if (!q || tab !== 'single') return all
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.value.toLowerCase().includes(q)
    )
  }, [seed, searchText, tab])

  const batchSize = useMemo(() => {
    if (tab !== 'batch') return 10
    const parsed = Number(searchText.trim())
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 500) return parsed
    return 10
  }, [tab, searchText])

  const batchUsers = useMemo(
    () => generateMockBatchUsers(batchSize, seed),
    [batchSize, seed]
  )

  const batchJsonString = useMemo(
    () => JSON.stringify(batchUsers, null, 2),
    [batchUsers]
  )

  const handleRegenerate = async () => {
    setSeed((prev) => prev + 101)
    await showToast({
      style: Toast.Style.Success,
      title: '已重新生成一批 100% 校验位合规的测试数据'
    })
  }

  return (
    <List
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={
        tab === 'single'
          ? '搜索测试数据类型（如：身份证、统一社会信用代码、银行卡、手机号）...'
          : '输入批量生成的 JSON 记录条数（默认 10 条，支持 1~500）...'
      }
      searchBarAccessory={
        <List.Dropdown
          value={tab}
          onChange={(v) => setTab(v as MockDataTab)}
          tooltip="切换测试数据生成模式"
        >
          <List.Dropdown.Item title="单项极速生成 (带校验位)" value="single" icon={Icon.Document} />
          <List.Dropdown.Item title="批量用户 JSON 数组" value="batch" icon={Icon.Code} />
        </List.Dropdown>
      }
      isShowingDetail={true}
    >
      {tab === 'single' && (
        <List.Section title="符合国家校验位标准算法的虚拟测试数据（回车即复制）">
          {singleItems.map((item) => (
            <List.Item
              key={item.id}
              id={item.id}
              icon={Icon.CheckCircle}
              title={item.label}
              subtitle={item.value}
              accessories={[{ tag: item.standard }]}
              detail={
                <List.Item.Detail
                  markdown={`### ${item.label}
\`\`\`text
${item.value}
\`\`\`

#### 编码结构拆解
${item.breakdownMarkdown}

#### 校验位算法说明
> ${item.algorithmNote}

*声明：本数据由纯本地数学公式即时合成，不对应任何真实自然人或企业，仅供研发联调测试。*
`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="遵循标准" text={item.standard} />
                      <List.Item.Detail.Metadata.Label title="校验状态" text="100% 算法合规通过" />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="格式特征" text={item.formatType} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制该测试数值" content={item.value} />
                  <Action
                    title="换一批全新的合规测试数据"
                    icon={Icon.ArrowClockwise}
                    shortcut={{ modifiers: ['cmd'], key: 'r' }}
                    onAction={handleRegenerate}
                  />
                  <Action.CopyToClipboard
                    title="复制键值对 JSON"
                    content={JSON.stringify({ [item.fieldKey]: item.value }, null, 2)}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {tab === 'batch' && (
        <List.Section title="批量结构化 Mock 用户数组">
          <List.Item
            id="batch-users-json"
            icon={Icon.Code}
            title={`批量模拟用户列表 JSON (${batchUsers.length} 条完整记录)`}
            subtitle="含姓名、18位身份证、手机号、信用代码、Luhn 银行卡"
            accessories={[{ tag: `${batchUsers.length} 条已就绪` }]}
            detail={
              <List.Item.Detail
                markdown={`### 批量 Mock JSON 数组预览 (${batchUsers.length} 条)
\`\`\`json
${batchJsonString}
\`\`\`
`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="生成条数"
                      text={`${batchUsers.length} 条`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="JSON 体积"
                      text={`${(batchJsonString.length / 1024).toFixed(1)} KB`}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="复制完整 JSON 数组" content={batchJsonString} />
                <Action
                  title="重新随机生成一批"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ['cmd'], key: 'r' }}
                  onAction={handleRegenerate}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  )
}

export default MockDataCommand
