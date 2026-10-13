import { describe, expect, it, vi } from 'vitest'
import { buildFeedbackLogPackage } from '../feedbackLogPackage'

describe('buildFeedbackLogPackage', () => {
  it('collects logs from the app directory and stores every log at the ZIP root', async () => {
    const compress = vi.fn(async ({ onProgress }) => {
      onProgress(50, 'Compressing...')
      return true
    })
    const ztools = {
      fs: {
        getCurrentDirectory: vi.fn(async () => 'C:\\Windows\\System32'),
        getParentDirectory: vi.fn(async () => 'C:\\Windows'),
        directoryExists: vi.fn(async (path) =>
          ['C:\\ZTools\\bin\\Log', 'C:\\Temp'].includes(path)
        ),
        getDirectoryContents: vi.fn(async (path) =>
          path === 'C:\\ZTools\\bin\\Log'
            ? [
                {
                  name: 'info-20260711101500789-PID1234.log',
                  isDirectory: false,
                  lastModified: '2026-07-11T10:15:00+08:00'
                }
              ]
            : path === 'C:\\Temp'
              ? [
                  {
                    name: 'ztools_setup_20260711090000.log',
                    isDirectory: false,
                    lastModified: '2026-07-11T09:00:00+08:00'
                  }
                ]
              : []
        ),
        createDirectory: vi.fn(async () => true),
        copyFile: vi.fn(async () => true),
        deleteFile: vi.fn(async () => true),
        deleteDirectory: vi.fn(async () => true)
      },
      sys: {
        getPath: vi.fn(async (name) =>
          name === 'app' ? 'C:\\ZTools\\bin\\' : 'C:\\Temp\\'
        )
      },
      zip: { compress },
      protocol: {
        readFileAsBlob: vi.fn(async () => new Blob(['log archive']))
      }
    }

    const result = await buildFeedbackLogPackage(
      ztools,
      new Date('2026-07-11T10:20:30+08:00')
    )

    expect(result).toBeInstanceOf(File)
    expect(compress).toHaveBeenCalledOnce()
    expect(compress.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sources: [
          expect.stringMatching(
            /\\feedback-logs-[^\\]+\\info-20260711101500789-PID1234\.log$/
          ),
          expect.stringMatching(
            /\\feedback-logs-[^\\]+\\ztools_setup_20260711090000\.log$/
          )
        ],
        format: 'zip',
        level: 6,
        storePaths: false,
        onProgress: expect.any(Function)
      })
    )
    expect(ztools.fs.getDirectoryContents).toHaveBeenCalledWith('C:\\ZTools\\bin\\Log')
    expect(ztools.fs.copyFile).toHaveBeenCalledTimes(2)
    expect(
      ztools.fs.copyFile.mock.calls.every(([, destination]) => {
        const relative = destination.replace(/^.*\\feedback-logs-[^\\]+\\/, '')
        return !relative.includes('\\')
      })
    ).toBe(true)
  })
})
