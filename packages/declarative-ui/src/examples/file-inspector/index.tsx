import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  useMemo,
  useState
} from '../../index.js'
import {
  convertTextBufferEncoding,
  fixFileExtension,
  inspectFileFromBuffer,
  pickAndReadLocalFile,
  saveConvertedTextFile
} from './inspector-service.js'
import type { FileDiagnosticResult } from './types.js'

export * from './types.js'
export * from './inspector-service.js'

export interface FileInspectorCommandProps {
  featureCode?: string
  initialDiagnostic?: FileDiagnosticResult | null
  initialRawBytes?: Uint8Array
  hostOverride?: unknown
}

export function FileInspectorCommand(props: FileInspectorCommandProps = {}) {
  const [rawBytes, setRawBytes] = useState<Uint8Array | null>(props.initialRawBytes ?? null)
  const [selectedFilePath, setSelectedFilePath] = useState<string>(
    props.initialDiagnostic?.filePath || ''
  )
  const [previewEncoding, setPreviewEncoding] = useState<string>(
    props.initialDiagnostic?.detectedEncoding || 'UTF-8'
  )
  const [lineEndingTarget, setLineEndingTarget] = useState<'CRLF' | 'LF'>('CRLF')
  const [searchText, setSearchText] = useState<string>('')
  const [isLoading, setIsLoading] = useState<boolean>(false)

  const fileInfo = useMemo<FileDiagnosticResult | null>(() => {
    if (rawBytes) {
      return inspectFileFromBuffer(
        rawBytes,
        selectedFilePath,
        previewEncoding
      )
    }
    return props.initialDiagnostic ?? null
  }, [rawBytes, selectedFilePath, props.initialDiagnostic, previewEncoding])

  const handlePickFile = async () => {
    setIsLoading(true)
    try {
      const res = await pickAndReadLocalFile(props.hostOverride)
      if (!res.ok || !res.bytes) {
        if (res.error && res.error !== '未选择文件') {
          await showToast({ style: Toast.Style.Failure, title: res.error })
        }
        return
      }
      setSelectedFilePath(res.filePath || 'inspected-file.bin')
      setRawBytes(res.bytes)
      await showToast({
        style: Toast.Style.Success,
        title: `已载入文件 (${res.bytes.byteLength} 字节)`
      })
    } finally {
      setIsLoading(false)
    }
  }

  const filteredLines = useMemo(() => {
    const lines = fileInfo?.previewLines ?? []
    const q = searchText.trim().toLowerCase()
    if (!q) return lines
    return lines.filter((l) => l.text.toLowerCase().includes(q))
  }, [fileInfo, searchText])

  const handleConvertToUtf8Bom = async () => {
    if (!fileInfo || !fileInfo.isText) {
      await showToast({
        style: Toast.Style.Failure,
        title: '此文件为二进制文件或为空，不可作为文本进行字符转码'
      })
      return
    }
    setIsLoading(true)
    try {
      const sourceBuf =
        rawBytes ??
        new TextEncoder().encode(fileInfo.previewLines.map((l) => l.text).join('\n'))
      const converted = convertTextBufferEncoding(
        sourceBuf,
        fileInfo.detectedEncoding,
        'utf-8-bom',
        lineEndingTarget
      )
      const res = await saveConvertedTextFile(
        fileInfo.filePath,
        converted,
        props.hostOverride
      )
      if (!res.ok) {
        await showToast({
          style: Toast.Style.Failure,
          title: res.error || '转码写入失败'
        })
        return
      }
      await showToast({
        style: Toast.Style.Success,
        title: `已转为 UTF-8-BOM (${lineEndingTarget})，Excel 打开不再乱码`
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleFixExtension = async () => {
    if (!fileInfo || !fileInfo.extensionMismatch) {
      await showToast({
        style: Toast.Style.Success,
        title: '当前文件扩展名与真实二进制魔数一致，无需修正'
      })
      return
    }
    setIsLoading(true)
    try {
      const res = await fixFileExtension(
        fileInfo.filePath,
        fileInfo.realExtension,
        props.hostOverride
      )
      if (!res.ok) {
        await showToast({
          style: Toast.Style.Failure,
          title: res.error || '重命名修正后缀失败'
        })
        return
      }
      await showToast({
        style: Toast.Style.Success,
        title: `已修正为真实后缀: .${fileInfo.realExtension}`
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <List
      navigationTitle="文件透视与转码"
      isLoading={isLoading}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索文本前 100 行解码预览内容..."
      filterBar={{
        summaryText: fileInfo
          ? `真实类型: ${fileInfo.realMimeType} (${fileInfo.extensionMismatch ? `假后缀! 实为 .${fileInfo.realExtension}` : '后缀一致'}) · 编码: ${fileInfo.detectedEncoding} (置信度 ${fileInfo.confidence}%) · 换行符: ${fileInfo.lineEnding}`
          : '支持 CSV/TXT 解决 Excel 乱码，Magic Bytes 秒破 WebP/AVIF 假后缀',
        actions: [
          {
            id: 'pick-file',
            title: '选择本地文件',
            onAction: () => {
              void handlePickFile()
            }
          },
          {
            id: 'to-utf8-bom',
            title: '转为 UTF-8-BOM (Excel不乱码)',
            onAction: () => {
              void handleConvertToUtf8Bom()
            }
          },
          {
            id: 'fix-ext',
            title: fileInfo?.extensionMismatch
              ? `修正扩展名为 .${fileInfo.realExtension}`
              : '校验文件后缀',
            onAction: () => {
              void handleFixExtension()
            }
          }
        ]
      }}
      workbenchPanel={{
        title: fileInfo ? fileInfo.fileName : '请拖入或选择需要透视与转码的文件',
        subtitle: fileInfo ? fileInfo.filePath : '二进制魔数透视与多字符集无损转码引擎',
        fields: [
          {
            id: 'previewEncoding',
            label: '解码预览字符集',
            type: 'select',
            value: previewEncoding,
            options: [
              { label: '自动探测 (UTF-8 / GBK)', value: fileInfo?.detectedEncoding || 'UTF-8' },
              { label: 'UTF-8 (标准无 BOM)', value: 'UTF-8' },
              { label: 'GBK / GB18030 (国标中文)', value: 'GBK' },
              { label: 'Big5 (繁体中文)', value: 'Big5' },
              { label: 'UTF-16LE', value: 'UTF-16LE' }
            ],
            onChange: (val: unknown) => setPreviewEncoding(String(val))
          },
          {
            id: 'lineEndingTarget',
            label: '目标换行符规范',
            type: 'select',
            value: lineEndingTarget,
            options: [
              { label: 'Windows 标准 (CRLF)', value: 'CRLF' },
              { label: 'Unix / macOS 标准 (LF)', value: 'LF' }
            ],
            onChange: (val: unknown) => setLineEndingTarget(val as 'CRLF' | 'LF')
          },
          {
            id: 'magicHex',
            label: '文件头魔数 (Magic Bytes)',
            type: 'info',
            value: fileInfo?.hexHeaderPreview || '等待读取'
          },
          {
            id: 'mimeInfo',
            label: '真实 MIME 与扩展名',
            type: 'info',
            value: fileInfo
              ? `${fileInfo.realMimeType} (.${fileInfo.realExtension})`
              : '未载入'
          }
        ],
        previewCard: {
          title: fileInfo?.extensionMismatch
            ? `发现假后缀伪装：表面为 .${fileInfo.currentExtension}，真实魔数为 .${fileInfo.realExtension}`
            : fileInfo?.isText
              ? `字符编码: ${fileInfo.detectedEncoding} · 换行符: ${fileInfo.lineEnding}`
              : '纯二进制文件格式（已自动禁用文本转码防止破坏结构）',
          subtitle: fileInfo
            ? `文件大小 ${(fileInfo.fileSize / 1024).toFixed(1)} KB · 置信度 ${fileInfo.confidence}%`
            : '拖入文件后立即显示前 100 行安全解码预览'
        }
      }}
      subList={{
        title: `文本前 100 行安全解码预览 (${filteredLines.length} 行)`,
        subtitle: '按 Enter 一键转为 Excel 兼容 UTF-8-BOM，或复制单行文本',
        emptyText: '请先选择需要透视或转码的本地文件',
        items: filteredLines.map((line) => (
          <List.Item
            key={`line-${line.lineNumber}`}
            id={`line-${line.lineNumber}`}
            title={line.text || '(空行)'}
            icon={Icon.Text}
            accessories={[
              fileInfo?.extensionMismatch && line.lineNumber === 1
                ? { tag: { value: `实为 .${fileInfo.realExtension}`, color: Color.Red } }
                : { tag: `L${line.lineNumber}` }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title="一键转为 UTF-8-BOM (解决 Excel 乱码)"
                  icon={Icon.CheckCircle}
                  onAction={handleConvertToUtf8Bom}
                />
                <Action
                  title={`修正假扩展名为 .${fileInfo?.realExtension || 'txt'}`}
                  icon={Icon.Pencil}
                  onAction={handleFixExtension}
                />
                <Action.CopyToClipboard title="复制该行文本" content={line.text} />
              </ActionPanel>
            }
          />
        ))
      }}
    />
  )
}

export default FileInspectorCommand
