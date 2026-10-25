import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  ToastStyle,
  useState,
  useMemo,
  useRef,
  useEffect,
} from '../../index.js'
import type { DnsRecordEntry, DnsRecordType, SslCertHealthReport } from './types.js'
import {
  normalizeDomainInput,
  evaluateSslCertInfo,
  inspectDomainSslCert,
  resolveDomainDoh,
} from './ssl-dns-service.js'

export * from './types.js'
export * from './ssl-dns-service.js'

export function SslDomainCheckCommand() {
  const [queryDomain, setQueryDomain] = useState<string>('github.com')
  const [recordFilter, setRecordFilter] = useState<string>('ALL')
  const [certReports, setCertReports] = useState<SslCertHealthReport[]>([])
  const [certError, setCertError] = useState<string>('')
  const [dnsRecords, setDnsRecords] = useState<DnsRecordEntry[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const abortRef = useRef<AbortController | null>(null)

  const handleRunDiagnosis = async (targetDomain?: string): Promise<void> => {
    const raw = (targetDomain ?? queryDomain).trim()
    let domain: string
    try {
      domain = normalizeDomainInput(raw)
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '域名格式不合法',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }

    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller
    setIsLoading(true)
    setCertError('')

    try {
      const types: DnsRecordType[] =
        recordFilter === 'ALL'
          ? ['A', 'AAAA', 'CNAME', 'MX', 'TXT']
          : [recordFilter as DnsRecordType]

      const [certOutcome, dnsOutcome] = await Promise.allSettled([
        inspectDomainSslCert(domain),
        resolveDomainDoh(domain, types, { signal: controller.signal }),
      ])

      if (certOutcome.status === 'fulfilled') {
        setCertReports((prev: SslCertHealthReport[]) => {
          const rest = prev.filter((item: SslCertHealthReport) => item.domain !== certOutcome.value.domain)
          return [certOutcome.value, ...rest]
        })
      } else {
        setCertError(
          certOutcome.reason instanceof Error
            ? certOutcome.reason.message
            : String(certOutcome.reason),
        )
      }

      if (dnsOutcome.status === 'fulfilled') {
        setDnsRecords(dnsOutcome.value)
        await showToast({
          style: ToastStyle.Success,
          title: `已完成 ${domain} 诊断`,
          message: `获取 ${dnsOutcome.value.length} 条 DNS 记录`,
        })
      } else {
        const reasonMsg =
          dnsOutcome.reason instanceof Error
            ? dnsOutcome.reason.message
            : String(dnsOutcome.reason)
        if (!reasonMsg.includes('DOH_ABORTED')) {
          await showToast({
            style: ToastStyle.Failure,
            title: 'DNS-over-HTTPS 查询失败',
            message: reasonMsg,
          })
        }
      }
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void handleRunDiagnosis('github.com')
    return () => {
      if (abortRef.current) {
        abortRef.current.abort()
      }
    }
  }, [])

  return (
    <List
      isShowingDetail={true}
      isLoading={isLoading}
      searchBarPlaceholder="输入域名（如 github.com）查询真实 SSL 证书与 DNS 解析..."
      searchText={queryDomain}
      onSearchTextChange={setQueryDomain}
      searchBarAccessory={
        <List.Dropdown
          tooltip="筛选 DNS 记录类型"
          value={recordFilter}
          onChange={(val: string) => setRecordFilter(val)}
        >
          <List.Dropdown.Item title="全部记录 (SSL + DNS)" value="ALL" />
          <List.Dropdown.Item title="A 记录 (IPv4)" value="A" />
          <List.Dropdown.Item title="AAAA 记录 (IPv6)" value="AAAA" />
          <List.Dropdown.Item title="CNAME 别名记录" value="CNAME" />
          <List.Dropdown.Item title="MX 邮件交换记录" value="MX" />
          <List.Dropdown.Item title="TXT 文本校验记录" value="TXT" />
        </List.Dropdown>
      }
    >
      <List.Section title="SSL/TLS 证书健康度巡检">
        <List.Item
          id="ssl-probe-trigger"
          title={`探测 ${queryDomain.trim() || '目标域名'} 实时 TLS 证书与 DoH 解析`}
          subtitle={certError ? `上次探测异常: ${certError}` : '按回车发起真实 TLS 443 握手与 Cloudflare DoH 查询'}
          icon={certError ? Icon.ExclamationMark : Icon.Globe}
          accessories={[certError ? { tag: { value: '探测异常', color: Color.Red } } : { tag: '实时探测' }]}
          detail={
            <List.Item.Detail
              markdown={`### 实时域名 TLS & DoH 诊断\n\n当前输入域名: \`${queryDomain.trim() || '-'}\`\n\n${
                certError ? `> **TLS 握手提示**: ${certError}\n\n` : ''
              }按回车立即通过宿主 \`tls.connect(443)\` 获取真实对端 X.509 证书链，并并发查询 Cloudflare DNS-over-HTTPS 记录。`}
            />
          }
          actions={
            <ActionPanel>
              <Action
                title={`立即诊断 ${queryDomain.trim() || '域名'}`}
                icon={Icon.Globe}
                onAction={() => {
                  void handleRunDiagnosis(queryDomain)
                }}
              />
            </ActionPanel>
          }
        />
        {certReports.map((cert: SslCertHealthReport) => (
          <List.Item
            key={cert.domain}
            id={`ssl-${cert.domain}`}
            title={cert.domain}
            subtitle={`颁发机构: ${cert.issuerName} · 到期日: ${cert.validToIso}`}
            icon={cert.isExpired || cert.isExpiringSoon ? Icon.ExclamationMark : Icon.Shield}
            accessories={[
              cert.isExpired
                ? { tag: { value: `已过期 ${Math.abs(cert.daysRemaining)} 天`, color: Color.Red } }
                : cert.isExpiringSoon
                  ? { tag: { value: `仅剩 ${cert.daysRemaining} 天`, color: Color.Red } }
                  : { tag: `剩余 ${cert.daysRemaining} 天` },
            ]}
            detail={
              <List.Item.Detail
                markdown={`### SSL/TLS 证书诊断: \`${cert.domain}\`\n\n- **通用名称 (CN)**: \`${
                  cert.subjectCN
                }\`\n- **颁发机构 (Issuer)**: ${
                  cert.issuerName
                }\n- **SAN 备用域名**: ${cert.subjectAltNames
                  .map((s: string) => `\`${s}\``)
                  .join(', ')}\n- **SHA-256 指纹**: \`${cert.fingerprint256}\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="域名 (Domain)" text={cert.domain} />
                    <List.Item.Detail.Metadata.Label title="TLS 协议版本" text={cert.protocol} />
                    <List.Item.Detail.Metadata.Label title="签发日期" text={cert.validFromIso} />
                    <List.Item.Detail.Metadata.Label title="截止日期" text={cert.validToIso} />
                    <List.Item.Detail.Metadata.Label
                      title="剩余有效天数"
                      text={
                        cert.isExpired
                          ? `已过期 ${Math.abs(cert.daysRemaining)} 天`
                          : `${cert.daysRemaining} 天`
                      }
                    />
                    <List.Item.Detail.Metadata.Label title="序列号" text={cert.serialNumber} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title={`查询 ${cert.domain} 实时 DNS 记录`}
                  icon={Icon.Globe}
                  onAction={() => {
                    setQueryDomain(cert.domain)
                    void handleRunDiagnosis(cert.domain)
                  }}
                />
                <Action.CopyToClipboard
                  title="复制证书诊断摘要"
                  content={`${cert.domain} | Issuer: ${cert.issuerName} | ValidTo: ${cert.validToIso} | DaysRemaining: ${cert.daysRemaining}`}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title={`DNS-over-HTTPS 实时解析记录 (${dnsRecords.length} 条)`}>
        {dnsRecords.map((rec: DnsRecordEntry, idx: number) => (
          <List.Item
            key={`${rec.type}-${rec.data}-${idx}`}
            id={`dns-${rec.type}-${idx}`}
            title={rec.data}
            subtitle={`${rec.name} · TTL ${rec.ttl}s`}
            icon={Icon.Globe}
            accessories={[{ tag: rec.type }]}
            detail={
              <List.Item.Detail
                markdown={`### DNS ${rec.type} 记录\n\n\`\`\`text\n${rec.name}  ${rec.ttl}  IN  ${rec.type}  ${rec.data}\n\`\`\``}
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard title="复制记录值" content={rec.data} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  )
}

export default SslDomainCheckCommand
