import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(currentFile), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const expected = {
  electron: '43.4.1',
  '@electron/packager': '20.3.0'
}
const runtimeCapabilityPromptPreload = path.join(root, 'src', 'preload', 'runtime-capability-prompt.ts')

for (const [name, version] of Object.entries(expected)) {
  if (packageJson.devDependencies?.[name] !== version) {
    throw new Error(`${name} 必须精确锁定为 ${version}`)
  }
}

const sourceFiles = []
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(target)
    else if (/\.(ts|js|mjs)$/.test(entry.name)) sourceFiles.push(target)
  }
}
collect(path.join(root, 'src'))
collect(path.join(root, 'scripts'))

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, 'utf8')
  if (/nodeIntegration\s*:\s*true/.test(source)) throw new Error(`${file} 启用了 nodeIntegration`)
  if (/contextIsolation\s*:\s*false/.test(source)) throw new Error(`${file} 禁用了 contextIsolation`)
  const isRuntimeCapabilityPromptPreload = file === runtimeCapabilityPromptPreload
  if (
    /\bipcRenderer\b/.test(source) &&
    file !== currentFile &&
    !file.endsWith(path.join('preload', 'main.ts')) &&
    !file.endsWith(path.join('preload', 'super-panel.ts')) &&
    !isRuntimeCapabilityPromptPreload
  ) {
    throw new Error(`${file} 暴露或引用了不允许的 ipcRenderer`)
  }
  if (isRuntimeCapabilityPromptPreload) {
    const methods = [...source.matchAll(/\bipcRenderer\.(\w+)\s*\(/g)].map(match => match[1]).sort()
    if (methods.join(',') !== 'invoke,on,removeListener' ||
        !/ipcRenderer\.on\(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL,\s*listener\)/.test(source) ||
        !/ipcRenderer\.removeListener\(RUNTIME_CAPABILITY_PROMPT_REQUEST_CHANNEL,\s*listener\)/.test(source) ||
        !/ipcRenderer\.invoke\(RUNTIME_CAPABILITY_PROMPT_ANSWER_CHANNEL,\s*allowed\)/.test(source) ||
        !/promptProcess\.isMainFrame === true/.test(source) ||
        !/location\.href === 'ztools:\/\/web\/platform\/runtime-permission-consent\.html'/.test(source)) {
      throw new Error(`${file} 超出了固定权限提示 IPC 边界`)
    }
  }
}

console.log(`Source verification passed (${sourceFiles.length} files)`)
