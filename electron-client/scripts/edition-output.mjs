import fs from 'node:fs'
import path from 'node:path'

/**
 * 主进程版本产物整理（build.mjs 与 tests/scripts/run-tests.mjs 共用）。
 *
 * 主进程按编译产物 out/main/commercial/edition.js 是否存在选择版本（见 src/main/edition.ts），
 * 界面层按源码 src/commercial/edition.js 是否存在选择版本；tsc 只写不删，
 * 源码目录去掉后旧产物仍会留在 out/ 里，造成版本混杂。
 * 因此源码目录不存在时，编译与测试前删除对应的旧产物。
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
