import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { parseVscHistory, parseJetBrainsHistory, readProjectText, describeProject } from '../../src/main/services/recent-projects-parser.js'
import { scanRecentProjects, readRecentProjectsDatabase, projectsEnvironment } from '../../src/main/services/recent-projects-reader.js'
import { RecentProjectsService, readProjectsInWorker } from '../../src/main/services/recent-projects-service.js'
import { launchRecentProject } from '../../src/main/services/recent-projects-launcher.js'
import { runProjectCommand } from '../../src/main/services/recent-projects-command.js'
import { validateRecentProjectsRequest, validateRecentProjectsScan, type RecentProjectsScan } from '../../src/contracts/recent-projects.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
const caller: CallerIdentity = { type: 'plugin', webContentsId: 781, pluginId: 'vscode-projects' }
const signal = () => new AbortController().signal
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file }
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-projects-')), support = path.join(home, 'Library', 'Application Support')
  const project = path.join(home, '项目 空格 $&;安全'), dbFile = path.join(support, 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  fs.mkdirSync(project); fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT UNIQUE, value BLOB); PRAGMA wal_checkpoint(TRUNCATE)')
  const set = (entries: unknown[]) => db.prepare('INSERT OR REPLACE INTO ItemTable VALUES (?, ?)').run('history.recentlyOpenedPathsList', JSON.stringify({ entries }))
  set([{ folderUri: pathToFileURL(project).href }])
  return { home, support, project, dbFile, db, set, env: { home, support }, close() { db.close(); fs.rmSync(home, { recursive: true, force: true }) } }
}
test('参数与能力表：拒绝任意路径、SQL、数组 action 及多余参数', () => {
  assert.equal(canCall('recent_projects', caller), true)
  validateMethodParams('recent_projects', { action: 'scan', operationId: 'scan_1' })
  for (const value of [null, {}, [], { action: ['open'], id: 'a'.repeat(64) }, { action: 'scan', operationId: '' }, { action: 'scan', operationId: 'ok', path: '/tmp' }, { action: 'open', id: 'x' }]) assert.throws(() => validateRecentProjectsRequest(value))
})
test('真实 SQLite WAL 与 worker：顺序、Git、Unicode 路径、失效项目，主库和 WAL 均不改写', async () => {
  const f = fixture(), service = new RecentProjectsService(f.env, undefined, undefined, 'darwin')
  put(path.join(f.project, '.git', 'HEAD'), 'ref: refs/heads/feature/真实分支\n')
  f.set([{ folderUri: pathToFileURL(f.project).href }, { folderUri: pathToFileURL(path.join(f.home, 'missing')).href }, { fileUri: 'file:///tmp/notes.txt' }, { folderUri: 'vscode-remote://ssh-remote+example/home/user/project' }])
  const before = [digest(f.dbFile), digest(f.dbFile + '-wal')]
  try {
    const result = await service.handle({ action: 'scan', operationId: 'real' }, caller, signal()) as RecentProjectsScan
    assert.equal(result.projects.length, 2); assert.equal(result.skippedRemote, 1); assert.equal(result.projects[0]!.path, f.project)
    assert.equal(result.projects[0]!.gitBranch, 'feature/真实分支'); assert.equal(result.projects[0]!.lastOpenedMs, null)
    assert.equal(result.projects[1]!.pathState, 'missing'); assert.deepEqual(result.warnings, [])
    assert.deepEqual([digest(f.dbFile), digest(f.dbFile + '-wal')], before)
  } finally { await service.stop(); f.close() }
})
test('共享库空历史覆盖旧历史；坏共享库报告错误，不偷偷回退旧记录', () => {
  const f = fixture(), shared = path.join(f.home, '.cursor-shared', 'sharedStorage', 'state.vscdb')
  fs.mkdirSync(path.dirname(shared), { recursive: true }); const db = new DatabaseSync(shared)
  try {
    db.exec('CREATE TABLE ItemTable(key TEXT,value TEXT)'); db.prepare('INSERT INTO ItemTable VALUES(?,?)').run('history.recentlyOpenedPathsList', '{"entries":[]}')
    assert.equal(scanRecentProjects(f.env).projects.length, 0)
    db.exec("UPDATE ItemTable SET value='invalid'")
    assert.throws(() => scanRecentProjects(f.env), /无法读取/)
  } finally { db.close(); f.close() }
})
test('SQLite 拒绝生成列、VIEW、巨型值和重复历史 key；错误后仍能重试', () => {
  const f = fixture(), file = path.join(f.home, 'bad.db')
  try {
    for (const schema of ["CREATE TABLE ItemTable(key TEXT,value TEXT GENERATED ALWAYS AS (hex(zeroblob(1000000000))) VIRTUAL)", "CREATE VIEW ItemTable AS SELECT 'history.recentlyOpenedPathsList' AS key, 'bad' AS value"]) {
      const db = new DatabaseSync(file); db.exec(schema); db.close(); assert.throws(() => readRecentProjectsDatabase(file), /结构/); fs.unlinkSync(file)
    }
    const db = new DatabaseSync(file)
    try {
      db.exec("CREATE TABLE ItemTable(key TEXT,value BLOB); INSERT INTO ItemTable VALUES('history.recentlyOpenedPathsList',zeroblob(4194305))")
      assert.throws(() => readRecentProjectsDatabase(file), /类型无效|超过/)
      db.exec("UPDATE ItemTable SET value='{}'; INSERT INTO ItemTable SELECT * FROM ItemTable")
      assert.throws(() => readRecentProjectsDatabase(file), /类型无效/)
    } finally { db.close() }
    assert.equal(scanRecentProjects(f.env).projects.length, 1)
  } finally { f.close() }
})
test('真实 XML：实体解码、两种目录变量、真实时间；非法实体与坏 URI 明确报错', () => {
  const xml = '<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="$USER_HOME$/A &amp; B"><value><RecentProjectMetaInfo><option name="activationTimestamp" value="1700000000000"/></RecentProjectMetaInfo></value></entry></map></option><option name="lastOpenedProject" value="$APPLICATION_CONFIG_DIR$/scratch"/></component></application>'
  const rows = parseJetBrainsHistory(xml, '/tmp/home$&', '/tmp/config', path.posix)
  assert.equal(rows[0]!.path, '/tmp/home$&/A & B'); assert.equal(rows[0]!.timestamp, 1700000000000); assert.equal(rows[1]!.path, '/tmp/config/scratch'); assert.equal(rows[1]!.timestamp, null)
  assert.throws(() => parseJetBrainsHistory('<!DOCTYPE x []>' + xml, '/tmp'), /声明/)
  assert.throws(() => parseVscHistory('{"entries":[{"folderUri":"file:///a%00b"}]}', '/tmp', path.posix), /路径/)
  const paths = parseVscHistory('{"entries":[{"folderUri":"file:///tmp/A"},{"folderUri":"file:///tmp/a"}]}', '/tmp', path.posix).projects
  assert.equal(paths.length, 2); assert.notEqual(paths[0]!.path, paths[1]!.path)
})
test('Git worktree 与异常文件：工作树 HEAD 正确，FIFO 不阻塞读取', () => {
  const f = fixture(), git = path.join(f.home, 'worktrees', 'branch')
  try {
    put(path.join(f.project, '.git'), 'gitdir: ../worktrees/branch\n'); put(path.join(git, 'HEAD'), 'a'.repeat(40))
    const item = describeProject({ path: f.project, kind: 'folder', timestamp: null }, { editor: 'cursor', label: 'Cursor', family: 'vsc', file: f.dbFile, format: 'sqlite' }, [])
    assert.equal(item.gitBranch, 'aaaaaaa')
    if (process.platform === 'darwin') {
      const fifo = path.join(f.home, 'pipe'); execFileSync('/usr/bin/mkfifo', [fifo])
      const start = Date.now(); assert.throws(() => readProjectText(fifo), /普通文件/); assert.ok(Date.now() - start < 1000)
    }
  } finally { f.close() }
})
test('owner 隔离、取消、关闭、停止；扫描失败清除旧条目，打开失败不得成功', async () => {
  const f = fixture(); let launched = 0
  const service = new RecentProjectsService(f.env, readProjectsInWorker, async () => { launched++; throw new Error('编辑器启动失败') }, 'darwin')
  try {
    const r = await service.handle({ action: 'scan', operationId: 'x' }, caller, signal()) as RecentProjectsScan, id = r.projects[0]!.id
    await assert.rejects(service.handle({ action: 'open', id }, { ...caller, pluginId: 'other' }, signal()), /不属于/); assert.equal(launched, 0)
    await assert.rejects(service.handle({ action: 'open', id }, caller, signal()), /启动失败/); assert.equal(launched, 1)
    service.closeOwner(caller.webContentsId); await assert.rejects(service.handle({ action: 'open', id }, caller, signal()), /过期/)
    const controller = new AbortController(); controller.abort(); await assert.rejects(service.handle({ action: 'scan', operationId: 'cancelled' }, caller, controller.signal))
    await service.stop(); await assert.rejects(service.handle({ action: 'scan', operationId: 'stopped' }, caller, signal()), /不可用/)
  } finally { await service.stop(); f.close() }
})
test('服务并发和运行中的取消不留下可打开的记录，之后可重试', async () => {
  const f = fixture(); let started = false
  const service = new RecentProjectsService(f.env, async (_env, abort) => { started = true; return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) }, undefined, 'darwin')
  try {
    const job = service.handle({ action: 'scan', operationId: 'pending' }, caller, signal()); const failure = assert.rejects(job, /cancelled/)
    assert.equal(started, true); await assert.rejects(service.handle({ action: 'scan', operationId: 'second' }, caller, signal()), /正在进行/)
    assert.equal((await service.handle({ action: 'cancel', operationId: 'wrong' }, caller, signal()) as { cancelled: boolean }).cancelled, false)
    await service.handle({ action: 'cancel', operationId: 'pending' }, caller, signal()); await failure
  } finally { await service.stop(); f.close() }
})
test('启动时再次检查路径；已移除项目不会进入系统打开命令', async () => {
  const f = fixture()
  try {
    const p = scanRecentProjects(f.env).projects[0]!
    // 路径已删除：给出中文原因，不透出 Node 原始错误文本
    fs.rmdirSync(f.project); await assert.rejects(launchRecentProject(p, 'open', signal()), (e: Error) => /^项目路径不存在/.test(e.message) && !/ENOENT|no such file/.test(e.message))
    // 项目文件夹被替换成同名普通文件：类型已改变
    fs.writeFileSync(f.project, 'x'); await assert.rejects(launchRecentProject(p, 'terminal', signal()), /类型已改变/)
  } finally { f.close() }
})
test('辅助进程真实取消、超时和输出溢出都等待退出；路径参数不经过 shell 展开', async () => {
  const f = fixture(), marker = path.join(f.home, 'command.pid')
  const script = "require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  try {
    const args = ['-e', script, marker], controller = new AbortController()
    const job = runProjectCommand(process.execPath, args, controller.signal, 5000)
    const rejected = assert.rejects(job, /取消/)
    for (let n = 0; n < 100 && !fs.existsSync(marker); n++) await new Promise(r => setTimeout(r, 10))
    const pid = Number(fs.readFileSync(marker, 'utf8')); controller.abort(); await rejected
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
    await assert.rejects(runProjectCommand(process.execPath, args, signal(), 150), /超时/)
    assert.throws(() => process.kill(Number(fs.readFileSync(marker, 'utf8')), 0), /ESRCH/)
    await assert.rejects(runProjectCommand(process.execPath, ['-e', "process.stdout.write('a'.repeat(100000));setInterval(()=>{},1000)"], signal(), 5000), /输出超限/)
    const literal = '空格 $&;$(echo BAD)'
    assert.equal((await runProjectCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], signal(), 1000)), literal)
  } finally { f.close() }
})
test('Windows：配置根目录取 APPDATA，结果校验接受盘符与 UNC 路径，其他平台仍拒绝服务', async () => {
  const saved = process.env.APPDATA
  try {
    process.env.APPDATA = 'C:\\Users\\测试\\AppData\\Roaming'
    assert.equal(projectsEnvironment('win32').support, 'C:\\Users\\测试\\AppData\\Roaming')
    assert.match(projectsEnvironment('darwin').support, /Library[\\/]Application Support$/)
  } finally { if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved }
  const row = (p: string) => ({ id: 'c'.repeat(64), path: p, name: 'x', editor: 'vscode', editorName: 'VS Code', family: 'vsc', kind: 'folder', lastOpenedMs: null, gitBranch: null, pathState: 'available', pathError: null })
  const scan = (p: string) => validateRecentProjectsScan({ success: true, projects: [row(p)], warnings: [], sourcesRead: 1, skippedRemote: 0 })
  for (const ok of ['/Users/a/proj', 'C:\\work\\proj', '\\\\server\\share\\proj']) assert.equal(scan(ok).projects[0]!.path, ok)
  for (const bad of ['proj', 'C:proj', 'C:/work/proj', 'file:///C:/work']) assert.throws(() => scan(bad), /条目无效/)
  // 非 Windows 上盘符路径不能当本地路径：按远程记录跳过，不报错也不伪造路径
  if (path.sep === '/') {
    const xml = '<application><component name="RecentProjectsManager"><option name="additionalInfo"><map><entry key="C:/work/proj"><value/></entry></map></option></component></application>'
    assert.deepEqual(parseJetBrainsHistory(xml, '/tmp'), [])
  }
  const f = fixture()
  try {
    const win = new RecentProjectsService(f.env, readProjectsInWorker, undefined, 'win32')
    try { assert.equal((await win.handle({ action: 'scan', operationId: 'w' }, caller, signal()) as RecentProjectsScan).projects.length, 1) } finally { await win.stop() }
    const linux = new RecentProjectsService(f.env, readProjectsInWorker, undefined, 'linux')
    try { await assert.rejects(linux.handle({ action: 'scan', operationId: 'l' }, caller, signal()), /不可用/) } finally { await linux.stop() }
  } finally { f.close() }
})
