import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(frontendRoot, '..')
const canonicalDirectory = resolve(frontendRoot, 'public/sdk')
const sdkFiles = ['ztools-api.js', 'plugin-sdk.js']
const targets = [
  {
    label: 'packages/api/runtime',
    directory: resolve(repositoryRoot, 'packages/api/runtime')
  }
]
const isElectronBuild = process.env.ZTOOLS_BUILD_TARGET === 'electron' ||
  process.env.ZTOOLS_SKIP_LEGACY_BIN_DEPLOY === '1'

if (!isElectronBuild) {
  targets.push({
    label: 'bin/WebResources/sdk',
    directory: resolve(repositoryRoot, 'bin/WebResources/sdk')
  })
}

const errors = []

function readRequiredFile(filePath, description) {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      errors.push(`[sdk-sync] Expected ${description} to be a file: ${filePath}`)
      return undefined
    }
    return readFileSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      errors.push(`[sdk-sync] Missing ${description}: ${filePath}`)
    } else {
      errors.push(`[sdk-sync] Cannot read ${description} at ${filePath}: ${error.message}`)
    }
    return undefined
  }
}

for (const fileName of sdkFiles) {
  const sourcePath = resolve(canonicalDirectory, fileName)
  const sourceBytes = readRequiredFile(sourcePath, 'canonical SDK file')

  for (const target of targets) {
    const targetPath = resolve(target.directory, fileName)
    const targetBytes = readRequiredFile(targetPath, `SDK copy in ${target.label}`)

    if (sourceBytes && targetBytes && !sourceBytes.equals(targetBytes)) {
      errors.push(`[sdk-sync] Byte mismatch between ${sourcePath} and ${targetPath}`)
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error)
  process.exitCode = 1
} else if (isElectronBuild) {
  console.log(
    '[sdk-sync] Verified plugin-sdk.js against its maintained source and verified both SDK files against packages/api/runtime; skipped bin/WebResources/sdk for the Electron build.'
  )
} else {
  console.log(
    '[sdk-sync] Verified plugin-sdk.js against its maintained source and verified both SDK files against packages/api/runtime and bin/WebResources/sdk.'
  )
}
