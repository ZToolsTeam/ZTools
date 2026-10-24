import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  ClipboardHistoryService,
  calculateShannonEntropy,
  isHighEntropyPassword,
  ClipboardItemRecord
} from '../../src/main/services/clipboard-history-service.js'
import {
  SnippetsService,
  expandSnippetMacros
} from '../../src/main/services/snippets-service.js'
import { FileSearchService } from '../../src/main/services/file-search-service.js'
import {
  WindowManagementService,
  WINDOW_ACTIONS
} from '../../src/main/services/window-management-service.js'
import type { SidecarManager } from '../../src/main/services/sidecar-manager.js'
import type { HudService } from '../../src/main/services/hud-service.js'

function testDir(name: string): string {
  return path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-${name}`)
}

// =============================================================================
// 1. ClipboardHistoryService Integration & Chaos Tests
// =============================================================================
test('ClipboardHistoryService: Shannon entropy and credential desensitization', () => {
  // 1. 低熵常规文本
  assert.equal(isHighEntropyPassword(''), false)
  assert.equal(isHighEntropyPassword('hello world'), false)
  assert.equal(isHighEntropyPassword('123456789012'), false)
  assert.equal(isHighEntropyPassword('abcdefghijklm'), false)

  // 2. 高熵安全凭证 (长度 >= 12, 无空白, 混合大小写字母/数字/特殊符号)
  const highEntropySecret = 'K8#mQ9$vL2!xP0@z'
  assert.equal(isHighEntropyPassword(highEntropySecret), true)
  assert.ok(calculateShannonEntropy(highEntropySecret) > 3.5)

  // 3. 超长但低熵（重复字符）
  const repetitive = 'A1!A1!A1!A1!A1!A1!A1!'
  assert.ok(calculateShannonEntropy(repetitive) < 3.0)
})

test('ClipboardHistoryService: SQLite WAL storage, deduplication, search & pin lifecycle', async () => {
  const root = testDir('clip-history-lifecycle')
  await fs.mkdir(root, { recursive: true })
  const dbPath = path.join(root, 'clipboard.sqlite')

  const service = new ClipboardHistoryService({
    dbPath,
    maxPreviewChars: 50,
    sequenceTimeoutMs: 500
  })

  try {
    // 1. 录入普通文本条目
    const rec1 = service.recordItem({
      content: 'First clipboard entry content',
      source_app_name: 'Code.exe',
      format_type: 'text'
    })
    assert.ok(rec1)
    assert.ok(rec1.id)

    // 2. 去重验证：重复录入相同文本，更新时间戳并复用 ID，不产生冗余数据
    const rec2 = service.recordItem({
      content: 'First clipboard entry content',
      source_app_name: 'Code.exe',
      format_type: 'text'
    })
    assert.ok(rec2)
    assert.equal(rec2.id, rec1.id)

    // 3. 录入黑名单应用（如 1Password）内容直接丢弃防泄密
    const recBlacklist = service.recordItem({
      content: 'MySecretPassword123!',
      source_app_name: '1Password.exe',
      format_type: 'text'
    })
    assert.equal(recBlacklist, null)

    // 4. 录入第二条与第三条记录
    const rec3 = service.recordItem({
      content: 'Second item with keyword react',
      format_type: 'text'
    })
    assert.ok(rec3)
    const rec4 = service.recordItem({
      content: 'Third item with keyword vue',
      format_type: 'text'
    })
    assert.ok(rec4)

    // 5. 关键字模糊查询
    const queryReact = service.queryItems({ search: 'react' })
    assert.equal(queryReact.length, 1)
    assert.equal(queryReact[0]?.content, 'Second item with keyword react')

    // 6. 收藏置顶 (Pin) 与非置顶清理 (Clear Unpinned)
    service.togglePin(rec3.id)
    const afterPin = service.queryItems({})
    const pinnedItem = afterPin.find((i: ClipboardItemRecord) => i.id === rec3.id)
    assert.equal(pinnedItem?.is_pinned, 1)

    // 清理全部未置顶项
    const clearedCount = service.clearUnpinned()
    assert.ok(clearedCount >= 2)

    const remaining = service.queryItems({})
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]?.id, rec3.id)

    // 7. 单条删除
    const deleted = service.deleteItem(rec3.id)
    assert.equal(deleted, true)
    assert.equal(service.queryItems({}).length, 0)
  } finally {
    service.stop()
  }
})

test('ClipboardHistoryService: Sequential paste state machine & auto-reset timeout', async () => {
  const service = new ClipboardHistoryService({
    dbPath: ':memory:',
    sequenceTimeoutMs: 100 // 100ms 超时
  })

  try {
    service.recordItem({ content: 'Batch Row 1' })
    service.recordItem({ content: 'Batch Row 2' })
    service.recordItem({ content: 'Batch Row 3' })

    // 流水粘贴逐步递进
    const p1 = await service.pasteSequential()
    assert.ok(p1)
    assert.equal(p1.sequenceIndex, 0)
    assert.equal(p1.total, 3)

    const p2 = await service.pasteSequential()
    assert.ok(p2)
    assert.equal(p2.sequenceIndex, 1)

    // 手动重置状态机
    service.resetPasteSequence()
    const pReset = await service.pasteSequential()
    assert.ok(pReset)
    assert.equal(pReset.sequenceIndex, 0)

    // 超时自动重置
    await new Promise(r => setTimeout(r, 150))
    const pTimeout = await service.pasteSequential()
    assert.ok(pTimeout)
    assert.equal(pTimeout.sequenceIndex, 0) // 超时后重新回到首项
  } finally {
    service.stop()
  }
})

test('ClipboardHistoryService: Sequential paste awaits the paste callback and reports failures without advancing', async () => {
  const service = new ClipboardHistoryService({ dbPath: ':memory:', sequenceTimeoutMs: 60_000 })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    service.recordItem({ content: 'Row A' })
    service.recordItem({ content: 'Row B' })
    const pasted: string[] = []
    const ok = await service.pasteSequential(async (text) => {
      await new Promise(r => setTimeout(r, 5))
      pasted.push(text)
    })
    assert.equal(ok.success, true)
    assert.deepEqual(pasted, [ok.item?.content])

    const failed = await service.pasteSequential(async () => {
      throw new ZToolsError(errorCodes.permissionDenied, '已复制，但无法自动粘贴：请授权辅助功能')
    })
    assert.equal(failed.success, false)
    assert.equal(failed.errorCode, errorCodes.permissionDenied)
    assert.match(failed.message ?? '', /辅助功能/)
    assert.equal(failed.sequenceIndex, 1)

    // 失败不推进指针：下一次重试的仍是同一条
    const retried = await service.pasteSequential(async (text) => { pasted.push(text) })
    assert.equal(retried.success, true)
    assert.equal(retried.sequenceIndex, 1)
    assert.equal(retried.item?.content, failed.item?.content)

    // 同步抛出的普通错误同样返回失败
    const syncFailure = await service.pasteSequential(() => { throw new Error('boom') })
    assert.equal(syncFailure.success, false)
    assert.equal(syncFailure.message, 'boom')
    await new Promise(r => setTimeout(r, 10))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    service.stop()
  }
})

// =============================================================================
// 2. SnippetsService Integration & Chaos Tests
// =============================================================================
test('SnippetsService: Keystroke macro expansion & cursor offset calculation', () => {
  // 1. {clipboard} 占位符宏展开
  const expClip = expandSnippetMacros('Hello {clipboard}!', { clipboard: 'World' })
  assert.equal(expClip.expanded, 'Hello World!')
  assert.equal(expClip.hasCursor, false)

  // 2. {date}, {time}, {datetime} 动态时间宏
  const expDate = expandSnippetMacros('Date: {date}, Time: {time}')
  assert.ok(!expDate.expanded.includes('{date}'))
  assert.ok(!expDate.expanded.includes('{time}'))

  // 3. {uuid} 占位符
  const expUuid = expandSnippetMacros('Key: {uuid}')
  assert.match(expUuid.expanded, /^Key: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

  // 4. {cursor} 光标回退位移计算
  const expCursor = expandSnippetMacros('console.log("{cursor}");')
  assert.equal(expCursor.expanded, 'console.log("");')
  assert.equal(expCursor.hasCursor, true)
  assert.equal(expCursor.cursorOffset, 3) // "); 长度为 3，需向左回退 3 字符
})

test('SnippetsService: SQLite CRUD, keyword uniqueness, keystroke matching & JSON import/export', async () => {
  const root = testDir('snippets-lifecycle')
  await fs.mkdir(root, { recursive: true })
  const dbPath = path.join(root, 'snippets.sqlite')

  let notifyCalled = 0
  const service = new SnippetsService({
    dbPath,
    onSnippetsChanged: () => { notifyCalled++ }
  })

  try {
    // 1. 创建短语
    const snip1 = service.createSnippet({
      name: '致谢问候',
      keyword: 'ty',
      snippet: 'Thank you very much!'
    })
    assert.equal(snip1.keyword, 'ty')
    assert.ok(notifyCalled > 0)

    const snip2 = service.createSnippet({
      name: '函数模板',
      keyword: 'fn',
      snippet: 'function {cursor}() {}'
    })

    // 2. 唯一触发词冲突校验 (Beyond Happy Path)
    assert.throws(
      () => service.createSnippet({ name: '冲突', keyword: 'ty', snippet: 'other' }),
      /已存在/
    )

    // 3. 按触发词后缀精准匹配与回退按键计算
    const match1 = service.matchAndExpand('Hello ty')
    assert.ok(match1.matched)
    assert.equal(match1.keyword, 'ty')
    assert.equal(match1.expanded, 'Thank you very much!')
    assert.equal(match1.backspaceCount, 2) // 'ty' 长度为 2

    // 不匹配的文本返回 matched: false
    assert.equal(service.matchAndExpand('nothing to match').matched, false)

    // 4. JSON 导出与导入验证
    const exported = service.exportSnippets()
    assert.equal(exported.length, 2)

    // 新增外部导入短语
    const importRes = service.importSnippets([
      { name: '邮箱', keyword: 'em', snippet: 'user@example.com' }
    ])
    assert.equal(importRes.imported, 1)
    assert.equal(service.listSnippets().length, 3)

    // 5. 切换禁用状态与删除
    service.toggleSnippet(snip1.id)
    const list = service.listSnippets()
    const found1 = list.find(s => s.id === snip1.id)
    assert.equal(found1?.enabled, false)

    // 被禁用的短语不再参与匹配
    assert.equal(service.matchAndExpand('Check ty').matched, false)

    service.deleteSnippet(snip1.id)
    assert.equal(service.listSnippets().length, 2)
  } finally {
    service.stop()
  }
})

// =============================================================================
// 3. FileSearchService Integration & Chaos Tests
// =============================================================================
test('FileSearchService: Streaming SHA-256 calculation and path validation', async () => {
  const root = testDir('file-search-sha256')
  await fs.mkdir(root, { recursive: true })

  const testFile = path.join(root, 'sample.txt')
  const content = 'ZTools Zero-eval streaming SHA-256 test data'
  await fs.writeFile(testFile, content, 'utf8')

  const expectedSha256 = createHash('sha256').update(content).digest('hex')

  const dummySidecar = {
    searchFiles: async () => ({ files: [], count: 0, total_matches: 0, elapsed_us: 0, elapsed_ms: 0, total_indexed: 0 })
  } as unknown as SidecarManager

  const service = new FileSearchService({ sidecarManager: dummySidecar })

  // 1. 正常计算真实文件哈希
  const res = await service.calculateSha256(testFile)
  assert.equal(res.success, true)
  assert.equal(res.sha256, expectedSha256)
  assert.equal(res.sizeBytes, Buffer.byteLength(content))
  assert.ok(typeof res.elapsedMs === 'number')

  // 2. 异常场景：计算不存在的文件
  const resMissing = await service.calculateSha256(path.join(root, 'not-exists.dat'))
  assert.equal(resMissing.success, false)
  assert.match(resMissing.error || '', /文件不存在/)

  // 3. 异常场景：目标为目录而非单个文件
  const resDir = await service.calculateSha256(root)
  assert.equal(resDir.success, false)
  assert.match(resDir.error || '', /目录/)

  // 4. 空白搜索词直接前置短路返回
  const emptySearch = await service.search('   ')
  assert.equal(emptySearch.count, 0)
  assert.equal(emptySearch.files.length, 0)
})

// =============================================================================
// 4. WindowManagementService Integration & HUD Tests
// =============================================================================
test('WindowManagementService: 15+ Win32 Snapping Actions & HUD Notification Loop', async () => {
  let hudMessage = ''
  let hudOptions: Record<string, unknown> | undefined
  const mockHudService: HudService = {
    showHUD: async (msg: string, opts?: any) => {
      hudMessage = msg
      hudOptions = opts
    }
  } as unknown as HudService

  let calledSidecarAction = ''
  const mockSidecarManager: SidecarManager = {
    manageWindow: async (action: string) => {
      calledSidecarAction = action
      return { success: true, action, rect: { x: 0, y: 0, width: 960, height: 1040 } }
    }
  } as unknown as SidecarManager

  const service = new WindowManagementService({
    sidecarManager: mockSidecarManager,
    hudService: mockHudService
  })

  // 1. 获取全量动作元数据清单
  const actions = service.listActions()
  assert.ok(actions.length >= 15)
  assert.ok(actions.some(a => a.name === 'left-half'))
  assert.ok(actions.some(a => a.name === 'maximize'))
  assert.ok(actions.some(a => a.name === 'center'))

  // 2. 动作名称规范化（kebab-case 与 snake_case 互转）
  assert.equal(service.normalizeActionName('left-half'), 'left-half')
  assert.equal(service.normalizeActionName('left_half'), 'left-half')
  assert.equal(service.normalizeActionName('MAXIMIZE'), 'maximize')
  assert.equal(service.normalizeActionName('invalid-action-xyz'), null)

  // 3. 执行分屏吸附与 HUD 联动链路
  const execLeft = await service.applyAction('left-half')
  assert.equal(execLeft.success, true)
  assert.equal(calledSidecarAction, 'left-half')
  assert.match(hudMessage, /左半屏/)
  assert.equal(hudOptions?.icon, WINDOW_ACTIONS['left-half'].icon)

  // 4. 异常动作调用防御
  const execBad = await service.applyAction('totally-unknown-action')
  assert.equal(execBad.success, false)
  assert.match(execBad.error || '', /不支持的窗口调度动作/)
})
