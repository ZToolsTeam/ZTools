#!/usr/bin/env node
/**
 * verify-changed-plugins.mjs
 * 插件 PR 合并前检查：只检查这次改动涉及的插件（合并即发布，这里没过就不能合并）
 *
 * 每个涉及的插件依次检查：
 * 1. 目录名与 plugin.json 的 id 一致，全仓库不能有重复 id；
 * 2. 从源码编译（build-declarative），编译或类型检查失败即不通过；
 * 3. 清单规范 + AST 安全扫描（scan-plugin-security，只扫源码，不扫编译产物）；
 * 4. 插件自带测试（tests/*.test.mjs）；
 * 5. 改了已有插件必须升版本号：安装包按带版本号的文件名在 CDN 强缓存 30 天，
 *    同版本换内容会让用户下载到旧包、校验失败；只做下架（revoked: true）的不要求升版本；
 * 6. 不允许直接删除插件目录：删除后已安装的用户收不到下架通知，应改为在 plugin.json 写 revoked: true。
 *
 * 改到 shared/ 公共源码时，所有复制了该文件的插件都要重新检查；
 * 改到脚本、规范包、工作流等基础设施时，全部插件都要检查（但不要求它们升版本）。
 *
 * 用法：
 *   node scripts/verify-changed-plugins.mjs --base origin/main   # 对比基线分支（PR 用）
 *   node scripts/verify-changed-plugins.mjs --all                 # 检查全部插件
 * 选项：
 *   --root <dir>      仓库根目录（默认当前目录）
 *   --skip-tests      不运行插件自带测试（仅限本地排查）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanPluginSecurity } from './scan-plugin-security.mjs'
import { describePlatforms, getManifestPlatforms } from '../packages/ztools-plugins-spec/src/validator.js'

const SHARED_DIR = 'shared'
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'create-plugin', SHARED_DIR, 'scripts', 'packages'])

/** 比较 x.y.z（忽略预发布后缀）；无法解析返回 null */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
    return m ? m.slice(1).map(Number) : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitShow(root, ref, rel) {
  try {
    return git(root, ['show', `${ref}:${rel}`])
  } catch {
    return null
  }
}

/** 插件目录：<pluginsRoot>/<id> 或作者分组的 <pluginsRoot>/<author>/<id>，返回相对仓库根目录的路径 */
export function listPluginDirs(root, pluginsRel) {
  const abs = path.join(root, pluginsRel)
  const out = []
  if (!fs.existsSync(abs)) return out
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (!d.isDirectory() || SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue
    const rel = `${pluginsRel}/${d.name}`
    if (fs.existsSync(path.join(root, rel, 'plugin.json'))) {
      out.push(rel)
      continue
    }
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(root, rel, e.name, 'plugin.json'))) out.push(`${rel}/${e.name}`)
    }
  }
  return out.sort()
}

/** 把改动文件归到插件目录；返回 { changed: Set<插件目录>, deleted: Set<插件目录>, infra: boolean } */
export function classifyChanges(root, pluginsRel, baseRef, files, currentPlugins) {
  const changed = new Set()
  const deleted = new Set()
  let infra = false
  const prefix = `${pluginsRel}/`
  const current = new Set(currentPlugins)
  for (const file of files) {
    // 只改文档不需要检查，也不要求升版本（安装包内容变了时，发布脚本会刷新该安装包的 CDN 缓存）
    if (/\.(md|txt)$/i.test(file) || /(^|\/)LICENSE$/.test(file)) continue
    if (!file.startsWith(prefix)) {
      if (file !== '.gitignore') infra = true
      continue
    }
    const rest = file.slice(prefix.length)
    if (rest.startsWith(`${SHARED_DIR}/`)) {
      // 公共源码改了：复制了这个文件的插件都要重新检查
      const name = path.basename(rest)
      for (const dir of currentPlugins) if (fs.existsSync(path.join(root, dir, 'src', name))) changed.add(dir)
      continue
    }
    const parts = rest.split('/')
    const candidates = [`${pluginsRel}/${parts[0]}`, parts.length > 2 ? `${pluginsRel}/${parts[0]}/${parts[1]}` : null].filter(Boolean)
    let matched = false
    for (const dir of candidates) {
      if (current.has(dir)) {
        changed.add(dir)
        matched = true
        break
      }
      if (gitShow(root, baseRef, `${dir}/plugin.json`) !== null) {
        deleted.add(dir)
        matched = true
        break
      }
    }
    // 不属于任何插件的文件按公共改动处理
    if (!matched) infra = true
  }
  return { changed, deleted, infra }
}

function readManifest(root, dir) {
  return JSON.parse(fs.readFileSync(path.join(root, dir, 'plugin.json'), 'utf8'))
}

function findBuildScript(root, pluginsRel) {
  return [path.join(root, 'scripts/build-declarative.mjs'), path.join(root, pluginsRel, 'scripts/build-declarative.mjs')].find((p) => fs.existsSync(p))
}

function runStep(cmd, args, cwd) {
  // 去掉 NODE_TEST_CONTEXT：否则在测试进程里启动的 node --test 会把结果交给外层，自己总是返回成功
  const { NODE_TEST_CONTEXT, ...env } = process.env
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env })
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim()
  return { ok: r.status === 0, output: output.split('\n').slice(-15).join('\n') }
}

/**
 * 执行检查，返回每个插件的结果；不直接退出进程，便于测试
 */
export async function verifyChangedPlugins({ root = process.cwd(), base = null, all = false, skipTests = false } = {}) {
  root = path.resolve(root)
  const pluginsRel = fs.existsSync(path.join(root, 'extensions')) ? 'extensions' : 'plugins'
  const plugins = listPluginDirs(root, pluginsRel)
  const results = new Map()
  const errorOf = (dir) => {
    if (!results.has(dir)) results.set(dir, { dir, errors: [], notes: [] })
    return results.get(dir)
  }

  let changed = new Set()
  let deleted = new Set()
  let infra = false
  if (all) {
    changed = new Set(plugins)
  } else {
    if (!base) throw new Error('需要 --base <分支或提交> 或 --all')
    const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim()
    const files = git(root, ['diff', '--name-only', `${mergeBase}...HEAD`]).split('\n').filter(Boolean)
    ;({ changed, deleted, infra } = classifyChanges(root, pluginsRel, mergeBase, files, plugins))
    base = mergeBase
  }
  const versionRequired = new Set(changed)
  const toCheck = new Set(infra ? plugins : changed)

  // 全仓库 id 唯一 & 目录名一致（每次都检查，成本很低）
  const idOwner = new Map()
  for (const dir of plugins) {
    let manifest
    try {
      manifest = readManifest(root, dir)
    } catch (err) {
      errorOf(dir).errors.push(`plugin.json 不是合法 JSON: ${err.message}`)
      continue
    }
    const name = path.basename(dir)
    if (manifest.id !== name) errorOf(dir).errors.push(`目录名 "${name}" 与 plugin.json 的 id "${manifest.id}" 不一致`)
    if (idOwner.has(manifest.id)) errorOf(dir).errors.push(`插件 id "${manifest.id}" 与 ${idOwner.get(manifest.id)} 重复`)
    else idOwner.set(manifest.id, dir)
  }

  for (const dir of deleted) {
    errorOf(dir).errors.push('不能直接删除插件目录：已安装的用户收不到下架通知。请保留目录，在 plugin.json 写 "revoked": true 和 "revokedReason"')
  }

  const buildScript = findBuildScript(root, pluginsRel)
  for (const dir of [...toCheck].sort()) {
    const r = errorOf(dir)
    let manifest
    try {
      manifest = readManifest(root, dir)
    } catch {
      continue
    }
    // 平台与发布状态写进结果，审核时按声明在对应系统上验证
    r.platform = describePlatforms(getManifestPlatforms(manifest))
    if (manifest.draft === true) r.notes.push(`草稿，不发布：${manifest.draftReason || '未说明'}`)

    // 版本号：只对这次真正改了的已有插件要求
    if (versionRequired.has(dir) && base) {
      const before = gitShow(root, base, `${dir}/plugin.json`)
      if (before !== null && manifest.revoked !== true) {
        let oldVersion = null
        try {
          oldVersion = JSON.parse(before).version
        } catch {}
        const cmp = compareVersions(manifest.version, oldVersion)
        if (cmp === null) r.errors.push(`版本号无法解析: 原 "${oldVersion}" → 现 "${manifest.version}"`)
        else if (cmp <= 0) r.errors.push(`改了插件内容就必须升版本号（现为 ${manifest.version}，需大于 ${oldVersion}）`)
        else r.notes.push(`版本 ${oldVersion} → ${manifest.version}`)
      } else if (before === null) {
        r.notes.push('新插件')
      }
    }

    // 已下架的插件不再扫描、编译、测试（发布时也只写下架记录）
    if (manifest.revoked === true) {
      r.notes.push('已下架')
      continue
    }

    // 先从源码编译：清单校验要求入口文件存在
    if (fs.existsSync(path.join(root, dir, 'tsconfig.json'))) {
      if (!buildScript) {
        r.errors.push('找不到构建脚本 scripts/build-declarative.mjs')
      } else {
        const id = dir.slice(pluginsRel.length + 1)
        const b = runStep(process.execPath, [buildScript, id], root)
        if (!b.ok) r.errors.push(`从源码编译失败:\n${b.output}`)
      }
    } else if (!fs.existsSync(path.join(root, dir, manifest.entry || 'dist/index.js'))) {
      r.errors.push(`没有 tsconfig.json，也找不到入口文件 ${manifest.entry || 'dist/index.js'}`)
    }

    const scan = await scanPluginSecurity(path.join(root, dir))
    for (const v of scan.violations.filter((x) => x.severity === 'error')) {
      r.errors.push(`[${v.rule}] ${v.file}:${v.line} ${v.message}`)
    }
    if (scan.requiresTwoManReview) r.notes.push(`需重点审核: ${scan.twoManReviewReasons.join('; ')}`)

    const testsDir = path.join(root, dir, 'tests')
    const tests = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/${f}`) : []
    if (tests.length && !skipTests) {
      const t = runStep(process.execPath, ['--test', ...tests], path.join(root, dir))
      if (!t.ok) r.errors.push(`插件自带测试未通过:\n${t.output}`)
    }
  }

  const list = [...results.values()].filter((r) => r.errors.length || toCheck.has(r.dir) || deleted.has(r.dir))
  return { pluginsRoot: pluginsRel, infra, checked: [...toCheck].sort(), results: list, passed: list.every((r) => r.errors.length === 0) }
}

export function renderSummary(report) {
  const lines = ['### 插件合并前检查', '']
  if (report.checked.length === 0 && report.results.length === 0) {
    lines.push('本次改动没有涉及插件。')
    return lines.join('\n')
  }
  lines.push(report.passed ? '**全部通过，可以合并。**' : '**未通过，修复后才能合并。**', '')
  if (report.infra) lines.push('改到了脚本/规范等公共部分，已检查全部插件。', '')
  lines.push('| 插件 | 平台 | 结果 | 说明 |', '| --- | --- | --- | --- |')
  for (const r of report.results) {
    const note = [...r.errors.map((e) => e.split('\n')[0]), ...r.notes].join('<br>').replace(/\|/g, '\\|')
    lines.push(`| ${r.dir} | ${r.platform || '-'} | ${r.errors.length ? '不通过' : '通过'} | ${note} |`)
  }
  return lines.join('\n')
}

async function runCli() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null
  }
  const report = await verifyChangedPlugins({
    root: get('--root') || process.cwd(),
    base: get('--base'),
    all: args.includes('--all'),
    skipTests: args.includes('--skip-tests')
  })
  for (const r of report.results) {
    console.log(`\n${r.errors.length ? '❌' : '✅'} ${r.dir}${r.notes.length ? `（${r.notes.join('；')}）` : ''}`)
    for (const e of r.errors) console.log(`   - ${e.replace(/\n/g, '\n     ')}`)
  }
  const summary = renderSummary(report)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
  console.log(`\n检查了 ${report.checked.length} 个插件：${report.passed ? '全部通过' : '有未通过项'}`)
  process.exit(report.passed ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((err) => {
    console.error('检查执行异常:', err.message)
    process.exit(1)
  })
}
