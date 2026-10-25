import React, {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  Toast,
  showToast,
  useEffect,
  useMemo,
  useState
} from '../../index.js'
import { callHostTransport } from '../shared/native-ipc.js'
import {
  filterInstalledFonts,
  sanitizePreviewSampleText,
  scanInstalledFonts
} from './font-service.js'
import type { FontLicenseFilter, SystemFontInfo } from './types.js'

export * from './types.js'
export * from './font-service.js'

export interface FontManagerCommandProps {
  featureCode?: string
  initialFonts?: SystemFontInfo[]
  initialFilter?: FontLicenseFilter
  initialSampleText?: string
  hostOverride?: unknown
}

const SAMPLE_PRESETS = [
  '天地玄黄 宇宙洪荒 永和九年 岁在癸丑 12345 ABC abc',
  '限时特惠 全场五折 · 现代极客效率工作台 2026',
  'The quick brown fox jumps over the lazy dog 0123456789'
]

function resolveInitialLicenseFilter(
  featureCode?: string,
  initialFilter?: FontLicenseFilter
): FontLicenseFilter {
  if (initialFilter) return initialFilter
  if (featureCode === 'font-manager-free-commercial') return 'free-commercial'
  if (featureCode === 'font-manager-commercial-risk') return 'commercial-risk'
  return 'all'
}

function getLicenseBadge(font: SystemFontInfo): {
  tag: string | { value: string; color: Color }
} {
  if (font.licenseType === 'free-commercial') {
    return { tag: '免费商用' }
  }
  if (font.licenseType === 'commercial-risk') {
    return { tag: { value: '商用需授权', color: Color.Red } }
  }
  if (font.licenseType === 'system-builtin') {
    return { tag: '系统内置' }
  }
  return { tag: '需核实授权' }
}

export function FontManagerCommand(props: FontManagerCommandProps = {}) {
  const [fonts, setFonts] = useState<SystemFontInfo[]>(props.initialFonts ?? [])
  const [licenseFilter, setLicenseFilter] = useState<FontLicenseFilter>(() =>
    resolveInitialLicenseFilter(props.featureCode, props.initialFilter)
  )
  const [searchText, setSearchText] = useState<string>('')
  const [sampleIdx, setSampleIdx] = useState<number>(0)
  const [isLoading, setIsLoading] = useState<boolean>(!props.initialFonts)

  const previewSampleText = useMemo(() => {
    if (props.initialSampleText) {
      return sanitizePreviewSampleText(props.initialSampleText)
    }
    return sanitizePreviewSampleText(SAMPLE_PRESETS[sampleIdx % SAMPLE_PRESETS.length]!)
  }, [props.initialSampleText, sampleIdx])

  const loadFonts = async () => {
    setIsLoading(true)
    try {
      const list = await scanInstalledFonts(props.hostOverride)
      setFonts(list)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    setLicenseFilter(resolveInitialLicenseFilter(props.featureCode, props.initialFilter))
  }, [props.featureCode, props.initialFilter])

  useEffect(() => {
    if (!props.initialFonts) {
      void loadFonts()
    }
  }, [])

  const filteredFonts = useMemo(
    () => filterInstalledFonts(fonts, licenseFilter, searchText),
    [fonts, licenseFilter, searchText]
  )

  const freeCount = useMemo(
    () => fonts.filter((f) => f.licenseType === 'free-commercial').length,
    [fonts]
  )

  const handleChangeSampleText = async () => {
    const nextIdx = (sampleIdx + 1) % SAMPLE_PRESETS.length
    setSampleIdx(nextIdx)
    await showToast({
      style: Toast.Style.Success,
      title: `已切换预览文案：${SAMPLE_PRESETS[nextIdx]!.slice(0, 18)}...`
    })
  }

  const handleRevealFontFile = async (filePath: string) => {
    await callHostTransport('shell_show_item_in_folder', { path: filePath }, props.hostOverride)
  }

  return (
    <List
      navigationTitle="字体管理"
      isLoading={isLoading}
      isShowingDetail={false}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="搜索字体名称、拼音，或切换商用授权状态..."
      searchBarAccessory={
        <List.Dropdown
          value={licenseFilter}
          onChange={(val) => setLicenseFilter(val as FontLicenseFilter)}
          tooltip="按商用授权状态筛选"
        >
          <List.Dropdown.Item title="全部已安装字体" value="all" icon={Icon.Text} />
          <List.Dropdown.Item
            title="免费可商用字体（安全合规）"
            value="free-commercial"
            icon={Icon.Shield}
          />
          <List.Dropdown.Item
            title="商业版权字体（需授权购买）"
            value="commercial-risk"
            icon={Icon.ExclamationMark}
          />
          <List.Dropdown.Item title="系统默认内置字体" value="system" icon={Icon.Gear} />
        </List.Dropdown>
      }
      filterBar={{
        summaryText: `共发现 ${fonts.length} 款本机字体 · 其中 ${freeCount} 款免费可商用 · 当前预览: "${previewSampleText}"`,
        actions: [
          {
            id: 'change-sample',
            title: '切换预览样本词',
            onAction: () => {
              void handleChangeSampleText()
            }
          },
          {
            id: 'refresh-fonts',
            title: '重新扫描字体库',
            onAction: () => {
              void loadFonts()
            }
          }
        ]
      }}
    >
      {filteredFonts.map((font) => (
        <List.Item
          key={font.uniqueId}
          id={font.uniqueId}
          title={font.chineseName || font.family}
          subtitle={`${font.family} · ${previewSampleText}`}
          icon={Icon.Text}
          accessories={[
            getLicenseBadge(font),
            { text: font.format.toUpperCase() },
            { text: font.weight }
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="复制字体 Family 英文名" content={font.family} />
              <Action.CopyToClipboard
                title="复制 CSS font-family 声明"
                content={`font-family: "${font.family}", "${font.chineseName || font.family}", sans-serif;`}
                shortcut={{ modifiers: ['cmd'], key: 'enter' }}
              />
              <Action
                title="在文件夹中定位字体文件"
                icon={Icon.Folder}
                shortcut={{ modifiers: ['cmd', 'shift'], key: 'o' }}
                onAction={() => handleRevealFontFile(font.filePath)}
              />
              {font.licenseUrl ? (
                <Action.OpenInBrowser
                  title="查看开源商用主页 / 许可详情"
                  url={font.licenseUrl}
                />
              ) : null}
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}

export default FontManagerCommand
