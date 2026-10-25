import React, {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import {
  filterProjectEntries,
  launchProjectInEditor,
  scanAllRecentProjects
} from './project-service.js'
import type { EditorFilterGroup, ProjectEntry, SupportedEditor } from './types.js'

export * from './types.js'
export * from './project-service.js'

export interface VscodeProjectsCommandProps {
  featureCode?: string
  initialProjects?: ProjectEntry[]
  hostOverride?: unknown
}

function getEditorIcon(editorType: SupportedEditor): Icon {
  switch (editorType) {
    case 'vscode':
    case 'cursor':
    case 'trae':
    case 'windsurf':
      return Icon.Code
    default:
      return Icon.Terminal
  }
}

export function VscodeProjectsCommand(props: VscodeProjectsCommandProps = {}) {
  const defaultEditorFilter: EditorFilterGroup =
    props.featureCode === 'projects-vscode-cursor'
      ? 'vsc-family'
      : props.featureCode === 'projects-jetbrains'
        ? 'jetbrains'
        : 'all'

  const [projects, setProjects] = useState<ProjectEntry[]>(props.initialProjects ?? [])
  const [selectedEditor, setSelectedEditor] = useState<EditorFilterGroup>(defaultEditorFilter)
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(!props.initialProjects)

  const handleRescan = async () => {
    setIsLoading(true)
    try {
      const scanned = await scanAllRecentProjects(undefined, props.hostOverride)
      if (scanned.length > 0 || !props.initialProjects) {
        setProjects(scanned)
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (!props.initialProjects) {
      void handleRescan()
    }
  }, [])

  const filteredProjects = useMemo(
    () => filterProjectEntries(projects, searchText, selectedEditor),
    [projects, searchText, selectedEditor]
  )

  const handleOpenInEditor = async (item: ProjectEntry) => {
    const res = await launchProjectInEditor(item, props.hostOverride)
    if (!res.ok) {
      await showToast({
        style: Toast.Style.Failure,
        title: '无法打开该项目',
        message: res.error
      })
      return
    }
    await showToast({
      style: Toast.Style.Success,
      title: `正在使用 ${item.editorName} 打开 ${item.name}`
    })
  }

  const handleCleanGhostProjects = async () => {
    const missingCount = projects.filter((p) => p.isMissing).length
    setProjects((prev) => prev.filter((p) => !p.isMissing))
    await showToast({
      style: Toast.Style.Success,
      title: `已清理 ${missingCount} 条失效项目记录`
    })
  }

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索项目名、路径、Git 分支或编辑器 (如: ztools、main、cursor) ..."
      searchBarAccessory={
        <List.Dropdown
          value={selectedEditor}
          onChange={(v: string) => setSelectedEditor(v as EditorFilterGroup)}
          tooltip="按编辑器筛选"
        >
          <List.Dropdown.Item title="全部编辑器项目" value="all" icon={Icon.Folder} />
          <List.Dropdown.Item
            title="VS Code 家族 (Code / Cursor / Trae)"
            value="vsc-family"
            icon={Icon.Code}
          />
          <List.Dropdown.Item
            title="JetBrains 家族 (IDEA / WebStorm 等)"
            value="jetbrains"
            icon={Icon.Terminal}
          />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共发现 ${filteredProjects.length} 个本地项目 · 支持回车秒开 IDE、Ctrl+Enter 唤起终端`,
        actions: [
          { id: 'refresh', title: '重新扫描', onAction: handleRescan },
          { id: 'clean-ghost', title: '清理失效记录', onAction: handleCleanGhostProjects }
        ]
      }}
    >
      {filteredProjects.map((item) => (
        <List.Item
          key={`${item.editorType}:${item.path}`}
          id={`${item.editorType}:${item.path}`}
          title={item.name}
          subtitle={item.displayPath}
          icon={getEditorIcon(item.editorType)}
          accessories={[
            ...(item.gitBranch ? [{ tag: `git:${item.gitBranch}` }] : []),
            item.isMissing ? { tag: '路径已失效' } : { tag: item.editorName },
            { text: item.lastOpenedRelative }
          ]}
          actions={
            <ActionPanel>
              <Action
                title={`用 ${item.editorName} 打开项目`}
                icon={Icon.Desktop}
                onAction={() => handleOpenInEditor(item)}
              />
              <Action.CopyToClipboard
                title="复制项目绝对路径"
                content={item.path}
                shortcut={{ modifiers: ['cmd'], key: 'c' }}
              />
              {item.gitBranch ? (
                <Action.CopyToClipboard
                  title="复制 Git 分支名"
                  content={item.gitBranch}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                />
              ) : null}
              <Action
                title="清理失效项目记录"
                icon={Icon.Trash}
                onAction={handleCleanGhostProjects}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default VscodeProjectsCommand
