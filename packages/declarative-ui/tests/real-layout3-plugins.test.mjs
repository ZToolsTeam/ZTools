/**
 * ZTools 布局三 10 款插件（P26 ~ P35）“去假接真”集成测试与异常边界测试套件
 *
 * 覆盖清单：
 * - P27 ocr: 真实宿主下不拼接 INITIAL_OCR_QUEUE_ITEMS、调用 OcrPlugin.recognizeImage / captureAndRecognize 并写入剪贴板、异常如实报错
 * - P28 record: 真实宿主下不拼接 INITIAL_RECORDED_VIDEOS、调用 RecordPlugin.startRecording / stopRecording 与录制状态栏 IPC、失败时严禁返回 rec_sim_
 * - P29 ai-image: 真实宿主下不拼接 INITIAL_AI_IMAGE_FILES、调用 AiImagePlugin.processImage 并读取真实输出文件体积、异常与安全路径拦截
 * - P30 ai-video: 真实宿主下不拼接 INITIAL_AI_VIDEO_FILES、调用 AiVideoPlugin.enhanceVideo 并校验真实产出文件存在性、无文件产出时严禁假报成功
 * - P31 batch-video: invokeNativeCapability 对接 dllplugin_call、真实宿主下严禁返回 simulated:true、不回退扫描非视频文件、不拼接 INITIAL_SAMPLE_VIDEOS
 * - P32 batch-audio: invokeNativeCapability 对接 dllplugin_call、真实宿主下严禁返回 simulated:true、不回退扫描非音频文件、不拼接 INITIAL_SAMPLE_AUDIOS
 * - P33 pdf: invokeNativeCapability 对接 dllplugin_call / image_to_pdf、真实宿主下严禁返回 simulated:true、不拼接 INITIAL_SAMPLE_PDFS
 * - P34 screenshots: pasteToActiveWindow 对接 clipboard_hide_and_paste_file、copyImageToClipboard 对接 clipboard_copy_file、extractOcr 对接 OcrPlugin.recognizeImage 且严禁返回假文本、真实解析 PNG/JPEG/BMP/GIF/WebP 宽高
 * - P35 color-picker: pickScreenColor 结合 screen_get_cursor_pos 与 ColorPickerPlugin.pickScreenPixel 获取真实像素颜色、真实宿主失败如实抛错、彻底清零 Math.random()
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as ocr from '../dist/examples/ocr/index.js'
import * as record from '../dist/examples/record/index.js'
import * as aiImage from '../dist/examples/ai-image/index.js'
import * as aiVideo from '../dist/examples/ai-video/index.js'
import * as batchVideo from '../dist/examples/batch-video/index.js'
import * as batchAudio from '../dist/examples/batch-audio/index.js'
import * as pdf from '../dist/examples/pdf/index.js'
import * as screenshotsService from '../dist/examples/screenshots/screenshots-service.js'
import * as colorConverter from '../dist/examples/screen-color-picker/converter.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_EXAMPLES_DIR = path.resolve(__dirname, '../src/examples')

/**
 * 模拟挂载真实 Electron 宿主全局环境（用于验证 isRealElectronHost() 为 true 的完整链路）
 */
async function withRealElectronWindow(handlers, fn) {
  const prevWindow = globalThis.window
  const calls = []
  const transportMethods = {}

  for (const [channel, impl] of Object.entries(handlers)) {
    transportMethods[channel] = async envelope => {
      const actualParams =
        envelope && typeof envelope === 'object' && 'params' in envelope && 'messageId' in envelope
          ? envelope.params
          : envelope
      calls.push({ channel, payload: actualParams })
      return impl(actualParams)
    }
  }

  globalThis.window = {
    __ztoolsElectron: {
      transport: {
        methods: transportMethods
      }
    }
  }

  try {
    return await fn(calls)
  } finally {
    if (prevWindow === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = prevWindow
    }
  }
}

// ============================================================================
// P27: ocr
// ============================================================================
test('P27 ocr: 真实宿主队列扫描、OcrPlugin.recognizeImage / captureAndRecognize 剪贴板写入与失败拦截', async () => {
  let clipboardText = ''

  await withRealElectronWindow(
    {
      system_get_path: ({ name }) => (name === 'pictures' ? 'D:\\RealPics' : ''),
      system_search_files: ({ query }) => {
        if (query === 'dir:D:\\RealPics') {
          return {
            files: [
              { name: 'invoice_01.png', path: 'D:\\RealPics\\invoice_01.png', is_dir: false, size: 128000, mtime: 1700000000 }
            ]
          }
        }
        return { files: [] }
      },
      dllplugin_call: ({ plugin, func, params }) => {
        assert.equal(plugin, 'OcrPlugin')
        if (func === 'recognizeImage') {
          return { text: `真实识别内容:${path.win32.basename(params.path)}`, confidence: 99.1, latencyMs: 32 }
        }
        if (func === 'captureAndRecognize') {
          return { text: '屏幕框选识别出的真实文字 2026', confidence: 98.5 }
        }
        throw new Error(`Unexpected func: ${func}`)
      },
      clipboard_copy_text: ({ text }) => {
        clipboardText = text
        return true
      }
    },
    async () => {
      // 1. 仅 1 张真实图片时严禁拼接 INITIAL_OCR_QUEUE_ITEMS
      const snapshot = await ocr.fetchOcrQueueSnapshot()
      assert.equal(snapshot.length, 1)
      assert.equal(snapshot.items.length, 1)
      assert.equal(snapshot[0].path, 'D:\\RealPics\\invoice_01.png')

      // 2. 批量 OCR 识别并写入真实剪贴板
      const batchRes = await ocr.executeBatchOcr(snapshot.items, {
        languageModelId: 'ocr-ch-en-v4',
        layoutStrategy: 'natural_paragraph',
        postAction: 'copy_clipboard',
        filterStampNoise: true
      })
      assert.equal(batchRes.ok, true)
      assert.equal(batchRes.recognizedCount, 1)
      assert.equal(batchRes.combinedText, '真实识别内容:invoice_01.png')
      assert.equal(clipboardText, '真实识别内容:invoice_01.png')

      // 3. 截屏框选 OCR 识别并写入剪贴板（绝不包含 EACCES 假报错文本）
      const capRes = await ocr.captureScreenAreaOcr()
      assert.equal(capRes.ok, true)
      assert.equal(capRes.text, '屏幕框选识别出的真实文字 2026')
      assert.ok(!capRes.text.includes('EACCES'), '严禁返回 EACCES 假报错文本')
      assert.equal(clipboardText, '屏幕框选识别出的真实文字 2026')
    }
  )

  // 4. 异常测试：真实宿主下 OcrPlugin 失败时如实返回 ok: false，绝不把文件名拼成假识别结果
  await withRealElectronWindow(
    {
      dllplugin_call: () => {
        throw new Error('ONNX_MODEL_LOAD_FAILED')
      }
    },
    async () => {
      const failBatch = await ocr.executeBatchOcr(
        [
          {
            id: '1',
            name: 'broken.png',
            path: 'D:\\RealPics\\broken.png',
            parentDir: 'D:\\RealPics',
            extension: '.png',
            sizeBytes: 1024,
            sampleText: '',
            confidencePercent: 0
          }
        ],
        {
          languageModelId: 'ocr-ch-en-v4',
          layoutStrategy: 'natural_paragraph',
          postAction: 'copy_clipboard',
          filterStampNoise: false
        }
      )
      assert.equal(failBatch.ok, false)
      assert.equal(failBatch.combinedText, '')

      const failCap = await ocr.captureScreenAreaOcr()
      assert.equal(failCap.ok, false)
      assert.equal(failCap.text, '')
    }
  )
})

// ============================================================================
// P28: record
// ============================================================================
test('P28 record: 真实宿主录像扫描、RecordPlugin 启停录屏与状态栏联动、失败时严禁返回 rec_sim_', async () => {
  await withRealElectronWindow(
    {
      system_get_path: ({ name }) => (name === 'videos' ? 'D:\\RealVideos' : ''),
      system_search_files: ({ query }) => {
        if (query === 'dir:D:\\RealVideos') {
          return {
            files: [
              { name: 'demo_01.mp4', path: 'D:\\RealVideos\\demo_01.mp4', is_dir: false, size: 10 * 1024 * 1024, mtime: 1700000000 }
            ]
          }
        }
        return { files: [] }
      },
      dllplugin_call: ({ plugin, func }) => {
        assert.equal(plugin, 'RecordPlugin')
        if (func === 'startRecording') {
          return { ok: true, sessionId: 'real_rec_9001', saveDir: 'D:\\RealVideos' }
        }
        if (func === 'stopRecording') {
          return { ok: true, outputPath: 'D:\\RealVideos\\out_9001.mp4' }
        }
        throw new Error(`Unexpected: ${func}`)
      },
      window_show_record_bar: () => ({ ok: true }),
      window_hide_record_bar: () => ({ ok: true })
    },
    async calls => {
      // 1. 仅 1 个真实视频时严禁拼接 INITIAL_RECORDED_VIDEOS
      const ws = await record.fetchRecordWorkspace()
      assert.equal(ws.recordings.length, 1)
      assert.equal(ws.recordings[0].path, 'D:\\RealVideos\\demo_01.mp4')

      // 2. 启动录制与显示录制状态栏
      const startRes = await record.startScreenRecording({
        sourceModeId: 'rec-fullscreen-primary',
        fps: '60',
        codecContainer: 'mp4_h264',
        wasapiLoopback: true,
        micMix: false,
        cursorHighlight: true,
        saveDir: 'D:\\RealVideos'
      })
      assert.equal(startRes.ok, true)
      assert.equal(startRes.sessionId, 'real_rec_9001')
      assert.ok(!startRes.sessionId.startsWith('rec_sim_'))
      assert.ok(calls.some(c => c.channel === 'window_show_record_bar'))

      // 3. 停止录制与隐藏录制状态栏
      const stopRes = await record.stopScreenRecording()
      assert.equal(stopRes.ok, true)
      assert.equal(stopRes.outputPath, 'D:\\RealVideos\\out_9001.mp4')
      assert.ok(calls.some(c => c.channel === 'window_hide_record_bar'))
    }
  )

  // 4. 异常测试：真实宿主下录制引擎不可用时如实返回 ok: false，绝不返回 rec_sim_
  await withRealElectronWindow(
    {
      system_get_path: () => 'D:\\RealVideos',
      dllplugin_call: () => {
        throw new Error('DXGI_DUPLICATION_ACCESS_LOST')
      },
      screen_record_start: () => {
        throw new Error('DXGI_DUPLICATION_ACCESS_LOST')
      }
    },
    async () => {
      const failStart = await record.startScreenRecording({
        sourceModeId: 'rec-fullscreen-primary',
        fps: '60',
        codecContainer: 'mp4_h264',
        wasapiLoopback: true,
        micMix: false,
        cursorHighlight: true
      })
      assert.equal(failStart.ok, false)
      assert.equal(failStart.sessionId, '')
      assert.match(failStart.error, /DXGI_DUPLICATION_ACCESS_LOST/)
    }
  )
})

// ============================================================================
// P29: ai-image
// ============================================================================
test('P29 ai-image: 真实宿主扫描、AiImagePlugin.processImage 真实输出体积读取与异常拦截', async () => {
  await withRealElectronWindow(
    {
      system_get_path: ({ name }) => (name === 'pictures' ? 'D:\\RealImages' : ''),
      system_search_files: ({ query }) => {
        if (query === 'dir:D:\\RealImages') {
          return {
            files: [
              { name: 'photo.png', path: 'D:\\RealImages\\photo.png', is_dir: false, size: 500000, mtime: 1700000000 }
            ]
          }
        }
        return { files: [] }
      },
      dllplugin_call: ({ plugin, func, params }) => {
        assert.equal(plugin, 'AiImagePlugin')
        assert.equal(func, 'processImage')
        return {
          ok: true,
          outputPath: `${params.outputDir}\\photo_2x.png`
        }
      },
      filesystem_get_file_size: ({ path: targetPath }) => {
        if (targetPath === 'D:\\RealImages\\photo_2x.png') {
          return 1480000
        }
        return 0
      },
      filesystem_stat: ({ path: targetPath }) => {
        if (targetPath === 'D:\\RealImages\\photo_2x.png') {
          return { size: 1480000 }
        }
        return { size: 0 }
      }
    },
    async () => {
      const queue = await aiImage.fetchAiImageQueue()
      assert.equal(queue.files.length, 1, '真实宿主下严禁拼接 INITIAL_AI_IMAGE_FILES')

      const batchRes = await aiImage.executeAiImageBatch(queue.files, {
        engineId: 'realesrgan-x4plus',
        scaleFactor: '2x',
        denoiseStrength: 'standard',
        outputFormat: 'png',
        gpuAccel: true
      })
      assert.equal(batchRes.ok, true)
      assert.equal(batchRes.processedCount, 1)
      assert.equal(batchRes.totalOutputBytes, 1480000)
      assert.equal(batchRes.outputs[0].sizeBytes, 1480000)
    }
  )

  // 异常与安全拦截测试
  const secRes = await aiImage.executeAiImageBatch(
    [
      {
        id: '1',
        name: 'cmd.png',
        path: 'C:\\Windows\\System32\\cmd.png',
        parentDir: 'C:\\Windows\\System32',
        extension: '.png',
        sizeBytes: 1024,
        width: 100,
        height: 100
      }
    ],
    {
      engineId: 'realesrgan-x4plus',
      scaleFactor: '2x',
      denoiseStrength: 'standard',
      outputFormat: 'png'
    }
  )
  assert.equal(secRes.ok, false)
  assert.match(secRes.error, /SECURITY_INTERCEPTED/)

  // 真实宿主下引擎报错时如实返回 ok: false
  await withRealElectronWindow(
    {
      dllplugin_call: () => {
        throw new Error('VULKAN_DEVICE_LOST')
      }
    },
    async () => {
      const failRes = await aiImage.executeAiImageBatch(
        [
          {
            id: '1',
            name: 'photo.png',
            path: 'D:\\RealImages\\photo.png',
            parentDir: 'D:\\RealImages',
            extension: '.png',
            sizeBytes: 500000,
            width: 1280,
            height: 720
          }
        ],
        {
          engineId: 'realesrgan-x4plus',
          scaleFactor: '2x',
          denoiseStrength: 'standard',
          outputFormat: 'png'
        }
      )
      assert.equal(failRes.ok, false)
      assert.match(failRes.error, /VULKAN_DEVICE_LOST/)
    }
  )
})

// ============================================================================
// P30: ai-video
// ============================================================================
test('P30 ai-video: 真实宿主扫描、AiVideoPlugin.enhanceVideo 真实文件校验与无产出拦截', async () => {
  await withRealElectronWindow(
    {
      system_get_path: ({ name }) => (name === 'videos' ? 'D:\\RealClips' : ''),
      system_search_files: ({ query }) => {
        if (query === 'dir:D:\\RealClips') {
          return {
            files: [
              { name: 'clip.mp4', path: 'D:\\RealClips\\clip.mp4', is_dir: false, size: 8000000, mtime: 1700000000 }
            ]
          }
        }
        return { files: [] }
      },
      dllplugin_call: ({ plugin, func }) => {
        assert.equal(plugin, 'AiVideoPlugin')
        assert.equal(func, 'enhanceVideo')
        return {
          ok: true,
          outputPath: 'D:\\RealClips\\clip_60fps_4k_2160p.mp4',
          sizeBytes: 19500000
        }
      }
    },
    async () => {
      const queue = await aiVideo.fetchAiVideoQueue()
      assert.equal(queue.files.length, 1, '真实宿主下严禁拼接 INITIAL_AI_VIDEO_FILES')

      const res = await aiVideo.executeAiVideoBatch(queue.files, {
        modelId: 'rife-v4-6',
        targetFps: '60fps',
        targetResolution: '4k_2160p',
        videoEncoder: 'hevc_nvenc',
        sceneChangeProtection: true
      })
      assert.equal(res.ok, true)
      assert.equal(res.processedCount, 1)
      assert.equal(res.totalOutputBytes, 19500000)
    }
  )

  // 异常测试：当插件未生成有效文件（sizeBytes === 0）时严禁假报成功
  await withRealElectronWindow(
    {
      dllplugin_call: () => ({ ok: true, outputPath: 'D:\\RealClips\\non_existent.mp4', sizeBytes: 0 }),
      filesystem_get_file_size: () => 0,
      filesystem_stat: () => ({ size: 0 })
    },
    async () => {
      const failRes = await aiVideo.executeAiVideoBatch(
        [
          {
            id: 'v1',
            name: 'clip.mp4',
            path: 'D:\\RealClips\\clip.mp4',
            parentDir: 'D:\\RealClips',
            extension: '.mp4',
            sizeBytes: 8000000,
            sourceFps: 30,
            sourceResolution: '1920×1080'
          }
        ],
        {
          modelId: 'rife-v4-6',
          targetFps: '60fps',
          targetResolution: '4k_2160p',
          videoEncoder: 'hevc_nvenc',
          sceneChangeProtection: true
        }
      )
      assert.equal(failRes.ok, false, '无有效产出文件时严禁假报成功')
    }
  )
})

// ============================================================================
// P31, P32, P33: batch-video, batch-audio, pdf
// ============================================================================
test('P31/P32/P33 batch-video & batch-audio & pdf: 对接 dllplugin_call，真实宿主拒绝 simulated:true 与非对应类型文件充数', async () => {
  await withRealElectronWindow(
    {
      system_get_path: ({ name }) => {
        if (name === 'videos') return 'D:\\Media\\Videos'
        if (name === 'music') return 'D:\\Media\\Music'
        if (name === 'documents') return 'D:\\Media\\Docs'
        return ''
      },
      system_search_files: ({ query }) => {
        if (query === 'dir:D:\\Media\\Videos') {
          // 目录下只有 .txt 文件，无视频文件：batch-video 绝不可把 .txt 当成视频返回
          return {
            files: [
              { name: 'notes.txt', path: 'D:\\Media\\Videos\\notes.txt', is_dir: false, size: 2048, mtime: 1700000000 }
            ]
          }
        }
        if (query === 'dir:D:\\Media\\Music') {
          return {
            files: [
              { name: 'readme.md', path: 'D:\\Media\\Music\\readme.md', is_dir: false, size: 1024, mtime: 1700000000 },
              { name: 'song.flac', path: 'D:\\Media\\Music\\song.flac', is_dir: false, size: 24000000, mtime: 1700000000 }
            ]
          }
        }
        if (query === 'dir:D:\\Media\\Docs') {
          return {
            files: [
              { name: 'arch.pdf', path: 'D:\\Media\\Docs\\arch.pdf', is_dir: false, size: 640000, mtime: 1700000000 }
            ]
          }
        }
        return { files: [] }
      },
      dllplugin_call: ({ plugin, func, params }) => {
        return { executed: true, plugin, func, inputPath: params.inputPath }
      }
    },
    async () => {
      // 1. batch-video 目录无视频时应返回 0 项，严禁回退扫描 .txt 充当视频，严禁拼接 INITIAL_SAMPLE_VIDEOS
      const vidQueue = await batchVideo.scanLocalVideoQueue()
      assert.equal(vidQueue.files.length, 0)

      // 2. batch-audio 只返回 .flac，过滤 .md，且不拼接 INITIAL_SAMPLE_AUDIOS
      const audQueue = await batchAudio.scanLocalAudioQueue()
      assert.equal(audQueue.files.length, 1)
      assert.equal(audQueue.files[0].name, 'song.flac')

      // 3. pdf 只返回真实扫描到的 1 份文档，不拼接 INITIAL_SAMPLE_PDFS
      const pdfQueue = await pdf.scanLocalPdfQueue()
      assert.equal(pdfQueue.files.length, 1)
      assert.equal(pdfQueue.files[0].name, 'arch.pdf')

      // 4. invokeNativeCapability 走真实 dllplugin_call 通道
      const vRes = await batchVideo.invokeNativeCapability('BatchCompressVideo', { crf: 23, inputPath: 'D:\\Media\\a.mp4' })
      assert.equal(vRes.ok, true)
      assert.equal(vRes.fromFallback, false)
      assert.equal(vRes.data.plugin, 'BatchVideoPlugin')

      const aRes = await batchAudio.invokeNativeCapability('BatchLoudnorm', { targetI: -16, inputPath: 'D:\\Media\\song.flac' })
      assert.equal(aRes.ok, true)
      assert.equal(aRes.fromFallback, false)
      assert.equal(aRes.data.plugin, 'BatchAudioPlugin')

      const pRes = await pdf.invokeNativeCapability('PdfToWord', { format: 'docx', inputPath: 'D:\\Media\\Docs\\arch.pdf' })
      assert.equal(pRes.ok, true)
      assert.equal(pRes.fromFallback, false)
      assert.equal(pRes.data.plugin, 'PdfPlugin')
    }
  )

  // 5. 异常测试：真实宿主下 dllplugin_call 失败时，三者均必须返回 ok: false，严禁返回 simulated: true
  await withRealElectronWindow(
    {
      dllplugin_call: () => {
        throw new Error('FFMPEG_BINARY_MISSING')
      }
    },
    async () => {
      const vFail = await batchVideo.invokeNativeCapability('BatchCompressVideo', { crf: 23 })
      assert.equal(vFail.ok, false)
      assert.equal(vFail.data?.simulated, undefined)

      const aFail = await batchAudio.invokeNativeCapability('BatchLoudnorm', { targetI: -16 })
      assert.equal(aFail.ok, false)
      assert.equal(aFail.data?.simulated, undefined)

      const pFail = await pdf.invokeNativeCapability('PdfToWord', { format: 'docx' })
      assert.equal(pFail.ok, false)
      assert.equal(pFail.data?.simulated, undefined)
    }
  )
})

// ============================================================================
// P34: screenshots
// ============================================================================
test('P34 screenshots: 真实 PNG/GIF/BMP 文件头尺寸解析、真实剪贴板回贴/复制与 OcrPlugin 识别（清零假 OCR 文本）', async () => {
  // 1. 构造真实 320x180 PNG 头部字节流并验证 parseImageDimensionsFromBytes
  const pngHeader = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x01, 0x40, // width = 320
    0x00, 0x00, 0x00, 0xb4  // height = 180
  ])
  const parsedDims = screenshotsService.parseImageDimensionsFromBytes(pngHeader)
  assert.deepEqual(parsedDims, { width: 320, height: 180 })

  const pngBase64 = Buffer.from(pngHeader).toString('base64')
  let copiedText = ''

  await withRealElectronWindow(
    {
      screenshots_scan: () => [
        {
          id: 'ss-real-1',
          filename: 'capture_real.png',
          path: 'D:\\RealShots\\capture_real.png',
          sizeBytes: 64000,
          modifiedAt: 1700000005000
        }
      ],
      filesystem_read_file: ({ path: p }) => {
        if (p === 'D:\\RealShots\\capture_real.png') return pngBase64
        return ''
      },
      clipboard_hide_and_paste_file: ({ filePath }) => {
        assert.equal(filePath, 'D:\\RealShots\\capture_real.png')
        return { ok: true }
      },
      clipboard_copy_file: ({ filePath }) => {
        assert.equal(filePath, 'D:\\RealShots\\capture_real.png')
        return { ok: true }
      },
      dllplugin_call: ({ plugin, func, params }) => {
        assert.equal(plugin, 'OcrPlugin')
        assert.equal(func, 'recognizeImage')
        assert.equal(params.path, 'D:\\RealShots\\capture_real.png')
        return { text: '截图中的真实报错信息: ECONNREFUSED 127.0.0.1:8080' }
      },
      clipboard_copy_text: ({ text }) => {
        copiedText = text
        return true
      }
    },
    async calls => {
      const mgr = new screenshotsService.ScreenshotsManager()
      const list = await mgr.loadScreenshots(true)
      assert.equal(list.length, 1)
      const shot = list[0]

      // 校验从 PNG 头部解析出的真实尺寸 320x180
      assert.equal(shot.width, 320)
      assert.equal(shot.height, 180)
      // 校验未执行 OCR 前绝不包含 `系统自动提取文件文本` 假文案
      assert.ok(!shot.ocrText.includes('系统自动提取文件文本'))
      assert.equal(shot.ocrText, '')

      // 校验 pasteToActiveWindow 调用 clipboard_hide_and_paste_file
      const pasteRes = await mgr.pasteToActiveWindow(shot)
      assert.equal(pasteRes.success, true)
      assert.ok(calls.some(c => c.channel === 'clipboard_hide_and_paste_file'))

      // 校验 copyImageToClipboard 调用 clipboard_copy_file
      const copyRes = await mgr.copyImageToClipboard(shot)
      assert.equal(copyRes.success, true)
      assert.ok(calls.some(c => c.channel === 'clipboard_copy_file'))

      // 校验 extractOcr 调用 OcrPlugin.recognizeImage 并写入剪贴板
      const ocrText = await mgr.extractOcr(shot)
      assert.equal(ocrText, '截图中的真实报错信息: ECONNREFUSED 127.0.0.1:8080')
      assert.equal(copiedText, '截图中的真实报错信息: ECONNREFUSED 127.0.0.1:8080')
    }
  )

  // 异常测试：真实宿主下 OcrPlugin 失败时 extractOcr 必须抛出异常，严禁伪造文本
  await withRealElectronWindow(
    {
      dllplugin_call: () => {
        throw new Error('OCR_SERVICE_DOWN')
      }
    },
    async () => {
      const mgr = new screenshotsService.ScreenshotsManager()
      await assert.rejects(
        () =>
          mgr.extractOcr({
            id: 'ss-1',
            filename: 'test.png',
            path: 'D:\\RealShots\\test.png',
            width: 100,
            height: 100,
            dimensions: '100 x 100',
            sizeBytes: 1000,
            formattedSize: '1 KB',
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            formattedDate: '刚刚',
            pinned: false,
            ocrText: '',
            ocrStatus: 'pending',
            thumbnailSvg: ''
          }),
        /OCR_SERVICE_DOWN/
      )
    }
  )
})

// ============================================================================
// P35: color-picker
// ============================================================================
test('P35 color-picker: 结合 screen_get_cursor_pos 与 ColorPickerPlugin.pickScreenPixel 取色，异常如实报错且零 Math.random()', async () => {
  // 1. 源码级断言：converter.ts 中严禁出现 Math.random()
  const converterSrc = fs.readFileSync(path.join(SRC_EXAMPLES_DIR, 'screen-color-picker/converter.ts'), 'utf8')
  assert.ok(!converterSrc.includes('Math.random('), 'screen-color-picker/converter.ts 中严禁使用 Math.random() 生成随机假颜色')

  // 2. 真实宿主链路测试：获取光标位置 (512, 384) 并调用 ColorPickerPlugin.pickScreenPixel
  await withRealElectronWindow(
    {
      screen_get_cursor_pos: () => ({ x: 512, y: 384 }),
      dllplugin_call: ({ plugin, func, params }) => {
        assert.equal(plugin, 'ColorPickerPlugin')
        assert.equal(func, 'pickScreenPixel')
        assert.equal(params.x, 512)
        assert.equal(params.y, 384)
        return { r: 48, g: 209, b: 88, x: 512, y: 384 }
      }
    },
    async () => {
      const picked = await colorConverter.pickScreenColor()
      assert.equal(picked.source, 'native')
      assert.equal(picked.hex, '#30D158')
      assert.deepEqual(picked.rgb, { r: 48, g: 209, b: 88 })
      assert.equal(picked.x, 512)
      assert.equal(picked.y, 384)
    }
  )

  // 3. 异常边界测试：真实宿主下取色失败或无权限时必须抛出异常，严禁静默降级返回随机颜色
  await withRealElectronWindow(
    {
      screen_get_cursor_pos: () => ({ x: 100, y: 100 }),
      dllplugin_call: () => {
        throw new Error('GDI_GETPIXEL_FAILED')
      },
      screen_pick_color: () => {
        throw new Error('GDI_GETPIXEL_FAILED')
      },
      screen_capture: () => {
        throw new Error('GDI_GETPIXEL_FAILED')
      }
    },
    async () => {
      await assert.rejects(() => colorConverter.pickScreenColor(), /GDI_GETPIXEL_FAILED/)
    }
  )
})
