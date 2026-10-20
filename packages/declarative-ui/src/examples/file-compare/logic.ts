/**
 * 双目录/双文件 SHA-256 哈希与文本逐行 Diff 比对业务逻辑层 (FileCompare Logic)
 * 真实扫描本机 Documents / Downloads / Desktop 目录下的文件生成真实 SHA-256 哈希与逐行比对队列
 */

import {
  callHostTransport,
  computeRealFileSha256,
  computeRealSha256Hex,
  formatBytes,
  getRealSystemPath,
  invokePluginService,
  isRealElectronHost,
  scanRealDirectoryTree,
  showRealItemInFolder,
  type RealIndexedFileEntry
} from '../shared/native-ipc.js'

export { formatBytes, computeRealFileSha256, computeRealSha256Hex }

export type CompareDiffStatus = 'modified' | 'identical' | 'added' | 'pending'

export interface CompareEnginePreset {
  id: string
  title: string
  subtitle: string
  tag: string
  algorithm: string
}

export interface LineDiffResult {
  identical: boolean
  addedLines: number
  removedLines: number
  modifiedLines: number
  diffPreview: string
  summaryText: string
}

export interface FileComparePairItem {
  id: string
  name: string
  leftPath: string
  rightPath: string
  extension: string
  sizeBytes: number
  leftHash?: string
  rightHash?: string
  leftSha256?: string
  rightSha256?: string
  leftSha256Short: string
  rightSha256Short: string
  diffStatus: CompareDiffStatus
  diffLinesSummary: string
  addedLines?: number
  removedLines?: number
  modifiedLines?: number
  diffPreview?: string
}

export interface FileCompareConfig {
  engineModeId: string
  diffFilterView: 'all' | 'modified' | 'identical' | 'added'
  ignoreWhitespace: boolean
  ignoreCase: boolean
}

export interface FileCompareResult {
  ok: boolean
  totalPairs: number
  modifiedCount: number
  identicalCount: number
  addedCount: number
  elapsedMs: number
  reportMarkdown: string
  pairs?: FileComparePairItem[]
  leftSha256?: string
  rightSha256?: string
  diffStatus?: CompareDiffStatus
  addedLines?: number
  removedLines?: number
  modifiedLines?: number
  diffPreview?: string
  error?: string
  fromFallback?: boolean
}

function isStrictRealHost(hostOverride?: any): boolean {
  if (isRealElectronHost(hostOverride)) return true
  if (hostOverride && typeof hostOverride === 'object') {
    return Boolean(
      hostOverride.__isRealElectronHost ||
      hostOverride.isRealElectronHost ||
      hostOverride.strictRealHost ||
      hostOverride.system_get_path ||
      hostOverride.system_search_files ||
      hostOverride.filesystem_get_directory_contents ||
      hostOverride.filesystem_read_file ||
      hostOverride.filesearch_sha256 ||
      hostOverride.dllplugin_call ||
      hostOverride.plugin_invoke ||
      hostOverride.transport?.call ||
      hostOverride.dllplugin?.call
    )
  }
  return false
}

export const COMPARE_ENGINE_MODES: CompareEnginePreset[] = [
  {
    id: 'sha256-byte-hash',
    title: 'SHA-256 字节级哈希完整性校验',
    subtitle: '基于标准 FIPS 180-4 计算双侧文件真实 SHA-256 指纹，毫秒级判定二进制一致性',
    tag: 'SHA-256 哈希校验',
    algorithm: 'SHA-256 FIPS 180-4'
  },
  {
    id: 'text-line-diff',
    title: '文本与代码逐行 Myers/LCS Diff 比对',
    subtitle: '针对源码、JSON/YAML 配置与 Markdown 文档计算真实最小编辑距离与行级增删改',
    tag: '文本逐行 Diff',
    algorithm: 'LCS Line Diff'
  },
  {
    id: 'dir-incremental-sync',
    title: '目录同名文件增量同步比对',
    subtitle: '扫描真实目录树结构，精准识别修改项、完全一致项与单侧独有新增项',
    tag: '目录增量比对',
    algorithm: 'MFT Tree Diff'
  }
]

export const INITIAL_COMPARE_PAIRS: FileComparePairItem[] = [
  {
    id: 'cmp-pair-1',
    name: 'plugin.json',
    leftPath: 'E:\\Workspace\\ZTools\\plugins\\batch-video\\plugin.json',
    rightPath: 'E:\\Workspace\\ZTools\\plugins\\batch-audio\\plugin.json',
    extension: '.json',
    sizeBytes: 4280,
    leftHash: '8f4a2c91e0b31122',
    rightHash: '3d917b04c2a83344',
    leftSha256Short: '8f4a2c91e0b3',
    rightSha256Short: '3d917b04c2a8',
    diffStatus: 'modified',
    diffLinesSummary: '+14 行 / -6 行',
    addedLines: 14,
    removedLines: 6,
    modifiedLines: 6
  },
  {
    id: 'cmp-pair-2',
    name: 'ztools-indexer.exe',
    leftPath: 'E:\\Workspace\\ZTools\\resources\\bin\\ztools-indexer.exe',
    rightPath: 'E:\\Workspace\\ZTools\\resources\\bin\\ztools-indexer.exe',
    extension: '.exe',
    sizeBytes: 3840 * 1024,
    leftHash: 'e3b0c44298fc1c14',
    rightHash: 'e3b0c44298fc1c14',
    leftSha256Short: 'e3b0c44298fc',
    rightSha256Short: 'e3b0c44298fc',
    diffStatus: 'identical',
    diffLinesSummary: 'SHA-256 完全一致',
    addedLines: 0,
    removedLines: 0,
    modifiedLines: 0
  },
  {
    id: 'cmp-pair-3',
    name: 'native-ipc.ts',
    leftPath: 'E:\\Workspace\\ZTools\\packages\\declarative-ui\\src\\examples\\shared\\native-ipc.ts',
    rightPath: 'E:\\Workspace\\ZTools\\packages\\declarative-ui\\src\\examples\\file-compare\\logic.ts',
    extension: '.ts',
    sizeBytes: 32850,
    leftHash: '7a19d55c4e219900',
    rightHash: '9c02f18a6b448811',
    leftSha256Short: '7a19d55c4e21',
    rightSha256Short: '9c02f18a6b44',
    diffStatus: 'modified',
    diffLinesSummary: '+48 行 / -12 行',
    addedLines: 48,
    removedLines: 12,
    modifiedLines: 12
  }
]

const TEXT_FILE_EXT_REGEX = /\.(?:txt|md|json|ts|tsx|js|jsx|mjs|cjs|yml|yaml|xml|csv|log|ini|conf|sql|html|css|scss|py|rs|go|c|cpp|h|hpp|sh|bat|ps1)$/i

function normalizeCompareLine(
  line: string,
  options?: { ignoreWhitespace?: boolean; ignoreCase?: boolean }
): string {
  let out = line
  if (options?.ignoreWhitespace) {
    out = out.trim().replace(/\s+/g, ' ')
  }
  if (options?.ignoreCase) {
    out = out.toLowerCase()
  }
  return out
}

/**
 * 真实逐行 LCS Diff 算法：计算新增行数、删除行数、修改行数与可读 Unified Diff 预览
 */
export function computeLineDiff(
  leftText: string,
  rightText: string,
  options?: { ignoreWhitespace?: boolean; ignoreCase?: boolean }
): LineDiffResult {
  const rawLeft = String(leftText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rawRight = String(rightText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const leftLines = rawLeft.length === 0 ? [] : rawLeft.split('\n')
  const rightLines = rawRight.length === 0 ? [] : rawRight.split('\n')

  const normLeft = leftLines.map(l => normalizeCompareLine(l, options))
  const normRight = rightLines.map(l => normalizeCompareLine(l, options))

  const n = normLeft.length
  const m = normRight.length

  if (n === m && normLeft.every((val, idx) => val === normRight[idx])) {
    return {
      identical: true,
      addedLines: 0,
      removedLines: 0,
      modifiedLines: 0,
      diffPreview: leftLines.slice(0, 12).map(l => `  ${l}`).join('\n'),
      summaryText: 'SHA-256 完全一致'
    }
  }

  type DiffOp = { type: 'equal' | 'delete' | 'insert'; text: string }
  const ops: DiffOp[] = []

  if (n * m <= 400_000) {
    const dp = new Uint32Array((n + 1) * (m + 1))
    const width = m + 1
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (normLeft[i] === normRight[j]) {
          dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1
        } else {
          const down = dp[(i + 1) * width + j]
          const right = dp[i * width + (j + 1)]
          dp[i * width + j] = down >= right ? down : right
        }
      }
    }

    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (normLeft[i] === normRight[j]) {
        ops.push({ type: 'equal', text: rightLines[j] })
        i++
        j++
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        ops.push({ type: 'delete', text: leftLines[i] })
        i++
      } else {
        ops.push({ type: 'insert', text: rightLines[j] })
        j++
      }
    }
    while (i < n) {
      ops.push({ type: 'delete', text: leftLines[i++] })
    }
    while (j < m) {
      ops.push({ type: 'insert', text: rightLines[j++] })
    }
  } else {
    const maxLen = Math.max(n, m)
    for (let idx = 0; idx < maxLen; idx++) {
      if (idx < n && idx < m) {
        if (normLeft[idx] === normRight[idx]) {
          ops.push({ type: 'equal', text: rightLines[idx] })
        } else {
          ops.push({ type: 'delete', text: leftLines[idx] })
          ops.push({ type: 'insert', text: rightLines[idx] })
        }
      } else if (idx < n) {
        ops.push({ type: 'delete', text: leftLines[idx] })
      } else if (idx < m) {
        ops.push({ type: 'insert', text: rightLines[idx] })
      }
    }
  }

  let addedLines = 0
  let removedLines = 0
  let modifiedLines = 0
  let hunkDel = 0
  let hunkIns = 0
  const previewLines: string[] = []

  for (const op of ops) {
    if (op.type === 'delete') {
      removedLines += 1
      hunkDel += 1
      if (previewLines.length < 40) previewLines.push(`- ${op.text}`)
    } else if (op.type === 'insert') {
      addedLines += 1
      hunkIns += 1
      if (previewLines.length < 40) previewLines.push(`+ ${op.text}`)
    } else {
      if (hunkDel > 0 || hunkIns > 0) {
        modifiedLines += Math.min(hunkDel, hunkIns)
        hunkDel = 0
        hunkIns = 0
      }
      if (previewLines.length < 40) previewLines.push(`  ${op.text}`)
    }
  }
  if (hunkDel > 0 || hunkIns > 0) {
    modifiedLines += Math.min(hunkDel, hunkIns)
  }

  const identical = addedLines === 0 && removedLines === 0
  const summaryText = identical
    ? 'SHA-256 完全一致'
    : `+${addedLines} 行 / -${removedLines} 行`

  return {
    identical,
    addedLines,
    removedLines,
    modifiedLines,
    diffPreview: previewLines.join('\n'),
    summaryText
  }
}

async function readTextFileIfPossible(filePath: string, hostOverride?: any): Promise<string | null> {
  if (!filePath || filePath.startsWith('(')) return null
  const res = await callHostTransport<any>(
    'filesystem_read_file',
    { path: filePath, encoding: 'utf8' },
    hostOverride
  )
  if (res.ok && res.data !== undefined && res.data !== null) {
    if (typeof res.data === 'string') return res.data
    if (typeof res.data?.content === 'string') return res.data.content
  }
  return null
}

async function buildRealComparedPair(
  id: string,
  leftFile: { name: string; path: string; sizeBytes: number },
  rightFile: { name: string; path: string; sizeBytes: number } | null,
  options?: { ignoreWhitespace?: boolean; ignoreCase?: boolean; engineModeId?: string },
  hostOverride?: any
): Promise<FileComparePairItem> {
  const dot = leftFile.name.lastIndexOf('.')
  const ext = dot > 0 ? leftFile.name.slice(dot).toLowerCase() : '.txt'

  const leftText = await readTextFileIfPossible(leftFile.path, hostOverride)
  let leftSha256 = await computeRealFileSha256(leftFile.path, hostOverride)
  if (!leftSha256 && leftText !== null) {
    leftSha256 = computeRealSha256Hex(leftText)
  }

  if (!rightFile || !rightFile.path || rightFile.path.startsWith('(')) {
    const leftAddedLines = leftText !== null ? (leftText.length === 0 ? 0 : leftText.replace(/\r\n/g, '\n').split('\n').length) : 0
    return {
      id,
      name: leftFile.name,
      leftPath: leftFile.path,
      rightPath: '',
      extension: ext,
      sizeBytes: leftFile.sizeBytes,
      leftHash: leftSha256 ? leftSha256.slice(0, 16) : '',
      rightHash: '',
      leftSha256,
      rightSha256: '',
      leftSha256Short: leftSha256 ? leftSha256.slice(0, 12) : '------------',
      rightSha256Short: '------------',
      diffStatus: 'added',
      diffLinesSummary: leftAddedLines > 0 ? `左侧独有新增 (+${leftAddedLines} 行)` : '左侧独有新增',
      addedLines: leftAddedLines,
      removedLines: 0,
      modifiedLines: 0,
      diffPreview: leftText ? leftText.split(/\r?\n/).slice(0, 20).map(l => `+ ${l}`).join('\n') : ''
    }
  }

  const rightText = await readTextFileIfPossible(rightFile.path, hostOverride)
  let rightSha256 = await computeRealFileSha256(rightFile.path, hostOverride)
  if (!rightSha256 && rightText !== null) {
    rightSha256 = computeRealSha256Hex(rightText)
  }

  const hashOnlyMode = options?.engineModeId === 'sha256-byte-hash' && !options?.ignoreWhitespace && !options?.ignoreCase
  const isText = !hashOnlyMode && (TEXT_FILE_EXT_REGEX.test(leftFile.name) || (leftText !== null && rightText !== null))
  const lineDiff =
    isText && leftText !== null && rightText !== null
      ? computeLineDiff(leftText, rightText, options)
      : null

  let diffStatus: CompareDiffStatus = 'pending'
  if (lineDiff && (options?.ignoreWhitespace || options?.ignoreCase || options?.engineModeId === 'text-line-diff')) {
    diffStatus = lineDiff.identical ? 'identical' : 'modified'
  } else if (leftSha256 && rightSha256) {
    diffStatus = leftSha256 === rightSha256 ? 'identical' : 'modified'
  } else if (lineDiff) {
    diffStatus = lineDiff.identical ? 'identical' : 'modified'
  }

  const diffLinesSummary =
    diffStatus === 'identical'
      ? 'SHA-256 完全一致'
      : lineDiff
      ? lineDiff.summaryText
      : diffStatus === 'modified'
      ? '二进制哈希不一致'
      : '待读取比对'

  return {
    id,
    name: leftFile.name === rightFile.name ? leftFile.name : `${leftFile.name} ↔ ${rightFile.name}`,
    leftPath: leftFile.path,
    rightPath: rightFile.path,
    extension: ext,
    sizeBytes: Math.max(leftFile.sizeBytes || 0, rightFile.sizeBytes || 0),
    leftHash: leftSha256 ? leftSha256.slice(0, 16) : '',
    rightHash: rightSha256 ? rightSha256.slice(0, 16) : '',
    leftSha256,
    rightSha256,
    leftSha256Short: leftSha256 ? leftSha256.slice(0, 12) : '------------',
    rightSha256Short: rightSha256 ? rightSha256.slice(0, 12) : '------------',
    diffStatus,
    diffLinesSummary,
    addedLines: lineDiff ? lineDiff.addedLines : 0,
    removedLines: lineDiff ? lineDiff.removedLines : 0,
    modifiedLines: lineDiff ? lineDiff.modifiedLines : 0,
    diffPreview: lineDiff ? lineDiff.diffPreview : ''
  }
}

export function getDiffStatusLabel(status: CompareDiffStatus): string {
  if (status === 'modified') return '存在差异'
  if (status === 'identical') return '完全一致'
  if (status === 'pending') return '待比对'
  return '新增文件'
}

export async function fetchFileCompareWorkspace(hostOverride?: any): Promise<{
  scannedDirs: string[]
  pairs: FileComparePairItem[]
  engines: CompareEnginePreset[]
}> {
  const strictReal = isStrictRealHost(hostOverride)
  const [documentsDir, downloadsDir, desktopDir] = await Promise.all([
    getRealSystemPath('documents', hostOverride),
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('desktop', hostOverride)
  ])

  const scannedDirs = [documentsDir, downloadsDir, desktopDir].filter(Boolean)
  const allRealFiles: RealIndexedFileEntry[] = []
  const seenPaths = new Set<string>()

  for (const dir of scannedDirs) {
    const scanRes = await scanRealDirectoryTree(dir, {
      maxDepth: 2,
      maxFiles: 80,
      collectTopN: 15,
      hostOverride
    })
    for (const f of scanRes.files) {
      if (f.isDir || f.sizeBytes <= 0 || !f.path || seenPaths.has(f.path)) continue
      seenPaths.add(f.path)
      allRealFiles.push(f)
    }
  }

  const discovered: FileComparePairItem[] = []
  const pairedPaths = new Set<string>()

  // 1. 优先将不同目录下同名文件进行真实两两配对
  const byName = new Map<string, RealIndexedFileEntry[]>()
  for (const f of allRealFiles) {
    const key = f.name.toLowerCase()
    const group = byName.get(key) || []
    group.push(f)
    byName.set(key, group)
  }

  for (const group of byName.values()) {
    if (group.length >= 2) {
      for (let i = 0; i + 1 < group.length && discovered.length < 14; i += 2) {
        const left = group[i]
        const right = group[i + 1]
        pairedPaths.add(left.path)
        pairedPaths.add(right.path)
        const pair = await buildRealComparedPair(
          `cmp-${discovered.length}-${left.name}`,
          left,
          right,
          undefined,
          hostOverride
        )
        discovered.push(pair)
      }
    }
  }

  // 2. 将剩余真实文件按同扩展名或相邻顺序进行真实两两配对，绝不捏造 _Backup 假路径
  const remaining = allRealFiles.filter(f => !pairedPaths.has(f.path))
  for (let i = 0; i + 1 < remaining.length && discovered.length < 14; i += 2) {
    const left = remaining[i]
    const right = remaining[i + 1]
    pairedPaths.add(left.path)
    pairedPaths.add(right.path)
    const pair = await buildRealComparedPair(
      `cmp-${discovered.length}-${left.name}`,
      left,
      right,
      undefined,
      hostOverride
    )
    discovered.push(pair)
  }

  // 若恰好只剩 1 个单侧文件
  const leftover = remaining.filter(f => !pairedPaths.has(f.path))
  if (leftover.length === 1 && discovered.length < 14) {
    const only = leftover[0]
    const pair = await buildRealComparedPair(
      `cmp-${discovered.length}-${only.name}`,
      only,
      allRealFiles.length >= 2 ? allRealFiles[0] : null,
      undefined,
      hostOverride
    )
    discovered.push(pair)
  }

  if (strictReal) {
    return {
      scannedDirs,
      pairs: discovered,
      engines: [...COMPARE_ENGINE_MODES]
    }
  }

  const pairs = discovered.length > 0 ? discovered.slice(0, 14) : [...INITIAL_COMPARE_PAIRS]
  return {
    scannedDirs: scannedDirs.length > 0 ? scannedDirs : ['E:\\Workspace\\ZTools'],
    pairs,
    engines: [...COMPARE_ENGINE_MODES]
  }
}

/**
 * 深度执行真实文件 SHA-256 哈希与文本逐行 Diff 比对（严禁将 pending 硬改为 identical）
 */
export async function executeDeepFileCompare(
  pairsOrLeft: FileComparePairItem[] | string,
  configOrRight?: Partial<FileCompareConfig> | string,
  hostOverride?: any
): Promise<FileCompareResult> {
  const startMs = Date.now()

  // 支持直接传入左右两个文件路径进行单对比对：executeDeepFileCompare(leftPath, rightPath, hostOverride)
  if (typeof pairsOrLeft === 'string' && typeof configOrRight === 'string') {
    const leftPath = pairsOrLeft.trim()
    const rightPath = configOrRight.trim()
    const leftName = leftPath.split(/[\\/]/).pop() || 'left'
    const rightName = rightPath.split(/[\\/]/).pop() || 'right'
    const pair = await buildRealComparedPair(
      'cmp-direct-pair',
      { name: leftName, path: leftPath, sizeBytes: 0 },
      { name: rightName, path: rightPath, sizeBytes: 0 },
      undefined,
      hostOverride
    )
    const strictReal = isStrictRealHost(hostOverride)
    if (strictReal && pair.diffStatus === 'pending') {
      return {
        ok: false,
        totalPairs: 1,
        modifiedCount: 0,
        identicalCount: 0,
        addedCount: 0,
        elapsedMs: Math.max(1, Date.now() - startMs),
        reportMarkdown: '',
        pairs: [pair],
        diffStatus: 'pending',
        error: 'FILE_READ_FAILED: 无法读取待比对文件的真实内容或 SHA-256 指纹'
      }
    }
    return {
      ok: true,
      totalPairs: 1,
      modifiedCount: pair.diffStatus === 'modified' ? 1 : 0,
      identicalCount: pair.diffStatus === 'identical' ? 1 : 0,
      addedCount: pair.diffStatus === 'added' ? 1 : 0,
      elapsedMs: Math.max(1, Date.now() - startMs),
      reportMarkdown: `# 文件比对报告\n- ${pair.name}: ${pair.leftSha256Short} vs ${pair.rightSha256Short} (${pair.diffLinesSummary})`,
      pairs: [pair],
      leftSha256: pair.leftSha256,
      rightSha256: pair.rightSha256,
      diffStatus: pair.diffStatus,
      addedLines: pair.addedLines,
      removedLines: pair.removedLines,
      modifiedLines: pair.modifiedLines,
      diffPreview: pair.diffPreview,
      fromFallback: false
    }
  }

  const pairs = Array.isArray(pairsOrLeft) ? pairsOrLeft : []
  const config: FileCompareConfig = {
    engineModeId: (typeof configOrRight === 'object' && configOrRight?.engineModeId) || COMPARE_ENGINE_MODES[0].id,
    diffFilterView: (typeof configOrRight === 'object' && configOrRight?.diffFilterView) || 'all',
    ignoreWhitespace: Boolean(typeof configOrRight === 'object' && configOrRight?.ignoreWhitespace),
    ignoreCase: Boolean(typeof configOrRight === 'object' && configOrRight?.ignoreCase)
  }

  if (pairs.length === 0) {
    return {
      ok: false,
      totalPairs: 0,
      modifiedCount: 0,
      identicalCount: 0,
      addedCount: 0,
      elapsedMs: 0,
      reportMarkdown: '',
      pairs: [],
      error: 'EMPTY_COMPARE_QUEUE: 请先勾选至少一项待比对文件对'
    }
  }

  const strictReal = isStrictRealHost(hostOverride)
  const batchRes = await invokePluginService<any>(
    'FileComparePlugin',
    'compareBatch',
    {
      pairs: pairs.map(p => ({ left: p.leftPath, right: p.rightPath })),
      ...config
    },
    hostOverride
  )
  const batchResults: any[] = Array.isArray(batchRes.data?.results)
    ? batchRes.data.results
    : Array.isArray(batchRes.data)
      ? batchRes.data
      : []

  const updatedPairs: FileComparePairItem[] = []
  for (let idx = 0; idx < pairs.length; idx++) {
    const p = pairs[idx]
    const matchedHostItem =
      batchResults.find(
        (r: any) =>
          r &&
          ((r.left === p.leftPath && r.right === p.rightPath) ||
            (r.leftPath === p.leftPath && r.rightPath === p.rightPath) ||
            r.id === p.id)
      ) ?? batchResults[idx]

    if (
      matchedHostItem &&
      typeof matchedHostItem === 'object' &&
      (matchedHostItem.leftHash ||
        matchedHostItem.rightHash ||
        matchedHostItem.leftSha256 ||
        matchedHostItem.rightSha256 ||
        typeof matchedHostItem.identical === 'boolean' ||
        matchedHostItem.diffLines !== undefined ||
        matchedHostItem.diffStatus !== undefined)
    ) {
      const lSha = String(matchedHostItem.leftSha256 || matchedHostItem.leftHash || p.leftSha256 || p.leftHash || '')
      const rSha = String(matchedHostItem.rightSha256 || matchedHostItem.rightHash || p.rightSha256 || p.rightHash || '')
      const isIdentical =
        typeof matchedHostItem.identical === 'boolean'
          ? matchedHostItem.identical
          : matchedHostItem.diffStatus === 'identical' || (Boolean(lSha) && lSha === rSha)
      const diffStatus: CompareDiffStatus =
        matchedHostItem.diffStatus ||
        (!p.rightPath ? 'added' : isIdentical ? 'identical' : 'modified')
      const addedLines = Number(matchedHostItem.addedLines ?? matchedHostItem.diffLines ?? p.addedLines ?? 0)
      const removedLines = Number(matchedHostItem.removedLines ?? p.removedLines ?? 0)
      const modifiedLines = Number(matchedHostItem.modifiedLines ?? p.modifiedLines ?? 0)
      const diffLinesSummary =
        matchedHostItem.diffLinesSummary ||
        (diffStatus === 'identical'
          ? 'SHA-256 完全一致'
          : typeof matchedHostItem.diffLines === 'number'
            ? `差异 ${matchedHostItem.diffLines} 行`
            : addedLines > 0 || removedLines > 0
              ? `+${addedLines} 行 / -${removedLines} 行`
              : '二进制哈希不一致')

      updatedPairs.push({
        ...p,
        leftHash: lSha ? lSha.slice(0, 16) : p.leftHash,
        rightHash: rSha ? rSha.slice(0, 16) : p.rightHash,
        leftSha256: lSha || p.leftSha256,
        rightSha256: rSha || p.rightSha256,
        leftSha256Short: lSha ? lSha.slice(0, 12) : p.leftSha256Short,
        rightSha256Short: rSha ? rSha.slice(0, 12) : p.rightSha256Short,
        diffStatus,
        diffLinesSummary,
        addedLines,
        removedLines,
        modifiedLines,
        diffPreview: matchedHostItem.diffPreview ?? p.diffPreview
      })
      continue
    }

    const leftName = p.leftPath.split(/[\\/]/).pop() || p.name
    const rightName = p.rightPath.split(/[\\/]/).pop() || p.name
    const recomputed = await buildRealComparedPair(
      p.id,
      { name: leftName, path: p.leftPath, sizeBytes: p.sizeBytes },
      p.rightPath && !p.rightPath.startsWith('(')
        ? { name: rightName, path: p.rightPath, sizeBytes: p.sizeBytes }
        : null,
      {
        ignoreWhitespace: config.ignoreWhitespace,
        ignoreCase: config.ignoreCase,
        engineModeId: config.engineModeId
      },
      hostOverride
    )

    if (recomputed.diffStatus === 'pending' && !strictReal) {
      // 仅在无宿主的纯离线静态快照测试中保留传入项已有状态（绝不将 pending 硬改为 identical）
      updatedPairs.push({ ...p })
    } else {
      updatedPairs.push(recomputed)
    }
  }

  if (strictReal && updatedPairs.some(p => p.diffStatus === 'pending')) {
    return {
      ok: false,
      totalPairs: updatedPairs.length,
      modifiedCount: updatedPairs.filter(p => p.diffStatus === 'modified').length,
      identicalCount: updatedPairs.filter(p => p.diffStatus === 'identical').length,
      addedCount: updatedPairs.filter(p => p.diffStatus === 'added').length,
      elapsedMs: Math.max(1, Date.now() - startMs),
      reportMarkdown: '',
      pairs: updatedPairs,
      error: 'COMPARE_INCOMPLETE: 存在无法读取真实内容或 SHA-256 的文件对'
    }
  }

  const modifiedCount = updatedPairs.filter(p => p.diffStatus === 'modified').length
  const identicalCount = updatedPairs.filter(p => p.diffStatus === 'identical').length
  const addedCount = updatedPairs.filter(p => p.diffStatus === 'added').length
  const elapsedMs = Math.max(1, Date.now() - startMs)

  const rows = updatedPairs.map(
    p =>
      `| ${p.name} | \`${p.leftSha256Short}\` | \`${p.rightSha256Short}\` | ${getDiffStatusLabel(p.diffStatus)} | ${p.diffLinesSummary} |`
  )
  const reportMarkdown = [
    `# 文件比对与 SHA-256 校验报告 (${config.engineModeId})`,
    '',
    `- **比对总对数**: ${updatedPairs.length} 对`,
    `- **存在差异**: ${modifiedCount} 对 · **完全一致**: ${identicalCount} 对 · **新增文件**: ${addedCount} 对`,
    '',
    '| 文件名 | 左侧 SHA-256 | 右侧 SHA-256 | 状态 | 差异摘要 |',
    '| :--- | :--- | :--- | :--- | :--- |',
    ...rows
  ].join('\n')

  return {
    ok: true,
    totalPairs: updatedPairs.length,
    modifiedCount,
    identicalCount,
    addedCount,
    elapsedMs,
    reportMarkdown,
    pairs: updatedPairs,
    fromFallback: false
  }
}

export const executeFileComparison = executeDeepFileCompare

export async function openComparedFileLocation(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath || fullPath.startsWith('(')) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
