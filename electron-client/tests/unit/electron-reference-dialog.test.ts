import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import { createElectronReferenceDialogProvider } from '../../src/main/platform/electron-reference-dialog.js'
import { parseDialogFilters, normalizeOpenDialogProperties } from '../../src/main/services/window-service.js'

const caller = { type: 'main', webContentsId: 42 } as const
test('native dialog provider reuses filter/property policy and shows requested authority in its title', async () => {
  const window = { isDestroyed: () => false } as BrowserWindow
  const opened: Electron.OpenDialogOptions[] = [], saved: Electron.SaveDialogOptions[] = []
  const provider = createElectronReferenceDialogProvider(actual => { assert.equal(actual, caller); return window }, parseDialogFilters, normalizeOpenDialogProperties, {
    open: async (_, options) => { opened.push(options); return { canceled: false, filePaths: ['/synthetic/directory'] } },
    save: async (_, options) => { saved.push(options); return { canceled: false, filePath: '/synthetic/output.txt' } },
    inspect: async () => ({ isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })
  })
  const folder = await provider.select('folder', { title: '合成目录', access: 'read-write' }, caller)
  assert.equal(folder.selections[0]!.kind, 'directory'); assert.deepEqual(opened[0]!.properties, ['openDirectory'])
  assert.equal(opened[0]!.title, '合成目录（读写授权）')
  await provider.select('open', { properties: ['multiSelections'], filters: '文本|*.txt' }, caller)
  assert.deepEqual(opened[1]!.properties, ['openFile', 'multiSelections']); assert.deepEqual(opened[1]!.filters, [{ name: '文本', extensions: ['txt'] }])
  await provider.select('save', { defaultName: 'output.txt' }, caller)
  assert.equal(saved[0]!.defaultPath, 'output.txt'); assert.equal(saved[0]!.title, '保存文件（写入授权）')
})
test('cancelled/destroyed native windows return no selections and do not inspect stale paths', async () => {
  for (const mode of ['open', 'save', 'folder'] as const) {
    let destroyed = false, inspections = 0
    const window = { isDestroyed: () => destroyed } as BrowserWindow
    const provider = createElectronReferenceDialogProvider(() => window, parseDialogFilters, normalizeOpenDialogProperties, {
      open: async () => { destroyed = true; return { canceled: false, filePaths: ['/private/stale'] } },
      save: async () => { destroyed = true; return { canceled: false, filePath: '/private/stale' } },
      inspect: async () => { inspections++; throw new Error('must not inspect') }
    })
    assert.deepEqual(await provider.select(mode, {}, caller), { canceled: true, selections: [] }); assert.equal(inspections, 0)
  }
})
test('native object classification rejects links/special entries and sanitizes filesystem failures', async () => {
  const window = { isDestroyed: () => false } as BrowserWindow
  for (const kind of ['link', 'special', 'missing']) {
    const provider = createElectronReferenceDialogProvider(() => window, parseDialogFilters, normalizeOpenDialogProperties, {
      open: async () => ({ canceled: false, filePaths: ['/private/secret-name'] }),
      inspect: async () => {
        if (kind === 'missing') throw new Error('/private/secret-name missing')
        return { isDirectory: () => false, isFile: () => false, isSymbolicLink: () => kind === 'link' }
      }
    })
    await assert.rejects(provider.select('open', {}, caller), error => {
      assert.ok(!(error as Error).message.includes('/private/secret-name')); return true
    })
  }
})
