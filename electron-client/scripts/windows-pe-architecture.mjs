import fs from 'node:fs'
import path from 'node:path'

export const PE_MACHINE_X86 = 0x014c
export const PE_MACHINE_X64 = 0x8664

function machineLabel(machine) {
  if (machine === PE_MACHINE_X86) return 'x86'
  if (machine === PE_MACHINE_X64) return 'x64'
  return `unknown (0x${machine.toString(16)})`
}

export function readPeMachine(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`不是 PE 文件: ${file}`)
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (
    peOffset < 64 ||
    peOffset + 6 > buffer.length ||
    buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`PE 头无效: ${file}`)
  }
  return buffer.readUInt16LE(peOffset + 4)
}

export function assertPeMachine(file, expectedMachine, description = 'PE 文件') {
  const actualMachine = readPeMachine(file)
  if (actualMachine !== expectedMachine) {
    throw new Error(`${description}必须为 ${machineLabel(expectedMachine)} PE: ${file} (实际 ${machineLabel(actualMachine)})`)
  }
  return actualMachine
}

export function expectedWindowsArtifactMachine(file, { applicationRoot, installerPath }) {
  const resolvedFile = path.resolve(file)
  const resolvedApplicationRoot = path.resolve(applicationRoot)
  const relativePath = path.relative(resolvedApplicationRoot, resolvedFile)
  const isInsideApplication = relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)

  if (isInsideApplication) {
    const applicationRelativePath = relativePath.replaceAll(path.sep, '/').toLowerCase()
    if (
      applicationRelativePath === 'ztoolsservice.exe' ||
      applicationRelativePath === 'resources/native/ztoolsnativehost32.exe'
    ) {
      return PE_MACHINE_X86
    }
    return PE_MACHINE_X64
  }

  if (resolvedFile === path.resolve(installerPath)) return PE_MACHINE_X86
  throw new Error(`未登记的 Windows PE 文件职责: ${file}`)
}

export function verifyWindowsArtifactPeFiles(peFiles, { applicationRoot, installerPath }) {
  const counts = { x64: 0, x86: 0 }
  for (const file of peFiles) {
    const expectedMachine = expectedWindowsArtifactMachine(file, { applicationRoot, installerPath })
    const actualMachine = readPeMachine(file)
    if (actualMachine !== expectedMachine) {
      throw new Error(
        `PE 架构与文件职责不符: ${file} (要求 ${machineLabel(expectedMachine)}，实际 ${machineLabel(actualMachine)})`
      )
    }
    counts[expectedMachine === PE_MACHINE_X64 ? 'x64' : 'x86'] += 1
  }
  return counts
}
