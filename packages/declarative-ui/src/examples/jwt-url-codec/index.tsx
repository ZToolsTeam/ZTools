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
import type { CodecMode, UrlQueryParamItem } from './types.js'
import {
  decodeJwtToken,
  verifyJwtHmacSha256,
  parseAndInspectUrl,
} from './jwt-url-service.js'

export * from './types.js'
export * from './jwt-url-service.js'

const DEFAULT_JWT_SAMPLE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzEwMjQiLCJuYW1lIjoiWlRvb2xzIERldmVsb3BlciIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTczNTY4OTYwMCwiZXhwIjoxOTg4MTUwNDAwfQ.4f-8h_l7mN3vR2kX9pQ1wZ5yB6cT0dG8jL4sA2eF6uI'

export function JwtUrlCodecCommand() {
  const [mode, setMode] = useState<CodecMode>('jwt')
  const [rawInput, setRawInput] = useState<string>(DEFAULT_JWT_SAMPLE)
  const [secretInput, setSecretInput] = useState<string>('')
  const [verifyMsg, setVerifyMsg] = useState<string>('未验签（可通过动作面板读取剪贴板密钥验签）')

  const jwtState = useMemo(() => {
    if (mode !== 'jwt') return null
    try {
      const result = decodeJwtToken(rawInput)
      return { ok: true as const, result }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [mode, rawInput])

  const urlState = useMemo(() => {
    if (mode !== 'url') return null
    try {
      const result = parseAndInspectUrl(rawInput)
      return { ok: true as const, result }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [mode, rawInput])

  const handleLoadFromClipboard = async (): Promise<void> => {
    try {
      const text = await Clipboard.readText()
      if (!text || !text.trim()) {
        await showToast({
          style: ToastStyle.Failure,
          title: '剪贴板为空',
          message: '请先复制 JWT Token 或 URL 链接',
        })
        return
      }
      const trimmed = text.trim()
      setRawInput(trimmed)
      if (trimmed.split('.').length === 3 && /^eyJ/.test(trimmed.replace(/^Bearer\s+/i, ''))) {
        setMode('jwt')
      } else if (/^https?:\/\//i.test(trimmed) || trimmed.includes('?')) {
        setMode('url')
      }
      await showToast({
        style: ToastStyle.Success,
        title: '已从剪贴板载入内容',
      })
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '读取剪贴板失败',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const handleVerifyFromClipboardSecret = async (): Promise<void> => {
    try {
      const clipSecret = (await Clipboard.readText())?.trim() || secretInput.trim()
      if (!clipSecret) {
        await showToast({
          style: ToastStyle.Failure,
          title: '缺少验签密钥',
          message: '请先复制 HS256 密钥到剪贴板',
        })
        return
      }
      setSecretInput(clipSecret)
      const res = await verifyJwtHmacSha256(rawInput, clipSecret)
      setVerifyMsg(res.verified ? `验签通过 (${res.algorithm})` : `验签失败: ${res.reason}`)
      await showToast({
        style: res.verified ? ToastStyle.Success : ToastStyle.Failure,
        title: res.verified ? 'HS256 签名校验通过' : 'HS256 签名校验失败',
        message: res.reason,
      })
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '验签异常',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder="粘贴 JWT Token 或 URL 链接直接解析..."
      searchText={rawInput}
      onSearchTextChange={setRawInput}
      searchBarAccessory={
        <List.Dropdown
          tooltip="切换解析模式"
          value={mode}
          onChange={(val: string) => setMode(val as CodecMode)}
        >
          <List.Dropdown.Item title="JWT Token 深度解析" value="jwt" />
          <List.Dropdown.Item title="URL 与 Query 参数拆解" value="url" />
        </List.Dropdown>
      }
    >
      {mode === 'jwt' && jwtState && !jwtState.ok && (
        <List.Section title="JWT 解析异常">
          <List.Item
            id="jwt-error"
            title="JWT 结构或编码非法"
            subtitle={jwtState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '解析失败', color: Color.Red } }]}
            detail={
              <List.Item.Detail
                markdown={`### JWT 解析失败\n\n\`\`\`text\n${jwtState.error}\n\`\`\`\n\n请确认输入符合 \`Header.Payload.Signature\` 三段式 Base64URL 规范。`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="从剪贴板载入 Token"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadFromClipboard()}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {mode === 'jwt' && jwtState && jwtState.ok && (
        <List.Section title="JWT 载荷与生命周期诊断">
          <List.Item
            id="jwt-overview"
            title={`算法 ${jwtState.result.algorithm} · 载荷字段 (${Object.keys(jwtState.result.payload).length} 项)`}
            subtitle={jwtState.result.expiryCountdownText}
            icon={Icon.Key}
            accessories={[
              jwtState.result.isExpired
                ? { tag: { value: 'TOKEN 已过期', color: Color.Red } }
                : { tag: '有效期内' },
            ]}
            detail={
              <List.Item.Detail
                markdown={`### Payload JSON\n\`\`\`json\n${JSON.stringify(
                  jwtState.result.payload,
                  null,
                  2,
                )}\n\`\`\`\n\n### Header JSON\n\`\`\`json\n${JSON.stringify(
                  jwtState.result.header,
                  null,
                  2,
                )}\n\`\`\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="签名算法 (alg)"
                      text={jwtState.result.algorithm}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="签发时间 (iat)"
                      text={jwtState.result.issuedAtText || '未声明'}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="生效时间 (nbf)"
                      text={jwtState.result.notBeforeText || '未声明'}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="过期时间 (exp)"
                      text={jwtState.result.expiresAtText || '未声明'}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title="生命周期状态"
                      text={jwtState.result.expiryCountdownText}
                    />
                    <List.Item.Detail.Metadata.Label title="本地验签状态" text={verifyMsg} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 Payload JSON"
                  content={JSON.stringify(jwtState.result.payload, null, 2)}
                />
                <Action.CopyToClipboard
                  title="复制 Header JSON"
                  content={JSON.stringify(jwtState.result.header, null, 2)}
                />
                <Action
                  title="使用剪贴板密钥校验 HS256 签名"
                  icon={Icon.Shield}
                  onAction={() => void handleVerifyFromClipboardSecret()}
                />
                <Action
                  title="从剪贴板重新读取 Token"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadFromClipboard()}
                />
              </ActionPanel>
            }
          />
          {Object.entries(jwtState.result.payload).map(([claimKey, claimVal]) => (
            <List.Item
              key={claimKey}
              id={`claim-${claimKey}`}
              title={claimKey}
              subtitle={typeof claimVal === 'object' ? JSON.stringify(claimVal) : String(claimVal)}
              icon={Icon.Code}
              accessories={[{ tag: typeof claimVal }]}
              detail={
                <List.Item.Detail
                  markdown={`### Claim: \`${claimKey}\`\n\n\`\`\`json\n${JSON.stringify(
                    claimVal,
                    null,
                    2,
                  )}\n\`\`\``}
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard
                    title={`复制 ${claimKey} 值`}
                    content={
                      typeof claimVal === 'object' ? JSON.stringify(claimVal) : String(claimVal)
                    }
                  />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}

      {mode === 'url' && urlState && !urlState.ok && (
        <List.Section title="URL 解析异常">
          <List.Item
            id="url-error"
            title="URL 格式无法识别"
            subtitle={urlState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '格式错误', color: Color.Red } }]}
            detail={<List.Item.Detail markdown={`### URL 解析异常\n\n\`\`\`text\n${urlState.error}\n\`\`\``} />}
          />
        </List.Section>
      )}

      {mode === 'url' && urlState && urlState.ok && (
        <List.Section title={`URL 结构与 Query 参数 (${urlState.result.queryParams.length} 项)`}>
          <List.Item
            id="url-overview"
            title={urlState.result.host !== '-' ? `${urlState.result.host}${urlState.result.pathname}` : 'Query 参数集合'}
            subtitle={urlState.result.decodedFullUrl}
            icon={Icon.Globe}
            accessories={[{ tag: urlState.result.protocol.toUpperCase() }]}
            detail={
              <List.Item.Detail
                markdown={`### 解码后完整 URL\n\`\`\`text\n${urlState.result.decodedFullUrl}\n\`\`\`\n\n### Query 参数 JSON\n\`\`\`json\n${JSON.stringify(
                  Object.fromEntries(
                    urlState.result.queryParams.map((p: UrlQueryParamItem) => [
                      p.key,
                      p.decodedValue,
                    ]),
                  ),
                  null,
                  2,
                )}\n\`\`\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label title="协议 (Protocol)" text={urlState.result.protocol} />
                    <List.Item.Detail.Metadata.Label title="主机 (Host)" text={urlState.result.host} />
                    <List.Item.Detail.Metadata.Label title="端口 (Port)" text={urlState.result.port} />
                    <List.Item.Detail.Metadata.Label title="路径 (Pathname)" text={urlState.result.pathname} />
                    <List.Item.Detail.Metadata.Label title="哈希锚点 (Hash)" text={urlState.result.hash || '无'} />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制解码后完整 URL"
                  content={urlState.result.decodedFullUrl}
                />
                <Action.CopyToClipboard
                  title="复制 Query 参数 JSON"
                  content={JSON.stringify(
                    Object.fromEntries(
                      urlState.result.queryParams.map((p: UrlQueryParamItem) => [
                        p.key,
                        p.decodedValue,
                      ]),
                    ),
                    null,
                    2,
                  )}
                />
              </ActionPanel>
            }
          />
          {urlState.result.queryParams.map((param: UrlQueryParamItem, idx: number) => (
            <List.Item
              key={`${param.key}-${idx}`}
              id={`param-${param.key}-${idx}`}
              title={param.key}
              subtitle={param.decodedValue}
              icon={Icon.Document}
              accessories={[
                param.isNestedUrl
                  ? { tag: '嵌套 URL' }
                  : param.isJsonLike
                    ? { tag: 'JSON 载荷' }
                    : { tag: 'Query' },
              ]}
              detail={
                <List.Item.Detail
                  markdown={`### 参数 \`${param.key}\`\n\n#### 解码值\n\`\`\`text\n${param.decodedValue}\n\`\`\`\n\n#### 原始编码值\n\`\`\`text\n${param.rawValue}\n\`\`\``}
                />
              }
              actions={
                <ActionPanel>
                  <Action.CopyToClipboard title="复制解码值" content={param.decodedValue} />
                  <Action.CopyToClipboard
                    title="复制 key=value"
                    content={`${param.key}=${param.rawValue}`}
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

export default JwtUrlCodecCommand
