import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronExecutable = createRequire(import.meta.url)('electron')
const application = path.join(root, 'tests', 'e2e', 'plugin-runtime-app')
const { values } = parseArgs({ options: { 'plugin-root': { type: 'string' } } })
if (values['plugin-root'] && !path.isAbsolute(values['plugin-root'])) {
  throw new Error('--plugin-root 必须是绝对路径')
}
const pluginRoot = values['plugin-root'] ?? path.resolve(root, '..', 'plugins', 'create-plugin', 'dist')
const webRoot = path.join(root, 'out', 'assets', 'web')
const diagnosticLog = path.join(root, 'out-test', 'plugin-renderer-e2e.log')

for (const required of [
  electronExecutable,
  path.join(application, 'package.json'),
  path.join(pluginRoot, 'todo', 'index.html'),
  path.join(pluginRoot, 'clipboard-manager', 'index.html'),
  path.join(pluginRoot, 'context-menu', 'index.html'),
  path.join(webRoot, 'sdk', 'ztools-api.js'),
  path.join(root, 'out', 'preload', 'main.js')
]) {
  if (!fs.existsSync(required)) throw new Error(`插件 Renderer E2E 前置产物不存在: ${required}`)
}
fs.mkdirSync(path.dirname(diagnosticLog), { recursive: true })
fs.writeFileSync(diagnosticLog, '', 'utf8')

const result = spawnSync(electronExecutable, [application, '--enable-logging=stderr'], {
  cwd: root,
  env: {
    ...process.env,
    ZTOOLS_TEST_PLUGIN_ROOT: pluginRoot,
    ZTOOLS_TEST_WEB_ROOT: webRoot,
    ZTOOLS_TEST_CLIENT_ROOT: root,
    ZTOOLS_TEST_DIAGNOSTIC_LOG: diagnosticLog
  },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 60_000
})
const diagnostics = fs.readFileSync(diagnosticLog, 'utf8')

if (result.error) {
  throw new Error(`${result.error.message}\nElectron test diagnostics:\n${diagnostics || '(empty)'}`)
}
if (result.status !== 0) {
  throw new Error(
    `插件 Renderer E2E 失败，退出码 ${result.status ?? 'unknown'}，信号 ${result.signal ?? 'none'}\n` +
    `Electron test diagnostics:\n${diagnostics || '(empty)'}`
  )
}
for (const marker of [
  'todo:verified',
  'clipboard-manager:verified',
  'context-menu:verified',
  'plugin-isolation:verified',
  'cleanup-complete',
  'app-exit:0'
]) {
  if (!diagnostics.includes(marker)) {
    throw new Error(`插件 Renderer E2E 缺少完成标记 ${marker}\nElectron test diagnostics:\n${diagnostics}`)
  }
}

console.log('Electron plugin renderer integration passed (pure JS, standard DLL UI, privileged DLL UI)')
