import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPeMachine, PE_MACHINE_X64, PE_MACHINE_X86 } from './windows-pe-architecture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

/**
 * 读取 Windows PE 文件的安全缓解标志 (ASLR, DEP, CFG)
 */
export function readPeSecurityMitigations(filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`不是有效的 PE 可执行文件: ${filePath}`)
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 96 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`PE 头部无效: ${filePath}`)
  }

  // DllCharacteristics 位于 OptionalHeader 偏移 70 字节处 (PE Header + 24 + 70 = PE Header + 94)
  const dllCharacteristics = buffer.readUInt16LE(peOffset + 94)

  const dynamicBase = (dllCharacteristics & 0x0040) !== 0   // ASLR (地址空间布局随机化)
  const highEntropyVa = (dllCharacteristics & 0x0020) !== 0 // 64位高熵 ASLR
  const nxCompat = (dllCharacteristics & 0x0100) !== 0      // DEP (数据执行保护)
  const guardCf = (dllCharacteristics & 0x4000) !== 0       // CFG (控制流防护)

  return {
    dynamicBase,
    highEntropyVa,
    nxCompat,
    guardCf,
    rawCharacteristics: dllCharacteristics
  }
}

/**
 * 校验二进制文件是否符合 ZTools 安全防御与防篡改标准
 */
export function verifyBinaryHardening(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`目标二进制文件不存在: ${binaryPath}`)
  }

  const mitigations = readPeSecurityMitigations(binaryPath)
  if (!mitigations.dynamicBase) {
    throw new Error(`安全合规校验失败: ${path.basename(binaryPath)} 未启用 DYNAMICBASE (ASLR)`)
  }
  if (!mitigations.nxCompat) {
    throw new Error(`安全合规校验失败: ${path.basename(binaryPath)} 未启用 NXCOMPAT (DEP)`)
  }

  return mitigations
}

/**
 * 扫描并验证发布包内不包含调试符号与敏感源码泄漏
 */
export function auditReleasePackageIntegrity(distDirectory) {
  const disallowedExtensions = new Set(['.pdb', '.map', '.ts', '.ilk', '.exp'])
  const leakedFiles = []

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (disallowedExtensions.has(ext)) {
          leakedFiles.push(path.relative(distDirectory, fullPath))
        }
      }
    }
  }

  walk(distDirectory)
  if (leakedFiles.length > 0) {
    throw new Error(`生产包完整性审计发现残留敏感文件:\n  ${leakedFiles.join('\n  ')}`)
  }
  return { clean: true, scannedDir: distDirectory }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sidecarDir = path.join(rootDir, 'out', 'native', 'win32-x64', 'bin')
  console.log('[harden-production] 开始校验侧车二进制安全加固标志...')
  const targets = ['ztools-uiaccess.exe', 'ztools-uiaccess-standard.exe', 'ztools-indexer.exe']

  for (const bin of targets) {
    const p = path.join(sidecarDir, bin)
    if (fs.existsSync(p)) {
      const m = verifyBinaryHardening(p)
      console.log(`  ✔ ${bin}: ASLR=${m.dynamicBase}, DEP=${m.nxCompat}, CFG=${m.guardCf}`)
    }
  }
  console.log('[harden-production] 生产二进制安全合规审计通过!')
}
