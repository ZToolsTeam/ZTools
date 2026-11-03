import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildAudioArguments, processAudioFiles } from '../../src/main/services/host-plugins/audio-processing.js'
import type { HostPluginContext, HostSystemCommands } from '../../src/main/services/host-plugins/shared-utils.js'
const ctx: HostPluginContext = { clipboard: null, processService: null, windowControl: null,
  authorizeExistingPath: async value => value, authorizeOutputPath: async value => value }

test('音频模式使用对应滤镜、编码参数与合并输入，未知模式和异常参数拒绝执行', () => {
  const args = (method: string, params: Record<string, unknown> = {}) => buildAudioArguments(method, params, ['in.wav'], 'out.mp3').join(' ')
  assert.match(args('batchloudnorm'), /loudnorm=I=-16/)
  assert.match(args('batchadjustvolume', { gainDb: 6 }), /volume=6dB/)
  assert.match(args('batchtrimduration'), /atrim=start=2.*areverse.*atrim=start=2/)
  assert.match(args('batchfadeinout'), /afade=t=in:d=3,areverse,afade=t=in:d=3,areverse/)
  assert.match(args('batchequalizer'), /highpass=f=90,equalizer=f=3000/)
  assert.match(args('batchcompressor'), /acompressor=threshold=/)
  assert.match(args('batchdenoise'), /afftdn=nr=14:nf=-45/)
  assert.match(args('batchtrimaudio'), /silenceremove=.*areverse/)
  assert.match(args('batchwritemetadata', { artist: '名字', year: '2026' }), /-metadata artist=名字 -metadata date=2026/)
  assert.match(args('batchconvertformat', { format: 'flac', compressionLevel: 8 }), /-c:a flac -compression_level 8/)
  assert.match(args('batchconvertformat', { sampleRateMode: '44100' }), /-ar 44100 -b:a 320k/)
  const merge = buildAudioArguments('batchmergeaudio', { format: 'wav' }, ['one.wav', 'two.wav'], 'out.wav').join(' ')
  assert.match(merge, /-i one.wav -i two.wav/)
  assert.match(merge, /concat=n=2:v=0:a=1/)
  assert.throws(() => args('notimplemented'), /不支持/)
  assert.throws(() => args('batchmergeaudio'), /至少两首/)
  assert.throws(() => args('batchadjustvolume', { gainDb: Infinity }), /无效/)
  assert.throws(() => args('batchconvertformat', { format: 'mp3;rm' }), /不支持/)
})

test('音频失败保留旧文件，取消/空产物不发布；部分成功回执保留真实结果', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-audio-unit-'))
  const output = path.join(temp, 'old.mp3'), input = path.join(temp, 'input.wav')
  await fs.writeFile(input, 'input')
  await fs.writeFile(output, 'KEEP')
  let invalidOutput = false
  let abort: AbortController | undefined
  const sys: HostSystemCommands = {
    runPowerShell: async () => { throw new Error('禁止真实命令') },
    runCommand: async (command, args) => {
      if (args[0] === '-version') return { exitCode: 0, stdout: '', stderr: '' }
      if (command === 'ffprobe') return { exitCode: 0, stdout: JSON.stringify(invalidOutput ? { streams: [] } : { streams: [{ codec_name: 'mp3', sample_rate: '48000' }], format: { duration: '2' } }), stderr: '' }
      await fs.writeFile(args.at(-1)!, 'valid-mock')
      abort?.abort()
      return { exitCode: 0, stdout: '', stderr: '' }
    }
  }
  try {
    const old = await processAudioFiles(ctx, sys, 'batchloudnorm', { outputPath: output }, [input])
    assert.equal(old.ok, false)
    assert.equal(await fs.readFile(output, 'utf8'), 'KEEP')
    invalidOutput = true
    assert.equal((await processAudioFiles(ctx, sys, 'batchdenoise', {}, [input])).ok, false)
    invalidOutput = false
    abort = new AbortController()
    assert.equal((await processAudioFiles(ctx, sys, 'batchloudnorm', {}, [input], undefined, abort.signal)).ok, false)
    abort = undefined
    const authority: HostPluginContext = { ...ctx, authorizeExistingPath: async value => {
      if (value.endsWith('denied.wav')) throw new Error('PERMISSION_DENIED')
      return value
    } }
    const partial = await processAudioFiles(authority, sys, 'batchloudnorm', {}, [input, path.join(temp, 'denied.wav')])
    assert.equal(partial.ok, false)
    assert.equal(partial.processedCount, 1)
    assert.equal((partial.errors as unknown[]).length, 1)
    assert.equal((await fs.readdir(temp)).some(name => name.startsWith('.ztools-audio')), false)
    const missing = await processAudioFiles(ctx, { ...sys, runCommand: async () => ({ exitCode: 127, stdout: '', stderr: 'missing' }) }, 'batchloudnorm', {}, [input])
    assert.equal(missing.ok, false)
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})

test('音频在依赖检查、路径授权、建目录或源探测期间取消后，不启动后续外部命令', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-audio-abort-'))
  try {
    for (const stage of ['initial', 'dependency', 'input', 'outputDir', 'outputPath', 'mkdir', 'sourceProbe']) {
      await t.test(stage, async sub => {
        const controller = new AbortController()
        const calls: Array<{ command: string; args: string[]; aborted: boolean }> = []
        const outDir = path.join(temp, stage)
        const cancelAt = (current: string) => { if (stage === current) controller.abort() }
        const authority: HostPluginContext = { ...ctx,
          authorizeExistingPath: async value => { cancelAt('input'); return value },
          authorizeOutputPath: async value => { cancelAt(value === outDir ? 'outputDir' : 'outputPath'); return value }
        }
        const mkdir = fs.mkdir.bind(fs)
        sub.mock.method(fs, 'mkdir', async (...args: Parameters<typeof fs.mkdir>) => {
          const result = await mkdir(...args)
          cancelAt('mkdir')
          return result
        })
        const commands: HostSystemCommands = {
          runPowerShell: async () => { throw new Error('音频不应调用 PowerShell') },
          runCommand: async (command, args) => {
            calls.push({ command, args, aborted: controller.signal.aborted })
            cancelAt(args[0] === '-version' ? 'dependency' : 'sourceProbe')
            return { exitCode: 0, stdout: JSON.stringify({ streams: [{ sample_rate: '48000' }] }), stderr: '' }
          }
        }
        cancelAt('initial')
        const result = await processAudioFiles(authority, commands, 'batchloudnorm', { outputDir: outDir },
          [path.join(temp, 'one.wav'), path.join(temp, 'two.wav')], undefined, controller.signal)
        assert.equal(result.ok, false)
        assert.equal(result.processedCount, 0)
        assert.match(String(result.error), /abort/i)
        assert.ok(calls.every(call => !call.aborted), '取消后不能开始任何新命令')
        assert.equal(calls.filter(call => call.args[0] !== '-version').length, stage === 'sourceProbe' ? 1 : 0)
        assert.equal(calls.filter(call => call.command === 'ffmpeg' && call.args[0] !== '-version').length, 0)
        if (stage === 'initial') assert.equal(calls.length, 0)
        if (stage === 'dependency') assert.equal(calls.length, 1)
        assert.equal((await fs.readdir(temp, { recursive: true })).some(name => name.includes('.ztools-audio')), false)
      })
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
})
