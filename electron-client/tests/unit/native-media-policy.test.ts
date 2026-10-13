import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import {
  NativeMediaPathPolicy,
  type NativeMediaPathResolver,
  type NativeMediaStat
} from '../../src/main/services/native-media-policy.js'

class FakePathResolver implements NativeMediaPathResolver {
  readonly calls: Array<{ value: string; caller: CallerIdentity; access: 'read' | 'write'; allowMissing: boolean }> = []
  readonly grants = new Set<string>()
  readonly root = path.join(path.sep, 'native-media-policy-tests')

  allow(caller: CallerIdentity, access: 'read' | 'write', ...values: string[]): void {
    for (const value of values) this.grants.add(`${caller.webContentsId}:${access}:${value}`)
  }

  canonical(caller: CallerIdentity, value: string): string {
    return path.join(this.root, String(caller.webContentsId), value)
  }

  async resolveAuthorizedPath(
    value: string,
    caller: CallerIdentity,
    access: 'read' | 'write',
    allowMissing: boolean
  ): Promise<string> {
    this.calls.push({ value, caller, access, allowMissing })
    if (!this.grants.has(`${caller.webContentsId}:${access}:${value}`)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'path not authorized')
    }
    return this.canonical(caller, value)
  }
}

function fileStats(size = 128): NativeMediaStat {
  return { size, isFile: () => true, isDirectory: () => false }
}

function directoryStats(): NativeMediaStat {
  return { size: 0, isFile: () => false, isDirectory: () => true }
}

function createPolicy(resolver = new FakePathResolver()) {
  const stats = new Map<string, NativeMediaStat>()
  const policy = new NativeMediaPathPolicy(resolver, [], {
    stat: async (target) => {
      const value = stats.get(target)
      if (!value) throw new Error('missing test stat')
      return value
    }
  })
  return { policy, resolver, stats }
}

const caller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 301,
  pluginId: 'batch-audio'
}

test('canonicalizes every media input and output with the actual caller grant', async () => {
  const { policy, resolver, stats } = createPolicy()
  resolver.allow(caller, 'read', 'source.wav', 'watermark.png')
  resolver.allow(caller, 'write', 'output')
  stats.set(resolver.canonical(caller, 'source.wav'), fileStats())
  stats.set(resolver.canonical(caller, 'watermark.png'), fileStats(1024))
  stats.set(resolver.canonical(caller, 'output'), directoryStats())
  const params = {
    files: ['source.wav'],
    watermarkFile: 'watermark.png',
    outputDir: 'output'
  }

  const result = await policy.authorizeCall('BatchAudioPlugin', 'BatchAddWatermark', params, caller)

  assert.deepEqual(result, {
    ...params,
    files: [resolver.canonical(caller, 'source.wav')],
    watermarkFile: resolver.canonical(caller, 'watermark.png'),
    outputDir: resolver.canonical(caller, 'output')
  })
  assert.deepEqual(resolver.calls.map(({ caller: seenCaller, access, allowMissing }) => ({
    webContentsId: seenCaller.webContentsId,
    access,
    allowMissing
  })), [
    { webContentsId: caller.webContentsId, access: 'read', allowMissing: false },
    { webContentsId: caller.webContentsId, access: 'read', allowMissing: false },
    { webContentsId: caller.webContentsId, access: 'write', allowMissing: false }
  ])
  assert.equal(params.files[0], 'source.wav')
})

test('read-only audio detection needs read grants but no output directory', async () => {
  const { policy, resolver, stats } = createPolicy()
  resolver.allow(caller, 'read', 'input.wav')
  stats.set(resolver.canonical(caller, 'input.wav'), fileStats())

  const result = await policy.authorizeCall('BatchAudioPlugin', 'BatchDetectSilence', {
    files: ['input.wav']
  }, caller)

  assert.deepEqual(result, { files: [resolver.canonical(caller, 'input.wav')] })
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', { files: ['input.wav'] }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('normalizes media parameters before caller-scoped path resolution', async () => {
  const { policy, resolver, stats } = createPolicy()
  resolver.allow(caller, 'read', 'input.wav')
  resolver.allow(caller, 'write', 'output')
  stats.set(resolver.canonical(caller, 'input.wav'), fileStats())
  stats.set(resolver.canonical(caller, 'output'), directoryStats())

  const result = await policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
    files: ['input.wav'],
    outputDir: 'output',
    format: 'wav',
    sampleRate: '48000',
    bitDepth: '24',
    channels: '1'
  }, caller)

  assert.deepEqual(result, {
    files: [resolver.canonical(caller, 'input.wav')],
    outputDir: resolver.canonical(caller, 'output'),
    format: 'wav',
    sampleRate: 48_000,
    bitDepth: 24,
    channels: 1
  })
})

test('input item, aggregate byte, and combined auxiliary-path limits are enforced', async () => {
  const { policy, resolver, stats } = createPolicy()
  const mediaCaller = { ...caller, webContentsId: 302 }
  const names = ['large.wav', 'a.wav', 'b.wav', 'c.wav', 'd.wav', 'small.wav', 'watermark.png']
  resolver.allow(mediaCaller, 'read', ...names)
  resolver.allow(mediaCaller, 'write', 'output')
  stats.set(resolver.canonical(mediaCaller, 'large.wav'), fileStats(512 * 1024 * 1024 + 1))
  for (const name of names.slice(1, 5)) {
    stats.set(resolver.canonical(mediaCaller, name), fileStats(500 * 1024 * 1024))
  }
  stats.set(resolver.canonical(mediaCaller, 'small.wav'), fileStats(1))
  stats.set(resolver.canonical(mediaCaller, 'watermark.png'), fileStats(1))
  stats.set(resolver.canonical(mediaCaller, 'output'), directoryStats())

  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['large.wav'], outputDir: 'output'
    }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['a.wav', 'b.wav', 'c.wav', 'd.wav', 'a.wav'], outputDir: 'output'
    }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.fileTooLarge
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchAddWatermark', {
      files: Array.from({ length: 100 }, () => 'small.wav'),
      watermarkFile: 'watermark.png',
      outputDir: 'output'
    }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: Array.from({ length: 101 }, () => 'a.wav'), outputDir: 'output'
    }, mediaCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('caller identity, write access, file type, and required output directory are enforced', async () => {
  const { policy, resolver, stats } = createPolicy()
  const otherCaller = { ...caller, webContentsId: 303 }
  resolver.allow(caller, 'read', 'source.wav')
  resolver.allow(caller, 'write', 'source.wav', 'not-a-directory')
  stats.set(resolver.canonical(caller, 'source.wav'), fileStats())
  stats.set(resolver.canonical(caller, 'not-a-directory'), fileStats())

  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'GetFileInfo', { filePath: 'source.wav' }, otherCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['source.wav'], outputDir: 'source.wav'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['source.wav'], outputDir: 'not-a-directory'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['source.wav']
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('explicit audio merge output is a safe leaf name and cannot equal an input', async () => {
  const { policy, resolver, stats } = createPolicy()
  const input = path.join('output', 'merged_output.wav')
  resolver.allow(caller, 'read', input, 'source.wav', 'second.wav')
  resolver.allow(caller, 'write', 'output')
  stats.set(resolver.canonical(caller, input), fileStats())
  stats.set(resolver.canonical(caller, 'source.wav'), fileStats())
  stats.set(resolver.canonical(caller, 'second.wav'), fileStats())
  stats.set(resolver.canonical(caller, 'output'), directoryStats())

  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
      files: [input, 'source.wav'], outputDir: 'output', outputFile: 'merged_output.wav'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
      files: ['source.wav', 'second.wav'], outputDir: 'output', outputFile: '..\\private.wav'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
      files: ['source.wav', 'second.wav'], outputDir: 'output', outputFile: 'C:\\private.wav'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )

  const accepted = await policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
    files: ['source.wav', 'second.wav'], outputDir: 'output', outputFile: 'mix.wav'
  }, caller)
  assert.equal(accepted.outputFile, 'mix.wav')

  for (const outputFile of [
    'COM¹.wav', 'COM².wav', 'COM³.wav', 'LPT¹.wav', 'LPT².wav', 'LPT³.wav',
    'CONIN$.wav', 'CONOUT$.wav', 'CON .wav'
  ]) {
    await assert.rejects(
      policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
        files: ['source.wav', 'second.wav'], outputDir: 'output', outputFile
      }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }

  const videoOutput = path.join('output', 'movie.mp4')
  const videoDefaultOutput = path.join('output', 'merged_output.mp4')
  resolver.allow(caller, 'read', videoOutput, videoDefaultOutput, 'source.mp4')
  stats.set(resolver.canonical(caller, videoOutput), fileStats())
  stats.set(resolver.canonical(caller, videoDefaultOutput), fileStats())
  stats.set(resolver.canonical(caller, 'source.mp4'), fileStats())
  await assert.rejects(
    policy.authorizeCall('BatchVideoPlugin', 'BatchMergeVideo', {
      files: [videoOutput, 'source.mp4'], outputDir: 'output', outputFile: 'movie.mp4'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchVideoPlugin', 'BatchMergeVideo', {
      files: [videoDefaultOutput, 'source.mp4'], outputDir: 'output'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('authorized media input and output paths preserve legitimate apostrophes', async () => {
  const { policy, resolver, stats } = createPolicy()
  const inputOne = "O'Brien part one.wav"
  const inputTwo = "O'Brien part two.wav"
  const outputDirectory = "O'Brien output"
  const outputFile = "O'Brien merged.wav"
  resolver.allow(caller, 'read', inputOne, inputTwo)
  resolver.allow(caller, 'write', outputDirectory)
  stats.set(resolver.canonical(caller, inputOne), fileStats())
  stats.set(resolver.canonical(caller, inputTwo), fileStats())
  stats.set(resolver.canonical(caller, outputDirectory), directoryStats())

  const result = await policy.authorizeCall('BatchAudioPlugin', 'BatchMergeAudio', {
    files: [inputOne, inputTwo],
    outputDir: outputDirectory,
    outputFile
  }, caller)

  assert.deepEqual(result, {
    files: [resolver.canonical(caller, inputOne), resolver.canonical(caller, inputTwo)],
    outputDir: resolver.canonical(caller, outputDirectory),
    outputFile
  })
  assert.deepEqual(resolver.calls.map(({ value, access }) => ({ value, access })), [
    { value: inputOne, access: 'read' },
    { value: inputTwo, access: 'read' },
    { value: outputDirectory, access: 'write' }
  ])

  const otherCaller = { ...caller, webContentsId: caller.webContentsId + 1 }
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'GetFileInfo', { filePath: inputOne }, otherCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
  for (const invalidOutputDirectory of ['bad"output', 'bad\0output', 'bad\routput', 'bad\noutput']) {
    await assert.rejects(
      policy.authorizeCall('BatchAudioPlugin', 'BatchConvertFormat', {
        files: [inputOne],
        outputDir: invalidOutputDirectory
      }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
})

test('path control characters, undeclared paths, and inherited method names fail closed', async () => {
  const { policy, resolver } = createPolicy()
  for (const value of ['bad"path.wav', 'bad\0path.wav', 'bad\rpath.wav', 'bad\npath.wav']) {
    await assert.rejects(
      policy.authorizeCall('BatchAudioPlugin', 'GetFileInfo', { filePath: value }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  }
  for (const functionName of ['toString', 'constructor', '__proto__']) {
    await assert.rejects(
      policy.authorizeCall('BatchAudioPlugin', functionName, {}, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound
    )
  }
  await assert.rejects(
    policy.authorizeCall('BatchAudioPlugin', 'BatchDetectSilence', {
      files: [], outputDir: 'output'
    }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.equal(resolver.calls.length, 0)
})

test('thumbnail remains denied while watermark settings use strict scalar-only policy', async () => {
  const { policy } = createPolicy()
  await assert.rejects(
    policy.authorizeCall('BatchVideoPlugin', 'GenerateThumbnail', {}, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.notSupported
  )
  assert.deepEqual(await policy.authorizeCall('BatchVideoPlugin', 'SaveWatermarkSettings', {
    watermarkType: 'text', text: 'watermark', x: 0, dynamicLoop: false
  }, caller), {
    watermarkType: 'text', text: 'watermark', x: 0, dynamicLoop: false
  })
  assert.deepEqual(await policy.authorizeCall('BatchVideoPlugin', 'LoadWatermarkSettings', {}, caller), {})
  await assert.rejects(
    policy.authorizeCall('BatchVideoPlugin', 'SaveWatermarkSettings', { watermarkFile: 'watermark.png' }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  await assert.rejects(
    policy.authorizeCall('BatchVideoPlugin', 'LoadWatermarkSettings', { async: true }, caller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
})

test('future report DLL methods require an explicit DLL-specific policy entry', async () => {
  const resolver = new FakePathResolver()
  const reportCaller = { ...caller, webContentsId: 304 }
  resolver.allow(reportCaller, 'read', 'report-input.mp4')
  const stats = new Map<string, NativeMediaStat>([
    [resolver.canonical(reportCaller, 'report-input.mp4'), fileStats()]
  ])
  const policy = new NativeMediaPathPolicy(resolver, [{
    dllId: 'MediaReportNative',
    methods: { GetFileInfo: { requiredInputFields: ['filePath'] } }
  }], {
    stat: async (target) => {
      const value = stats.get(target)
      if (!value) throw new Error('missing test stat')
      return value
    }
  })

  const result = await policy.authorizeCall('MediaReportNative', 'GetFileInfo', {
    filePath: 'report-input.mp4'
  }, reportCaller)
  assert.deepEqual(result, { filePath: resolver.canonical(reportCaller, 'report-input.mp4') })
  await assert.rejects(
    policy.authorizeCall('MediaReportNative', 'BatchConvertFormat', {}, reportCaller),
    (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound
  )
})
