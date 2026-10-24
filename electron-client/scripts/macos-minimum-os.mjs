import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function compareOsVersions(a, b) {
  const valid = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/
  if (!valid.test(a) || !valid.test(b)) throw new Error('非法OS版本')
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number)
  if ([...aa, ...bb].some(n => !Number.isSafeInteger(n))) throw new Error('OS版本溢出')
  for (let i = 0; i < 3; i++) {
    const delta = (aa[i] ?? 0) - (bb[i] ?? 0)
    if (delta) return Math.sign(delta)
  }
  return 0
}

export function parseMacDeploymentVersion(output) {
  if (typeof output !== 'string') throw new Error('INVALID_OTOOL_OUTPUT')
  const blocks = output.split(/Load command \d+\s*\r?\n/).slice(1)
  const versions = []
  for (const block of blocks) {
    const command = /^\s*cmd (LC_[A-Z0-9_]+)\s*$/m.exec(block)?.[1]
    if (command === 'LC_BUILD_VERSION') {
      if (!/^\s*platform (?:1|MACOS|macos)\s*$/m.test(block)) throw new Error('NON_MACOS_DEPLOYMENT_TARGET')
      versions.push(/^\s*minos (\d+\.\d+(?:\.\d+)?)\s*$/m.exec(block)?.[1])
    } else if (command === 'LC_VERSION_MIN_MACOSX') {
      versions.push(/^\s*version (\d+\.\d+(?:\.\d+)?)\s*$/m.exec(block)?.[1])
    } else if (command?.startsWith('LC_VERSION_MIN_')) {
      throw new Error('NON_MACOS_DEPLOYMENT_TARGET')
    }
  }
  if (versions.length !== 1 || !versions[0]) throw new Error('MISSING_OR_DUPLICATE_DEPLOYMENT_TARGET')
  compareOsVersions(versions[0], versions[0])
  return versions[0]
}

export function inspectMacDeployment(filePath, architecture, { exec = execFileSync, fsApi = fs, tmpdir = os.tmpdir } = {}) {
  if (!['arm64', 'x86_64'].includes(architecture)) throw new Error('INVALID_MACHO_SLICE')
  const run = (target) => parseMacDeploymentVersion(exec('/usr/bin/otool', ['-arch', architecture, '-l', target], {
    encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024
  }))
  // otool 把 `文件(成员)` 解析为静态库成员语法：Electron 的「ZTools Helper (GPU)」等路径会被截断成不存在的文件。
  // 含括号时改为读取临时目录中同名无括号的符号链接（otool 会跟随链接），用完即删。
  if (!/[()]/.test(filePath)) return run(filePath)
  const directory = fsApi.mkdtempSync(path.join(tmpdir(), 'ztools-otool-'))
  try {
    const alias = path.join(directory, 'macho')
    fsApi.symlinkSync(path.resolve(filePath), alias)
    return run(alias)
  } finally {
    fsApi.rmSync(directory, { recursive: true, force: true })
  }
}

export function inspectMacBundleMinimumOs(bundlePath, { exec = execFileSync } = {}) {
  const info = JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundlePath, 'Contents', 'Info.plist')], {
    encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024
  }))
  compareOsVersions(info.LSMinimumSystemVersion, info.LSMinimumSystemVersion)
  return info.LSMinimumSystemVersion
}
