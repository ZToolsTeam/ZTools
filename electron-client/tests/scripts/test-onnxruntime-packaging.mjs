import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, extractFile, listPackage, statFile, uncache } from '@electron/asar'
import { createMacUniversalPackagerOptions } from '../../scripts/package-macos-universal.mjs'
import { ONNXRUNTIME_WEB_PACKAGED_FILES } from '../../scripts/onnxruntime-package-contract.mjs'
import { createWindowsPackagerOptions } from '../../scripts/windows-package-contract.mjs'

const sourceRequire = createRequire(import.meta.url)
const sourceNodeModules = fileURLToPath(new URL('../../node_modules/', import.meta.url))
const bundledDependencies = ['@protobufjs', 'protobufjs', 'flatbuffers', 'guid-typescript', 'long', 'platform']
const stagedPackages = ['onnxruntime-web', 'onnxruntime-common', ...bundledDependencies]

function snapshotFiles(directory) {
  const files = {}
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) visit(file)
      else files[path.relative(directory, file).replaceAll(path.sep, '/')] =
        createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  visit(directory)
  return files
}

function createTemporaryRoot(t) {
  const temporaryBase = fs.realpathSync(os.tmpdir())
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryBase, 'ztools-onnx-packaging-'))
  t.after(() => {
    const resolved = fs.realpathSync(temporaryRoot)
    assert.equal(path.dirname(resolved), temporaryBase)
    assert.ok(path.basename(resolved).startsWith('ztools-onnx-packaging-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return temporaryRoot
}

function createOptions(platform, sourceRoot, outputRoot) {
  return platform === 'win32'
    ? createWindowsPackagerOptions({ clientRoot: sourceRoot, outputRoot })
    : createMacUniversalPackagerOptions({ sourceRoot, outputRoot,
      appBundleId: 'org.example.ztools', shortVersion: '1.1.8', buildVersion: '1.1.8011' })
}

async function runAfterPrune(options, buildPath) {
  assert.ok(options.afterPrune.length > 0)
  for (const hook of options.afterPrune) {
    await hook({ buildPath, electronVersion: options.electronVersion,
      platform: options.platform, arch: options.arch })
  }
}

function createIdentityModel() {
  // 仅用源码依赖中的标准 ONNX protobuf 编码器生成夹具；推理进程只能加载成包依赖。
  const { onnx } = sourceRequire(path.join(sourceNodeModules,
    'onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js'))
  const tensorType = { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 3 }] } } }
  const model = {
    irVersion: 8,
    opsetImport: [{ version: 13 }],
    graph: { name: 'packaged-identity',
      node: [{ opType: 'Identity', input: ['input'], output: ['output'] }],
      input: [{ name: 'input', type: tensorType }], output: [{ name: 'output', type: tensorType }] }
  }
  assert.equal(onnx.ModelProto.verify(model), null)
  return onnx.ModelProto.encode(model).finish()
}

const inferenceRunner = String.raw`
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
async function main() {
  const [archive, modelPath] = process.argv.slice(2)
  assert.ok(process.versions.electron, '必须使用 Electron 的真实 ASAR 加载器')
  const packagedRequire = createRequire(path.join(archive, 'package.json'))
  const runtimePath = packagedRequire.resolve('onnxruntime-web')
  const commonPath = packagedRequire.resolve('onnxruntime-common')
  assert.ok(runtimePath.startsWith(archive + path.sep), runtimePath)
  assert.ok(commonPath.startsWith(archive + path.sep), commonPath)
  const ort = packagedRequire('onnxruntime-web')
  const wasmDirectory = path.join(archive + '.unpacked', 'node_modules', 'onnxruntime-web', 'dist')
  ort.env.wasm.wasmPaths = pathToFileURL(wasmDirectory + path.sep).href
  ort.env.wasm.numThreads = 1
  const session = await ort.InferenceSession.create(fs.readFileSync(modelPath), { executionProviders: ['wasm'] })
  try {
    const input = new ort.Tensor('float32', Float32Array.from([0, -2, 3.5]), [3])
    const result = await session.run({ input })
    assert.deepEqual(Array.from(result.output.data), [0, -2, 3.5])
    await assert.rejects(session.run({}), /input.*missing|missing.*input/i)
  } finally {
    await session.release()
  }
  await assert.rejects(ort.InferenceSession.create(Uint8Array.of(0), { executionProviders: ['wasm'] }),
    /invalid|model|protobuf|deserialize|parse/i)
  console.log('ONNX_PACKAGING_RESULT:' + JSON.stringify({ runtimePath, commonPath, result: [0, -2, 3.5] }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
`

test('双端 afterPrune 裁剪真实运行时后仍可从 ASAR 执行 WASM 推理，且不修改源依赖', { timeout: 120000 }, async (t) => {
  const temporaryRoot = createTemporaryRoot(t)
  const originalPackages = Object.fromEntries(stagedPackages.map(name =>
    [name, snapshotFiles(path.join(sourceNodeModules, name))]))
  const modelPath = path.join(temporaryRoot, 'identity.onnx')
  const runnerPath = path.join(temporaryRoot, 'infer.cjs')
  fs.writeFileSync(modelPath, createIdentityModel())
  fs.writeFileSync(runnerPath, inferenceRunner)

  for (const platform of ['win32', 'darwin']) {
    await t.test(platform, async () => {
      const buildPath = path.join(temporaryRoot, platform)
      fs.mkdirSync(buildPath)
      fs.writeFileSync(path.join(buildPath, 'package.json'), JSON.stringify({ name: 'onnx-packaging-fixture' }))
      for (const name of stagedPackages) {
        fs.cpSync(path.join(sourceNodeModules, name), path.join(buildPath, 'node_modules', name), { recursive: true })
      }
      const untouchedFile = path.join(buildPath, 'node_modules', 'unrelated-runtime', 'index.js')
      fs.mkdirSync(path.dirname(untouchedFile), { recursive: true })
      fs.writeFileSync(untouchedFile, 'module.exports = 1\n')
      const options = createOptions(platform, buildPath, temporaryRoot)
      await runAfterPrune(options, buildPath)
      const runtimeRoot = path.join(buildPath, 'node_modules', 'onnxruntime-web')
      assert.deepEqual(Object.keys(snapshotFiles(runtimeRoot)).sort(), [...ONNXRUNTIME_WEB_PACKAGED_FILES].sort())
      assert.deepEqual(snapshotFiles(path.join(buildPath, 'node_modules', 'onnxruntime-common')),
        originalPackages['onnxruntime-common'])
      for (const name of bundledDependencies) assert.equal(fs.existsSync(path.join(buildPath, 'node_modules', name)), false, name)
      assert.equal(fs.readFileSync(untouchedFile, 'utf8'), 'module.exports = 1\n')
      const once = snapshotFiles(buildPath)
      await runAfterPrune(options, buildPath)
      assert.deepEqual(snapshotFiles(buildPath), once, '重复裁剪不应改变已整理的暂存目录')

      const archive = path.join(temporaryRoot, platform + '.asar')
      t.after(() => uncache(archive))
      await createPackageWithOptions(buildPath, archive, options.asar)
      for (const relative of ONNXRUNTIME_WEB_PACKAGED_FILES) {
        const packagedPath = path.normalize('node_modules/onnxruntime-web/' + relative)
        assert.equal(statFile(archive, packagedPath).unpacked, true, relative)
        assert.deepEqual(extractFile(archive, packagedPath), fs.readFileSync(path.join(runtimeRoot, relative)))
      }
      assert.notEqual(statFile(archive, path.normalize('node_modules/onnxruntime-common/dist/cjs/index.js')).unpacked, true)
      assert.equal(listPackage(archive).some(entry =>
        /^\/node_modules\/(?:@protobufjs|protobufjs|flatbuffers|guid-typescript|long|platform)(?:\/|$)/
          .test(entry.replaceAll('\\', '/'))), false)
      const result = spawnSync(sourceRequire('electron'), [runnerPath, archive, modelPath], {
        cwd: temporaryRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
        encoding: 'utf8', windowsHide: true, timeout: 30000
      })
      assert.ifError(result.error)
      assert.equal(result.status, 0, result.stdout + result.stderr)
      assert.match(result.stdout, /ONNX_PACKAGING_RESULT:/)
      for (const name of stagedPackages) {
        assert.deepEqual(snapshotFiles(path.join(sourceNodeModules, name)), originalPackages[name], name + ' 源文件必须保持不变')
      }
    })
  }
})

test('afterPrune 允许缺少运行时的空暂存目录，并把无效目录错误传播给打包器', async (t) => {
  const temporaryRoot = createTemporaryRoot(t)
  for (const platform of ['win32', 'darwin']) {
    const buildPath = path.join(temporaryRoot, platform)
    fs.mkdirSync(buildPath)
    const options = createOptions(platform, buildPath, temporaryRoot)
    await runAfterPrune(options, buildPath)
    assert.deepEqual(fs.readdirSync(buildPath), [])
    const runtimePath = path.join(buildPath, 'node_modules', 'onnxruntime-web')
    fs.mkdirSync(path.dirname(runtimePath))
    fs.writeFileSync(runtimePath, '无效的运行时目录')
    await assert.rejects(runAfterPrune(options, buildPath), error => error.code === 'ENOTDIR')
    assert.equal(fs.readFileSync(runtimePath, 'utf8'), '无效的运行时目录')
  }
})
