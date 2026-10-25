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
import type { SvgExportFormat } from './types.js'
import { optimizeSvgSource } from './svg-service.js'

export * from './types.js'
export * from './svg-service.js'

const DEFAULT_SVG_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Sketch 64.1 - https://sketch.com -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.754321" stroke-linecap="round" stroke-linejoin="round">
  <metadata>Created with Sketch</metadata>
  <polygon points="12.00001 2.00004 2.00002 7.00009 12.00001 12.00005 22.00008 7.00009 12.00001 2.00004" />
  <polyline points="2.00002 17.00001 12.00001 22.00006 22.00008 17.00001" />
  <polyline points="2.00002 12.00005 12.00001 17.00001 22.00008 12.00005" />
</svg>`

export function SvgIconStudioCommand() {
  const [rawSvg, setRawSvg] = useState<string>(DEFAULT_SVG_SAMPLE)
  const [exportFormat, setExportFormat] = useState<SvgExportFormat>('minified')

  const svgState = useMemo(() => {
    try {
      const result = optimizeSvgSource(rawSvg)
      return { ok: true as const, result }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [rawSvg])

  const handleLoadClipboard = async (): Promise<void> => {
    try {
      const clip = await Clipboard.readText()
      if (!clip || !clip.trim()) {
        await showToast({
          style: ToastStyle.Failure,
          title: '剪贴板为空',
          message: '请先复制 <svg>...</svg> 源码到剪贴板',
        })
        return
      }
      setRawSvg(clip.trim())
      await showToast({
        style: ToastStyle.Success,
        title: '已载入剪贴板 SVG 源码',
      })
    } catch (err) {
      await showToast({
        style: ToastStyle.Failure,
        title: '读取剪贴板失败',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <List
      isShowingDetail={true}
      searchBarPlaceholder="粘贴 <svg>...</svg> 源码实时净化压缩..."
      searchText={rawSvg}
      onSearchTextChange={setRawSvg}
      searchBarAccessory={
        <List.Dropdown
          tooltip="选择导出代码格式"
          value={exportFormat}
          onChange={(val: string) => setExportFormat(val as SvgExportFormat)}
        >
          <List.Dropdown.Item title="压缩后 SVG (Minified)" value="minified" />
          <List.Dropdown.Item title="React TSX 无状态组件" value="react-tsx" />
          <List.Dropdown.Item title="Vue 3 SFC 单文件组件" value="vue-sfc" />
          <List.Dropdown.Item title="Data URI (UTF-8 / Base64)" value="data-uri" />
        </List.Dropdown>
      }
    >
      {!svgState.ok && (
        <List.Section title="SVG 解析异常">
          <List.Item
            id="svg-error"
            title="SVG 源码不合法"
            subtitle={svgState.error}
            icon={Icon.ExclamationMark}
            accessories={[{ tag: { value: '解析失败', color: Color.Red } }]}
            detail={
              <List.Item.Detail
                markdown={`### SVG 校验未通过\n\n\`\`\`text\n${svgState.error}\n\`\`\`\n\n请粘贴包含完整 \`<svg ...>...</svg>\` 标签的矢量图代码。`}
              />
            }
            actions={
              <ActionPanel>
                <Action
                  title="从剪贴板载入 SVG"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadClipboard()}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}

      {svgState.ok && (
        <List.Section title="SVG 压缩优化与多框架代码导出">
          <List.Item
            id="svg-minified"
            title="无损压缩 SVG (Minified)"
            subtitle={`${svgState.result.metrics.originalBytes} B -> ${svgState.result.metrics.optimizedBytes} B (节省 ${svgState.result.metrics.savedPercentage}%)`}
            icon={Icon.Code}
            accessories={[
              svgState.result.metrics.removedDangerousNodes > 0
                ? {
                    tag: {
                      value: `已拦截 ${svgState.result.metrics.removedDangerousNodes} 处 XSS 节点`,
                      color: Color.Red,
                    },
                  }
                : { tag: `-${svgState.result.metrics.savedPercentage}%` },
            ]}
            detail={
              <List.Item.Detail
                markdown={`### 压缩后 SVG 源码\n\`\`\`xml\n${svgState.result.optimizedSvg}\n\`\`\`\n\n### React TSX 组件预览\n\`\`\`tsx\n${svgState.result.reactTsxCode}\n\`\`\``}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="原始体积"
                      text={`${svgState.result.metrics.originalBytes} Bytes`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="压缩后体积"
                      text={`${svgState.result.metrics.optimizedBytes} Bytes`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="压缩率"
                      text={`节省 ${svgState.result.metrics.savedBytes} Bytes (${svgState.result.metrics.savedPercentage}%)`}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="画布视口 (viewBox)"
                      text={svgState.result.metrics.viewBox}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="图形节点数"
                      text={`${svgState.result.metrics.pathCount} 个矢量图元`}
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制压缩后 SVG"
                  content={svgState.result.optimizedSvg}
                />
                <Action.CopyToClipboard
                  title="复制 React TSX 组件"
                  content={svgState.result.reactTsxCode}
                />
                <Action.CopyToClipboard
                  title="复制 Vue 3 SFC 组件"
                  content={svgState.result.vueSfcCode}
                />
                <Action.CopyToClipboard
                  title="复制 Base64 Data URI"
                  content={svgState.result.base64DataUri}
                />
                <Action
                  title="从剪贴板载入新 SVG"
                  icon={Icon.Clipboard}
                  onAction={() => void handleLoadClipboard()}
                />
              </ActionPanel>
            }
          />

          <List.Item
            id="svg-react-tsx"
            title="React TSX 无状态图标组件"
            subtitle="自动转换 strokeWidth / fillRule / clipRule 驼峰属性并透传 SVGProps"
            icon={Icon.Document}
            accessories={[{ tag: 'React TSX' }]}
            detail={
              <List.Item.Detail
                markdown={`### React TSX 组件代码\n\`\`\`tsx\n${svgState.result.reactTsxCode}\n\`\`\``}
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 React TSX 组件"
                  content={svgState.result.reactTsxCode}
                />
              </ActionPanel>
            }
          />

          <List.Item
            id="svg-vue-sfc"
            title="Vue 3 SFC 单文件图标组件"
            subtitle="标准 <template> + <script setup lang='ts'> 结构"
            icon={Icon.Document}
            accessories={[{ tag: 'Vue 3 SFC' }]}
            detail={
              <List.Item.Detail
                markdown={`### Vue 3 SFC 组件代码\n\`\`\`vue\n${svgState.result.vueSfcCode}\n\`\`\``}
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 Vue 3 SFC 组件"
                  content={svgState.result.vueSfcCode}
                />
              </ActionPanel>
            }
          />

          <List.Item
            id="svg-data-uri"
            title="CSS / Image 内联 Data URI"
            subtitle={svgState.result.base64DataUri.slice(0, 72)}
            icon={Icon.Eye}
            accessories={[{ tag: 'Data URI' }]}
            detail={
              <List.Item.Detail
                markdown={`### UTF-8 Data URI\n\`\`\`text\n${svgState.result.dataUri}\n\`\`\`\n\n### Base64 Data URI\n\`\`\`text\n${svgState.result.base64DataUri}\n\`\`\``}
              />
            }
            actions={
              <ActionPanel>
                <Action.CopyToClipboard
                  title="复制 UTF-8 Data URI"
                  content={svgState.result.dataUri}
                />
                <Action.CopyToClipboard
                  title="复制 Base64 Data URI"
                  content={svgState.result.base64DataUri}
                />
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  )
}

export default SvgIconStudioCommand
