/**
 * 本机识别（Windows 文字识别、两端的公式识别）用的 onnxruntime-web 打包规则，Windows 与 macOS 共用。
 * 只带 Node 入口与 wasm 运行时，其余构建变体（webgpu/jsep 等，约 100 MB）不打包；
 * 工作线程要从真实文件加载 wasm，整个目录解到 asar 外。
 */
import fs from 'node:fs'
import path from 'node:path'

export const ONNXRUNTIME_WEB_VERSION = '1.31.1'
export const ONNXRUNTIME_WEB_PACKAGED_FILES = Object.freeze([
  'package.json',
  'dist/ort.node.min.js',
  'dist/ort-wasm-simd-threaded.mjs',
  'dist/ort-wasm-simd-threaded.wasm'
])
export const ONNXRUNTIME_WEB_UNPACK_DIR = '**/node_modules/onnxruntime-web'

/** 打包时排除的路径：onnxruntime-web 里清单以外的文件，以及 Node 入口已内联的依赖（只需要 onnxruntime-common） */
export const ONNXRUNTIME_WEB_IGNORED_PATHS = Object.freeze([
  new RegExp(`^/node_modules/onnxruntime-web/(?!(?:${ONNXRUNTIME_WEB_PACKAGED_FILES.map(file => file.replaceAll('.', '\\.')).join('|')}|dist)$)`),
  /^\/node_modules\/(?:@protobufjs|protobufjs|flatbuffers|guid-typescript|long|platform)(?:\/|$)/
])

const ONNXRUNTIME_WEB_BUNDLED_DEPENDENCIES = Object.freeze([
  '@protobufjs',
  'protobufjs',
  'flatbuffers',
  'guid-typescript',
  'long',
  'platform'
])

/**
 * Packager 的 prune 会保留 onnxruntime-web 在 package.json 中声明的传递依赖，
 * 但当前只加载已内联的 Node 入口和 wasm 文件；这些依赖不能进入生产 ASAR。
 */
export function pruneOnnxRuntimeDependencies({ buildPath }) {
  const nodeModules = path.join(buildPath, 'node_modules')
  for (const dependency of ONNXRUNTIME_WEB_BUNDLED_DEPENDENCIES) {
    fs.rmSync(path.join(nodeModules, dependency), { recursive: true, force: true })
  }

  const runtimeRoot = path.join(nodeModules, 'onnxruntime-web')
  if (!fs.existsSync(runtimeRoot)) return
  const allowed = new Set(ONNXRUNTIME_WEB_PACKAGED_FILES)
  const prune = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const relative = path.relative(runtimeRoot, target).replaceAll(path.sep, '/')
      if (entry.isDirectory()) {
        prune(target)
        if (fs.readdirSync(target).length === 0) fs.rmSync(target, { recursive: true, force: true })
      } else if (!allowed.has(relative)) {
        fs.rmSync(target, { force: true })
      }
    }
  }
  prune(runtimeRoot)
}
