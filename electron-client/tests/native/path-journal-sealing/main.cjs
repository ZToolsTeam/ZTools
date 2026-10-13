const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')

const [output, compiledModule] = process.argv.slice(2)
if (process.platform !== 'win32' || !output || !compiledModule || !path.isAbsolute(output) || !path.isAbsolute(compiledModule)) process.exit(2)
const userData = path.join(output, 'user-data')
fs.mkdirSync(userData)
app.setPath('userData', userData)
app.setPath('sessionData', userData)
app.setPath('logs', path.join(output, 'logs'))
app.whenReady().then(async () => {
  const { createJournalSealer } = await import(pathToFileURL(compiledModule).href)
  const sealer = createJournalSealer(safeStorage)
  let checks = 0
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true); checks++
  for (const text of ['', 'synthetic journal', '恢复记录\u0000临时名称\n']) {
    const encrypted = await sealer.seal(text)
    assert.equal(await sealer.open(encrypted), text); checks++
    assert.ok(encrypted.length > 36 && encrypted.subarray(0, 4).toString() === 'ZPJ1'); checks++
    const damaged = Buffer.from(encrypted); damaged[damaged.length - 1] ^= 1
    await assert.rejects(sealer.open(damaged)); checks++
  }
  console.log(JSON.stringify({ status: 'PASS', scope: 'windows-isolated-electron-async-key-sealing', tests: checks,
    electronVersion: process.versions.electron, processArch: process.arch, pid: process.pid,
    realOsKeySealing: true, productionZToolsAcceptance: false }))
  app.exit(0)
}).catch(() => { console.error('PATH_JOURNAL_NATIVE_SEALING_FAILED'); app.exit(1) })
