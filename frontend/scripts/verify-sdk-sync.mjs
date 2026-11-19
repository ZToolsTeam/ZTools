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
} else {
  console.log(
    '[sdk-sync] Verified both SDK files in frontend/public/sdk against packages/api/runtime.'
  )
}
