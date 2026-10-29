import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import type { RecentProject } from '../../src/contracts/recent-projects.js'
import { findWindowsEditor, launchWindowsProject, type WindowsLaunchDeps } from '../../src/main/services/recent-projects-launcher.js'
import { parseJetBrainsHistory, parseVscHistory } from '../../src/main/services/recent-projects-parser.js'

const signal = () => new AbortController().signal
const fileStat = { isFile: () => true, isDirectory: () => false }
const dirStat = { isFile: () => false, isDirectory: () => true }
const enoent = (file: string) => Object.assign(new Error(`ENOENT: no such file or directory, stat '${file}'`), { code: 'ENOENT' })
type SpawnCall = { file: string; args: string[]; options: Record<string, unknown> }
/** 构造 Windows 启动依赖替身：files/dirs 为存在的路径，dirEntries 为 readdir 结果（值为 Error 时模拟读取失败），spawnMode 控制子进程启动结果 */
function deps(options: { env?: NodeJS.ProcessEnv; files?: string[]; dirs?: string[]; dirEntries?: Record<string, string[] | Error>; spawnMode?: 'spawn' | 'error' | 'throw' } = {}) {
  const files = new Set(options.files ?? []), dirs = new Set(options.dirs ?? []), statCalls: string[] = [], spawns: SpawnCall[] = []
  const fake = ((file: string, args: string[], spawnOptions: Record<string, unknown>) => {
    spawns.push({ file, args, options: spawnOptions })
    if (options.spawnMode === 'throw') throw new Error('spawn EINVAL')
    const child = Object.assign(new EventEmitter(), { unref: () => { (child as unknown as { unrefed: boolean }).unrefed = true } })
    process.nextTick(() => options.spawnMode === 'error' ? child.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })) : child.emit('spawn'))
    return child
  }) as unknown as typeof spawn
  const value: WindowsLaunchDeps = {
    env: options.env ?? { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    homedir: () => 'C:\\Users\\u',
    readdir: async dir => { const entries = options.dirEntries?.[dir]; if (entries instanceof Error) throw entries; if (!entries) throw enoent(dir); return [...entries] },
    stat: async file => { statCalls.push(file); if (files.has(file)) return fileStat; if (dirs.has(file)) return dirStat; throw enoent(file) },
    spawn: fake
  }
  return { value, statCalls, spawns }
}
const project = (over: Partial<RecentProject> = {}): RecentProject => ({ id: 'a'.repeat(64), path: 'C:\\work\\my app & co', name: 'my app & co', editor: 'vscode', editorName: 'VS Code', family: 'vsc', kind: 'folder', lastOpenedMs: null, gitBranch: null, pathState: 'available', pathError: null, ...over })

test('Windows 编辑器查找：用户 Programs 优先于 Program Files 与 x86，同一编辑器多个目录名按顺序；不经过 PATH', async () => {
  const local = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', machine = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
  const both = deps({ files: [local, machine] })
  assert.equal(await findWindowsEditor('vscode', both.value), local)
  assert.deepEqual(both.statCalls, [local])
  const machineOnly = deps({ files: [machine, 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'] })
  assert.equal(await findWindowsEditor('vscode', machineOnly.value), machine)
  assert.deepEqual(machineOnly.statCalls, [local, machine])
  const x86 = 'C:\\Program Files (x86)\\Microsoft VS Code Insiders\\Code - Insiders.exe'
  assert.equal(await findWindowsEditor('vscode-insiders', deps({ files: [x86] }).value), x86)
  // Cursor 先查小写目录（官方安装器），再查大写目录
  const cursor = deps({ files: ['C:\\Program Files\\Cursor\\Cursor.exe'] })
  assert.equal(await findWindowsEditor('cursor', cursor.value), 'C:\\Program Files\\Cursor\\Cursor.exe')
  assert.deepEqual(cursor.statCalls.slice(0, 3), ['C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'C:\\Program Files\\cursor\\Cursor.exe', 'C:\\Program Files (x86)\\cursor\\Cursor.exe'])
  // 没有 LOCALAPPDATA 时退回用户目录下的 AppData\Local；没有 Program Files 变量时只查用户目录
  const noEnv = deps({ env: {}, files: ['C:\\Users\\u\\AppData\\Local\\Programs\\Trae CN\\Trae CN.exe'] })
  assert.equal(await findWindowsEditor('trae-cn', noEnv.value), 'C:\\Users\\u\\AppData\\Local\\Programs\\Trae CN\\Trae CN.exe')
  assert.deepEqual(noEnv.statCalls, ['C:\\Users\\u\\AppData\\Local\\Programs\\Trae CN\\Trae CN.exe'])
})

test('Windows JetBrains 查找：固定目录优先，再按前缀匹配带版本号目录（新版本在前），读目录失败跳过', async () => {
  const fixed = 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe', older = 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe'
  const dirEntries = { 'C:\\Program Files\\JetBrains': ['IntelliJ IDEA 2024.3', 'PyCharm 2025.1', 'IntelliJ IDEA 2025.2'], 'C:\\Program Files (x86)\\JetBrains': new Error('EACCES: permission denied') }
  const versioned = deps({ files: [fixed, older], dirEntries })
  assert.equal(await findWindowsEditor('idea', versioned.value), fixed)
  // 固定目录（不带版本号）的候选都先于带版本号的候选被检查，PyCharm 目录不会被当成 IDEA
  const firstVersioned = versioned.statCalls.indexOf(fixed)
  assert.ok(versioned.statCalls.slice(0, firstVersioned).every(file => !/\d{4}\.\d/.test(file)))
  assert.ok(!versioned.statCalls.some(file => file.includes('PyCharm')))
  const unversioned = 'C:\\Program Files\\IntelliJ IDEA\\bin\\idea64.exe'
  assert.equal(await findWindowsEditor('idea', deps({ files: [unversioned, fixed], dirEntries }).value), unversioned)
  // Toolbox 装在用户 Programs 下的带版本号目录
  const toolbox = 'C:\\Users\\u\\AppData\\Local\\Programs\\PyCharm Professional 2025.1\\bin\\pycharm64.exe'
  assert.equal(await findWindowsEditor('pycharm', deps({ files: [toolbox], dirEntries: { 'C:\\Users\\u\\AppData\\Local\\Programs': ['PyCharm Professional 2025.1', 'Microsoft VS Code'] } }).value), toolbox)
  // 同名路径是目录而不是可执行文件时不算找到
  await assert.rejects(findWindowsEditor('rider', deps({ dirs: ['C:\\Program Files\\JetBrains Rider\\bin\\rider64.exe'] }).value), /未找到 JetBrains Rider 的安装位置，请确认已安装对应编辑器/)
})

test('Windows 编辑器找不到时明确报错，不启动任何进程', async () => {
  const none = deps()
  await assert.rejects(launchWindowsProject(project(), 'open', signal(), { ...none.value, stat: async file => file === project().path ? dirStat : none.value.stat(file) }), /未找到 Microsoft VS Code 的安装位置/)
  assert.equal(none.spawns.length, 0)
  await assert.rejects(findWindowsEditor('windsurf', deps({ env: {} }).value), /未找到 Windsurf 的安装位置/)
})

test('Windows 打开项目：编辑器可执行文件直接启动，项目路径原样作为单个参数，不经 shell', async () => {
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', h = deps({ files: [exe], dirs: [project().path] })
  assert.deepEqual(await launchWindowsProject(project(), 'open', signal(), h.value), { success: true, accepted: true, id: 'a'.repeat(64), action: 'open' })
  assert.equal(h.spawns.length, 1); assert.equal(h.spawns[0]!.file, exe); assert.deepEqual(h.spawns[0]!.args, ['C:\\work\\my app & co'])
  assert.equal(h.spawns[0]!.options.shell, false); assert.equal(h.spawns[0]!.options.detached, true); assert.equal(h.spawns[0]!.options.cwd, undefined)
  // 工作区文件
  const ws = project({ path: 'D:\\ws\\team.code-workspace', kind: 'workspace' }), w = deps({ files: [exe, ws.path] })
  await launchWindowsProject(ws, 'open', signal(), w.value); assert.deepEqual(w.spawns[0]!.args, ['D:\\ws\\team.code-workspace'])
})

test('Windows 打开终端：使用 ComSpec /K，工作目录为项目目录或工作区文件所在目录；缺少 ComSpec 用系统目录下 cmd.exe 绝对路径', async () => {
  const folder = deps({ dirs: [project().path] })
  await launchWindowsProject(project(), 'terminal', signal(), folder.value)
  assert.deepEqual({ file: folder.spawns[0]!.file, args: folder.spawns[0]!.args, cwd: folder.spawns[0]!.options.cwd, shell: folder.spawns[0]!.options.shell }, { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/K'], cwd: 'C:\\work\\my app & co', shell: false })
  const ws = project({ path: 'D:\\ws\\sub dir\\team.code-workspace', kind: 'workspace' }), file = deps({ files: [ws.path], env: {} })
  await launchWindowsProject(ws, 'terminal', signal(), file.value)
  assert.equal(file.spawns[0]!.file, 'C:\\Windows\\System32\\cmd.exe'); assert.equal(file.spawns[0]!.options.cwd, 'D:\\ws\\sub dir')
  // 有 SystemRoot 时按它拼接，不退回裸文件名 cmd.exe（避免按当前目录 / PATH 查找）
  const sysRoot = deps({ files: [ws.path], env: { SystemRoot: 'D:\\WINNT' } })
  await launchWindowsProject(ws, 'terminal', signal(), sysRoot.value)
  assert.equal(sysRoot.spawns[0]!.file, 'D:\\WINNT\\System32\\cmd.exe')
})

test('Windows 打开终端：UNC 项目不作为 cwd（cmd 会退回 C:\\Windows），改用 pushd 进入目录，含 cmd 特殊字符的网络路径拒绝', async () => {
  // 文件夹项目：路径含空格，自行加引号并按原样传给 cmd（windowsVerbatimArguments），不经 Node 的引号规则
  const unc = project({ path: '\\\\server\\share\\my proj' }), folder = deps({ dirs: [unc.path] })
  assert.deepEqual(await launchWindowsProject(unc, 'terminal', signal(), folder.value), { success: true, accepted: true, id: 'a'.repeat(64), action: 'terminal' })
  assert.equal(folder.spawns.length, 1)
  assert.deepEqual({ file: folder.spawns[0]!.file, args: folder.spawns[0]!.args, shell: folder.spawns[0]!.options.shell, verbatim: folder.spawns[0]!.options.windowsVerbatimArguments }, { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/K', 'pushd', '"\\\\server\\share\\my proj"'], shell: false, verbatim: true })
  assert.ok(!('cwd' in folder.spawns[0]!.options), 'UNC 路径不能出现在 cwd 里')
  // 不带空格的 & / ^ / % 等会被 cmd 当成命令或变量：一律拒绝，不启动终端
  for (const bad of ['\\\\srv\\s\\x&calc', '\\\\srv\\s\\R^D', '\\\\srv\\s\\%PATH%', '\\\\srv\\s\\a|b', '\\\\srv\\s\\a>b', '\\\\srv\\s\\x!y']) {
    const p = project({ path: bad }), d = deps({ dirs: [bad] })
    await assert.rejects(launchWindowsProject(p, 'terminal', signal(), d.value), /网络路径含/)
    assert.equal(d.spawns.length, 0, bad)
  }
  // 工作区文件在 UNC 共享上：pushd 到所在目录；ComSpec 缺失时同样使用绝对路径
  const ws = project({ path: '\\\\nas\\team\\ws\\team.code-workspace', kind: 'workspace' }), file = deps({ files: [ws.path], env: { SystemRoot: 'C:\\Windows' } })
  await launchWindowsProject(ws, 'terminal', signal(), file.value)
  assert.deepEqual({ file: file.spawns[0]!.file, args: file.spawns[0]!.args, cwd: file.spawns[0]!.options.cwd }, { file: 'C:\\Windows\\System32\\cmd.exe', args: ['/K', 'pushd', '"\\\\nas\\team\\ws"'], cwd: undefined })
  // 盘符路径不受影响：仍以 cwd 启动，参数只有 /K
  const local = deps({ dirs: [project().path] })
  await launchWindowsProject(project(), 'terminal', signal(), local.value)
  assert.deepEqual(local.spawns[0]!.args, ['/K'])
  // 故障注入：UNC 分支 spawn 异步报错 / 同步抛错同样如实失败
  await assert.rejects(launchWindowsProject(unc, 'terminal', signal(), deps({ dirs: [unc.path], spawnMode: 'error' }).value), /^Error: 启动失败：spawn UNKNOWN$/)
  await assert.rejects(launchWindowsProject(unc, 'terminal', signal(), deps({ dirs: [unc.path], spawnMode: 'throw' }).value), /spawn EINVAL/)
})

test('Windows 启动故障注入：spawn 异步报错、同步抛错、路径类型改变、路径不存在、预先取消均如实失败', async () => {
  const exe = 'C:\\Program Files\\Microsoft VS Code\\Code.exe'
  await assert.rejects(launchWindowsProject(project(), 'open', signal(), deps({ files: [exe], dirs: [project().path], spawnMode: 'error' }).value), /^Error: 启动失败：spawn UNKNOWN$/)
  await assert.rejects(launchWindowsProject(project(), 'terminal', signal(), deps({ dirs: [project().path], spawnMode: 'error' }).value), /启动失败/)
  await assert.rejects(launchWindowsProject(project(), 'terminal', signal(), deps({ dirs: [project().path], spawnMode: 'throw' }).value), /spawn EINVAL/)
  // 文件夹项目变成了文件 / 工作区文件变成了目录
  const changed = deps({ files: [project().path, exe] })
  await assert.rejects(launchWindowsProject(project(), 'open', signal(), changed.value), /项目路径类型已改变：记录的是文件夹.*请重新扫描/); assert.equal(changed.spawns.length, 0)
  await assert.rejects(launchWindowsProject(project({ kind: 'workspace' }), 'terminal', signal(), deps({ dirs: [project().path] }).value), /类型已改变/)
  const missing = deps({ files: [exe] })
  // 路径不存在：给出中文原因，不把 Node 原始错误（ENOENT: no such file...）透给插件，原始错误保留在 cause
  await assert.rejects(launchWindowsProject(project(), 'open', signal(), missing.value), (e: Error) =>
    /^项目路径不存在/.test(e.message) && !/ENOENT|no such file/.test(e.message) && (e.cause as NodeJS.ErrnoException).code === 'ENOENT'); assert.equal(missing.spawns.length, 0)
  // 无权限、上级不是目录、未知错误码均转成中文
  for (const [code, pattern] of [['EACCES', /没有权限访问项目路径/], ['EPERM', /没有权限/], ['ENOTDIR', /上级不是文件夹/], ['ELOOP', /循环的符号链接/], ['EIO', /无法读取/], ['EWHATEVER', /无法读取项目路径（EWHATEVER）/]] as const) {
    const failing = { ...deps({ files: [exe] }).value, stat: async () => { throw Object.assign(new Error(`${code}: raw node message`), { code }) } }
    await assert.rejects(launchWindowsProject(project(), 'open', signal(), failing), (e: Error) => pattern.test(e.message) && !/raw node message/.test(e.message))
  }
  const noCode = { ...deps({ files: [exe] }).value, stat: async () => { throw new Error('raw') } }
  await assert.rejects(launchWindowsProject(project(), 'open', signal(), noCode), /^Error: 无法读取项目路径，请重新扫描$/)
  const aborted = new AbortController(); aborted.abort(new Error('已取消')); const pre = deps({ files: [exe], dirs: [project().path] })
  await assert.rejects(launchWindowsProject(project(), 'open', aborted.signal, pre.value), /已取消/); assert.equal(pre.spawns.length, 0); assert.equal(pre.statCalls.length, 0)
})

const jetbrainsXml = (entries: string[], last?: string) => `<application><component name="RecentProjectsManager">${last ? `<option name="lastOpenedProject" value="${last}"/>` : ''}<option name="additionalInfo"><map>${entries.map(key => `<entry key="${key}"><value><RecentProjectMetaInfo><option name="projectOpenTimestamp" value="1700000000000"/></RecentProjectMetaInfo></value></entry>`).join('')}</map></option></component></application>`

test('Windows 路径解析（path.win32）：VS Code 盘符 URI、JetBrains 盘符/UNC/$USER_HOME$，远程与盘符相对路径跳过', () => {
  const win = path.win32
  const vsc = parseVscHistory(JSON.stringify({ entries: [
    { folderUri: 'file:///c%3A/Users/%E6%B5%8B%E8%AF%95/my%20proj' },
    { workspace: { configPath: 'file:///d%3A/ws/team.code-workspace' } },
    { folderUri: 'vscode-remote://ssh-remote%2Bbox/home/u/proj', remoteAuthority: 'ssh-remote+box' },
    { folderUri: 'file://server/share/proj' },
    { fileUri: 'file:///c%3A/notes.txt' }
  ] }), 'C:\\Users\\测试', win)
  assert.deepEqual(vsc.projects, [{ path: 'c:\\Users\\测试\\my proj', kind: 'folder', timestamp: null }, { path: 'd:\\ws\\team.code-workspace', kind: 'workspace', timestamp: null }])
  assert.equal(vsc.skippedRemote, 2)
  const rows = parseJetBrainsHistory(jetbrainsXml(['C:/work/proj', '$USER_HOME$/IdeaProjects/demo', '$APPLICATION_CONFIG_DIR$/light-edit', '\\\\server\\share\\proj', 'C:proj', 'D:\\a\\..\\b']), 'C:\\Users\\测试', 'C:\\Users\\测试\\AppData\\Roaming\\JetBrains\\IntelliJIdea2025.2', win)
  assert.deepEqual(rows.map(r => r.path), ['C:\\work\\proj', 'C:\\Users\\测试\\IdeaProjects\\demo', 'C:\\Users\\测试\\AppData\\Roaming\\JetBrains\\IntelliJIdea2025.2\\light-edit', '\\\\server\\share\\proj', 'D:\\b'])
  assert.ok(rows.every(r => r.timestamp === 1700000000000))
  // 老版 lastOpenedProject 同样按 Windows 路径解析，已有的不重复
  assert.deepEqual(parseJetBrainsHistory(jetbrainsXml(['C:/work/proj'], 'E:/legacy'), 'C:\\Users\\u', undefined, win).map(r => `${r.path}|${r.timestamp}`), ['C:\\work\\proj|1700000000000', 'E:\\legacy|null'])
  // 相对路径、带查询的文件 URI、NUL 字符明确报错
  assert.throws(() => parseJetBrainsHistory(jetbrainsXml(['proj']), 'C:\\Users\\u', undefined, win), /项目路径无效/)
  assert.throws(() => parseVscHistory('{"entries":[{"folderUri":"file:///c%3A/a?x=1"}]}', 'C:\\Users\\u', win), /非法查询/)
  assert.throws(() => parseVscHistory('{"entries":[{"folderUri":"file:///c%3A/a%00b"}]}', 'C:\\Users\\u', win), /路径/)
  // 同样的输入按 POSIX 解析：盘符路径不当本地路径
  assert.deepEqual(parseJetBrainsHistory(jetbrainsXml(['C:/work/proj']), '/Users/u', undefined, path.posix), [])
  assert.deepEqual(parseVscHistory('{"entries":[{"folderUri":"file:///Users/u/p"}]}', '/Users/u', path.posix).projects.map(p => p.path), ['/Users/u/p'])
})
