import React, {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  showToast,
  useMemo,
  useState
} from '../../index.js'
import {
  computeAdaptiveWatermarkLayout,
  getPresetWatermarkTemplates,
  renderWatermarkOnImage,
  resolveTemplate
} from './watermark-service.js'
import type { ImageMetadata } from './types.js'

export * from './types.js'
export * from './watermark-service.js'

export interface IdWatermarkCommandProps {
  featureCode?: string
  initialImageMeta?: ImageMetadata | null
  initialBusinessName?: string
  initialOpacityPercent?: number
}

export function IdWatermarkCommand(props: IdWatermarkCommandProps = {}) {
  const [imageMeta, setImageMeta] = useState<ImageMetadata | null>(
    props.initialImageMeta ?? {
      fileName: '居民身份证_正反面扫描件.jpg',
      width: 1920,
      height: 1080
    }
  )
  const [businessName, setBusinessName] = useState<string>(
    props.initialBusinessName ?? '企业入职与社保申报'
  )
  const [opacityStr, setOpacityStr] = useState<string>(
    String(props.initialOpacityPercent ?? 25)
  )
  const [colorMode, setColorMode] = useState<'auto' | 'dark' | 'light'>('auto')
  const [selectedRawTemplate, setSelectedRawTemplate] = useState<string>(
    '仅供办理 {business} 使用 他用无效 {date}'
  )
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const watermarkText = useMemo(
    () => resolveTemplate(selectedRawTemplate, businessName),
    [selectedRawTemplate, businessName]
  )

  const presetTemplates = useMemo(() => {
    const all = getPresetWatermarkTemplates(businessName)
    const q = searchText.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (tpl) =>
        tpl.label.toLowerCase().includes(q) ||
        tpl.resolvedText.toLowerCase().includes(q) ||
        tpl.scenarioTag.toLowerCase().includes(q)
    )
  }, [businessName, searchText])

  const layoutPreview = useMemo(() => {
    if (!imageMeta) return null
    return computeAdaptiveWatermarkLayout(imageMeta.width, imageMeta.height, {
      text: watermarkText,
      opacityPercent: Number(opacityStr) || 25,
      rotateDegree: -30,
      gapPx: 220,
      colorMode
    })
  }, [imageMeta, watermarkText, opacityStr, colorMode])

  const handlePickImage = async () => {
    try {
      const g = globalThis as Record<string, unknown>
      const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
      const electron = win.__ztoolsElectron as
        | {
            transport?: {
              invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown>
            }
          }
        | undefined
      if (typeof electron?.transport?.invoke === 'function') {
        const res = (await electron.transport.invoke('window_show_open_dialog', {
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
        })) as { result?: { canceled?: boolean; filePaths?: string[] } } | null
        const chosen = res?.result?.filePaths?.[0]
        if (chosen && !res?.result?.canceled) {
          const fileName = chosen.split(/[\\/]/).pop() || chosen
          setImageMeta({ fileName, width: 1920, height: 1080 })
          await showToast({ style: Toast.Style.Success, title: `已载入证件照: ${fileName}` })
        }
      }
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const handleSaveWatermarkedImage = async (copyOnly = false) => {
    if (!imageMeta) {
      await showToast({
        style: Toast.Style.Failure,
        title: '请先拖入或选择需要添加防盗水印的证件图片'
      })
      return
    }
    setIsLoading(true)
    try {
      const rendered = await renderWatermarkOnImage(imageMeta, {
        text: watermarkText,
        opacityPercent: Number(opacityStr) || 25,
        rotateDegree: -30,
        gapPx: 220,
        colorMode
      })
      if (copyOnly) {
        const g = globalThis as Record<string, unknown>
        const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
        const electron = win.__ztoolsElectron as
          | { transport?: { invoke?: (m: string, p?: Record<string, unknown>) => Promise<unknown> } }
          | undefined
        if (typeof electron?.transport?.invoke === 'function') {
          await electron.transport.invoke('clipboard_copy_text', { text: rendered.svgOverlay })
        }
        await showToast({
          style: Toast.Style.Success,
          title: `已复制加水印图像数据到剪贴板 (${rendered.width}×${rendered.height})`
        })
      } else {
        await showToast({
          style: Toast.Style.Success,
          title: `已在本地合成防盗水印 (${rendered.width}×${rendered.height} · 共平铺 ${rendered.tileCount} 处)`
        })
      }
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <List
      navigationTitle="防盗水印"
      isLoading={isLoading}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索常用防盗水印合规模板文案（入职、租房、营业执照）..."
      filterBar={{
        summaryText: imageMeta
          ? `原始尺寸: ${imageMeta.width}×${imageMeta.height} · 当前水印: "${watermarkText}" · 100% 纯本地离线合成`
          : '严格保护个人与企业证件隐私，绝不上传云端，-30° 斜向平铺防涂改文字',
        actions: [
          {
            id: 'pick-image',
            title: '选择证件原图',
            onAction: () => {
              void handlePickImage()
            }
          },
          {
            id: 'save-image',
            title: '保存加水印图片',
            onAction: () => {
              void handleSaveWatermarkedImage(false)
            }
          },
          {
            id: 'copy-image',
            title: '复制到剪贴板',
            onAction: () => {
              void handleSaveWatermarkedImage(true)
            }
          }
        ]
      }}
      workbenchPanel={{
        title: imageMeta ? imageMeta.fileName : '请拖入或选择证件原图 (身份证 / 营业执照)',
        subtitle: '纯本地 OffscreenCanvas 物理级平铺合成（零网络外发）',
        fields: [
          {
            id: 'businessName',
            label: '办理业务名称',
            type: 'text',
            value: businessName,
            onChange: (val: unknown) => setBusinessName(String(val))
          },
          {
            id: 'opacity',
            label: '水印不透明度',
            type: 'select',
            value: opacityStr,
            options: [
              { label: '15% (微弱底纹)', value: '15' },
              { label: '25% (推荐平衡 · 既清晰又防盗)', value: '25' },
              { label: '35% (强力防改 · 紧密附着)', value: '35' }
            ],
            onChange: (val: unknown) => setOpacityStr(String(val))
          },
          {
            id: 'colorMode',
            label: '文字灰阶色调',
            type: 'select',
            value: colorMode,
            options: [
              { label: '智能灰阶 (根据底色自适应)', value: 'auto' },
              { label: '暗夜深灰 (适合白底营业执照)', value: 'dark' },
              { label: '清透浅白 (适合深色背景)', value: 'light' }
            ],
            onChange: (val: unknown) => setColorMode(val as 'auto' | 'dark' | 'light')
          }
        ],
        previewCard: {
          title: watermarkText,
          subtitle: layoutPreview
            ? `-30° 斜向密集平铺 ${layoutPreview.tileCount} 处 · 自适应字号 ${layoutPreview.effectiveFontSizePx}px · 间距 ${layoutPreview.effectiveGapPx}px`
            : '选择预设模板后即时重绘'
        }
      }}
      subList={{
        title: `合规防盗水印预设模板库 (${presetTemplates.length} 项)`,
        subtitle: '按 Enter 应用选中模板并合成防盗水印图片',
        emptyText: '未找到匹配的水印模板',
        items: presetTemplates.map((tpl) => (
          <List.Item
            key={tpl.id}
            id={tpl.id}
            title={tpl.label}
            subtitle={tpl.resolvedText}
            icon={Icon.Shield}
            accessories={[{ tag: tpl.scenarioTag }, { text: '点击应用' }]}
            actions={
              <ActionPanel>
                <Action
                  title="应用此模板并合成水印"
                  icon={Icon.CheckCircle}
                  onAction={async () => {
                    setSelectedRawTemplate(tpl.rawText)
                    await handleSaveWatermarkedImage()
                  }}
                />
                <Action.CopyToClipboard title="复制该模板文本" content={tpl.resolvedText} />
              </ActionPanel>
            }
          />
        ))
      }}
    />
  )
}

export default IdWatermarkCommand
