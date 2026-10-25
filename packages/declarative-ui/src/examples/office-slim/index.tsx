import React, {
  List,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  useState,
  useMemo,
  useCallback
} from '../../index.js'
import type { OfficeDocImage, OfficeDocSummary, SlimQualityPreset } from './types.js'
import {
  extractImagesFromOoxmlArchive,
  formatOfficeBytes,
  inspectOoxmlArchive,
  processOoxmlSlimArchive
} from './office-slim-service.js'
import { callHostTransport } from '../shared/native-ipc.js'

export * from './types.js'
export * from './office-slim-service.js'

export interface OfficeSlimProps {
  featureCode?: string
  initialDocSummary?: OfficeDocSummary | null
  initialRawBytes?: Uint8Array | null
  hostOverride?: unknown
}

export function OfficeSlim({
  featureCode = 'office-slim-workbench',
  initialDocSummary = null,
  initialRawBytes = null,
  hostOverride
}: OfficeSlimProps = {}) {
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [searchText, setSearchText] = useState<string>('')
  const [quality, setQuality] = useState<SlimQualityPreset>(
    featureCode === 'office-clean-metadata' ? 'lossless' : 'balanced'
  )
  const [cleanMetadata, setCleanMetadata] = useState<boolean>(true)
  const [currentDoc, setCurrentDoc] = useState<OfficeDocSummary | null>(initialDocSummary)
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(initialRawBytes)

  const handlePickDocument = useCallback(async () => {
    setIsLoading(true)
    try {
      const dialogRes = await callHostTransport<{ canceled?: boolean; filePaths?: string[] }>(
        'window_show_open_dialog',
        {
          properties: ['openFile'],
          filters: [{ name: 'Office Documents', extensions: ['docx', 'pptx', 'xlsx'] }]
        },
        hostOverride
      )
      const chosen = dialogRes.data?.filePaths?.[0]
      if (!dialogRes.ok || dialogRes.data?.canceled || !chosen) return
      const readRes = await callHostTransport<{ base64Data?: string; filePath?: string; error?: string }>(
        'dllplugin_call',
        { plugin: 'OfficeSlimPlugin', func: 'readFile', params: { filePath: chosen } },
        hostOverride
      )
      if (!readRes.ok || !readRes.data?.base64Data) {
        await showToast({ style: Toast.Style.Failure, title: readRes.error || '读取文档失败' })
        return
      }
      const b64 = readRes.data.base64Data
      const bytes =
        typeof Buffer !== 'undefined'
          ? new Uint8Array(Buffer.from(b64, 'base64'))
          : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const summary = inspectOoxmlArchive(bytes, chosen, quality)
      setRawBytes(bytes)
      setCurrentDoc(summary)
      await showToast({
        style: Toast.Style.Success,
        title: `已解析 ${summary.fileName} (含 ${summary.images.length} 张内嵌媒体)`
      })
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setIsLoading(false)
    }
  }, [quality, hostOverride])

  const filteredImages = useMemo(() => {
    const list = currentDoc?.images || []
    const q = searchText.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (img: OfficeDocImage) =>
        img.name.toLowerCase().includes(q) ||
        img.entryPath.toLowerCase().includes(q) ||
        img.format.toLowerCase().includes(q)
    )
  }, [currentDoc, searchText])

  const handleStartSlim = useCallback(async () => {
    if (!currentDoc) {
      await showToast({
        style: Toast.Style.Failure,
        title: '请先选择要瘦身的 Office 文档'
      })
      return
    }
    setIsLoading(true)
    try {
      if (rawBytes) {
        const slimmed = processOoxmlSlimArchive(rawBytes, { quality, cleanMetadata })
        const outPath = currentDoc.filePath.replace(/(\.(?:docx|pptx|xlsx))$/i, '_slim$1')
        const base64Data =
          typeof Buffer !== 'undefined'
            ? Buffer.from(slimmed.outputBytes).toString('base64')
            : btoa(String.fromCharCode(...slimmed.outputBytes))
        await callHostTransport(
          'dllplugin_call',
          { plugin: 'OfficeSlimPlugin', func: 'writeSlim', params: { outputPath: outPath, base64Data } },
          hostOverride
        )
      }
      await showToast({
        style: Toast.Style.Success,
        title: '文档深度瘦身与隐私清理完成',
        message: `${currentDoc.fileName} 体积减少 ${currentDoc.savedPercent}%`
      })
    } catch (err) {
      await showToast({
        style: Toast.Style.Failure,
        title: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setIsLoading(false)
    }
  }, [currentDoc, rawBytes, quality, cleanMetadata, hostOverride])

  const handleExtractAllImages = useCallback(async () => {
    if (!currentDoc || currentDoc.images.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: '当前文档不含可提取的内嵌原图'
      })
      return
    }
    if (rawBytes) {
      const extracted = extractImagesFromOoxmlArchive(rawBytes)
      for (const img of extracted) {
        const outPath = `${currentDoc.filePath}_${img.name}`
        const base64Data =
          typeof Buffer !== 'undefined'
            ? Buffer.from(img.bytes).toString('base64')
            : btoa(String.fromCharCode(...img.bytes))
        await callHostTransport(
          'dllplugin_call',
          { plugin: 'OfficeSlimPlugin', func: 'writeSlim', params: { outputPath: outPath, base64Data } },
          hostOverride
        )
      }
    }
    await showToast({
      style: Toast.Style.Success,
      title: `已无损提取全部 ${currentDoc.images.length} 张原图`
    })
  }, [currentDoc, rawBytes, hostOverride])

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索文档内嵌图片名称或格式..."
      filterBar={{
        summaryText: currentDoc
          ? `当前文档: ${currentDoc.fileName} · 原始 ${formatOfficeBytes(currentDoc.originalSize)} → 预计 ${formatOfficeBytes(currentDoc.estimatedSize)} (-${currentDoc.savedPercent}%)`
          : '支持 Word (.docx)、PowerPoint (.pptx)、Excel (.xlsx) 纯本地离线无损瘦身与作者隐私擦除',
        actions: [
          {
            id: 'pick-doc',
            title: '选择 Office 文档',
            onAction: handlePickDocument
          },
          {
            id: 'start-slim',
            title: '立即瘦身另存',
            onAction: handleStartSlim
          },
          {
            id: 'extract-images',
            title: '提取全部原图',
            onAction: handleExtractAllImages
          }
        ]
      }}
      workbenchPanel={{
        title: 'OOXML 压缩与隐私清理配置',
        subtitle: currentDoc ? currentDoc.filePath : '本地解包重压缩 · 保持原排版与动画关系树不变',
        fields: [
          {
            id: 'quality',
            label: '图像重压缩档位',
            type: 'select',
            value: quality,
            options: [
              { label: '推荐优化 (80% 视觉无损)', value: 'balanced' },
              { label: '强力压缩 (65% 适合微信/企微传输)', value: 'aggressive' },
              { label: '仅擦除隐私与无损优化', value: 'lossless' }
            ],
            onChange: (val: unknown) => setQuality(val as SlimQualityPreset)
          },
          {
            id: 'cleanMetadata',
            label: '擦除作者与审阅批注 (core.xml)',
            type: 'toggle',
            value: cleanMetadata,
            onChange: (val: unknown) => setCleanMetadata(Boolean(val))
          },
          {
            id: 'authorStatus',
            label: '作者与修订隐私检测',
            type: 'info',
            value: currentDoc?.hasAuthorMetadata ? '包含作者与修订人记录 (待擦除)' : '未检出敏感作者信息'
          },
          {
            id: 'commentsStatus',
            label: '内部隐藏批注检测',
            type: 'info',
            value: currentDoc?.hasComments ? '包含审阅批注流 (待剥离)' : '无残留批注'
          }
        ],
        previewCard: {
          title: '瘦身前后体积预估',
          subtitle: currentDoc
            ? `${formatOfficeBytes(currentDoc.originalSize)} → ${formatOfficeBytes(currentDoc.estimatedSize)} (预计节省 ${currentDoc.savedPercent}%)`
            : '拖入或选择文档后立即计算瘦身空间'
        }
      }}
      subList={{
        title: `文档内嵌媒体资源明细 (${filteredImages.length} 项)`,
        subtitle: '按 Enter 立即执行文档瘦身，或导出单张高清原图',
        emptyText: '该文档无内嵌多媒体图片，可直接执行作者与批注隐私元数据擦除',
        items: filteredImages.map((img: OfficeDocImage) => (
          <List.Item
            key={img.entryPath}
            id={img.entryPath}
            title={img.name}
            subtitle={`${img.dimensions} · 内部路径: ${img.entryPath}`}
            icon={Icon.Image}
            accessories={[
              {
                tag: `${formatOfficeBytes(img.originalSize)} → ${formatOfficeBytes(img.estimatedSize)}`
              },
              { text: `-${img.savedPercent}%` }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="立即执行文档瘦身并另存"
                  icon={Icon.CheckCircle}
                  onAction={handleStartSlim}
                />
                <Action
                  title="一键提取全部原图到文件夹"
                  icon={Icon.Download}
                  onAction={handleExtractAllImages}
                />
              </ActionPanel>
            }
          />
        ))
      }}
    />
  )
}

export const OfficeSlimCommand = OfficeSlim
export default OfficeSlim
