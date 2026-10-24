import assert from 'node:assert/strict'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { NativeMediaParameterPolicy } from '../../src/main/services/native-media-parameter-policy.js'

const policy = new NativeMediaParameterPolicy()

function expectInvalid(action: () => unknown): void {
  assert.throws(action, (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest)
}

test('normalizes only the exact numeric select values used by the audio UI', () => {
  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchConvertFormat', {
    files: ['input.wav'],
    outputDir: 'output',
    format: 'flac',
    sampleRate: '48000',
    bitDepth: '24',
    channels: '1',
    taskId: 'audio-task-1'
  }), {
    files: ['input.wav'],
    outputDir: 'output',
    format: 'flac',
    sampleRate: 48_000,
    bitDepth: 24,
    channels: 1,
    taskId: 'audio-task-1'
  })

  for (const value of ['48000junk', ' 48000', '44_100', true, 44_100.5]) {
    expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchConvertFormat', {
      files: ['input.wav'], sampleRate: value
    }))
  }
})

test('validates finite ranges, integer constraints, enums, and required native arguments', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchCompressVideo', {
    files: ['input.mp4'], quality: 23, codec: 'AV1'
  }), { files: ['input.mp4'], quality: 23, codec: 'av1' })

  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchCompressVideo', {
    files: ['input.mp4'], quality: 52
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchCompressVideo', {
    files: ['input.mp4'], quality: 23, codec: 'h264 -vf drawtext=text=bad'
  }))
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', {
    files: ['input.wav'], volume: Number.POSITIVE_INFINITY
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchResizeVideo', {
    files: ['input.mp4'], width: 0, height: 0
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchRotateVideo', {
    files: ['input.mp4'], angle: 45
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchConvertFormat', {
    files: ['input.mp4'], format: 'unknown-container'
  }))
})

test('keeps meaningful zero and false values and validates UI no-op booleans', () => {
  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', {
    files: ['input.wav']
  }), { files: ['input.wav'] })

  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchFadeInOut', {
    files: ['input.wav'], fadeIn: 0, fadeOut: 0
  }), { files: ['input.wav'], fadeIn: 0, fadeOut: 0 })

  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchDetectSilence', {
    files: ['input.wav'], noise: 0, duration: 0.5
  }), { files: ['input.wav'], noise: 0, duration: 0.5 })

  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchMergeAudio', {
    files: ['a.wav', 'b.wav'], insertSilence: false, silenceDuration: 0
  }), { files: ['a.wav', 'b.wav'], insertSilence: false, silenceDuration: 0 })

  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchConvertToGif', {
    files: ['input.mp4'], format: 'webp', fps: 10, width: 0, height: 0, loop: false
  }), { files: ['input.mp4'], format: 'webp', fps: 10, width: 0, height: 0, loop: false })

  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchSpeedUpVideo', {
    files: ['input.mp4'], speed: 1, audioSync: false
  }), { files: ['input.mp4'], speed: 1, audioSync: false })

  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchSpeedUpVideo', {
    files: ['input.mp4'], speed: 1, audioSync: 0
  }))
})

test('parses full time strings to seconds and rejects partial, negative, and excessive values', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchExtractSegment', {
    files: ['input.mp4'], startTime: '01:02', duration: '00:00:03.5'
  }), { files: ['input.mp4'], startTime: 62, duration: 3.5 })

  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractSegment', {
    files: ['input.mp4'], startTime: '10seconds', duration: 1
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractSegment', {
    files: ['input.mp4'], startTime: -1, duration: 1
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractSegment', {
    files: ['input.mp4'], startTime: 0, duration: '00:60'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchTrimVideo', {
    files: ['input.mp4'], duration: 7 * 24 * 60 * 60 + 1
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractSegment', {
    files: ['input.mp4'], startTime: 7 * 24 * 60 * 60 - 1, duration: 2
  }))
})

test('restricts clips to dense bounded arrays of exact time fields', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchExtractClips', {
    files: ['input.mp4'],
    clips: [{ startTime: '00:10', duration: '5' }, { startTime: 20, duration: 2 }]
  }), {
    files: ['input.mp4'],
    clips: [{ startTime: 10, duration: 5 }, { startTime: 20, duration: 2 }]
  })

  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractClips', {
    files: ['input.mp4'], clips: [{ startTime: 1, duration: 2, outputFile: 'x.mp4' }]
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractClips', {
    files: ['input.mp4'], clips: [{ startTime: 1 }]
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractClips', {
    files: ['input.mp4'], clips: Array.from({ length: 101 }, () => ({ startTime: 0, duration: 1 }))
  }))
  const sparse: unknown[] = []
  sparse.length = 1
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchExtractClips', {
    files: ['input.mp4'], clips: sparse
  }))
})

test('limits watermark enum, color, text and numeric fields without claiming filter escaping', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'],
    watermarkType: 'text',
    text: "O'Brien: 100%",
    fontColor: '#FFFFFF',
    opacity: 0,
    dynamicLoop: false,
    saveSettings: false
  }), {
    files: ['input.mp4'],
    watermarkType: 'text',
    text: "O'Brien: 100%",
    fontColor: '#ffffff',
    opacity: 0,
    dynamicLoop: false,
    saveSettings: false
  })

  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'], watermarkType: 'anything', text: 'hello'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'], watermarkType: 'text', fontColor: 'white@evil', text: 'hello'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'], watermarkType: 'text', text: 'line\nbreak'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'], watermarkType: 'text', text: 'x'.repeat(4_097)
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchAddWatermark', {
    files: ['input.mp4'], watermarkType: 'image', text: 'unused text'
  }))
})

test('watermark presets accept only declared scalar fields and preserve zero and false', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'SaveWatermarkSettings', {
    watermarkType: 'text',
    text: 'safe watermark',
    fontSize: 24,
    fontColor: '#AABBCC',
    padding: 0,
    angle: 0,
    opacity: 0,
    x: 0,
    y: 0,
    dynamicLoop: false
  }), {
    watermarkType: 'text',
    text: 'safe watermark',
    fontSize: 24,
    fontColor: '#aabbcc',
    padding: 0,
    angle: 0,
    opacity: 0,
    x: 0,
    y: 0,
    dynamicLoop: false
  })
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'LoadWatermarkSettings', {}), {})
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'SaveWatermarkSettings', {
    watermarkFile: 'image.png'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'SaveWatermarkSettings', {
    files: ['input.mp4'], outputDir: 'output', taskId: 'task_1', async: true
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'LoadWatermarkSettings', {
    arbitraryFilter: 'drawtext=text=untrusted'
  }))
})

test('validates merge branch shape instead of accepting ignored native fields', () => {
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchMergeVideo', {
    files: ['input.mp4'], introFile: 'intro.mp4', outputDir: 'output'
  }), { files: ['input.mp4'], introFile: 'intro.mp4', outputDir: 'output' })
  assert.deepEqual(policy.normalize('BatchVideoPlugin', 'BatchMergeVideo', {
    files: ['a.mp4', 'b.mp4'], position: 'prepend', checkFormat: false
  }), { files: ['a.mp4', 'b.mp4'], position: 'prepend', checkFormat: false })
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchMergeVideo', {
    files: ['a.mp4'], introFile: 'intro.mp4', position: 'prepend'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchMergeVideo', {
    files: ['a.mp4'], mergeMode: 'single'
  }))
  expectInvalid(() => policy.normalize('BatchVideoPlugin', 'BatchMergeVideo', {
    files: ['a.mp4']
  }))
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchMergeAudio', {
    outputFile: 'mix.wav'
  }))
})

test('rejects unknown keys and inherited method names while leaving other DLL policy domains untouched', () => {
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', {
    files: ['input.wav'], async: true
  }))
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', {
    files: ['input.wav'], arbitraryFilter: 'volume=100'
  }))
  const hiddenUnknown = { files: ['input.wav'] }
  Object.defineProperty(hiddenUnknown, 'async', { value: true })
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', hiddenUnknown))
  const inheritedParameters = Object.assign(Object.create({ volume: 5 }), { files: ['input.wav'] }) as Record<string, unknown>
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchNormalizeVolume', inheritedParameters))
  assert.throws(
    () => policy.normalize('BatchAudioPlugin', 'constructor', {}),
    (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound
  )
  assert.throws(
    () => policy.normalize('BatchAudioPlugin', 'toString', {}),
    (error) => error instanceof ZToolsError && error.code === errorCodes.methodNotFound
  )
  const customDllParams = { custom: true }
  assert.equal(policy.normalize('ReportPlugin', 'FutureMethod', customDllParams), customDllParams)
  assert.equal(policy.normalize('__PROTO__', 'constructor', customDllParams), customDllParams)
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchSetMetadata', {
    files: ['input.wav'], title: 'title', extra: 1
  }))
})

test('validates native task ID parameters with the same transport grammar', () => {
  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'GetTaskStatus', { taskId: 'task_01:test' }), {
    taskId: 'task_01:test'
  })
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'GetTaskStatus', { taskId: 'bad id' }))
  expectInvalid(() => policy.normalize('BatchAudioPlugin', 'GetTaskList', { taskId: 'unexpected' }))
})

test('bounds inserted merge silence while preserving inactive zero and native default', () => {
  for (const silenceDuration of [0.1, 1, 60]) {
    assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchMergeAudio', {
      files: ['a.wav', 'b.wav'], insertSilence: true, silenceDuration
    }), { files: ['a.wav', 'b.wav'], insertSilence: true, silenceDuration })
  }
  assert.deepEqual(policy.normalize('BatchAudioPlugin', 'BatchMergeAudio', {
    files: ['a.wav', 'b.wav'], insertSilence: true
  }), { files: ['a.wav', 'b.wav'], insertSilence: true })
  for (const silenceDuration of [0, 0.099, 60.001, NaN, Infinity]) {
    expectInvalid(() => policy.normalize('BatchAudioPlugin', 'BatchMergeAudio', {
      files: ['a.wav', 'b.wav'], insertSilence: true, silenceDuration
    }))
  }
})
