// @vitest-environment node
/**
 * scripts/sync-bundled-plugins.mjs 的集成与故障测试：在临时目录里搭出 frontend/ 与 ../plugins/ 的真实目录结构，
 * 用子进程运行真实脚本。重点覆盖 --check 与 --ensure 对「多余文件」的判定必须一致：
 * --ensure 会删除的条目（整个 public/bundled-plugins/ 目录树里不在同步清单里的文件与空目录：更深层目录、
 * 已移除插件的目录、顶层杂项文件、符号链接都算），--check 必须报为不一致，且 --check 只读、不删除任何文件。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-bundled-plugins.mjs')
const ENGINE_IMPORT = 'import { LocalStorage } from "@ztools/declarative-ui";'
const tmpDirs = []

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** 最小工作区：一个内置插件 demo（入口 + 一个分块）、计算器引擎；返回 frontend 目录 */
function makeWorkspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-sync-bundled-')))
  tmpDirs.push(base)
  const frontend = path.join(base, 'frontend')
  const plugins = path.join(base, 'plugins')
  write(frontend, 'scripts/sync-bundled-plugins.mjs', fs.readFileSync(SCRIPT))
  write(frontend, 'src/config/bundledPlugins.json', JSON.stringify({ ids: ['demo'] }, null, 2) + '\n')
  write(plugins, 'demo/plugin.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', author: 'ZTools Team' }) + '\n')
  write(plugins, 'demo/icon.svg', '<svg/>\n')
  write(plugins, 'demo/dist/index.js', 'export default 1\n')
  write(plugins, 'demo/dist/chunk-a.js', 'export const a = 1\n')
  write(plugins, 'calculator/dist/calculator-engine.js', `${ENGINE_IMPORT}\nexport const evaluate = () => 0\n`)
  return { frontend, plugins, out: path.join(frontend, 'public/bundled-plugins/demo') }
}

function sync(frontend, ...args) {
  const res = spawnSync(process.execPath, [path.join(frontend, 'scripts/sync-bundled-plugins.mjs'), ...args], { cwd: frontend, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

function generatedConfig(frontend) {
  const text = fs.readFileSync(path.join(frontend, 'src/config/bundledPlugins.generated.js'), 'utf8')
  return JSON.parse(text.slice(text.indexOf('export default ') + 'export default '.length))
}

describe('sync-bundled-plugins.mjs', () => {
  it('商店官方插件生成展示元数据，按ID排序；不复制草稿、下架、社区、内置或安装凭据字段', () => {
    const ws = makeWorkspace()
    const manifests = [
      ['z-office', { id: 'z-office', name: '办公工具', category: ['办公效率', '文本工具'], description: '本地说明', version: '9.0.0', downloadUrl: 'https://example.com/private.zip', privateNote: '不可进入展示清单' }],
      ['official/a-media', { id: 'a-media', name: '媒体工具', category: 'media' }],
      ['draft', { id: 'draft', draft: true }],
      ['revoked', { id: 'revoked', revoked: true }],
      ['community', { id: 'community', author: 'Community' }]
    ]
    for (const [dir, manifest] of manifests) {
      write(ws.plugins, `${dir}/plugin.json`, JSON.stringify({ author: 'ZTools Team', ...manifest }))
    }
    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    const generated = generatedConfig(ws.frontend)
    expect(generated.storeOfficialIds).toEqual(['a-media', 'z-office'])
    expect(generated.storePlugins).toEqual([
      { id: 'a-media', name: '媒体工具', description: '', category: 'media' },
      { id: 'z-office', name: '办公工具', description: '本地说明', category: ['办公效率', '文本工具'] }
    ])
    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(generatedConfig(ws.frontend)).toEqual(generated)
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('元数据丢失或来源更新时 --check 只读报错，--ensure 恢复真实名称和分类', () => {
    const ws = makeWorkspace()
    write(ws.plugins, 'calendar/plugin.json', JSON.stringify({ id: 'calendar', author: { name: 'ZTools Team' } }))
    expect(sync(ws.frontend).status).toBe(0)
    const generated = generatedConfig(ws.frontend)
    expect(generated.storePlugins).toEqual([{ id: 'calendar', name: 'calendar', description: '', category: [] }])
    delete generated.storePlugins
    const file = path.join(ws.frontend, 'src/config/bundledPlugins.generated.js')
    fs.writeFileSync(file, `export default ${JSON.stringify(generated)}\n`)
    const missing = fs.readFileSync(file, 'utf8')
    const result = sync(ws.frontend, '--check')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不一致：src/config/bundledPlugins.generated.js')
    expect(fs.readFileSync(file, 'utf8')).toBe(missing)
    write(ws.plugins, 'calendar/plugin.json', JSON.stringify({ id: 'calendar', author: 'ZTools Team', name: '日历', category: ['办公效率'] }))
    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(generatedConfig(ws.frontend).storePlugins).toEqual([{ id: 'calendar', name: '日历', description: '', category: ['办公效率'] }])
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('同步后 --check 通过；--check 只读', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    const before = fs.readdirSync(path.join(ws.out, 'dist')).sort()
    const res = sync(ws.frontend, '--check')
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toContain('内置插件副本一致（1 个）')
    expect(fs.readdirSync(path.join(ws.out, 'dist')).sort()).toEqual(before)
  })

  it('[故障] dist/ 与插件根目录下有 --ensure 会删除的多余文件：--check 报不一致并计数，且不删除', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    // 旧版本留下的分块（plugins 里已经没有它了）与插件根目录下的多余文件
    write(ws.out, 'dist/chunk-old.js', 'export const old = 1\n')
    write(ws.out, 'dist/chunk-old.js.map', '{}\n')
    write(ws.out, 'README.txt', 'stale\n')
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('多余：demo/dist/chunk-old.js（同步时会被删除）')
    expect(res.stderr).toContain('多余：demo/dist/chunk-old.js.map（同步时会被删除）')
    expect(res.stderr).toContain('多余：demo/README.txt（同步时会被删除）')
    expect(res.stderr).toContain('（3 处）')
    // 只读：多余文件原样保留
    for (const rel of ['dist/chunk-old.js', 'dist/chunk-old.js.map', 'README.txt']) expect(fs.existsSync(path.join(ws.out, rel)), rel).toBe(true)

    // --ensure 删除的正是 --check 报出的那些文件，删完后 --check 通过
    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    for (const rel of ['dist/chunk-old.js', 'dist/chunk-old.js.map', 'README.txt']) expect(fs.existsSync(path.join(ws.out, rel)), rel).toBe(false)
    for (const rel of ['plugin.json', 'icon.svg', 'dist/index.js', 'dist/chunk-a.js']) expect(fs.existsSync(path.join(ws.out, rel)), rel).toBe(true)
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('[故障] plugins 里删掉一个分块后：已提交副本里的旧分块被报为多余；内容不一致与多余文件一起计数', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    fs.rmSync(path.join(ws.plugins, 'demo/dist/chunk-a.js'))
    write(ws.plugins, 'demo/dist/index.js', 'export default 2\n')
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('多余：demo/dist/chunk-a.js（同步时会被删除）')
    expect(res.stderr).toContain('不一致：demo/dist/index.js')
    expect(fs.existsSync(path.join(ws.out, 'dist/chunk-a.js'))).toBe(true)
  })

  it('[故障] 更深层目录里的多余文件：--check 报出，--ensure 删除并清掉变空的目录', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    write(ws.out, 'dist/nested/stale.js', 'export {}\n')
    write(ws.out, 'assets/deep/stale.png', 'png')
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('多余：demo/dist/nested/stale.js（同步时会被删除）')
    expect(res.stderr).toContain('多余：demo/assets/deep/stale.png（同步时会被删除）')
    expect(res.stderr).toContain('（2 处）')
    expect(fs.existsSync(path.join(ws.out, 'dist/nested/stale.js'))).toBe(true)

    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(fs.existsSync(path.join(ws.out, 'dist/nested'))).toBe(false)
    expect(fs.existsSync(path.join(ws.out, 'assets'))).toBe(false)
    expect(fs.existsSync(path.join(ws.out, 'dist/index.js'))).toBe(true)
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('[故障] 已从名单移除的插件目录与顶层杂项文件：--check 报出，--ensure 删除，index.json 保留', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    const root = path.dirname(ws.out)
    write(root, 'removed-plugin/plugin.json', '{}\n')
    write(root, 'removed-plugin/dist/index.js', 'export default 0\n')
    write(root, 'stray.txt', 'stale\n')
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('多余：removed-plugin/plugin.json（同步时会被删除）')
    expect(res.stderr).toContain('多余：removed-plugin/dist/index.js（同步时会被删除）')
    expect(res.stderr).toContain('多余：stray.txt（同步时会被删除）')
    expect(res.stderr).toContain('（3 处）')
    expect(res.stderr).not.toContain('多余：index.json')

    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(fs.existsSync(path.join(root, 'removed-plugin'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'stray.txt'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'index.json'))).toBe(true)
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it.for([
    { kind: '目录', relative: 'linked-dir', directory: true },
    { kind: '文件', relative: 'dist/linked.js', directory: false }
  ])('[故障] $kind 符号链接：--check 只读报出，--ensure 只删链接本身', ({ relative, directory }, context) => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    const outside = path.join(path.dirname(ws.frontend), 'outside-dir')
    write(outside, 'keep.js', 'export {}\n')
    const link = path.join(ws.out, relative)
    try {
      fs.symlinkSync(directory ? outside : path.join(outside, 'keep.js'), link,
        directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
    } catch (error) {
      if (!directory && process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        context.skip('当前 Windows 用户没有创建文件符号链接的权限；目录 junction 单独验证')
      }
      throw error
    }
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`多余：demo/${relative}（同步时会被删除）`)
    expect(res.stderr).not.toContain('linked-dir/keep.js')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)

    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(fs.existsSync(link)).toBe(false)
    // 链接指向的真实文件不受影响
    expect(fs.readFileSync(path.join(outside, 'keep.js'), 'utf8')).toBe('export {}\n')
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('[故障] 空目录：--check 报出，--ensure 删除', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    fs.mkdirSync(path.join(ws.out, 'dist/empty/inner'), { recursive: true })
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('多余：demo/dist/empty/（空目录，同步时会被删除）')
    expect(res.stderr).not.toContain('demo/dist/empty/inner/')
    expect(res.stderr).toContain('（1 处）')
    expect(fs.existsSync(path.join(ws.out, 'dist/empty/inner'))).toBe(true)
    expect(sync(ws.frontend, '--ensure').status).toBe(0)
    expect(fs.existsSync(path.join(ws.out, 'dist/empty'))).toBe(false)
    expect(sync(ws.frontend, '--check').status).toBe(0)
  })

  it('[故障] 副本目录整个缺失：--check 报不一致，不创建任何文件', () => {
    const ws = makeWorkspace()
    expect(sync(ws.frontend).status).toBe(0)
    fs.rmSync(ws.out, { recursive: true, force: true })
    const res = sync(ws.frontend, '--check')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('不一致：demo/dist/index.js')
    expect(fs.existsSync(ws.out)).toBe(false)
  })

  it('内置插件声明的截图：复制到副本并写进清单（不计入插件大小）；未声明的截图不复制；不合格时同步失败', () => {
    const ws = makeWorkspace()
    const specRoot = path.resolve(path.dirname(SCRIPT), '../../packages/ztools-plugins-spec')
    for (const f of ['official-ids.json', 'reserved-ids.json', 'src/host-requirements.js', 'src/validator.js']) {
      write(path.dirname(ws.frontend), `packages/ztools-plugins-spec/${f}`, fs.readFileSync(path.join(specRoot, f)))
    }
    const png = (w, h) => {
      const buf = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
      buf.writeUInt32BE(13, 8)
      buf.write('IHDR', 12, 'latin1')
      buf.writeUInt32BE(w, 16)
      buf.writeUInt32BE(h, 20)
      return buf
    }
    const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', author: 'ZTools Team', screenshots: [{ path: 'screenshots/01.png', title: '主界面' }] }
    write(ws.plugins, 'demo/plugin.json', JSON.stringify(manifest) + '\n')
    write(ws.plugins, 'demo/screenshots/01.png', png(1280, 800))
    write(ws.plugins, 'demo/screenshots/old.png', png(1280, 800))
    expect(sync(ws.frontend).status).toBe(0)
    expect(fs.readFileSync(path.join(ws.out, 'screenshots/01.png'))).toEqual(png(1280, 800))
    expect(fs.existsSync(path.join(ws.out, 'screenshots/old.png'))).toBe(false)
    const entry = generatedConfig(ws.frontend).plugins.find((p) => p.id === 'demo')
    expect(entry.screenshots).toEqual([{ path: 'screenshots/01.png', title: '主界面', width: 1280, height: 800 }])
    const sizeWithout = ['plugin.json', 'icon.svg', 'dist/index.js', 'dist/chunk-a.js'].reduce((n, rel) => n + fs.statSync(path.join(ws.plugins, 'demo', rel)).size, 0)
    expect(entry.size).toBe(sizeWithout)
    expect(sync(ws.frontend, '--check').status).toBe(0)

    // 截图被换成伪装 PNG：--check 报不一致，同步直接失败
    write(ws.plugins, 'demo/screenshots/01.png', 'GIF89a')
    const bad = sync(ws.frontend)
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('不是有效的 PNG')
  })
})
