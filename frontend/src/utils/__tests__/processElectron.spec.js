import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProcessAPI from '../../../public/js/cef-ipc/src/api/process.js'

describe('Electron Process SDK', () => {
  let call
  let api

  beforeEach(() => {
    call = vi.fn().mockResolvedValue({ success: true, pid: 1234 })
    api = new ProcessAPI({
      call,
      isElectronEnvironment: () => true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends structured arguments instead of a renderer command line', async () => {
    await api.start(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoProfile -Command "Write-Output \\"hello world\\""',
      { show: false }
    )

    expect(call).toHaveBeenCalledWith('process_start', {
      path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-NoProfile', '-Command', 'Write-Output "hello world"'],
      workingDir: '',
      show: false
    })
  })

  it('preserves array argument boundaries and rejects malformed input', async () => {
    await api.start('C:\\selected\\tool.exe', ['a b', '"quoted"'])
    expect(call).toHaveBeenCalledWith('process_start', {
      path: 'C:\\selected\\tool.exe',
      args: ['a b', '"quoted"'],
      workingDir: '',
      show: true
    })
    await expect(api.start('C:\\selected\\tool.exe', '"unfinished')).rejects.toThrow('unclosed quote')
    await expect(api.start('C:\\selected\\tool.exe', [1])).rejects.toThrow('only contain strings')
  })

  it('keeps wait alive for the declared process timeout', async () => {
    await api.wait(1234, 15_000)
    expect(call).toHaveBeenCalledWith(
      'process_wait',
      { pid: 1234, timeout: 15_000 },
      { timeout: 16_000 }
    )

    await api.wait(1234)
    expect(call).toHaveBeenLastCalledWith(
      'process_wait',
      { pid: 1234, timeout: 0 },
      { timeout: Infinity }
    )
  })
})
