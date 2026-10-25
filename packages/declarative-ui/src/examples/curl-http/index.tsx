import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  Clipboard,
  showToast,
  ToastStyle,
  useState,
  useMemo,
} from '../../index.js'
import type { CodeTargetLang, HttpResponseSnapshot } from './types.js'
import {
  parseCurlCommand,
  generateCodeFromCurl,
  executeCurlRequest,
} from './curl-service.js'

export * from './types.js'
export * from './curl-service.js'

const DEFAULT_CURL_SAMPLE =
  'curl -X POST "https://httpbin.org/post" -H "Content-Type: application/json" -H "X-Client: ZTools" -d \'{"query":"declarative-ui","limit":10}\''

export function CurlHttpCommand() {
  const [rawCurl, setRawCurl] = useState<string>(DEFAULT_CURL_SAMPLE)
  const [targetLang, setTargetLang] = useState<CodeTargetLang>('fetch')
  const [responseSnap, setResponseSnap] = useState<HttpResponseSnapshot | null>(null)
  const [isSending, setIsSending] = useState<boolean>(false)

  const parsedState = useMemo(() => {
    try {
      const parsed = parseCurlCommand(rawCurl)
      const generatedCode = generateCodeFromCurl(parsed, targetLang)
      return { ok: true as const, parsed, generatedCode }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [rawCurl, targetLang])

  const handleLoadClipboard = async (): Promise<void> => {
    try {
      const clip = await Clipboard.readText()
      if (!clip || !clip.trim()) {
        await showToast({
          style: ToastStyle.Failure,
          title: '剪贴板为空',
          message: '请先从浏览器 DevTools 复制 Copy as cURL 命令',
        })
        return
      }
      setRawCurl(clip.trim())
      setResponseSnap(null)
      await showToast({
        style: ToastStyle.Success,
        title: '已载入剪贴板 cURL 命令',
      })
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '读取剪贴板失败',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleSendRequest = async (): Promise<void> => {
    if (!parsedState.ok || isSending) return
    setIsSending(true)
    try {
      const snap = await executeCurlRequest(parsedState.parsed)
      setResponseSnap(snap)
      await showToast({
        style: snap.ok ? ToastStyle.Success : ToastStyle.Failure,
        title: `HTTP ${snap.status} (${snap.elapsedMs}ms)`,
        message: `${snap.sizeBytes} bytes`,
      })
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '请求执行失败',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSending(false)
    }
  }

  return (
    <List
      isShowingDetail={true}
      isLoading={isSending}
      searchBarPlaceholder="粘贴 cURL 命令或 HTTP URL..."
      searchText={rawCurl}
      onSearchTextChange={setRawCurl}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择目标代码语言"
          value={targetLang}
          onChange={(val: string) => setTargetLang(val as CodeTargetLang)}
        >
          <List.Dropdown.Item title="JavaScript Fetch" value="fetch" />
          <List.Dropdown.Item title="TypeScript Axios" value="axios" />
          <List.Dropdown.Item title="Python Requests" value="python" />
          <List.Dropdown.Item title="Go net/http" value="go" />
        </List.Dropdown>
      }
    >
      {!parsedState.ok && (
        <List.Section title="cURL 语法解析错误">
          <List.Item
            id="curl-parse-error"
            title="无法解析 cURL 命令"
            subtitle={parsedState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '语法错误', color: Color.Red } }]}
            detail={
              <List.Item.Detail
                markdown={`### cURL 解析异常\n\n\`\`\`text\n${parsedState.error}\n\`\`\`\n\n支持从 Chrome / Edge DevTools 直接复制 \`Copy as cURL (bash / cmd / PowerShell)\`。`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="从剪贴板粘贴 cURL"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadClipboard()}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {parsedState.ok && (
        <List.Section title="请求结构与多语言代码互转">
          <List.Item
            id="curl-overview"
            title={`${parsedState.parsed.method} ${parsedState.parsed.url}`}
            subtitle={`Headers: ${Object.keys(parsedState.parsed.headers).length} 项 · 代码目标: ${targetLang.toUpperCase()}`}
            icon={Icon.Terminal}
            accessories={[
              responseSnap
                ? responseSnap.ok
                  ? { tag: `HTTP ${responseSnap.status} · ${responseSnap.elapsedMs}ms` }
                  : {
                      tag: {
                        value: `HTTP ${responseSnap.status}`,
                        color: Color.Red,
                      },
                    }
                : { tag: parsedState.parsed.method },
            ]}
            detail={
              <List.Item.Detail
                markdown={`### 生成代码 (${targetLang.toUpperCase()})\n\`\`\`${
                  targetLang === 'python' ? 'python' : targetLang === 'go' ? 'go' : 'ts'
                }\n${parsedState.generatedCode}\n\`\`\`\n\n${
                  responseSnap
                    ? `### 实时响应结果 (HTTP ${responseSnap.status} · ${responseSnap.elapsedMs}ms)\n\`\`\`json\n${responseSnap.bodyText}\n\`\`\``
                    : '### 实时响应结果\n按回车执行「立即发起 HTTP 请求」即可在本地验证此接口并查看响应载荷。'
                }`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="请求方法 (Method)"
                      text={parsedState.parsed.method}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="目标地址 (URL)"
                      text={parsedState.parsed.url}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="请求头数量"
                      text={`${Object.keys(parsedState.parsed.headers).length} 项`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="请求体 (Body)"
                      text={
                        parsedState.parsed.body
                          ? `${parsedState.parsed.body.length} 字符`
                          : '无请求体'
                      }
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="立即发起 HTTP 请求"
                  icon={Icon.Play}
                  onAction={() => void handleSendRequest()}
                />
                <Action.CopyToClipboard
                  title={`复制 ${targetLang.toUpperCase()} 代码`}
                  content={parsedState.generatedCode}
                />
                {responseSnap && (
                  <Action.CopyToClipboard
                    title="复制响应 Body"
                    content={responseSnap.bodyText}
                  />
                )}
                <Action
                  title="从剪贴板载入 cURL"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadClipboard()}
                />
              </ActionPanel>
            }
          />

          {(Object.entries(parsedState.parsed.headers) as Array<[string, string]>).map(
            ([hKey, hVal]) => (
              <List.Item
                key={hKey}
                id={`header-${hKey}`}
                title={hKey}
                subtitle={String(hVal)}
                icon={Icon.Code}
                accessories={[{ tag: 'Header' }]}
                detail={
                  <List.Item.Detail
                    markdown={`### Request Header: \`${hKey}\`\n\n\`\`\`text\n${String(hVal)}\n\`\`\``}
                  />
                }
                actions={
                  <ActionPanel>
                    <Action.CopyToClipboard
                      title={`复制 ${hKey}`}
                      content={`${hKey}: ${String(hVal)}`}
                    />
                  </ActionPanel>
                }
              />
            ),
          )}
        </List.Section>
      )}
    </List>
  )
}

export default CurlHttpCommand
