import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createMacApplicationInspector } from '../platform/macos/local-application.js'
import { runProjectCommand } from './recent-projects-command.js'
import type { ProjectEditor, RecentProject } from '../../contracts/recent-projects.js'
const apps: Record<ProjectEditor, { names: string[]; ids: string[]; cli?: string }> = {
  vscode: { names: ['Visual Studio Code'], ids: ['com.microsoft.VSCode'], cli: 'code' },
  'vscode-insiders': { names: ['Visual Studio Code - Insiders'], ids: ['com.microsoft.VSCodeInsiders'], cli: 'code-insiders' },
  cursor: { names: ['Cursor'], ids: ['com.todesktop.230313mzl4w4u92'], cli: 'cursor' },
  trae: { names: ['Trae'], ids: ['com.trae.app'], cli: 'trae' },
  'trae-cn': { names: ['Trae CN'], ids: ['com.trae.app.cn'], cli: 'trae' },
  windsurf: { names: ['Windsurf'], ids: ['com.exafunction.windsurf'], cli: 'windsurf' },
  idea: { names: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'], ids: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'] },
  webstorm: { names: ['WebStorm'], ids: ['com.jetbrains.WebStorm'] },
  pycharm: { names: ['PyCharm', 'PyCharm CE'], ids: ['com.jetbrains.pycharm', 'com.jetbrains.pycharm.ce'] },
  goland: { names: ['GoLand'], ids: ['com.jetbrains.goland'] }, clion: { names: ['CLion'], ids: ['com.jetbrains.CLion'] },
  rider: { names: ['Rider'], ids: ['com.jetbrains.rider'] }, datagrip: { names: ['DataGrip'], ids: ['com.jetbrains.datagrip'] },
  rustrover: { names: ['RustRover'], ids: ['com.jetbrains.rustrover'] }
}
async function findEditor(editor: ProjectEditor, signal: AbortSignal) {
  const app = apps[editor], candidates = new Set<string>()
  for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) for (const name of app.names) candidates.add(path.join(root, name + '.app'))
  const inspect = createMacApplicationInspector({
    lstat: fs.lstat, realpath: fs.realpath, access: fs.access,
    readInfoPlist: async (file, abort) => JSON.parse(await runProjectCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], abort || signal, 3000)) as unknown
  }); const errors: string[] = []
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      const output = await runProjectCommand('/usr/bin/mdfind', [app.ids.map(id => `kMDItemCFBundleIdentifier == '${id}'`).join(' || ')], signal, 4000)
      candidates.clear(); for (const file of output.split('\n').filter(Boolean)) candidates.add(file)
    }
    for (const file of candidates) {
      signal.throwIfAborted()
      try {
        const real = await fs.realpath(file), bundle = await inspect(real, signal)
        if (app.ids.includes(bundle.bundleIdentifier)) return { ...app, path: real, executable: bundle.executableName }
        errors.push(`${path.basename(file)} 的应用标识不匹配`)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error instanceof Error ? error.message : String(error)) }
    }
  }
  throw new Error(`未找到可用的 ${app.names[0]}${errors.length ? `：${errors[0]}` : '，请先安装对应编辑器'}`)
}
/** Windows 上各编辑器的可执行文件：只在固定安装位置查找，不经过 PATH 里的 .cmd 脚本 */
const windowsEditors: Record<ProjectEditor, { dirs: string[]; exe: string }> = {
  vscode: { dirs: ['Microsoft VS Code'], exe: 'Code.exe' },
  'vscode-insiders': { dirs: ['Microsoft VS Code Insiders'], exe: 'Code - Insiders.exe' },
  cursor: { dirs: ['cursor', 'Cursor'], exe: 'Cursor.exe' },
  trae: { dirs: ['Trae'], exe: 'Trae.exe' },
  'trae-cn': { dirs: ['Trae CN'], exe: 'Trae CN.exe' },
  windsurf: { dirs: ['Windsurf'], exe: 'Windsurf.exe' },
  idea: { dirs: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA Community Edition'], exe: 'bin\\idea64.exe' },
  webstorm: { dirs: ['WebStorm'], exe: 'bin\\webstorm64.exe' },
  pycharm: { dirs: ['PyCharm', 'PyCharm Professional', 'PyCharm Community Edition'], exe: 'bin\\pycharm64.exe' },
  goland: { dirs: ['GoLand'], exe: 'bin\\goland64.exe' },
  clion: { dirs: ['CLion'], exe: 'bin\\clion64.exe' },
  rider: { dirs: ['JetBrains Rider', 'Rider'], exe: 'bin\\rider64.exe' },
  datagrip: { dirs: ['DataGrip'], exe: 'bin\\datagrip64.exe' },
  rustrover: { dirs: ['RustRover'], exe: 'bin\\rustrover64.exe' }
}
/** Windows 启动依赖：默认是真实文件系统、进程与环境变量；测试注入替身以在非 Windows 上覆盖查找与启动分支 */
export interface WindowsLaunchDeps {
  env: NodeJS.ProcessEnv
  homedir: () => string
  readdir: (dir: string) => Promise<string[]>
  stat: (file: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>
  spawn: typeof spawn
}
const windowsDeps: WindowsLaunchDeps = { env: process.env, homedir: () => os.homedir(), readdir: dir => fs.readdir(dir), stat: file => fs.stat(file), spawn }

export async function findWindowsEditor(editor: ProjectEditor, deps: WindowsLaunchDeps = windowsDeps): Promise<string> {
  const app = windowsEditors[editor], win = path.win32, candidates: string[] = [], env = deps.env
  const local = env.LOCALAPPDATA || win.join(deps.homedir(), 'AppData', 'Local')
  const programRoots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter((root): root is string => Boolean(root))
  const jetbrainsFamily = app.exe.startsWith('bin\\')
  for (const dir of app.dirs) {
    candidates.push(win.join(local, 'Programs', dir, app.exe))
    for (const root of programRoots) candidates.push(win.join(root, dir, app.exe))
  }
  // JetBrains 安装目录带版本号（如 “IntelliJ IDEA 2025.2”）：在 Program Files\JetBrains 与用户 Programs 下按前缀查找
  if (jetbrainsFamily) {
    for (const root of [...programRoots.map(r => win.join(r, 'JetBrains')), win.join(local, 'Programs')]) {
      let entries: string[] = []
      try { entries = await deps.readdir(root) } catch { continue }
      for (const entry of entries.sort().reverse()) if (app.dirs.some(dir => entry.startsWith(dir))) candidates.push(win.join(root, entry, app.exe))
    }
  }
  for (const file of candidates) {
    try { if ((await deps.stat(file)).isFile()) return file } catch { /* 继续查找下一个安装位置 */ }
  }
  throw new Error(`未找到 ${app.dirs[0]} 的安装位置，请确认已安装对应编辑器`)
}

/** 直接启动可执行文件并等待其启动成功或失败；参数原样传递，路径里的空格与 & 等字符不会被当成命令 */
function spawnDetached(start: typeof spawn, file: string, args: string[], cwd?: string, verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = start(file, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: false, ...(cwd ? { cwd } : {}), ...(verbatim ? { windowsVerbatimArguments: true } : {}) }) }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return }
    child.once('error', error => reject(new Error(`启动失败：${error.message}`)))
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function launchWindowsProject(project: RecentProject, action: 'open' | 'terminal', signal: AbortSignal, deps: WindowsLaunchDeps = windowsDeps) {
  signal.throwIfAborted()
  const stat = await deps.stat(project.path)
  if (project.kind === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error('项目路径类型已改变，请重新扫描')
  if (action === 'terminal') {
    const directory = project.kind === 'folder' ? project.path : path.win32.dirname(project.path)
    // ComSpec 缺失时用系统目录下的 cmd.exe 绝对路径，不按 PATH / 当前目录查找裸文件名
    const shell = deps.env.ComSpec || path.win32.join(deps.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
    // UNC 路径（\\server\share\proj）不能作为 cmd 的工作目录（cmd 会退回 C:\Windows 却照常打开），改用 pushd 临时映射盘符。
    // /K 之后的内容由 cmd 自己解析：Node 只给含空格的参数加引号，不带空格的 \\srv\s\x&calc 会被 cmd 拆成两条命令。
    // 因此拒绝含 cmd 特殊字符的网络路径（% 在引号内也会展开），其余路径自行加引号并按原样传给 cmd。
    if (directory.startsWith('\\\\')) {
      if (/[&|<>^%!"\r\n]/.test(directory)) throw new Error('网络路径含 & | < > ^ % ! 等字符，无法安全地在终端中打开，请先映射为盘符')
      await spawnDetached(deps.spawn, shell, ['/K', 'pushd', `"${directory}"`], undefined, true)
    } else await spawnDetached(deps.spawn, shell, ['/K'], directory)
  } else {
    await spawnDetached(deps.spawn, await findWindowsEditor(project.editor, deps), [project.path])
  }
  signal.throwIfAborted()
  return { success: true, accepted: true, id: project.id, action }
}

export async function launchRecentProject(project: RecentProject, action: 'open' | 'terminal', signal: AbortSignal) {
  if (process.platform === 'win32') return launchWindowsProject(project, action, signal)
  signal.throwIfAborted()
  const stat = await fs.stat(project.path)
  if (project.kind === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error('项目路径类型已改变，请重新扫描')
  if (action === 'terminal') {
    const directory = project.kind === 'folder' ? project.path : path.dirname(project.path)
    await runProjectCommand('/usr/bin/open', ['-a', '/System/Applications/Utilities/Terminal.app', directory], signal, 8000)
  } else {
    const editor = await findEditor(project.editor, signal)
    if (editor.cli) {
      const cli = path.join(editor.path, 'Contents', 'Resources', 'app', 'out', 'cli.js')
      if (!(await fs.stat(cli)).isFile()) throw new Error('编辑器命令行入口不是普通文件')
      const executable = path.join(editor.path, 'Contents', 'MacOS', editor.executable)
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      for (const key of ['VSCODE_IPC_HOOK_CLI', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE']) delete (env as NodeJS.ProcessEnv)[key]
      // 参数直接传递，路径含空格或 shell 字符也不作为命令执行。
      await runProjectCommand(executable, [cli, '--new-window', project.path], signal, 12000, env)
    } else await runProjectCommand('/usr/bin/open', ['-a', editor.path, project.path], signal, 8000)
  }
  signal.throwIfAborted()
  return { success: true, accepted: true, id: project.id, action }
}
