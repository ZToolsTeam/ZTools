import fs from 'node:fs'
import path from 'node:path'
import type { MainEdition } from './edition-types.js'
import { ossEdition } from './edition-oss/index.js'

/**
 * 主进程版本选择（与界面层 vite.config.js 的 @edition 别名对应）。
 *
 * tsc 按 `src/**` 编译，`src/main/commercial/` 存在时会编译出 `commercial/edition.js`；
 * 开源仓库没有这个目录。运行时只按入口文件是否存在来选择：
 * - 入口文件不存在：使用开源版；
 * - 入口文件存在：必须加载成功且导出合法，否则直接抛错。不能悄悄退化成开源版，
 *   否则正式构建会在没人察觉的情况下丢掉账号、统计与更新。
 */

/** 其他版本入口（相对编译后的本文件） */
export const EDITION_ENTRY = path.join(__dirname, 'commercial', 'edition.js')

/** 只用于测试替换文件探测与模块加载 */
export interface EditionLoaderIo {
  exists(file: string): boolean
  load(file: string): unknown
}

const defaultIo: EditionLoaderIo = {
  exists: (file) => fs.existsSync(file),
  // 编译输出是 CommonJS，直接 require
  load: (file) => require(file) as unknown
}

const STORE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.json$/

function isMainEdition(value: unknown): value is MainEdition {
  if (typeof value !== 'object' || value === null) return false
  const edition = value as Partial<MainEdition>
  return edition.id === 'commercial' &&
    Array.isArray(edition.storeFiles) &&
    edition.storeFiles.every((file) => typeof file === 'string' && STORE_FILE_PATTERN.test(file) && !file.includes('..')) &&
    typeof edition.createServices === 'function'
}

/** 加载主进程版本实现 */
export function loadMainEdition(io: EditionLoaderIo = defaultIo, entry = EDITION_ENTRY): MainEdition {
  if (!io.exists(entry)) return ossEdition
  // 入口存在时加载错误原样抛出（内部依赖缺失、代码抛错都不能被吞掉）
  const loaded = io.load(entry)
  const edition = typeof loaded === 'object' && loaded !== null
    ? (loaded as { mainEdition?: unknown }).mainEdition
    : undefined
  if (!isMainEdition(edition)) {
    throw new Error(`主进程版本入口 ${entry} 导出无效`)
  }
  return edition
}

let currentEdition: MainEdition | undefined

/** 当前进程使用的版本实现（只加载一次） */
export function mainEdition(): MainEdition {
  currentEdition ??= loadMainEdition()
  return currentEdition
}
