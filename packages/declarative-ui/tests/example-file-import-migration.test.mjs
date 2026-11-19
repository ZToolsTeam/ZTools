/**
 * 13 个示例显式文件/文件夹导入与零启动自动扫描集成测试
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderDeclarativeRoot,
  AiImageCommand,
  AiVideoCommand,
  BatchAudioCommand,
  BatchRenameCommand,
  BatchVideoCommand,
  PdfCommand,
  ShredderCommand,
  SqlitePluginCommand,
  FileUnlockCommand,
  VideoDownloaderCommand,
  MultiDownloadCommand,
  OcrCommand,
  LanShareCommand,
  fetchRealBatchRenameFiles
} from '../dist/index.js'
import {
  pickExampleFiles,
  collectExampleFolderFiles,
  expandExampleInputPaths
} from '../dist/examples/shared/file-import.js'

const tick = (ms = 12) => new Promise(resolve => setTimeout(resolve, ms))

function setupWindowTransport(handlers = {}) {
  const calls = []
  const prevWindow = globalThis.window
  globalThis.window = {
    __ztoolsElectron: {
      transport: {
        methods: new Proxy(
          {},
          {
            get(_t, method) {
              return async envelope => {
                const params =
                  envelope && typeof envelope === 'object' && 'params' in envelope
                    ? envelope.params
                    : envelope
                calls.push({ method: String(method), params })
                const fn = handlers[String(method)]
                if (!fn) return { success: true, data: {} }
                const data = await fn(params)
                return { success: true, data }
              }
            }
          }
        )
      }
    }
  }
  return {
    calls,
    restore() {
      if (prevWindow === undefined) delete globalThis.window
      else globalThis.window = prevWindow
    }
  }
}

function collectActions(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectActions(item, out)
    return out
  }
  if (node.type === 'Action' && node.props) out.push(node.props)
  if (Array.isArray(node.children)) collectActions(node.children, out)
  if (node.props && typeof node.props === 'object') {
    if (node.props.actions) collectActions(node.props.actions, out)
    if (node.props.subList?.items) collectActions(node.props.subList.items, out)
  }
  return out
}

test('1. 全部 13 个示例挂载零自动扫描/零偷读剪贴板，初始列表为空且顶栏按钮 <= 2', async () => {
  const env = setupWindowTransport({
    system_get_disk_usage: () => ({ total: 500e9, used: 200e9, available: 300e9 }),
    'system.info': () => ({ storage: [] })
  })
  try {
    const specs = [
      { id: 'ai-image', Cmd: AiImageCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'ai-video', Cmd: AiVideoCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'batch-audio', Cmd: BatchAudioCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'batch-rename', Cmd: BatchRenameCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'batch-video', Cmd: BatchVideoCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'pdf', Cmd: PdfCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'shredder', Cmd: ShredderCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'sqlite-plugin', Cmd: SqlitePluginCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'video-downloader', Cmd: VideoDownloaderCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'multi-download', Cmd: MultiDownloadCommand, kind: 'subList', actions: ['选择文件', '选择文件夹'] },
      { id: 'ocr', Cmd: OcrCommand, kind: 'subList', actions: ['截图识别', '添加图片'] },
      { id: 'lan-share', Cmd: LanShareCommand, kind: 'children', actions: ['选择文件', '选择文件夹'] },
      { id: 'file-unlock', Cmd: FileUnlockCommand, kind: 'unlock', actions: null }
    ]

    for (const spec of specs) {
      const root = renderDeclarativeRoot(spec.Cmd)
      await tick(15)
      const tree = root.getLatest()
      const fb = tree.props?.filterBar?.props || tree.props?.filterBar
      assert.equal(tree.type, 'List', `${spec.id} 根节点应为 List`)
      assert.ok(Array.isArray(fb?.actions) && fb.actions.length <= 2, `${spec.id} 顶栏按钮最多 2 个`)
      if (spec.actions) {
        assert.deepEqual(
          fb.actions.map(a => a.title || a.label),
          spec.actions,
          `${spec.id} 顶栏按钮标题应严格匹配`
        )
      }
      if (spec.kind === 'subList') {
        const subList = tree.props?.subList?.props || tree.props?.subList
        assert.equal(subList.items.length, 0, `${spec.id} 初始队列必须为空 []`)
      } else if (spec.kind === 'children') {
        assert.equal(tree.children.length, 0, `${spec.id} 初始列表必须为空 []`)
      } else {
        const items = tree.children.flatMap(s => s?.children || [])
        assert.equal(items.length, 1, 'file-unlock 初始未选路径时仅展示空引导项')
        assert.equal(items[0].props.id, 'empty-status')
        const actions = collectActions(tree)
        const clearBtn = actions.find(a => a.title === '清空列表')
        assert.ok(clearBtn, 'file-unlock 应包含「清空列表」动作')
        assert.equal(clearBtn.style, 'destructive')
        assert.deepEqual(clearBtn.shortcut?.modifiers, ['ctrl', 'shift'])
      }
      root.unmount()
    }

    const forbidden = [
      'system_get_path',
      'system_search_files',
      'clipboard_read_text',
      'filesystem_get_directory_contents',
      'window_show_open_dialog',
      'window_show_select_folder_dialog'
    ]
    for (const ch of forbidden) {
      assert.equal(
        env.calls.some(c => c.method === ch),
        false,
        `挂载任何示例时绝不可触发 ${ch}`
      )
    }
  } finally {
    env.restore()
  }
})

test('2. 共享导入逻辑: 过滤串格式、深度与数量截断、跳过噪声目录与 batch-rename 一级限制', async () => {
  let capturedDialogParams = null
  const host = {
    transport: {
      async call(method, params) {
        if (method === 'window_show_open_dialog') {
          capturedDialogParams = params
          return {
            filePaths: ['D:\\Media\\clip.mp4', 'D:\\Media\\empty.mp4', 'D:\\Media\\readme.txt']
          }
        }
        if (method === 'filesystem_get_file_size') {
          return params.path.endsWith('empty.mp4') ? 0 : 4096
        }
        if (method === 'window_show_select_folder_dialog') {
          return { canceled: false, folderPath: 'D:\\RenameRoot' }
        }
        if (method === 'filesystem_get_directory_contents') {
          if (params.path === 'D:\\RenameRoot') {
            return {
              success: true,
              files: [
                { name: 'a.txt', size: 100, isDirectory: false },
                { name: '~$draft.txt', size: 100, isDirectory: false },
                { name: 'nested', size: 0, isDirectory: true },
                { name: 'node_modules', size: 0, isDirectory: true }
              ]
            }
          }
          if (params.path === 'D:\\RenameRoot\\nested') {
            return {
              success: true,
              files: [
                { name: 'b.txt', size: 200, isDirectory: false },
                { name: 'deep', size: 0, isDirectory: true }
              ]
            }
          }
          if (params.path === 'D:\\RenameRoot\\nested\\deep') {
            return {
              success: true,
              files: [{ name: 'c.txt', size: 300, isDirectory: false }]
            }
          }
          return { success: true, files: [] }
        }
        return {}
      }
    }
  }

  // 1) "名称|ext1;ext2" 过滤串及 0 字节/非支持后缀忽略
  const picked = await pickExampleFiles(
    { extensions: ['.mp4', '.mkv'], skipEmptyFiles: true },
    { title: '选择视频', filterName: '视频文件' },
    host
  )
  assert.equal(capturedDialogParams.filters, '视频文件|mp4;mkv')
  assert.equal(picked.files.length, 1)
  assert.equal(picked.files[0].name, 'clip.mp4')
  assert.equal(picked.ignored, 2)

  // 2) maxDepth: 2 限制 & 跳过 ~$ 和 node_modules
  const depthLimited = await collectExampleFolderFiles(
    'D:\\RenameRoot',
    { maxDepth: 2, maxFiles: 10 },
    {},
    host
  )
  assert.deepEqual(depthLimited.files.map(f => f.name), ['a.txt', 'b.txt'])

  // 3) maxFiles 截断
  const capped = await collectExampleFolderFiles(
    'D:\\RenameRoot',
    { maxDepth: 5, maxFiles: 1 },
    {},
    host
  )
  assert.equal(capped.files.length, 1)
  assert.equal(capped.truncated, true)

  // 4) batch-rename 仅取一级子文件
  const renameRes = await fetchRealBatchRenameFiles(host)
  assert.deepEqual(renameRes.files.map(f => f.name), ['a.txt'])
})

test('3. 拖入文件夹（含无 directories 旧客户端兜底）、UI 移除/清空与 shredder 默认不勾选', async () => {
  const env = setupWindowTransport({
    window_show_select_folder_dialog: () => ({ canceled: false, folderPath: 'D:\\DropBox' }),
    filesystem_directory_exists: ({ path }) => path === 'D:\\DropBox',
    filesystem_get_directory_contents: ({ path }) => {
      if (path === 'D:\\DropBox') {
        return {
          success: true,
          files: [
            { name: 'big.bin', size: 60 * 1024 * 1024, isDirectory: false },
            { name: 'small.log', size: 1024, isDirectory: false }
          ]
        }
      }
      return { success: true, files: [] }
    }
  })

  try {
    // 1) 不带 directories 的旧负载也能按路径展开文件夹
    const expanded = await expandExampleInputPaths(['D:\\DropBox', 'D:\\DropBox\\small.log'])
    assert.deepEqual(expanded.files.map(f => f.name), ['big.bin', 'small.log'])

    // 2) Shredder 挂载 -> 点击选择文件夹 -> 验证默认全部不勾选 & 支持单项移除/清空列表
    const root = renderDeclarativeRoot(ShredderCommand)
    await tick(10)
    let tree = root.getLatest()
    const pickFolderBtn = tree.props.filterBar.actions[1]
    await pickFolderBtn.onAction()
    await tick(20)

    tree = root.getLatest()
    const subItems = tree.props.subList.items
    assert.equal(subItems.length, 2)
    assert.equal(subItems.every(item => item.props.checked === false), true, 'shredder 导入后默认不得勾选')

    const actions = collectActions(subItems[0])
    const removeAction = actions.find(a => a.title === '从列表移除')
    const clearAction = actions.find(a => a.title === '清空列表')
    assert.ok(removeAction, '应包含「从列表移除」动作')
    assert.equal(removeAction.shortcut?.key, 'backspace')
    assert.deepEqual(removeAction.shortcut?.modifiers, ['ctrl'])
    assert.ok(clearAction, '应包含「清空列表」动作')
    assert.equal(clearAction.style, 'destructive')
    assert.deepEqual(clearAction.shortcut?.modifiers, ['ctrl', 'shift'])

    // 移除第一项
    await removeAction.onAction()
    await tick(10)
    assert.equal(root.getLatest().props.subList.items.length, 1)

    // 清空列表
    await clearAction.onAction()
    await tick(10)
    assert.equal(root.getLatest().props.subList.items.length, 0)
    root.unmount()
  } finally {
    env.restore()
  }
})

test('4. OCR 上限 100 张截断验证', async () => {
  const manyImgs = Array.from({ length: 120 }, (_, i) => ({
    name: `img_${i + 1}.png`,
    size: 4096,
    isDirectory: false
  }))
  const host = {
    transport: {
      async call(method) {
        if (method === 'window_show_select_folder_dialog') {
          return { canceled: false, folderPath: 'D:\\OcrAlbum' }
        }
        if (method === 'filesystem_get_directory_contents') {
          return { success: true, files: manyImgs }
        }
        return {}
      }
    }
  }
  const res = await collectExampleFolderFiles('D:\\OcrAlbum', { extensions: ['.png'], maxFiles: 100 }, {}, host)
  assert.equal(res.files.length, 100)
  assert.equal(res.truncated, true)
})
