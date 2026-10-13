import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SystemPlatformAdapter } from '../system.js'
import { getRuntimeCapabilityTarget } from '../runtime-capability-target.js'

const execFileAsync = promisify(execFile)

export function createWindowsSystemPlatformAdapter(userDataPath: string): SystemPlatformAdapter {
  return {
    userDataPath: process.env.LOCALAPPDATA ?? userDataPath,
    getRuntimeTarget: () => getRuntimeCapabilityTarget('win32', process.arch),
    async getNativeId() {
      const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const executable = path.join(
        windowsRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      try {
        const { stdout } = await execFileAsync(executable, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "(Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq 'C:').VolumeSerialNumber"
        ], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true
        })
        return stdout
          .split(/\\r?\\n/)
          .map((line) => line.trim())
          .find((line) => /^[0-9A-F]{8}$/i.test(line)) ?? ''
      } catch {
        return ''
      }
    }
  }
}
