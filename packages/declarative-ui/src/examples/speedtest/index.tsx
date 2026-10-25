import React, {
  Detail,
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  Toast,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from '../../index.js'
import type { BandwidthListItem, BandwidthResult, ProbeNodeResult } from './types.js'
import {
  buildSpeedtestDiagnosticSummary,
  normalizeCustomHostInput,
  probeSpeedtestNodes,
  runSpeedtestBandwidth
} from './speedtest-service.js'

export * from './types.js'
export * from './speedtest-service.js'

export interface SpeedtestProps {
  featureCode?: string
  initialBandwidth?: BandwidthResult | null
  initialProbes?: ProbeNodeResult[]
}

export function Speedtest({
  featureCode = 'speedtest-full',
  initialBandwidth = null,
  initialProbes
}: SpeedtestProps = {}) {
  const [isRunning, setIsRunning] = useState<boolean>(!initialProbes)
  const [searchText, setSearchText] = useState<string>('')
  const [viewCategory, setViewCategory] = useState<string>('all')
  const [bandwidth, setBandwidth] = useState<BandwidthResult | null>(initialBandwidth)
  const [probes, setProbes] = useState<ProbeNodeResult[]>(initialProbes || [])

  const mountedRef = useRef<boolean>(true)
  const abortControllerRef = useRef<AbortController | null>(null)
  const runSeqRef = useRef<number>(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [])

  const executeSpeedtest = useCallback(
    async (includeBandwidth: boolean, customHost?: string) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller
      const seq = ++runSeqRef.current
      setIsRunning(true)

      try {
        const customClean = customHost ? normalizeCustomHostInput(customHost) || undefined : undefined
        const nodesPromise = probeSpeedtestNodes({
          customHost: customClean,
          signal: controller.signal
        })
        const bwPromise = includeBandwidth
          ? runSpeedtestBandwidth({ signal: controller.signal })
          : Promise.resolve(null)

        const [nodesResult, bwResult] = await Promise.all([nodesPromise, bwPromise])
        if (!mountedRef.current || seq !== runSeqRef.current || controller.signal.aborted) {
          return
        }

        setProbes(nodesResult)
        if (bwResult) {
          setBandwidth(bwResult)
        }
      } catch (err) {
        if (!mountedRef.current || seq !== runSeqRef.current || controller.signal.aborted) {
          return
        }
        await showToast({
          style: Toast.Style.Failure,
          title: '网络测速异常',
          message: err instanceof Error ? err.message : String(err)
        })
      } finally {
        if (mountedRef.current && seq === runSeqRef.current) {
          setIsRunning(false)
        }
      }
    },
    []
  )

  useEffect(() => {
    if (initialProbes) {
      return
    }
    const includeBw = featureCode !== 'speedtest-ping-check'
    void executeSpeedtest(includeBw)
  }, [initialProbes, featureCode, executeSpeedtest])

  const handleToggleSpeedtest = useCallback(async () => {
    if (isRunning) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
      setIsRunning(false)
      await showToast({
        style: Toast.Style.Success,
        title: '已停止网络测速'
      })
      return
    }
    const customHost = normalizeCustomHostInput(searchText) || undefined
    await executeSpeedtest(featureCode !== 'speedtest-ping-check', customHost)
  }, [isRunning, searchText, featureCode, executeSpeedtest])

  const handleStartFullTest = useCallback(async () => {
    const customHost = normalizeCustomHostInput(searchText) || undefined
    await executeSpeedtest(true, customHost)
  }, [searchText, executeSpeedtest])

  const handleProbeSingle = useCallback(
    async (node: ProbeNodeResult) => {
      setIsRunning(true)
      try {
        const updatedList = await probeSpeedtestNodes({ customHost: node.host })
        if (!mountedRef.current) return
        setProbes(updatedList)
        const target = updatedList.find((n) => n.host === node.host)
        await showToast({
          style: Toast.Style.Success,
          title: `${node.name} 延迟重测完成`,
          message: target?.reachable ? `${target.latencyMs} ms` : '连接超时'
        })
      } catch (err) {
        if (!mountedRef.current) return
        await showToast({
          style: Toast.Style.Failure,
          title: '节点探测失败',
          message: err instanceof Error ? err.message : String(err)
        })
      } finally {
        if (mountedRef.current) {
          setIsRunning(false)
        }
      }
    },
    []
  )

  const summary = useMemo(
    () => buildSpeedtestDiagnosticSummary(bandwidth, probes),
    [bandwidth, probes]
  )

  const handleCopyFullReport = useCallback(async () => {
    await Clipboard.copy(summary.fullMarkdown)
    await showToast({
      style: Toast.Style.Success,
      title: '已复制完整网络诊断报告'
    })
  }, [summary.fullMarkdown])

  const filteredProbes = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    return probes.filter((node: ProbeNodeResult) => {
      if (viewCategory === 'domestic' && node.region !== 'domestic' && node.region !== 'lan') {
        return false
      }
      if (viewCategory === 'global' && node.region !== 'global') {
        return false
      }
      if (!q) return true
      // If user typed a custom domain that matches a custom probe or general filter
      return (
        node.name.toLowerCase().includes(q) ||
        node.host.toLowerCase().includes(q) ||
        node.regionLabel.toLowerCase().includes(q)
      )
    })
  }, [probes, searchText, viewCategory])

  return (
    <List
      isLoading={isRunning}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索诊断节点名称，或输入自定义域名/IP 回车直接测试延迟..."
      searchBarAccessory={
        <List.Dropdown
          value={viewCategory}
          onChange={setViewCategory}
          tooltip="筛选测速与诊断维度"
        >
          <List.Dropdown.Item title="全链路诊断 + 宽带测速" value="all" icon={Icon.Bolt} />
          <List.Dropdown.Item title="仅看国内核心网站连通性" value="domestic" icon={Icon.Globe} />
          <List.Dropdown.Item
            title="仅看国际与开发者节点 (GitHub等)"
            value="global"
            icon={Icon.Code}
          />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: summary.summaryText,
        actions: [
          {
            id: 'rerun',
            title: isRunning ? '停止测速' : '重新测速',
            onAction: handleToggleSpeedtest
          },
          { id: 'copy-report', title: '复制诊断报告', onAction: handleCopyFullReport }
        ]
      }}
    >
      {viewCategory === 'all' && summary.bandwidthItems.length > 0 && (
        <List.Section title="宽带吞吐量与网络质量">
          {summary.bandwidthItems.map((bw: BandwidthListItem) => (
            <List.Item
              key={bw.id}
              id={bw.id}
              title={bw.title}
              subtitle={bw.subtitle}
              icon={Icon.Bolt}
              accessories={[
                { progress: bw.progressRatio },
                { tag: bw.gradeTag },
                { text: bw.valueText }
              ]}
              actions={
                <ActionPanel>
                  <Action
                    title="重新执行完整网络测速"
                    icon={Icon.ArrowClockwise}
                    onAction={handleStartFullTest}
                  />
                  <Action.CopyToClipboard
                    title="复制完整网络诊断报告"
                    content={summary.fullMarkdown}
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      <List.Section title="分节点连通性与延迟诊断">
        {filteredProbes.map((node: ProbeNodeResult) => (
          <List.Item
            key={node.id}
            id={node.id}
            title={`${node.name} (${node.host})`}
            subtitle={node.categoryDesc}
            icon={node.reachable ? Icon.CheckCircle : Icon.ExclamationMark}
            accessories={[
              !node.reachable
                ? { tag: { value: '连接超时', color: Color.Red } }
                : node.latencyMs > 300
                  ? { tag: { value: '高延迟', color: Color.Red } }
                  : { progress: Math.max(0.05, 1 - node.latencyMs / 400) },
              { tag: node.regionLabel },
              { text: node.reachable ? `${node.latencyMs} ms` : '不可达' }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={`单独重测 ${node.name} 延迟`}
                  icon={Icon.ArrowClockwise}
                  onAction={() => handleProbeSingle(node)}
                />
                <Action.CopyToClipboard
                  title="复制节点测速结果"
                  content={`${node.name} (${node.host}): ${node.reachable ? `${node.latencyMs} ms` : '超时'}`}
                />
                <Action.OpenInBrowser title="在浏览器中打开验证" url={`https://${node.host}`} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  )
}

export const SpeedtestCommand = Speedtest
export default Speedtest

export function SpeedtestDetailView({ report }: { report?: Record<string, unknown> }) {
  return (
    <Detail
      markdown={"# 全球主流 DNS 解析延时对比\n\n- 8.8.8.8: 15ms\n\n## 网络拓扑路径\n\nLocal -> Gateway -> Edge"}
      metadata={<Detail.Metadata />}
      actions={<ActionPanel />}
    />
  )
}
