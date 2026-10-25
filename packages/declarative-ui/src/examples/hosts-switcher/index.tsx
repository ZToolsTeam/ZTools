import React, {
  Action,
  ActionPanel,
  Form,
  Icon,
  List,
  Toast,
  showToast,
  useMemo,
  useState,
  useNavigation
} from '../../index.js'
import {
  DEFAULT_HOSTS_PROFILES,
  applyCombinedHosts,
  buildCombinedHostsContent,
  flushDnsCache,
  parseHostsContent,
  readSystemHosts
} from './hosts-service.js'
import type { HostsProfile } from './types.js'

export * from './types.js'
export * from './hosts-service.js'

export function HostsProfileForm({
  initialProfile,
  onSave
}: {
  initialProfile?: HostsProfile
  onSave: (profile: HostsProfile) => void
}) {
  const { pop } = useNavigation()
  const [name, setName] = useState(initialProfile?.name ?? '')
  const [rawContent, setRawContent] = useState(
    initialProfile?.rawContent ?? '127.0.0.1       example.local'
  )

  const handleSubmit = async () => {
    if (!name.trim()) {
      await showToast({ style: Toast.Style.Failure, title: '方案名称不能为空' })
      return
    }
    const rules = parseHostsContent(rawContent)
    const validCount = rules.filter((r) => r.isValid).length
    const invalidCount = rules.filter((r) => !r.isValid).length

    onSave({
      id: initialProfile?.id || `hosts-${Date.now()}`,
      name: name.trim(),
      isEnabled: initialProfile?.isEnabled ?? true,
      isSystem: initialProfile?.isSystem ?? false,
      rawContent,
      rulesCount: validCount,
      invalidCount,
      updatedAt: Date.now(),
      updatedAtFormatted: '刚刚更新'
    })
    await showToast({ style: Toast.Style.Success, title: `已保存方案: ${name.trim()}` })
    pop()
  }

  return (
    <Form
      navigationTitle={initialProfile ? '编辑 Hosts 方案' : '新建 Hosts 环境方案'}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存方案" icon={Icon.CheckCircle} onSubmit={handleSubmit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="方案名称"
        placeholder="如：测试环境集群 A"
        value={name}
        onChange={setName}
      />
      <Form.TextArea
        id="rawContent"
        title="Hosts 映射规则"
        placeholder="每行一条：IP 域名 # 备注"
        value={rawContent}
        onChange={setRawContent}
      />
    </Form>
  )
}

export interface HostsSwitcherCommandProps {
  featureCode?: string
  initialProfiles?: HostsProfile[]
  hostOverride?: unknown
}

export function HostsSwitcherCommand(props: HostsSwitcherCommandProps = {}) {
  const { push } = useNavigation()
  const [profiles, setProfiles] = useState<HostsProfile[]>(
    props.initialProfiles ?? DEFAULT_HOSTS_PROFILES
  )
  const [filterStatus, setFilterStatus] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)

  React.useEffect(() => {
    if (!props.initialProfiles) {
      void (async () => {
        const sysRes = await readSystemHosts(undefined, props.hostOverride)
        if (sysRes.ok && sysRes.content.trim()) {
          const rules = parseHostsContent(sysRes.content)
          const validCount = rules.filter((r) => r.isValid).length
          const invalidCount = rules.filter((r) => !r.isValid).length
          setProfiles((prev) =>
            prev.map((p) =>
              p.id === 'hosts-system'
                ? {
                    ...p,
                    rawContent: sysRes.content,
                    rulesCount: validCount,
                    invalidCount
                  }
                : p
            )
          )
        }
      })()
    }
  }, [])

  const filteredProfiles = useMemo(() => {
    const byStatus = profiles.filter((p) => {
      if (filterStatus === 'enabled') return p.isEnabled
      if (filterStatus === 'disabled') return !p.isEnabled
      return true
    })
    const q = searchText.trim().toLowerCase()
    if (!q) return byStatus
    return byStatus.filter(
      (p) => p.name.toLowerCase().includes(q) || p.rawContent.toLowerCase().includes(q)
    )
  }, [profiles, filterStatus, searchText])

  const activeCount = useMemo(
    () => profiles.filter((p) => p.isEnabled).length,
    [profiles]
  )

  const handleToggleProfile = async (profileId: string) => {
    const next = profiles.map((p) =>
      p.id === profileId ? { ...p, isEnabled: !p.isEnabled } : p
    )
    setProfiles(next)
    setIsLoading(true)
    try {
      const merged = buildCombinedHostsContent(next)
      const res = await applyCombinedHosts(merged.combinedContent, undefined, props.hostOverride)
      if (!res.success) {
        await showToast({
          style: Toast.Style.Failure,
          title: '写入系统 Hosts 受阻',
          message: res.error
        })
        return
      }
      await showToast({
        style: Toast.Style.Success,
        title: `已生效 (${merged.activeRulesCount} 条映射) 并刷新 DNS`
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleFlushDns = async () => {
    setIsLoading(true)
    try {
      const res = await flushDnsCache(undefined, props.hostOverride)
      if (!res.success) {
        await showToast({
          style: Toast.Style.Failure,
          title: '刷新 DNS 缓存失败',
          message: res.error
        })
        return
      }
      await showToast({
        style: Toast.Style.Success,
        title: '本地 DNS 缓存已成功刷新'
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleOpenCreateForm = () => {
    push(
      <HostsProfileForm
        onSave={(created) => {
          setProfiles((prev) => [...prev, created])
        }}
      />
    )
  }

  const handleEditProfile = (profile: HostsProfile) => {
    push(
      <HostsProfileForm
        initialProfile={profile}
        onSave={(updated) => {
          setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
        }}
      />
    )
  }

  const handleDeleteProfile = async (id: string) => {
    setProfiles((prev) => prev.filter((p) => p.id !== id))
    await showToast({ style: Toast.Style.Success, title: '已删除该 Hosts 方案' })
  }

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索方案名、规则 IP 或域名 (如: 127.0.0.1、staging.ztools.cn) ..."
      searchBarAccessory={
        <List.Dropdown
          value={filterStatus}
          onChange={(v: string) => setFilterStatus(v as 'all' | 'enabled' | 'disabled')}
          tooltip="按启用状态筛选"
        >
          <List.Dropdown.Item title="全部方案" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="仅查看已启用" value="enabled" icon={Icon.CheckCircle} />
          <List.Dropdown.Item title="仅查看已禁用" value="disabled" icon={Icon.Circle} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共 ${profiles.length} 个方案（已激活 ${activeCount} 个） · 系统 DNS 缓存已处于最新状态`,
        actions: [
          { id: 'new-profile', title: '新建方案', onAction: handleOpenCreateForm },
          { id: 'flush-dns', title: '刷新 DNS', onAction: handleFlushDns }
        ]
      }}
    >
      {filteredProfiles.map((profile) => (
        <List.Item
          key={profile.id}
          id={profile.id}
          title={profile.name}
          subtitle={`${profile.rulesCount} 条规则`}
          icon={profile.isEnabled ? Icon.CheckCircle : Icon.Circle}
          accessories={[
            ...(profile.isSystem ? [{ tag: '系统源文件' }] : []),
            { text: profile.isEnabled ? '已启用' : '未激活' }
          ]}
          detail={
            <List.Item.Detail
              markdown={`\`\`\`ini\n${profile.rawContent}\n\`\`\``}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label title="方案名称" text={profile.name} />
                  <List.Item.Detail.Metadata.Label
                    title="生效状态"
                    text={profile.isEnabled ? '正在生效中' : '已停用'}
                  />
                  <List.Item.Detail.Metadata.Label
                    title="规则数量"
                    text={`${profile.rulesCount} 条有效映射`}
                  />
                  <List.Item.Detail.Metadata.Separator />
                  <List.Item.Detail.Metadata.Label
                    title="最后更新"
                    text={profile.updatedAtFormatted}
                  />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action
                title={profile.isEnabled ? '禁用此方案' : '启用此方案'}
                icon={profile.isEnabled ? Icon.XMarkCircle : Icon.CheckCircle}
                onAction={() => handleToggleProfile(profile.id)}
              />
              <Action
                title="编辑方案内容"
                icon={Icon.Pencil}
                shortcut={{ modifiers: ['cmd'], key: 'e' }}
                onAction={() => handleEditProfile(profile)}
              />
              <Action
                title="立即刷新 DNS 缓存"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={handleFlushDns}
              />
              <Action
                title="新建环境方案"
                icon={Icon.Plus}
                shortcut={{ modifiers: ['cmd'], key: 'n' }}
                onAction={handleOpenCreateForm}
              />
              {!profile.isSystem ? (
                <Action
                  title="删除此方案"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                  onAction={() => handleDeleteProfile(profile.id)}
                />
              ) : null}
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default HostsSwitcherCommand
