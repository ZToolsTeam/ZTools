import React from "../../index.js";
import {
  List,
  Detail,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  useNavigation
} from "../../index.js";
import { useState, useEffect } from "../../runtime/hooks.js";
import {
  runNetworkDiagnostics,
  generateAsciiBar,
  NetworkDiagnosticReport,
  SpeedtestPhase,
  SpeedtestHistoryRecord,
  getSpeedtestHistory,
  saveSpeedtestRecord,
  compareWithPrevious,
  exportReportAsMarkdown,
  exportReportSummary,
  getSpeedRating
} from "./diagnostic.js";

export * from "./diagnostic.js";

/**
 * 测速与网络诊断可视化详情视图 (现代纯正 TSX 模式)
 */
export function SpeedtestDetailView({ report }: { report: NetworkDiagnosticReport }) {
  const ratingInfo = report.rating || getSpeedRating(report.speed.downloadMbps, report.speed.pingMs);

  const dnsChart = report.dnsList
    .map(
      (dns) =>
        `- **${dns.name.padEnd(20, " ")}** \`[${dns.ip}]\`: \`${generateAsciiBar(
          dns.latencyMs,
          100,
          15
        )}\` **${dns.latencyMs} ms** (${dns.status.toUpperCase()})`
    )
    .join("\n");

  const markdown = `
# 网络连通性与测速诊断报告

### 诊断概览
- **公网出口 IP**: \`${report.publicIp.ip}\` (${report.publicIp.isp})
- **局域网 IP**: \`${report.local.ip}\` (网关: \`${report.local.gateway}\`)
- **测试时间**: \`${report.speed.timestamp}\`
- **综合评级**: **\`${ratingInfo.badge}\`** (${ratingInfo.rating})

---

### 带宽与延迟指标
\`\`\`
下行速率: ${report.speed.downloadMbps} Mbps [${generateAsciiBar(report.speed.downloadMbps, 1000, 20)}]
上行速率: ${report.speed.uploadMbps} Mbps [${generateAsciiBar(report.speed.uploadMbps, 200, 20)}]
基准延迟: ${report.speed.pingMs} ms (抖动: ±${report.speed.jitterMs} ms | 丢包: ${report.speed.packetLossPercent}%)
\`\`\`

---

### 全球主流 DNS 解析延时对比
${dnsChart}

---

### 网络拓扑路径
\`\`\`
[客户端: ${report.local.ip}] 
   ↓ (千兆网卡)
[默认网关: ${report.local.gateway}]
   ↓ (光纤接入)
[省骨干网: ${report.publicIp.asn}]
   ↓ (出口路由)
[公网出口: ${report.publicIp.ip} - ${report.publicIp.city}]
\`\`\`
  `;

  return (
    <Detail
      markdown={markdown}
      navigationTitle="网络诊断与测速全貌"
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="公网出口" text={report.publicIp.ip} icon={Icon.Globe} />
          <Detail.Metadata.Label title="运营商 ISP" text={report.publicIp.isp} icon={Icon.Terminal} />
          <Detail.Metadata.Label title="下行带宽" text={`${report.speed.downloadMbps} Mbps`} icon={Icon.Download} />
          <Detail.Metadata.Label title="上行带宽" text={`${report.speed.uploadMbps} Mbps`} icon={Icon.Upload} />
          <Detail.Metadata.Label title="网络延迟" text={`${report.speed.pingMs} ms (±${report.speed.jitterMs} ms)`} icon={Icon.Clock} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="网络评级">
            <Detail.Metadata.TagList.Item
              text={ratingInfo.rating}
              color={Color.Green}
              icon={Icon.Checkmark}
            />
            <Detail.Metadata.TagList.Item text={`${report.speed.packetLossPercent}% 丢包`} color={Color.Blue} />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
      actions={
        <ActionPanel title="诊断操作">
          <Action.CopyToClipboard title="复制完整诊断报告" content={markdown} icon={Icon.CopyClipboard} />
          <Action.CopyToClipboard
            title="导出为标准 Markdown"
            content={exportReportAsMarkdown(report)}
            icon={Icon.Document}
          />
          <Action.CopyToClipboard
            title="分享测速结果简报"
            content={exportReportSummary(report)}
            icon={Icon.Link}
          />
          <Action.CopyToClipboard title="复制公网 IP" content={report.publicIp.ip} icon={Icon.Globe} />
          <Action.CopyToClipboard title="复制局域网 IP" content={report.local.ip} icon={Icon.Pin} />
          <Action.OpenInBrowser title="打开 Speedtest 官方测速" url="https://www.speedtest.net" icon={Icon.Globe} />
        </ActionPanel>
      }
    />
  );
}

/**
 * 网络测速与 IP 诊断主命令 (现代纯正 TSX 模式)
 */
export default function SpeedtestCommand() {
  const [report, setReport] = useState<NetworkDiagnosticReport>(runNetworkDiagnostics());
  const [phase, setPhase] = useState<SpeedtestPhase>("completed");
  const [history, setHistory] = useState<SpeedtestHistoryRecord[]>([]);
  const { push } = useNavigation();

  useEffect(() => {
    getSpeedtestHistory().then((h) => setHistory(h));
  }, []);

  const previousRecord = history.length > 0 ? history[0] : null;
  const comparison = compareWithPrevious(report.speed, previousRecord);
  const ratingInfo = report.rating || getSpeedRating(report.speed.downloadMbps, report.speed.pingMs);

  const handleRerun = async () => {
    setPhase("ping");
    await showToast(Toast.Style.Animated, "正在测试往返延迟与抖动 (Ping & Jitter)...");

    // 阶段模拟
    const newReport = runNetworkDiagnostics({
      downloadMbps: Math.round((620 + Math.random() * 150) * 10) / 10,
      uploadMbps: Math.round((75 + Math.random() * 25) * 10) / 10,
      pingMs: Math.round(9 + Math.random() * 5),
      jitterMs: Math.round((1.2 + Math.random() * 1.0) * 10) / 10,
      timestamp: new Date().toLocaleTimeString()
    });

    setReport(newReport);
    setPhase("completed");

    const updatedHistory = await saveSpeedtestRecord(newReport);
    setHistory(updatedHistory);
    await showToast(Toast.Style.Success, `测速完成: 下行 ${newReport.speed.downloadMbps} Mbps (${newReport.rating?.rating})`);
  };

  return (
    <List
      navigationTitle="网络与 IP 诊断"
      searchBarPlaceholder="搜索网络接口、公网 IP、运营商、DNS 节点..."
      actions={
        <ActionPanel title="全局操作">
          <Action title="重新测试 (Re-run Benchmark)" icon={Icon.Repeat} onAction={handleRerun} />
          <Action.Push
            title="查看完整网络拓扑与诊断详情"
            icon={Icon.Eye}
            target={() => <SpeedtestDetailView report={report} />}
          />
          <Action.CopyToClipboard
            title="复制测速报告 (Markdown)"
            content={exportReportAsMarkdown(report, history)}
            icon={Icon.Document}
          />
          <Action.CopyToClipboard
            title="分享测速结果简报"
            content={exportReportSummary(report)}
            icon={Icon.Link}
          />
        </ActionPanel>
      }
    >
      <List.Section title="测速结果与综合评级">
        <List.Item
          id="item-download"
          title={`下行带宽: ${report.speed.downloadMbps} Mbps`}
          subtitle={`[${generateAsciiBar(report.speed.downloadMbps, 1000, 18)}]`}
          icon={Icon.Download}
          accessories={[
            { text: `趋势: ${comparison.downloadDiff}` },
            { text: ratingInfo.badge, tag: "fast" }
          ]}
          actions={
            <ActionPanel title="带宽操作">
              <Action title="重新测试 (Re-run)" icon={Icon.Repeat} onAction={handleRerun} />
              <Action.CopyToClipboard
                title="复制下行带宽数值"
                content={`${report.speed.downloadMbps} Mbps`}
                icon={Icon.CopyClipboard}
              />
              <Action.Push
                title="查看完整报告"
                icon={Icon.Eye}
                target={() => <SpeedtestDetailView report={report} />}
              />
            </ActionPanel>
          }
        />
        <List.Item
          id="item-upload"
          title={`上行带宽: ${report.speed.uploadMbps} Mbps`}
          subtitle={`[${generateAsciiBar(report.speed.uploadMbps, 200, 18)}]`}
          icon={Icon.Upload}
          accessories={[
            { text: "充沛" },
            { text: `${report.speed.uploadMbps} Mbps` }
          ]}
          actions={
            <ActionPanel title="带宽操作">
              <Action title="重新测试 (Re-run)" icon={Icon.Repeat} onAction={handleRerun} />
              <Action.CopyToClipboard
                title="复制上行带宽数值"
                content={`${report.speed.uploadMbps} Mbps`}
                icon={Icon.CopyClipboard}
              />
            </ActionPanel>
          }
        />
        <List.Item
          id="item-latency"
          title={`往返延迟: ${report.speed.pingMs} ms (抖动 ±${report.speed.jitterMs} ms)`}
          subtitle={`综合评级: ${ratingInfo.rating}`}
          icon={Icon.Clock}
          accessories={[
            { text: `Ping 变化: ${comparison.pingDiff}` },
            { text: `${report.speed.packetLossPercent}% 丢包` }
          ]}
          actions={
            <ActionPanel title="延迟操作">
              <Action title="重新测试 (Re-run)" icon={Icon.Repeat} onAction={handleRerun} />
              <Action.CopyToClipboard
                title="复制测试摘要"
                content={exportReportSummary(report)}
                icon={Icon.CopyClipboard}
              />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="公网出口与本地网络">
        <List.Item
          id="item-public-ip"
          title={`公网出口: ${report.publicIp.ip}`}
          subtitle={`${report.publicIp.isp} · ${report.publicIp.asn}`}
          icon={Icon.Globe}
          accessories={[
            { text: `${report.publicIp.city}, ${report.publicIp.country}` }
          ]}
          actions={
            <ActionPanel title="公网 IP">
              <Action.CopyToClipboard title="复制公网 IP" content={report.publicIp.ip} icon={Icon.CopyClipboard} />
              <Action.CopyToClipboard title="复制运营商信息" content={report.publicIp.isp} icon={Icon.Terminal} />
            </ActionPanel>
          }
        />
        <List.Item
          id="item-local-net"
          title={`内网地址: ${report.local.ip}`}
          subtitle={`网关: ${report.local.gateway} (网卡: ${report.local.interfaceName})`}
          icon={Icon.Pin}
          accessories={[
            { text: `掩码: ${report.local.subnetMask}` }
          ]}
          actions={
            <ActionPanel title="内网信息">
              <Action.CopyToClipboard title="复制内网 IP" content={report.local.ip} icon={Icon.CopyClipboard} />
              <Action.CopyToClipboard title="复制网关地址" content={report.local.gateway} icon={Icon.Pin} />
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="全球主流 DNS 解析延时">
        {report.dnsList.map((dns) => (
          <List.Item
            key={dns.ip}
            id={`dns-${dns.ip}`}
            title={`${dns.name} (${dns.ip})`}
            subtitle={dns.location}
            icon={dns.status === "fast" ? Icon.Checkmark : Icon.Clock}
            accessories={[
              { text: `${dns.latencyMs} ms` },
              { text: dns.status.toUpperCase(), tag: dns.status }
            ]}
            actions={
              <ActionPanel title={dns.name}>
                <Action.CopyToClipboard title="复制 DNS 地址" content={dns.ip} icon={Icon.CopyClipboard} />
                <Action title="重新测试 (Re-run)" icon={Icon.Repeat} onAction={handleRerun} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      {history.length > 0 && (
        <List.Section title={`历史测速记录 (最近 ${history.length} 次)`}>
          {history.slice(0, 5).map((h) => (
            <List.Item
              key={h.id}
              id={h.id}
              title={`↓ ${h.downloadMbps} Mbps | ↑ ${h.uploadMbps} Mbps`}
              subtitle={`Ping: ${h.pingMs} ms · 评级: ${h.rating}`}
              icon={Icon.Calendar}
              accessories={[
                { text: h.ratingBadge, tag: "badge" },
                { text: h.timestamp }
              ]}
              actions={
                <ActionPanel title="历史记录">
                  <Action.CopyToClipboard
                    title="复制该次测速数据"
                    content={`下行: ${h.downloadMbps} Mbps | 上行: ${h.uploadMbps} Mbps | 延迟: ${h.pingMs} ms (${h.timestamp})`}
                    icon={Icon.CopyClipboard}
                  />
                  <Action title="重新测试 (Re-run)" icon={Icon.Repeat} onAction={handleRerun} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
