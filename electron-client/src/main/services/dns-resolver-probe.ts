import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { DnsProbeResult } from '../../contracts/dns-benchmark.js'

export const DNS_PROBE_DOMAIN = 'example.com'
export async function probeDnsServer(server: string, signal: AbortSignal, domain = DNS_PROBE_DOMAIN): Promise<DnsProbeResult> {
  signal.throwIfAborted()
  const resolver = new Resolver({ timeout: 1500, tries: 1 })
  resolver.setServers([server])
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  const started = performance.now()
  try {
    const answers = await resolver.resolve4(domain)
    signal.throwIfAborted()
    if (!answers.length || answers.some(value => isIP(value) !== 4)) throw new Error('DNS 未返回有效 IPv4 解析结果')
    return { server, milliseconds: Math.round((performance.now() - started) * 10) / 10, answers, error: null }
  } catch (error) {
    signal.throwIfAborted()
    return { server, milliseconds: null, answers: [], error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160) }
  } finally { signal.removeEventListener('abort', cancel); resolver.cancel() }
}
export async function benchmarkDnsServers(servers: string[], signal: AbortSignal): Promise<DnsProbeResult[]> {
  const results: DnsProbeResult[] = new Array(servers.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, servers.length) }, async () => {
    while (cursor < servers.length) {
      signal.throwIfAborted()
      const index = cursor++, server = servers[index]!
      results[index] = await probeDnsServer(server, signal)
    }
  }))
  return results
}
