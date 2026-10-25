import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  useMemo,
  useState
} from '../../index.js'
import {
  REGEX_PRESETS,
  parseAndExplainCron,
  runSafeRegexMatch
} from './regex-cron-service.js'
import type { RegexCronMode, RegexPresetItem } from './types.js'

export * from './types.js'
export * from './regex-cron-service.js'

export interface RegexCronCommandProps {
  featureCode?: string
  initialMode?: RegexCronMode
  initialSearchText?: string
  initialTestSample?: string
}

const CRON_TEMPLATES = [
  { id: 'cron-daily-2am', expr: '0 0 2 * * ?', title: '每天凌晨 02:00:00 执行备份' },
  { id: 'cron-every-15m', expr: '*/15 * * * *', title: '每隔 15 分钟轮询同步一次' },
  { id: 'cron-workday-930', expr: '0 30 9 ? * MON-FRI', title: '每个工作日上午 09:30:00 推送日报' },
  { id: 'cron-month-1st', expr: '0 0 0 1 * ?', title: '每月 1 号零点生成月度账单' }
]

export function RegexCronCommand(props: RegexCronCommandProps = {}) {
  const defaultMode: RegexCronMode =
    props.initialMode ??
    (props.featureCode === 'regex-tester'
      ? 'tester'
      : props.featureCode === 'cron-explainer'
        ? 'cron'
        : 'dict')

  const [currentMode, setCurrentMode] = useState<RegexCronMode>(defaultMode)
  const [searchText, setSearchText] = useState<string>(props.initialSearchText ?? '')
  const [testSample, setTestSample] = useState<string>(
    props.initialTestSample ??
      '联系人手机：13800138000，备用号：18612345678，身份证：11010519900307281X，车牌：京AD12345'
  )

  const filteredRegexList = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return REGEX_PRESETS
    return REGEX_PRESETS.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.categoryLabel.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q)) ||
        item.description.toLowerCase().includes(q)
    )
  }, [searchText])

  const activeTesterPattern =
    currentMode === 'tester' && searchText.trim()
      ? searchText.trim()
      : '1(?:3\\d|4[5-9]|5[0-35-9]|6[2567]|7[0-8]|8\\d|9[0-35-9])\\d{8}'

  const regexMatchResult = useMemo(
    () => runSafeRegexMatch(activeTesterPattern, testSample, 'g'),
    [activeTesterPattern, testSample]
  )

  const activeCronExpr =
    currentMode === 'cron' && searchText.trim() ? searchText.trim() : '0 0 2 * * ?'

  const cronResult = useMemo(() => parseAndExplainCron(activeCronExpr), [activeCronExpr])

  const handleLoadIntoTester = (item: RegexPresetItem) => {
    setCurrentMode('tester')
    setSearchText(item.pattern)
    if (item.validExamples.length > 0) {
      setTestSample(item.validExamples.join('  |  '))
    }
  }

  return (
    <List
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={
        currentMode === 'cron'
          ? '输入 5/6 位 Cron 表达式（如 0 0 2 * * ? 或 */15 * * * *）...'
          : currentMode === 'tester'
            ? '输入待测试正则表达式（如 /1[3-9]\\d{9}/g）...'
            : '搜索常用中国本土正则（如：身份证、手机号、信用代码、新能源车牌）...'
      }
      searchBarAccessory={
        <List.Dropdown
          value={currentMode}
          onChange={(v) => setCurrentMode(v as RegexCronMode)}
          tooltip="切换工作模式"
        >
          <List.Dropdown.Item title="中国常用正则字典" value="dict" icon={Icon.Document} />
          <List.Dropdown.Item title="实时正则测试器" value="tester" icon={Icon.Play} />
          <List.Dropdown.Item title="Cron 中文翻译与推算" value="cron" icon={Icon.Clock} />
        </List.Dropdown>
      }
      isShowingDetail={true}
    >
      {currentMode === 'dict' && (
        <List.Section title={`常用本土业务正则库（共 ${filteredRegexList.length} 项）`}>
          {filteredRegexList.map((item) => (
            <List.Item
              key={item.id}
              id={item.id}
              icon={Icon.Code}
              title={item.title}
              subtitle={item.categoryLabel}
              accessories={[{ tag: item.tags[0] || item.categoryLabel }]}
              detail={
                <List.Item.Detail
                  markdown={`### ${item.title}
\`\`\`regexp
${item.pattern}
\`\`\`

#### 规则说明
${item.description}

#### 合规通过用例 (Pass)
${item.validExamples.map((ex) => `- \`${ex}\``).join('\n')}

#### 拦截反例用例 (Reject)
${item.invalidExamples.map((ex) => `- \`${ex}\` *(不匹配)*`).join('\n')}
`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="业务分类" text={item.categoryLabel} />
                      <List.Item.Detail.Metadata.Label title="适用范围" text={item.scope} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label
                        title="推荐修饰符"
                        text={item.recommendedFlags || '无 (默认精准匹配)'}
                      />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制正则表达式" content={item.pattern} />
                  <Action
                    title="载入到实时正则测试器"
                    icon={Icon.Play}
                    shortcut={{ modifiers: ['cmd'], key: 't' }}
                    onAction={() => handleLoadIntoTester(item)}
                  />
                  <Action.CopyToClipboard
                    title="复制带斜杠字面量"
                    content={`/${item.pattern}/${item.recommendedFlags || ''}`}
                    shortcut={{ modifiers: ['cmd'], key: 'c' }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {currentMode === 'tester' && (
        <List.Section title="实时正则匹配与捕获组透视">
          <List.Item
            id="tester-summary"
            icon={regexMatchResult.isValidRegex ? Icon.CheckCircle : Icon.XMarkCircle}
            title={
              regexMatchResult.isValidRegex
                ? `共命中 ${regexMatchResult.totalMatches} 处匹配（耗时 ${regexMatchResult.elapsedMs}ms）`
                : '正则表达式语法错误或已触发安全熔断'
            }
            subtitle={activeTesterPattern}
            accessories={[
              regexMatchResult.isValidRegex
                ? { tag: '语法有效' }
                : { tag: { value: '异常拦截', color: Color.Red } }
            ]}
            detail={
              <List.Item.Detail
                markdown={
                  regexMatchResult.isValidRegex
                    ? `### 实时测试结果
\`\`\`regexp
/${activeTesterPattern}/g
\`\`\`

#### 待测样本原文
\`\`\`text
${testSample}
\`\`\`

#### 命中片段与捕获组清单 (${regexMatchResult.totalMatches} 项)
${
  regexMatchResult.matches.length === 0
    ? '*当前样本未命中任何匹配项*'
    : regexMatchResult.matches
        .map(
          (m) =>
            `- **Match #${m.index + 1}**: \`${m.text}\` *(位置 [${m.start}, ${m.end}])*\n${
              m.groups.length > 0
                ? m.groups.map((g) => `  - Group ${g.groupIndex}: \`${g.value}\``).join('\n')
                : ''
            }`
        )
        .join('\n')
}
`
                    : `### 正则异常诊断
> **错误详情**：${regexMatchResult.errorMessage}
`
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="复制当前正则表达式" content={activeTesterPattern} />
                <Action.CopyToClipboard
                  title="复制全部命中结果"
                  content={regexMatchResult.matches.map((m) => m.text).join('\n')}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {currentMode === 'cron' && (
        <List.Section title="Cron 语义直译与未来 5 次触发时间推算">
          <List.Item
            id="cron-live-result"
            icon={cronResult.isValid ? Icon.Clock : Icon.XMarkCircle}
            title={cronResult.chineseSummary}
            subtitle={cronResult.expression}
            accessories={[
              cronResult.isValid
                ? { tag: '解析成功' }
                : { tag: { value: '表达式有误', color: Color.Red } }
            ]}
            detail={
              <List.Item.Detail
                markdown={
                  cronResult.isValid
                    ? `### Cron 自然语言直译
> **${cronResult.chineseSummary}**

#### 未来 5 次执行时间推算 (Asia/Shanghai)
| 批次 | 触发绝对时间 | 相对倒计时 |
| :--- | :--- | :--- |
${cronResult.nextRuns
  .map((r, i) => `| 第 ${i + 1} 次 | \`${r.formattedTime}\` | ${r.relativeTime} |`)
  .join('\n')}

#### 槽位字段拆解
| 槽位 | 当前值 | 语义说明 |
| :--- | :--- | :--- |
${cronResult.slots.map((s) => `| ${s.name} | \`${s.value}\` | ${s.meaning} |`).join('\n')}
`
                    : `### Cron 解析失败
> **错误原因**：${cronResult.errorMessage}
`
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="复制 Cron 表达式" content={cronResult.expression} />
                <Action.CopyToClipboard
                  title="复制未来 5 次执行时间"
                  content={cronResult.nextRuns.map((r) => r.formattedTime).join('\n')}
                />
              </ActionPanel>
            }
          />
          {CRON_TEMPLATES.map((tpl) => (
            <List.Item
              key={tpl.id}
              id={tpl.id}
              icon={Icon.Calendar}
              title={tpl.title}
              subtitle={tpl.expr}
              accessories={[{ text: '常用模板' }]}
              actions={
                <ActionPanel>
                  <Action
                    title="推算此 Cron 模板"
                    icon={Icon.Play}
                    onAction={() => setSearchText(tpl.expr)}
                  />
                  <Action.CopyToClipboard title="复制模板表达式" content={tpl.expr} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  )
}

export default RegexCronCommand
