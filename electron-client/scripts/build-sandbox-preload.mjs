import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontendRequire = createRequire(path.join(root, '../frontend/package.json'))
const { buildSync } = frontendRequire('esbuild')
const requireLocal = createRequire(path.join(root, 'package.json'))
const ts = requireLocal('typescript')

/** Reuse the installed Vite toolchain; sandbox execution only needs Electron's bounded module shim. */
export function buildSandboxPreload({ entryFile = path.join(root, 'src/preload/main.ts'),
  outputFile = path.join(root, 'out/preload/main.js') } = {}) {
  if (!path.isAbsolute(entryFile) || !path.isAbsolute(outputFile) || !outputFile.endsWith('.js')) {
    throw new Error('SANDBOX_PRELOAD_ABSOLUTE_PATHS_REQUIRED')
  }
  const result = buildSync({ entryPoints: [entryFile], outfile: outputFile, bundle: true,
    platform: 'node', format: 'cjs', target: 'es2022', external: ['electron'],
    sourcemap: 'external', metafile: true, write: false, logLevel: 'silent' })
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.some(dependency => dependency.external && dependency.path !== 'electron')) {
      throw new Error('SANDBOX_PRELOAD_FORBIDDEN_MODULE')
    }
  }
  const javascript = result.outputFiles.find(file => path.resolve(file.path) === path.resolve(outputFile))
  if (!javascript) throw new Error('SANDBOX_PRELOAD_OUTPUT_MISSING')
  const source = ts.createSourceFile('sandbox-preload.js', javascript.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  function inspect(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        ['require', '__require'].includes(node.expression.text)) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== 'electron') {
        throw new Error('SANDBOX_PRELOAD_FORBIDDEN_MODULE')
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
  // Validate all results before writing any application output.
  for (const file of result.outputFiles) {
    if (![path.resolve(outputFile), path.resolve(outputFile + '.map')].includes(path.resolve(file.path))) {
      throw new Error('SANDBOX_PRELOAD_UNEXPECTED_OUTPUT')
    }
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  for (const file of result.outputFiles) fs.writeFileSync(file.path, file.contents)
  return { outputFile, externalModules: ['electron'], bundled: true }
}

export function buildRuntimeCapabilityPromptPreload({
  entryFile = path.join(root, 'src/preload/runtime-capability-prompt.ts'),
  outputFile = path.join(root, 'out/preload/runtime-capability-prompt.js')
} = {}) {
  return buildSandboxPreload({ entryFile, outputFile })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildSandboxPreload()))
}
