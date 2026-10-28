import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Clipboard, setDeclarativeBridge } from '../dist/api/index.js'

afterEach(() => setDeclarativeBridge(null))

test('宿主负责完整粘贴，SDK不先写一次剪贴板而干扰在途请求', async () => {
  const copies = [], pastes = []
  setDeclarativeBridge({ copyToClipboard: async text => copies.push(text), pasteToActive: async text => pastes.push(text) })
  await Clipboard.paste({ text: '保留原文' })
  assert.deepEqual(copies, [])
  assert.deepEqual(pastes, ['保留原文'])
})

test('宿主忙或拒绝时原样抛错，不额外复制、不降级为假成功', async () => {
  let writes = 0
  const failure = Object.assign(new Error('正在粘贴'), { code: 'CLIPBOARD_ERROR' })
  setDeclarativeBridge({ copyToClipboard: async () => { writes++ }, pasteToActive: async () => { throw failure } })
  await assert.rejects(Clipboard.paste('不能覆盖'), error => error === failure)
  assert.equal(writes, 0)
})

test('没有自动粘贴能力时保留手动复制路径但明确拒绝；复制失败仍保留原错误', async () => {
  let text = ''
  setDeclarativeBridge({ copyToClipboard: async value => { text = value } })
  await assert.rejects(Clipboard.paste('手动内容'), { code: 'NOT_SUPPORTED' })
  assert.equal(text, '手动内容')
  const failure = new Error('写入被拒绝')
  setDeclarativeBridge({ copyToClipboard: async () => { throw failure } })
  await assert.rejects(Clipboard.paste('不会成功'), error => error === failure)
})
