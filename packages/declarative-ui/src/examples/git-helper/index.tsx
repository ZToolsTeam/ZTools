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
  COMMIT_TYPES,
  GITIGNORE_STACK_TEMPLATES,
  buildConventionalCommit,
  generateGitignoreContent,
  searchGitEmergencies
} from './git-helper-service.js'
import type { GitHelperMode } from './types.js'

export * from './types.js'
export * from './git-helper-service.js'

export interface GitHelperCommandProps {
  featureCode?: string
  initialMode?: GitHelperMode
  initialSearchText?: string
  initialSelectedStacks?: string[]
}

export function GitHelperCommand(props: GitHelperCommandProps = {}) {
  const defaultMode: GitHelperMode =
    props.initialMode ??
    (props.featureCode === 'git-commit-builder'
      ? 'commit'
      : props.featureCode === 'gitignore-generator'
        ? 'gitignore'
        : 'emergency')

  const [mode, setMode] = useState<GitHelperMode>(defaultMode)
  const [searchText, setSearchText] = useState<string>(props.initialSearchText ?? '')
  const [selectedStacks, setSelectedStacks] = useState<string[]>(
    props.initialSelectedStacks ?? ['Node', 'ReactVue', 'macOS', 'Windows', 'IDEs']
  )

  const filteredEmergencies = useMemo(() => searchGitEmergencies(searchText), [searchText])

  const parsedCommitInput = useMemo(() => {
    const raw = searchText.trim()
    if (!raw) {
      return { scope: 'core', subject: '新增声明式插件独立开发与安全扫描支持' }
    }
    const colonIdx = raw.indexOf(':')
    if (colonIdx > 0 && colonIdx < 24) {
      return {
        scope: raw.slice(0, colonIdx).trim(),
        subject: raw.slice(colonIdx + 1).trim()
      }
    }
    return { scope: '', subject: raw }
  }, [searchText])

  const gitignoreOutput = useMemo(
    () => generateGitignoreContent(selectedStacks),
    [selectedStacks]
  )

  const toggleStack = (stackId: string) => {
    setSelectedStacks((prev) =>
      prev.includes(stackId) ? prev.filter((id) => id !== stackId) : [...prev, stackId]
    )
  }

  return (
    <List
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder={
        mode === 'emergency'
          ? '输入大白话翻车场景（如：撤销提交、漏提文件、恢复误删分支、撤销pull）...'
          : mode === 'commit'
            ? '输入改动说明（支持 scope:描述 格式，如 auth:修复登录态刷新失败）...'
            : '搜索技术栈或系统模板（如：Node、Python、Go、Rust、macOS）...'
      }
      searchBarAccessory={
        <List.Dropdown
          value={mode}
          onChange={(v) => setMode(v as GitHelperMode)}
          tooltip="切换 Git 助手工作模式"
        >
          <List.Dropdown.Item title="Git 翻车自救锦囊" value="emergency" icon={Icon.Shield} />
          <List.Dropdown.Item title="规范提交生成器 (Commit)" value="commit" icon={Icon.Pencil} />
          <List.Dropdown.Item title=".gitignore 模板合成" value="gitignore" icon={Icon.Document} />
        </List.Dropdown>
      }
      isShowingDetail={true}
    >
      {mode === 'emergency' && (
        <List.Section title={`高频翻车现场与自救指南（共 ${filteredEmergencies.length} 项）`}>
          {filteredEmergencies.map((item) => (
            <List.Item
              key={item.id}
              id={item.id}
              icon={Icon.Shield}
              title={item.title}
              subtitle={item.primaryCommand}
              accessories={[
                item.safetyLevel === '有损警告'
                  ? { tag: { value: item.safetyLevel, color: Color.Red } }
                  : { tag: item.safetyLevel }
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 事故现场：${item.title}

#### 首选救命命令（回车一键复制）
\`\`\`bash
${item.primaryCommand}
\`\`\`

#### 分步安全排障操作
${item.steps
  .map(
    (s, i) => `${i + 1}. **${s.title}**
\`\`\`bash
${s.cmd}
\`\`\`
*${s.explain}*`
  )
  .join('\n\n')}

#### 底层 Git 原理与防坑说明
> ${item.principle}
`}
                  metadata={
                    <List.Item.Detail.Metadata>
                      <List.Item.Detail.Metadata.Label title="场景分类" text={item.categoryLabel} />
                      <List.Item.Detail.Metadata.Label title="安全等级" text={item.safetyLevel} />
                      <List.Item.Detail.Metadata.Separator />
                      <List.Item.Detail.Metadata.Label title="上手难度" text={item.difficulty} />
                    </List.Item.Detail.Metadata>
                  }
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制首选救命命令" content={item.primaryCommand} />
                  <Action.CopyToClipboard
                    title="复制全部自救步骤命令"
                    content={item.steps.map((s) => `# ${s.title}\n${s.cmd}`).join('\n\n')}
                    shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {mode === 'commit' && (
        <List.Section title="选择 Conventional Commits 提交类型（强制中文规范）">
          {COMMIT_TYPES.map((t) => {
            const built = buildConventionalCommit({
              type: t.type,
              scope: parsedCommitInput.scope,
              subject: parsedCommitInput.subject
            })
            return (
              <List.Item
                key={t.type}
                id={t.type}
                icon={Icon.Pencil}
                title={`${t.type}: ${t.chineseMeaning}`}
                subtitle={built.message}
                accessories={[{ tag: `前缀 ${t.type}:` }]}
                detail={
                  <List.Item.Detail
                    markdown={`### 规范提交命令预览
\`\`\`bash
${built.gitCommand}
\`\`\`

#### 生成的 Commit Message
> **${built.message}**

#### 类型规范说明 (\`${t.type}\`)
- **中文定义**：${t.chineseMeaning}
- **适用边界**：${t.description}

#### 团队标准范例
${t.examples.map((ex) => `- \`${ex}\``).join('\n')}
`}
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.CopyToClipboard
                      title="复制完整 git commit 命令"
                      content={built.gitCommand}
                    />
                    <Action.CopyToClipboard
                      title="仅复制中文提交备注文本"
                      content={built.message}
                      shortcut={{ modifiers: ['cmd'], key: 'c' }}
                    />
                  </ActionPanel>
                }
              />
            )
          })}
        </List.Section>
      )}

      {mode === 'gitignore' && (
        <List.Section
          title={`.gitignore 模板多选合成（已选 ${selectedStacks.length} 个栈，去重后 ${gitignoreOutput.totalUniqueRules} 条规则）`}
        >
          {GITIGNORE_STACK_TEMPLATES.map((tpl) => {
            const checked = selectedStacks.includes(tpl.id)
            return (
              <List.Item
                key={tpl.id}
                id={tpl.id}
                icon={checked ? Icon.CheckCircle : Icon.Circle}
                title={tpl.name}
                subtitle={`${tpl.category} · 含 ${tpl.rules.length} 条忽略规则`}
                accessories={[
                  {
                    tag: checked ? '已勾选合并' : '未选'
                  }
                ]}
                detail={
                  <List.Item.Detail
                    markdown={`### 合成后的 \`.gitignore\` 预览（自动去重）
\`\`\`gitignore
${gitignoreOutput.content}
\`\`\`
`}
                    metadata={
                      <List.Item.Detail.Metadata>
                        <List.Item.Detail.Metadata.Label
                          title="已合并技术栈"
                          text={gitignoreOutput.selectedStacks.join(', ')}
                        />
                        <List.Item.Detail.Metadata.Label
                          title="去重后规则总数"
                          text={`${gitignoreOutput.totalUniqueRules} 条`}
                        />
                      </List.Item.Detail.Metadata>
                    }
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.CopyToClipboard
                      title="复制合成后的 .gitignore 全文"
                      content={gitignoreOutput.content}
                    />
                    <Action
                      title={checked ? `取消勾选 ${tpl.name}` : `勾选加入 ${tpl.name}`}
                      icon={checked ? Icon.XMarkCircle : Icon.CheckCircle}
                      shortcut={{ modifiers: ['cmd'], key: 't' }}
                      onAction={() => toggleStack(tpl.id)}
                    />
                  </ActionPanel>
                }
              />
            )
          })}
        </List.Section>
      )}
    </List>
  )
}

export default GitHelperCommand
