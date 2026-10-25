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
  getProxyStatus,
  parseSshConfigFile,
  setDevToolsProxy,
  unsetDevToolsProxy
} from './ssh-proxy-service.js'
import type { ProxyStatus, SshHostEntry } from './types.js'

export * from './types.js'
export * from './ssh-proxy-service.js'

export interface SshProxyHelperCommandProps {
  featureCode?: string
  initialHosts?: SshHostEntry[]
  initialProxyStatus?: ProxyStatus
  hostOverride?: unknown
}

export function SshProxyHelperCommand(props: SshProxyHelperCommandProps = {}) {
  const [sshHosts, setSshHosts] = useState<SshHostEntry[]>(props.initialHosts ?? [])
  const [proxyStatus, setProxyStatus] = useState<ProxyStatus>(
    props.initialProxyStatus ?? {
      isEnabled: true,
      port: 7890,
      isGitSet: true,
      isNpmSet: true,
      detectedPorts: [7890, 10808]
    }
  )
  const [filterCategory, setFilterCategory] = useState<'all' | 'prod' | 'tunnels'>('all')
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(!props.initialHosts)

  useEffect(() => {
    if (!props.initialHosts) {
      void (async () => {
        setIsLoading(true)
        try {
          const [hosts, status] = await Promise.all([
            parseSshConfigFile(undefined, props.hostOverride),
            getProxyStatus(undefined, props.hostOverride)
          ])
          setSshHosts(hosts)
          if (!props.initialProxyStatus) {
            setProxyStatus(status)
          }
        } finally {
          setIsLoading(false)
        }
      })()
    }
  }, [])

  const filteredHosts = useMemo(() => {
    const byCat = sshHosts.filter((h) => {
      if (filterCategory === 'prod') return Boolean(h.proxyJump || /prod|bastion|jump/i.test(h.host))
      if (filterCategory === 'tunnels') return Boolean(h.localForwards && h.localForwards.length > 0)
      return true
    })
    const q = searchText.trim().toLowerCase()
    if (!q) return byCat
    return byCat.filter(
      (h) =>
        h.host.toLowerCase().includes(q) ||
        h.hostName.toLowerCase().includes(q) ||
        (h.user && h.user.toLowerCase().includes(q))
    )
  }, [sshHosts, filterCategory, searchText])

  const handleToggleProxy = async () => {
    try {
      if (proxyStatus.isEnabled) {
        const next = await unsetDevToolsProxy({ applySystemGit: true }, props.hostOverride)
        setProxyStatus(next)
        await showToast({
          style: Toast.Style.Success,
          title: '已关闭 Git & NPM 全局命令行代理'
        })
      } else {
        const next = await setDevToolsProxy(
          proxyStatus.port,
          { applySystemGit: true },
          props.hostOverride
        )
        setProxyStatus(next)
        await showToast({
          style: Toast.Style.Success,
          title: `已开启 Git & NPM 代理 (127.0.0.1:${proxyStatus.port})`
        })
      }
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: '切换开发代理失败',
        message: err instanceof Error ? err.message : '端口未监听'
      })
    }
  }

  const currentProxyPort = proxyStatus.port
  const isProxyEnabled = proxyStatus.isEnabled

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={true}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索 SSH 主机别名、IP、用户或代理端口 (如: prod-db、192.168、root) ..."
      searchBarAccessory={
        <List.Dropdown
          value={filterCategory}
          onChange={(v: string) => setFilterCategory(v as 'all' | 'prod' | 'tunnels')}
          tooltip="筛选主机分类"
        >
          <List.Dropdown.Item title="全部主机与代理" value="all" icon={Icon.List} />
          <List.Dropdown.Item title="仅查看生产 / 跳板机" value="prod" icon={Icon.Lock} />
          <List.Dropdown.Item title="仅查看本地端口隧道" value="tunnels" icon={Icon.ArrowRight} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `Git/NPM 代理: ${isProxyEnabled ? `已开启 (端口: ${currentProxyPort})` : '已关闭'} · 共 ${sshHosts.length} 台 SSH 主机`,
        actions: [
          {
            id: 'toggle-proxy',
            title: isProxyEnabled ? '关闭代理' : '开启代理',
            onAction: handleToggleProxy
          }
        ]
      }}
    >
      <List.Section title="开发工具链代理管控">
        <List.Item
          id="dev-proxy-card"
          title={`Git & NPM 命令行代理 (${isProxyEnabled ? '已启用' : '已停用'})`}
          subtitle={`本地代理端口: 127.0.0.1:${currentProxyPort}`}
          icon={isProxyEnabled ? Icon.CheckCircle : Icon.Circle}
          accessories={[
            { tag: isProxyEnabled ? '已全局接管' : '直连直通' },
            { text: isProxyEnabled ? 'Git & NPM 加速中' : '未生效' }
          ]}
          detail={
            <List.Item.Detail
              markdown={`### 命令行代理环境变量\n\`\`\`bash\n# macOS / Linux (Bash / Zsh)\nexport http_proxy=http://127.0.0.1:${currentProxyPort}\nexport https_proxy=http://127.0.0.1:${currentProxyPort}\n\n# Windows PowerShell\n$env:http_proxy="http://127.0.0.1:${currentProxyPort}"\n$env:https_proxy="http://127.0.0.1:${currentProxyPort}"\n\`\`\``}
              metadata={
                <List.Item.Detail.Metadata>
                  <List.Item.Detail.Metadata.Label
                    title="Git 全局代理"
                    text={
                      proxyStatus.isGitSet
                        ? `http://127.0.0.1:${currentProxyPort}`
                        : '未配置 (直连)'
                    }
                  />
                  <List.Item.Detail.Metadata.Label
                    title="NPM 代理"
                    text={
                      proxyStatus.isNpmSet
                        ? `http://127.0.0.1:${currentProxyPort}`
                        : '未配置 (直连)'
                    }
                  />
                  <List.Item.Detail.Metadata.Label
                    title="嗅探端口"
                    text={proxyStatus.detectedPorts.join(', ') || '无可用代理端口'}
                  />
                </List.Item.Detail.Metadata>
              }
            />
          }
          actions={
            <ActionPanel>
              <Action
                title={
                  isProxyEnabled
                    ? '关闭 Git & NPM 全局代理'
                    : '一键开启 Git & NPM 全局代理'
                }
                icon={isProxyEnabled ? Icon.XMarkCircle : Icon.CheckCircle}
                onAction={handleToggleProxy}
              />
              <Action.CopyToClipboard
                title="复制终端代理环境变量指令"
                content={`export http_proxy=http://127.0.0.1:${currentProxyPort}; export https_proxy=http://127.0.0.1:${currentProxyPort}`}
                shortcut={{ modifiers: ['cmd'], key: 'c' }}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="SSH 主机列表">
        {filteredHosts.map((host) => (
          <List.Item
            key={host.host}
            id={host.host}
            title={host.host}
            subtitle={`${host.user || 'root'}@${host.hostName}:${host.port || 22}`}
            icon={Icon.Terminal}
            accessories={[
              ...(host.proxyJump ? [{ tag: `跳板: ${host.proxyJump}` }] : []),
              { text: host.identityFileShort || '默认密钥' }
            ]}
            detail={
              <List.Item.Detail
                markdown={`\`\`\`ini\nHost ${host.host}\n  HostName ${host.hostName}\n  User ${host.user || 'root'}\n  Port ${host.port || 22}\n${host.identityFile ? `  IdentityFile ${host.identityFile}\n` : ''}${host.proxyJump ? `  ProxyJump ${host.proxyJump}\n` : ''}\`\`\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="Host 别名" text={host.host} />
                    <List.Item.Detail.Metadata.Label title="目标 IP / 域名" text={host.hostName} />
                    <List.Item.Detail.Metadata.Label
                      title="登录用户名"
                      text={host.user || 'root'}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="SSH 端口"
                      text={String(host.port || 22)}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="认证密钥"
                      text={host.identityFile || '系统默认密钥'}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 SSH 连接命令"
                  content={`ssh ${host.host}`}
                  icon={Icon.Terminal}
                />
                <Action.CopyToClipboard
                  title="复制主机真实 IP / 域名"
                  content={host.hostName}
                  shortcut={{ modifiers: ['cmd', 'shift'], key: 'c' }}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  )
}

export default SshProxyHelperCommand
