import fs from 'node:fs'
import path from 'node:path'

/**
 * 主进程版本产物整理（build.mjs 与 run-tests.mjs 共用）。
 *
 * 主进程按编译产物 out/main/commercial/edition.js 是否存在选择版本（见 src/main/edition.ts），
 * 界面层按源码 src/commercial/edition.js 是否存在选择版本；tsc 只写不删，
 * 源码目录去掉后旧产物仍会留在 out/ 里，造成「主进程官方版、界面层开源版」或开源包夹带旧的闭源代码。
 * 因此：
 * - 源码目录 src/main/commercial 不存在时，编译前删除对应的旧产物；
 * - 源码目录存在（官方构建）时，编译后把 out/main/commercial 下的 .js 原地压缩、去掉注释与源码映射，
 *   发行包不带可直接阅读的闭源源码。
 */

/** 闭源主进程源码目录（相对 electron-client 根目录） */
export const COMMERCIAL_MAIN_SOURCE = path.join('src', 'main', 'commercial')
/** 闭源主进程测试源码目录（相对 electron-client 根目录） */
export const COMMERCIAL_TEST_SOURCE = path.join('tests', 'commercial')

/** 源码不存在时要删除的旧产物：[源码目录, 产物目录] */
const STALE_OUTPUTS = [
  [COMMERCIAL_MAIN_SOURCE, path.join('out', 'main', 'commercial')],
  [COMMERCIAL_MAIN_SOURCE, path.join('out-test', 'src', 'main', 'commercial')],
  [COMMERCIAL_TEST_SOURCE, path.join('out-test', 'tests', 'commercial')]
]

function assertRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('EDITION_OUTPUT_ROOT_MUST_BE_ABSOLUTE')
  }
}

/** 当前源码树是否包含闭源主进程组件 */
export function hasCommercialMainSource(root, fsApi = fs) {
  assertRoot(root)
  return fsApi.existsSync(path.join(root, COMMERCIAL_MAIN_SOURCE))
}

/**
 * 删除源码已不存在的版本产物，返回被删除的目录（相对 root）。
 * 删除失败直接抛错：留着旧产物继续构建会得到版本混杂的安装包。
 */
export function removeStaleEditionOutputs(root, fsApi = fs) {
  assertRoot(root)
  const removed = []
  for (const [source, output] of STALE_OUTPUTS) {
    if (fsApi.existsSync(path.join(root, source))) continue
    const target = path.join(root, output)
    if (!fsApi.existsSync(target)) continue
    fsApi.rmSync(target, { recursive: true, force: true })
    if (fsApi.existsSync(target)) throw new Error(`无法删除旧的版本产物: ${output}`)
    removed.push(output)
  }
  return removed
}

function listFiles(directory, fsApi) {
  const files = []
  for (const entry of fsApi.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(target, fsApi))
    else if (entry.isFile()) files.push(target)
  }
  return files
}

/**
 * 原地压缩 out/main/commercial 下的编译产物：保留 CommonJS 语义，
 * 去掉全部注释（含 legal 注释）与 sourceMappingURL，并删除对应的 .js.map / .d.ts 文件。
 * esbuild 由调用方传入（复用界面层已安装的工具链，不新增依赖）。
 * 返回 { files, removedMaps }；目录不存在、没有 .js 或压缩结果异常时抛错。
 */
export function minifyCommercialMainOutput(root, esbuild, fsApi = fs) {
  assertRoot(root)
  if (!esbuild || typeof esbuild.transformSync !== 'function') {
    throw new Error('EDITION_OUTPUT_ESBUILD_REQUIRED')
  }
  const outputDirectory = path.join(root, 'out', 'main', 'commercial')
  if (!fsApi.existsSync(outputDirectory)) {
    throw new Error(`官方构建缺少闭源主进程编译产物: ${path.join('out', 'main', 'commercial')}`)
  }
  const all = listFiles(outputDirectory, fsApi)
  const scripts = all.filter((file) => file.endsWith('.js'))
  if (scripts.length === 0) {
    throw new Error('官方构建的闭源主进程产物中没有 .js 文件')
  }
  const removedMaps = []
  for (const file of all) {
    if (file.endsWith('.map') || file.endsWith('.d.ts')) {
      fsApi.rmSync(file, { force: true })
      removedMaps.push(path.relative(root, file))
    }
  }
  for (const file of scripts) {
    const source = fsApi.readFileSync(file, 'utf8')
    // 输入是 tsc 产出的 CommonJS（不含 import / export 语法）：format 'cjs' 不会再包一层，
    // require / exports / __dirname 原样保留，只是允许压缩模块内的顶层变量名
    const { code } = esbuild.transformSync(source, {
      loader: 'js',
      format: 'cjs',
      minify: true,
      legalComments: 'none',
      sourcemap: false,
      target: 'es2022',
      platform: 'node',
      charset: 'utf8'
    })
    const output = code.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '').trimEnd() + '\n'
    if (output.trim() === '' && source.trim() !== '') {
      throw new Error(`压缩结果为空: ${path.relative(root, file)}`)
    }
    fsApi.writeFileSync(file, output, 'utf8')
  }
  return { files: scripts.map((file) => path.relative(root, file)), removedMaps }
}
