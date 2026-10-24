import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ClipboardHistoryService } from '../../src/main/services/clipboard-history-service.js'

test('三种历史持久化后恢复原始内容，图片与文件不按文本截断', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipboard-formats-'))
  const dbPath = path.join(directory, 'history.sqlite')
  let service = new ClipboardHistoryService({ dbPath, maxTextBytes: 8 })
  try {
    const text = service.recordClipboardEntry({ type: 'text', text: '文本' })!
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const picture = service.recordClipboardEntry({ type: 'image', image })!
    const files = [path.join(directory, '有 空格.txt'), path.join(directory, '第二份.txt')]
    const fileRecord = service.recordClipboardEntry({ type: 'files', files })!
    service.close()
    service = new ClipboardHistoryService({ dbPath, maxTextBytes: 8 })
    assert.deepEqual(service.getEntry(text.id), { type: 'text', text: '文本' })
    assert.deepEqual(service.getEntry(picture.id), { type: 'image', image })
    assert.deepEqual(service.getEntry(fileRecord.id), { type: 'files', files })
    assert.equal(service.queryItems().length, 3)
    assert.throws(() => service.getEntry('missing'), /已不存在/)
    assert.throws(() => service.recordClipboardEntry({ type: 'image', image: 'x'.repeat(16 * 1024 * 1024 + 1) }), /16 MiB/)
  } finally {
    service.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('手工构造 files 记录不能获得系统采集来源，清空保留置顶', () => {
  const service = new ClipboardHistoryService()
  try {
    const manual = service.recordItem({ content: JSON.stringify(['/tmp/not-selected']), format_type: 'files' })!
    assert.throws(() => service.getEntry(manual.id), /并非系统剪贴板采集/)
    service.togglePin(manual.id)
    service.recordClipboardEntry({ type: 'text', text: 'remove' })
    assert.equal(service.clearUnpinned(), 1)
    assert.equal(service.queryItems()[0]?.id, manual.id)
  } finally { service.close() }
})

test('流水粘贴回调携带条目类型，失败不前进；新条目插入顶部后不重复粘贴同一条', async () => {
  const service = new ClipboardHistoryService()
  try {
    service.recordClipboardEntry({ type: 'image', image: 'data:image/png;base64,aGVsbG8=' }, 10)
    const failed = await service.pasteSequential(async (_text, item) => {
      assert.equal(item.format_type, 'image')
      throw new Error('paste denied')
    }, 20)
    assert.equal(failed.success, false)
    assert.equal(failed.sequenceIndex, 0)
    assert.equal(service.getSequentialStatus().sequencePointer, 0)

    service.recordClipboardEntry({ type: 'text', text: 'first' }, 30)
    const firstPaste = await service.pasteSequential(undefined, 40)
    assert.equal(firstPaste.item?.content, 'first')
    // 期间插入了一条新记录到顶部，或者刚才粘贴的条目位置变动，下一次应粘贴下一条（image）而不是重复贴 first
    service.recordClipboardEntry({ type: 'text', text: 'new-top' }, 50)
    const secondPaste = await service.pasteSequential(undefined, 60)
    assert.equal(secondPaste.item?.format_type, 'image')
  } finally { service.close() }
})

test('图片列表只返回缩略图，按 ID 恢复才读原图，搜索短词不误匹配图片 base64', () => {
  const service = new ClipboardHistoryService()
  try {
    service.useImageThumbnailer(() => 'data:image/png;base64,dGh1bWI=')
    const rawImage = `data:image/png;base64,${'QUJD'.repeat(2000)}`
    const recorded = service.recordClipboardEntry({ type: 'image', image: rawImage })!
    assert.equal(recorded.content, 'data:image/png;base64,dGh1bWI=')
    const listed = service.queryItems()
    assert.equal(listed[0]?.content, 'data:image/png;base64,dGh1bWI=')
    assert.deepEqual(service.getEntry(recorded.id), { type: 'image', image: rawImage })
    assert.deepEqual(service.queryItems({ search: 'QUJ' }), [])
  } finally { service.close() }
})
