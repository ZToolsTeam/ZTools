import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { loadMainEdition, type EditionLoaderIo } from '../../src/main/edition.js'
import { ossEdition } from '../../src/main/edition-oss/index.js'

// 构建脚本的版本产物整理（scripts/edition-output.mjs）：
// - 闭源源码不存在时删除旧的编译产物，加载器回到开源版；
// - 官方构建时把闭源主进程产物原地压缩，去掉注释与源码映射，压缩后仍能按 CommonJS 正常加载。

const clientRoot = path.resolve(__dirname, '..', '..', '..')

interface MinifyResult { files: string[]; removedMaps: string[] }
interface EditionOutputModule {
  COMMERCIAL_MAIN_SOURCE: string
  hasCommercialMainSource(root: string, fsApi?: typeof fs): boolean
  removeStaleEditionOutputs(root: string, fsApi?: typeof fs): string[]
  minifyCommercialMainOutput(root: string, esbuild: unknown, fsApi?: typeof fs): MinifyResult
}

async function loadModule(): Promise<EditionOutputModule> {
  const url = pathToFileURL(path.join(clientRoot, 'scripts', 'edition-output.mjs')).href
  return await import(url) as EditionOutputModule
}

function loadEsbuild(): unknown {
  return createRequire(path.join(clientRoot, '..', 'frontend', 'package.json'))('esbuild')
}

async function tempRoot(t: { after(fn: () => Promise<void>): void }, name: string): Promise<string> {
  // 取真实路径：macOS 的临时目录是符号链接，require 解析出的 __dirname 是真实路径
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `ztools-edition-output-${name}-`)))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}

/** 与 src/main/edition.ts 默认实现相同：真实文件探测 + require */
const realIo: EditionLoaderIo = {
  exists: (file) => fs.existsSync(file),
  load: (file) => require(file) as unknown
}

// 一个导出合法的「官方版入口」：createServices 复用开源版，只用来验证加载器的选择
const STALE_ENTRY = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainEdition = void 0;
const oss = require(${JSON.stringify(path.join(clientRoot, 'out-test', 'src', 'main', 'edition-oss', 'index.js'))});
exports.mainEdition = { id: 'commercial', storeFiles: ['user_account.json'], createServices: oss.ossEdition.createServices };
`

test('stale out/main/commercial without its source is removed and the loader falls back to the open-source edition', async (t) => {
  const editionOutput = await loadModule()
  const root = await tempRoot(t, 'stale')
  const entry = write(root, 'out/main/commercial/edition.js', STALE_ENTRY)
  write(root, 'out/main/commercial/edition.js.map', '{}')
  write(root, 'out-test/src/main/commercial/edition.js', STALE_ENTRY)
  write(root, 'out-test/tests/commercial/old.test.js', '')
  write(root, 'out/main/edition.js', '// 开源产物不能被删')

  // 故障前提：不清理时加载器会选中旧的官方版产物
  assert.equal(loadMainEdition(realIo, entry).id, 'commercial')
  assert.equal(editionOutput.hasCommercialMainSource(root), false)

  const removed = editionOutput.removeStaleEditionOutputs(root)
  assert.deepEqual(removed.map((item) => item.split(path.sep).join('/')).sort(), [
    'out-test/src/main/commercial',
    'out-test/tests/commercial',
    'out/main/commercial'
  ])
  assert.equal(fs.existsSync(path.join(root, 'out/main/commercial')), false)
  assert.equal(fs.existsSync(path.join(root, 'out/main/edition.js')), true, '只删除版本产物')
  assert.equal(loadMainEdition(realIo, entry), ossEdition)

  // 重复执行是空操作
  assert.deepEqual(editionOutput.removeStaleEditionOutputs(root), [])
})

test('outputs are kept when the commercial source exists, and partial sources only keep their own outputs', async (t) => {
  const editionOutput = await loadModule()
  const root = await tempRoot(t, 'keep')
  write(root, 'src/main/commercial/edition.ts', 'export {}')
  write(root, 'out/main/commercial/edition.js', STALE_ENTRY)
  write(root, 'out-test/src/main/commercial/edition.js', STALE_ENTRY)
  write(root, 'out-test/tests/commercial/old.test.js', '')
  assert.equal(editionOutput.hasCommercialMainSource(root), true)
  // tests/commercial 源码不存在时只删它自己的编译测试
  assert.deepEqual(editionOutput.removeStaleEditionOutputs(root).map((item) => item.split(path.sep).join('/')), ['out-test/tests/commercial'])
  assert.equal(fs.existsSync(path.join(root, 'out/main/commercial/edition.js')), true)
  assert.equal(fs.existsSync(path.join(root, 'out-test/src/main/commercial/edition.js')), true)
})

test('stale output removal rejects relative roots and fails loudly when deletion does not take effect', async (t) => {
  const editionOutput = await loadModule()
  assert.throws(() => editionOutput.removeStaleEditionOutputs('relative/root'), /EDITION_OUTPUT_ROOT_MUST_BE_ABSOLUTE/)
  assert.throws(() => editionOutput.hasCommercialMainSource(''), /EDITION_OUTPUT_ROOT_MUST_BE_ABSOLUTE/)

  const root = await tempRoot(t, 'stuck')
  write(root, 'out/main/commercial/edition.js', STALE_ENTRY)
  // 模拟文件被占用：rmSync 没有生效
  const stuckFs = { ...fs, rmSync: () => undefined } as unknown as typeof fs
  assert.throws(() => editionOutput.removeStaleEditionOutputs(root, stuckFs), /无法删除旧的版本产物/)
  // 删除本身抛错时原样抛出
  const throwingFs = { ...fs, rmSync: () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }) } } as unknown as typeof fs
  assert.throws(() => editionOutput.removeStaleEditionOutputs(root, throwingFs), /EBUSY/)
})

test('official build minifies commercial output in place, strips comments and source maps, and keeps CommonJS loadable', async (t) => {
  const editionOutput = await loadModule()
  const root = await tempRoot(t, 'minify')
  const source = `"use strict";
/** 闭源实现说明：不应出现在发行包里 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainEdition = void 0;
/*! legal 注释也要去掉 */
const helper_js_1 = require("./nested/helper.js");
// 行注释：内部说明
function createServicesWithLongName(context) { return helper_js_1.describe(context, __dirname); }
exports.mainEdition = { id: 'commercial', storeFiles: ['user_account.json'], createServices: createServicesWithLongName };
//# sourceMappingURL=edition.js.map
`
  const entry = write(root, 'out/main/commercial/edition.js', source)
  write(root, 'out/main/commercial/edition.js.map', '{"sources":["../../../src/main/commercial/edition.ts"]}')
  write(root, 'out/main/commercial/nested/helper.js', `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.describe = describe;
/** 嵌套目录同样压缩 */
function describe(context, directory) { return { context, directory }; }
//# sourceMappingURL=helper.js.map
`)
  write(root, 'out/main/commercial/nested/helper.js.map', '{}')
  write(root, 'out/main/commercial/edition.d.ts', 'export {}')
  write(root, 'out/main/edition.js', '/** 开源产物不压缩 */\n')

  const result = editionOutput.minifyCommercialMainOutput(root, loadEsbuild())
  assert.deepEqual(result.files.map((item) => item.split(path.sep).join('/')).sort(), [
    'out/main/commercial/edition.js',
    'out/main/commercial/nested/helper.js'
  ])
  assert.equal(result.removedMaps.length, 3)
  for (const file of ['edition.js.map', 'nested/helper.js.map', 'edition.d.ts']) {
    assert.equal(fs.existsSync(path.join(root, 'out/main/commercial', file)), false, file)
  }
  const minified = fs.readFileSync(entry, 'utf8')
  assert.ok(minified.length < source.length)
  for (const leaked of ['闭源实现说明', 'legal 注释', '行注释', 'sourceMappingURL']) {
    assert.equal(minified.includes(leaked), false, leaked)
  }
  assert.equal(fs.readFileSync(path.join(root, 'out/main/edition.js'), 'utf8'), '/** 开源产物不压缩 */\n')

  // 压缩后仍是 CommonJS：require 正常，导出与相对 require、__dirname 都保留
  const loaded = createRequire(entry)(entry) as { mainEdition: { id: string; storeFiles: string[]; createServices(context: unknown): unknown } }
  assert.equal(loaded.mainEdition.id, 'commercial')
  assert.deepEqual(loaded.mainEdition.storeFiles, ['user_account.json'])
  assert.deepEqual(loaded.mainEdition.createServices('ctx'), { context: 'ctx', directory: path.dirname(entry) })
})

test('minification fails loudly instead of shipping unprocessed or broken output', async (t) => {
  const editionOutput = await loadModule()
  const esbuild = loadEsbuild()
  const root = await tempRoot(t, 'minify-fault')

  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, esbuild), /缺少闭源主进程编译产物/)
  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, undefined), /EDITION_OUTPUT_ESBUILD_REQUIRED/)
  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, {}), /EDITION_OUTPUT_ESBUILD_REQUIRED/)
  assert.throws(() => editionOutput.minifyCommercialMainOutput('out', esbuild), /EDITION_OUTPUT_ROOT_MUST_BE_ABSOLUTE/)

  write(root, 'out/main/commercial/readme.txt', '')
  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, esbuild), /没有 \.js 文件/)

  // 语法错误的产物：压缩失败要抛错，原文件保持不变
  const broken = write(root, 'out/main/commercial/edition.js', 'exports.a = (;\n')
  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, esbuild))
  assert.equal(fs.readFileSync(broken, 'utf8'), 'exports.a = (;\n')

  // 压缩器返回空结果（异常工具链）：拒绝写入
  fs.writeFileSync(broken, 'exports.a = 1;\n', 'utf8')
  const emptyEsbuild = { transformSync: () => ({ code: '' }) }
  assert.throws(() => editionOutput.minifyCommercialMainOutput(root, emptyEsbuild), /压缩结果为空/)
  assert.equal(fs.readFileSync(broken, 'utf8'), 'exports.a = 1;\n')
})
