import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  useState,
  useMemo,
} from '../../index.js'
import type { CalcMode, ChmodRoleBreakdown } from './types.js'
import { calculateIpv4Cidr, convertChmod } from './chmod-cidr-service.js'

export * from './types.js'
export * from './chmod-cidr-service.js'

const PRESET_CIDRS = [
  '192.168.1.0/24',
  '10.244.0.0/16',
  '172.16.32.0/20',
  '192.168.10.128/26',
  '10.0.0.1/31',
  '203.0.113.42/32',
]

const PRESET_CHMODS = [
  { code: '755', desc: '可执行程序 / 公开目录标准权限 (rwxr-xr-x)' },
  { code: '644', desc: '常规配置文件 / 静态资源标准权限 (rw-r--r--)' },
  { code: '600', desc: 'SSH 私钥 (~/.ssh/id_ed25519) 严格私有权限 (rw-------)' },
  { code: '700', desc: '私有目录 (~/.ssh) 仅属主可访问权限 (rwx------)' },
  { code: '777', desc: '全放开读写执行权限（存在安全风险）' },
]

export function ChmodCidrCalcCommand() {
  const [mode, setMode] = useState<CalcMode>('cidr')
  const [queryText, setQueryText] = useState<string>('192.168.1.0/24')

  const cidrState = useMemo(() => {
    if (mode !== 'cidr') return null
    try {
      const result = calculateIpv4Cidr(queryText)
      return { ok: true as const, result }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [mode, queryText])

  const chmodState = useMemo(() => {
    if (mode !== 'chmod') return null
    try {
      const result = convertChmod(queryText)
      return { ok: true as const, result }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [mode, queryText])

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder={
        mode === 'cidr'
          ? '输入 IPv4/CIDR（如 192.168.1.0/24 或 10.0.0.1/28）...'
          : '输入八进制权限（如 755、600）或符号权限（如 rwxr-xr-x）...'
      }
      searchText={queryText}
      onSearchTextChange={(val: string) => {
        setQueryText(val)
        const trimmed = (val || '').trim()
        if (trimmed) {
          if (trimmed.includes('.') || trimmed.includes('/')) {
            setMode('cidr')
          } else if (/^[0-7]{3}$/.test(trimmed) || /^[rwx-]{9}$/i.test(trimmed)) {
            setMode('chmod')
          }
        }
      }}
      searchBarAccessory={
        <List.Dropdown
          tooltip="切换计算器模式"
          value={mode}
          onChange={(val: string) => {
            const nextMode = val as CalcMode
            setMode(nextMode)
            setQueryText(nextMode === 'cidr' ? '192.168.1.0/24' : '755')
          }}
        >
          <List.Dropdown.Item title="IPv4 CIDR 子网计算器" value="cidr" />
          <List.Dropdown.Item title="Linux chmod 权限推演" value="chmod" />
        </List.Dropdown>
      }
    >
      {mode === 'cidr' && cidrState && !cidrState.ok && (
        <List.Section title="CIDR 网段格式错误">
          <List.Item
            id="cidr-error"
            title="无法解析 IPv4 CIDR"
            subtitle={cidrState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '输入错误', color: Color.Red } }]}
            detail={
              <List.Item.Detail
                markdown={`### IPv4 CIDR 校验错误\n\n\`\`\`text\n${cidrState.error}\n\`\`\`\n\n示例格式：\`192.168.1.0/24\`、\`10.0.0.0/8\`、\`172.16.0.1/32\`。`}
              />
            }
          />
        </List.Section>
      )}

      {mode === 'cidr' && cidrState && cidrState.ok && (
        <List.Section title="IPv4 CIDR 子网规划计算结果">
          <List.Item
            id="cidr-main"
            title={`${cidrState.result.networkAddress}/${cidrState.result.prefixLength}`}
            subtitle={`可用范围: ${cidrState.result.firstUsableIp} ~ ${cidrState.result.lastUsableIp} (${cidrState.result.usableHosts.toLocaleString()} 台主机)`}
            icon={Icon.Wifi}
            accessories={[{ tag: `掩码 ${cidrState.result.netmask}` }]}
            detail={
              <List.Item.Detail
                markdown={`### 子网规划详情 (\`${cidrState.result.input}\`)\n\n- **可用主机范围**: \`${cidrState.result.firstUsableIp}\` - \`${cidrState.result.lastUsableIp}\`\n- **32位二进制掩码**:\n\`\`\`text\n${cidrState.result.netmaskBinary}\n\`\`\`\n- **地址段属性**: ${cidrState.result.addressScope}\n- **路由说明**: ${cidrState.result.usageHint}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="网络地址 (Network)"
                      text={cidrState.result.networkAddress}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="子网掩码 (Netmask)"
                      text={cidrState.result.netmask}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="反掩码 (Wildcard)"
                      text={cidrState.result.wildcardMask}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="广播地址 (Broadcast)"
                      text={cidrState.result.broadcastAddress}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="总地址容量"
                      text={`${cidrState.result.totalHosts.toLocaleString()} 个 IP`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="可用主机数"
                      text={`${cidrState.result.usableHosts.toLocaleString()} 台`}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制可用 IP 范围"
                  content={`${cidrState.result.firstUsableIp} - ${cidrState.result.lastUsableIp}`}
                />
                <Action.CopyToClipboard
                  title="复制子网掩码"
                  content={cidrState.result.netmask}
                />
                <Action.CopyToClipboard
                  title="复制网络地址/CIDR"
                  content={`${cidrState.result.networkAddress}/${cidrState.result.prefixLength}`}
                />
              </ActionPanel>
            }
          />

          {PRESET_CIDRS.map((preset: string) => (
            <List.Item
              key={preset}
              id={`preset-cidr-${preset}`}
              title={`常用网段模板: ${preset}`}
              subtitle="点击回车立即载入此网段进行子网计算"
              icon={Icon.Globe}
              accessories={[{ tag: '快速切换' }]}
              actions={
                <ActionPanel>
                  <Action
                    title={`计算 ${preset}`}
                    icon={Icon.Play}
                    onAction={() => setQueryText(preset)}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {mode === 'chmod' && chmodState && !chmodState.ok && (
        <List.Section title="chmod 权限表达式错误">
          <List.Item
            id="chmod-error"
            title="无法解析 chmod 权限值"
            subtitle={chmodState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '格式错误', color: Color.Red } }]}
            detail={
              <List.Item.Detail
                markdown={`### chmod 权限格式错误\n\n\`\`\`text\n${chmodState.error}\n\`\`\``}
              />
            }
          />
        </List.Section>
      )}

      {mode === 'chmod' && chmodState && chmodState.ok && (
        <List.Section title="Linux chmod 权限位双向推演">
          <List.Item
            id="chmod-main"
            title={`${chmodState.result.octal}  (${chmodState.result.lsSymbolic})`}
            subtitle={chmodState.result.chmodCommand}
            icon={chmodState.result.isWorldWritable ? Icon.ExclamationMark : Icon.Shield}
            accessories={[
              chmodState.result.isWorldWritable
                ? { tag: { value: '高危全局可写', color: Color.Red } }
                : { tag: chmodState.result.symbolic },
            ]}
            detail={
              <List.Item.Detail
                markdown={`### Linux 权限矩阵 (\`${chmodState.result.octal}\` / \`${
                  chmodState.result.lsSymbolic
                }\`)\n\n${
                  chmodState.result.securityWarning
                    ? `> **${chmodState.result.securityWarning}**\n\n`
                    : ''
                }| 角色 | 八进制 | 符号 | 读取 (r=4) | 写入 (w=2) | 执行 (x=1) |\n| :--- | :---: | :---: | :---: | :---: | :---: |\n${chmodState.result.roles
                  .map(
                    (r: ChmodRoleBreakdown) =>
                      `| ${r.role} | \`${r.digit}\` | \`${r.symbolic}\` | ${
                        r.read ? '允许' : '-'
                      } | ${r.write ? '允许' : '-'} | ${r.execute ? '允许' : '-'} |`,
                  )
                  .join('\n')}\n\n### 终端命令\n\`\`\`bash\n${
                  chmodState.result.chmodCommand
                }\n${chmodState.result.chmodRecursiveCommand}\n\`\`\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="八进制表示 (Octal)"
                      text={chmodState.result.octal}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="符号表示 (Symbolic)"
                      text={chmodState.result.symbolic}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="ls -l 显示格式"
                      text={chmodState.result.lsSymbolic}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 chmod 命令"
                  content={chmodState.result.chmodCommand}
                />
                <Action.CopyToClipboard
                  title="复制八进制权限值"
                  content={chmodState.result.octal}
                />
                <Action.CopyToClipboard
                  title="复制符号权限值"
                  content={chmodState.result.symbolic}
                />
              </ActionPanel>
            }
          />

          {PRESET_CHMODS.map((item) => (
            <List.Item
              key={item.code}
              id={`preset-chmod-${item.code}`}
              title={`chmod ${item.code}`}
              subtitle={item.desc}
              icon={Icon.Key}
              accessories={[
                item.code === '777'
                  ? { tag: { value: '风险权限', color: Color.Red } }
                  : { tag: '常用预设' },
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title={`查看 chmod ${item.code} 详情`}
                    icon={Icon.Play}
                    onAction={() => setQueryText(item.code)}
                  />
                  <Action.CopyToClipboard
                    title={`复制 chmod ${item.code}`}
                    content={`chmod ${item.code} `}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  )
}

export default ChmodCidrCalcCommand
