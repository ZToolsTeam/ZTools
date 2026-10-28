import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'
import { validateEnvironmentRequest, type EnvironmentChange, type EnvironmentSnapshot } from '../../src/contracts/environment-manager.js'
import { NativePathAccessAdapter } from '../../src/main/platform/native-path-access.js'
import type { AnchoredPathObject } from '../../src/main/platform/path-access.js'
import { preserveAndWriteEnvironment } from '../../src/main/services/environment-file-write.js'
import { SystemEnvironmentProvider, runEnvironmentCommand } from '../../src/main/services/environment-provider.js'
import { EnvironmentBackupStore } from '../../src/main/services/environment-backups.js'
import { EnvironmentManagerService, inspectEnvironmentPath } from '../../src/main/services/environment-manager-service.js'
import { ENV_BEGIN, ENV_END, readEnvironmentProfile, replaceEnvironmentProfile } from '../../src/main/services/environment-profile.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 37, pluginId: 'env-manager', pluginInstanceId: 'environment-audit' }
const signal = () => new AbortController().signal
const helper = path.resolve(__dirname, '../../../out/native/darwin-universal/path-access/native/ZToolsPathAccessBroker')
const mac = process.platform === 'darwin'
async function fixture(t: { after: (fn: () => Promise<void>) => void }, original: string | null = "# 用户已有配置\nexport ORIGINAL_KEEP='kept'\n") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-environment-test-'))), profile = path.join(root, '.zshrc')
  if (original !== null) await fs.writeFile(profile, original, { mode: 0o600 })
  const environment = { HOME: root, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', ZTOOLS_ENV_CASE: '原进程值' }
  const provider = new SystemEnvironmentProvider(() => new NativePathAccessAdapter(helper, 15000), 'darwin', environment, root, '/bin/zsh')
  const backups = new EnvironmentBackupStore(path.join(root, 'backups')), service = new EnvironmentManagerService(provider, backups)
  t.after(async () => { await service.stop(); await fs.rm(root, { recursive: true, force: true }) })
  const call = (request: unknown, who = caller, abort = signal()) => service.handle(request, who, abort)
  const list = async () => await call({ action: 'list' }) as EnvironmentSnapshot
  const prepare = async (change: EnvironmentChange, snapshot?: EnvironmentSnapshot) => await call({ action: 'prepare', sessionId: (snapshot || await list()).sessionId, change }) as { planId: string; removed: string[] }
  const apply = async (change: EnvironmentChange) => {
    const plan = await prepare(change)
    return await call({ action: 'apply', planId: plan.planId }) as { verified: boolean; backupId: string }
  }
  return { root, profile, environment, provider, backups, service, call, list, prepare, apply }
}
test('环境管理 IPC 严格拒绝数组枚举、无效名称、超长值和跨用途参数', () => {
  assert.equal(canCall('environment_manager', caller), true)
  const sessionId = '11111111-1111-4111-8111-111111111111'
  const base = { action: 'prepare', sessionId, change: { kind: 'set', source: 'user', key: 'PATH', value: '' } }
  validateMethodParams('environment_manager', base)
  for (const bad of [null, { action: ['list'] }, { action: 'list', path: '/etc/zshrc' }, { ...base, change: { ...base.change, source: ['user'] } }, { ...base, change: { ...base.change, kind: ['set'] } },
    { ...base, change: { ...base.change, key: 'X;touch' } }, { ...base, change: { ...base.change, value: '\0' } }, { ...base, change: { ...base.change, value: 'a'.repeat(32768) } }]) assert.throws(() => validateEnvironmentRequest(bad))
})
test('字面量导出段往返保留空值、空格、引号、多行、反引号和美元符号', () => {
  const entries = new Map([['EMPTY', ''], ['TEXT', " 中文 ' $HOME `echo bad` \n第二行\r末尾\\ "]])
  const before = '# existing\nexport OUTSIDE=unchanged\n', raw = replaceEnvironmentProfile(before, entries)
  assert.deepEqual(readEnvironmentProfile(raw).entries, entries)
  assert.equal(readEnvironmentProfile(raw).before, before)
  assert.equal(replaceEnvironmentProfile(raw, entries), raw)
  assert.throws(() => replaceEnvironmentProfile(before, new Map([['VALUE', `first\n${ENV_END}\nlast`]])), /边界标记/)
  assert.throws(() => readEnvironmentProfile(`${ENV_BEGIN}\nexport X=$(touch bad)\n${ENV_END}\n`), /无效/)
  assert.throws(() => readEnvironmentProfile(`${ENV_BEGIN}\n${ENV_BEGIN}\n${ENV_END}\n`), /重复/)
})
test('真实 Mac 宿主读写、独立新 shell 验证、重建服务读取和备份恢复', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.profile, 'utf8')
  const snapshot = await f.list()
  assert.equal(snapshot.variables.find(v => v.key === 'ZTOOLS_ENV_CASE')?.scope, 'process')
  assert.deepEqual(snapshot.sources, [{ id: 'user', label: f.profile }])
  const marker = path.join(f.root, 'must-not-execute'), value = ` 中文 '$HOME' \`touch ${marker}\` $(touch ${marker})\n第二行 `
  const changed = await f.apply({ kind: 'set', source: 'user', key: 'ZTOOLS_ENV_CASE', value })
  assert.equal(changed.verified, true)
  assert.ok((await fs.readFile(f.profile, 'utf8')).startsWith(original))
  assert.equal(f.environment.ZTOOLS_ENV_CASE, '原进程值')
  const out = execFileSync('/bin/zsh', ['-f', '-c', 'source "$1"; /usr/bin/printf "%s" "$ZTOOLS_ENV_CASE"', '--', f.profile], { encoding: 'utf8', env: { HOME: f.root, PATH: '/usr/bin:/bin' } })
  assert.equal(out, value); await assert.rejects(fs.access(marker))
  const restarted = new EnvironmentManagerService(f.provider, new EnvironmentBackupStore(path.join(f.root, 'backups')))
  try {
    const after = await restarted.handle({ action: 'list' }, caller, signal()) as EnvironmentSnapshot
    assert.equal(after.variables.find(v => v.scope === 'user' && v.key === 'ZTOOLS_ENV_CASE')?.value, value)
    assert.equal(after.backups[0]?.id, changed.backupId)
  } finally { await restarted.stop() }
  await f.apply({ kind: 'restore', source: 'user', backupId: changed.backupId })
  assert.equal(await fs.readFile(f.profile, 'utf8'), original)
})
test('PATH 清理只删除确认不存在目录，保留空项、相对路径、外部卷和既有顺序', { skip: !mac }, async t => {
  const f = await fixture(t), absent = path.join(f.root, 'missing-dir'), literal = `/usr/bin:${absent}::relative:/Volumes/offline/bin:/bin`
  await f.apply({ kind: 'set', source: 'user', key: 'PATH', value: literal })
  const plan = await f.prepare({ kind: 'clean', source: 'user' })
  assert.deepEqual(plan.removed, [absent])
  await f.call({ action: 'apply', planId: plan.planId })
  assert.equal(f.provider.values(await f.provider.read('user', signal())).get('PATH'), '/usr/bin::relative:/Volumes/offline/bin:/bin')
  assert.equal((await inspectEnvironmentPath('/Volumes/offline/bin', 'darwin')).status, 'unknown')
  await f.apply({ kind: 'set', source: 'user', key: 'PATH', value: absent })
  await assert.rejects(f.prepare({ kind: 'clean', source: 'user' }), /为空/)
})
test('备份失败、损坏及外部编辑均停止写入，不覆盖原文件', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.profile, 'utf8')
  const first = await f.prepare({ kind: 'set', source: 'user', key: 'ZTOOLS_ENV_CASE', value: 'new' })
  await fs.appendFile(f.profile, '# external edit\n')
  await assert.rejects(f.call({ action: 'apply', planId: first.planId }), /配置已变化/)
  assert.equal(await fs.readFile(f.profile, 'utf8'), original + '# external edit\n')
  const latest = await f.apply({ kind: 'set', source: 'user', key: 'ZTOOLS_ENV_CASE', value: 'new' }), good = await fs.readFile(f.profile, 'utf8')
  await fs.appendFile(path.join(f.root, 'backups', `${latest.backupId}.json`), 'bad')
  await assert.rejects(f.list())
  assert.equal(await fs.readFile(f.profile, 'utf8'), good)
  const failingStorePath = path.join(f.root, 'not-a-directory'); await fs.writeFile(failingStorePath, 'keep')
  const service = new EnvironmentManagerService(f.provider, new EnvironmentBackupStore(failingStorePath))
  try { await assert.rejects(service.handle({ action: 'list' }, caller, signal())); assert.equal(await fs.readFile(f.profile, 'utf8'), good) } finally { await service.stop() }
})
test('跨窗口计划、已取消计划和旧快照无法写入', { skip: !mac }, async t => {
  const f = await fixture(t), before = await fs.readFile(f.profile, 'utf8'), snapshot = await f.list()
  const plan = await f.prepare({ kind: 'set', source: 'user', key: 'ZTOOLS_ENV_CASE', value: 'new' }, snapshot)
  await assert.rejects(f.call({ action: 'apply', planId: plan.planId }, { ...caller, webContentsId: 38 }), /不存在或已过期/)
  await f.call({ action: 'cancel' }); await assert.rejects(f.call({ action: 'apply', planId: plan.planId }), /不存在或已过期/)
  await f.list(); await assert.rejects(f.prepare({ kind: 'set', source: 'user', key: 'ZTOOLS_ENV_CASE', value: 'new' }, snapshot), /过期/)
  assert.equal(await fs.readFile(f.profile, 'utf8'), before)
})
test('语法检查不执行启动脚本，语法错误保持原配置', { skip: !mac }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'syntax-must-not-run')
  await fs.writeFile(f.profile, `touch '${marker}'\n`)
  await f.prepare({ kind: 'set', source: 'user', key: 'VALUE', value: 'literal' })
  await assert.rejects(fs.access(marker))
  await fs.writeFile(f.profile, 'if then\n')
  await assert.rejects(f.prepare({ kind: 'set', source: 'user', key: 'VALUE', value: 'literal' }), /组件执行失败/)
  assert.equal(await fs.readFile(f.profile, 'utf8'), 'if then\n')
})
test('合法 here-document 保留，未闭合正文及函数或引号中的伪管理段拒绝', { skip: !mac }, async t => {
  const f = await fixture(t), complete = "cat <<'DONE'\nhello\nDONE\n"
  await fs.writeFile(f.profile, complete)
  await f.apply({ kind: 'set', source: 'user', key: 'VALUE', value: 'literal' })
  assert.ok((await fs.readFile(f.profile, 'utf8')).startsWith(complete))
  await fs.writeFile(f.profile, "cat <<'DONE'\nhello\n")
  await assert.rejects(f.prepare({ kind: 'set', source: 'user', key: 'VALUE', value: 'literal' }), /顶层命令/)
  const block = `${ENV_BEGIN}\nexport VALUE='body'\n${ENV_END}\n`
  for (const raw of [`cat <<'DONE'\n${block}DONE\n`, `function example() {\n${block}}\n`, `echo '\n${block}'\n`]) {
    await fs.writeFile(f.profile, raw); await assert.rejects(f.list()); assert.equal(await fs.readFile(f.profile, 'utf8'), raw)
  }
})
test('Bash 不新建高优先级配置遮蔽已有登录脚本', { skip: !mac }, async t => {
  const f = await fixture(t), provider = new SystemEnvironmentProvider(() => new NativePathAccessAdapter(helper, 15000), 'darwin', f.environment, f.root, '/bin/bash')
  for (const name of ['.bash_login', '.profile']) {
    const existing = path.join(f.root, name); await fs.writeFile(existing, "export ORIGINAL_KEEP='kept'\n")
    await assert.rejects(provider.read('user', signal()), /不能新建 .bash_profile/)
    assert.equal(await fs.readFile(existing, 'utf8'), "export ORIGINAL_KEEP='kept'\n")
    await fs.unlink(existing)
  }
  const before = await provider.read('user', signal()), after = provider.change(before, 'VALUE', 'literal')
  await provider.write(before, after, signal())
  assert.equal(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'source "$1"; printf "%s" "$VALUE"', '--', path.join(f.root, '.bash_profile')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }), 'literal')
})
test('首次创建配置可恢复不存在状态，原子保存失败保留原配置', { skip: !mac }, async t => {
  const f = await fixture(t, null)
  const saved = await f.apply({ kind: 'set', source: 'user', key: 'VALUE', value: '' })
  assert.equal(f.provider.values(await f.provider.read('user', signal())).get('VALUE'), '')
  await f.apply({ kind: 'restore', source: 'user', backupId: saved.backupId })
  await assert.rejects(fs.access(f.profile))
  assert.ok((await f.backups.list()).length >= 2)
})
test('写入阶段的备份失败和读回不一致均不允许成功', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.profile, 'utf8')
  class FailingBackups extends EnvironmentBackupStore { override async save(): Promise<never> { throw new Error('备份磁盘写满') } }
  const failed = new EnvironmentManagerService(f.provider, new FailingBackups(path.join(f.root, 'full-backups')))
  try {
    const listed = await failed.handle({ action: 'list' }, caller, signal()) as EnvironmentSnapshot
    const plan = await failed.handle({ action: 'prepare', sessionId: listed.sessionId, change: { kind: 'set', source: 'user', key: 'VALUE', value: 'new' } }, caller, signal()) as { planId: string }
    await assert.rejects(failed.handle({ action: 'apply', planId: plan.planId }, caller, signal()), /备份磁盘写满/)
    assert.equal(await fs.readFile(f.profile, 'utf8'), original)
  } finally { await failed.stop() }
  const originalWrite = f.provider.write.bind(f.provider)
  f.provider.write = async () => undefined // 注入系统返回但未落盘的失败边界。
  await assert.rejects(f.apply({ kind: 'set', source: 'user', key: 'VALUE', value: 'new' }), /读回不一致/)
  assert.equal(await fs.readFile(f.profile, 'utf8'), original)
  f.provider.write = originalWrite
})
test('软链接、硬链接和只读配置不会被修改', { skip: !mac }, async t => {
  const f = await fixture(t), target = path.join(f.root, 'original'), text = 'original\n'
  await fs.rename(f.profile, target); await fs.writeFile(target, text); await fs.symlink(target, f.profile)
  await assert.rejects(f.list()); assert.equal(await fs.readFile(target, 'utf8'), text)
  await fs.unlink(f.profile); await fs.link(target, f.profile); await assert.rejects(f.list())
  await fs.unlink(f.profile); await fs.copyFile(target, f.profile); await fs.chmod(f.profile, 0o400)
  const plan = await f.prepare({ kind: 'set', source: 'user', key: 'VALUE', value: 'literal' })
  await assert.rejects(f.call({ action: 'apply', planId: plan.planId }), /只读/)
  assert.equal(await fs.readFile(f.profile, 'utf8'), text)
})
test('真实原生并发编辑不丢失：移动前追加、原位被占用、移出原对象被继续写入', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.profile, 'utf8'), external = '# 其他程序并发修改\n', next = original + "export VALUE='new'\n"
  for (const phase of ['before-move', 'occupy-target', 'late-original'] as const) {
    await fs.writeFile(f.profile, original)
    let originalPath = ''
    class RacingAdapter extends NativePathAccessAdapter {
      override async move(directory: AnchoredPathObject, segments: readonly string[], destination: AnchoredPathObject, replace: boolean, abort: AbortSignal) {
        assert.equal(replace, false)
        if (segments[0] === '.zshrc' && phase === 'before-move') await fs.appendFile(f.profile, external)
        if (segments[0] === 'updated' && phase === 'late-original') await fs.appendFile(originalPath, external)
        const result = await super.move(directory, segments, destination, replace, abort)
        if (segments[0] === '.zshrc') {
          const names = (await fs.readdir(f.root)).filter(name => name.startsWith('.ztools-env-recovery-'))
          for (const name of names) {
            const candidate = path.join(f.root, name, 'original')
            if (await fs.stat(candidate).then(() => true, () => false)) originalPath = candidate
          }
          if (phase === 'occupy-target') await fs.writeFile(f.profile, external)
        }
        return result
      }
    }
    const adapter = new RacingAdapter(helper, 15000)
    try {
      const pending = preserveAndWriteEnvironment(adapter, f.profile, original, next, signal())
      if (phase === 'late-original') {
        const preserved = await pending
        assert.equal(await fs.readFile(f.profile, 'utf8'), next)
        assert.equal(await fs.readFile(preserved, 'utf8'), original + external)
      } else {
        await assert.rejects(pending, phase === 'before-move' ? /并发编辑/ : /原位恢复未确认.*请检查原配置/)
        assert.equal(await fs.readFile(f.profile, 'utf8'), phase === 'before-move' ? original + external : external)
        if (phase === 'occupy-target') assert.equal(await fs.readFile(originalPath, 'utf8'), original)
      }
    } finally { await adapter.stop() }
    // 每一轮只移除本测试创建的恢复目录，避免下一轮误选旧夹具。
    for (const name of (await fs.readdir(f.root)).filter(name => name.startsWith('.ztools-env-recovery-'))) await fs.rm(path.join(f.root, name), { recursive: true })
  }
})
test('真实命令取消等待子进程退出，非零退出和输出超限不能报成功', { skip: !mac }, async () => {
  const abort = new AbortController()
  const pending = runEnvironmentCommand('/bin/sleep', ['10'], undefined, abort.signal)
  abort.abort(); await assert.rejects(pending, /取消/)
  await assert.rejects(runEnvironmentCommand('/bin/sh', ['-c', 'exit 2'], undefined, signal()), /组件执行失败/)
  await assert.rejects(runEnvironmentCommand('/usr/bin/yes', ['line'], undefined, signal()), /组件执行失败/)
})
test('文件组件退出失败也保留真实原件路径，不被清理异常覆盖', { skip: !mac }, async t => {
  const f = await fixture(t), original = await fs.readFile(f.profile, 'utf8')
  class StopFailureAdapter extends NativePathAccessAdapter {
    override async stop() { await super.stop(); throw new Error('测试退出确认失败') }
  }
  const provider = new SystemEnvironmentProvider(() => new StopFailureAdapter(helper, 15000), 'darwin', f.environment, f.root, '/bin/zsh')
  const before = await provider.read('user', signal()), after = provider.change(before, 'VALUE', 'new')
  await assert.rejects(provider.write(before, after, signal()), /退出未确认.*原文件.*\.ztools-env-recovery-/)
  const directories = (await fs.readdir(f.root)).filter(name => name.startsWith('.ztools-env-recovery-'))
  assert.equal(directories.length, 1)
  assert.equal(await fs.readFile(path.join(f.root, directories[0]!, 'original'), 'utf8'), original)
})
