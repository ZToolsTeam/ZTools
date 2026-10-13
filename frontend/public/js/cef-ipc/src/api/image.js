/**
 * Image API - 图片处理
 * 通过 ImagePlugin DLL 插件实现（基于 Image32 库）
 * 所有图片处理函数均通过异步调用执行，不阻塞 CEF 主线程
 */
class ImageAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 异步调用 DLL 插件函数（内部方法）
   * 通过 callAsync + waitTask 实现非阻塞调用，避免大图处理时冻结 UI
   * @private
   * @param {string} funcName - DLL 函数名
   * @param {Object} params - 函数参数
   * @param {number} [pollInterval=200] - 轮询间隔（ms）
   * @returns {Promise<Object>} DLL 返回的 JSON 结果
   */
  async _callAsync(funcName, params, pollInterval = 200) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const api = this._referenceAPI ??= new ReferenceImageAPI(this.transport)
      switch (funcName) {
        case 'ImageToBase64':
          if (params.format !== undefined) throw Object.assign(new Error('引用编码保留原始PNG/JPEG格式'), { code: 'INVALID_REQUEST' })
          return { result: await api.imageToBase64(params.input) }
        case 'Base64ToImage': await api.base64ToImage(params.input, params.output, params.format); break
        case 'GetInfo': return { result: await api.getInfo(params.path) }
        case 'Convert': await api.convert(params.input, params.output, params.format, params.quality ?? 85); break
        case 'Resize': await api.resize(params.input, params.output, params.width, params.height,
          { keepAspectRatio: params.keepAspectRatio, ...(params.quality !== undefined ? { quality: params.quality } : {}) }); break
        case 'Scale': await api.scale(params.input, params.output, params.scaleX / 100, params.scaleY / 100); break
        case 'Crop': await api.crop(params.input, params.output, { x: params.x, y: params.y, width: params.width, height: params.height }); break
        case 'Rotate': await api.rotate(params.input, params.output, params.angle); break
        case 'Flip': await api.flip(params.input, params.output, params.direction); break
        case 'Compress': await api.compress(params.input, params.output, params.quality); break
        default: {
          const error = new Error('此图片方法的跨平台provider尚未实现')
          error.code = 'METHOD_NOT_FOUND'
          throw error
        }
      }
      return { result: true }
    }
    const dllplugin = window.ztools.dllplugin
    const taskId = await dllplugin.callAsync('ImagePlugin', funcName, params)
    let terminalObserved = false
    try {
      const result = await dllplugin.waitTask(taskId, pollInterval, 30_000)
      terminalObserved = true
      return result
    } catch (error) {
      terminalObserved = error?.taskDone === true || error?.workNotStarted === true
      throw error
    } finally {
      if (terminalObserved) {
        try { await dllplugin.clearCallback(taskId, true) }
        catch (error) { console.error('[image] 图片任务清理失败:', error) }
      }
    }
  }

  /** Contract 2 effect preview writes to private cache and returns a read-only FileRef. */
  async preview(input, operation, params = {}, options = {}) {
    if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('当前宿主尚未开放引用预览'), { code: 'NOT_SUPPORTED' })
    return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).preview(input, operation, params, options)
  }

  _unwrapResult(response, operation = '图片处理') {
    if (response == null) {
      throw new Error(`${operation}返回空结果`)
    }
    if (response.error) {
      throw new Error(response.error)
    }
    return response.result !== undefined ? response.result : response
  }

  _isTrueResult(response, operation = '图片处理') {
    const value = this._unwrapResult(response, operation)
    return value === true || value === 'true'
  }

  /**
   * 格式转换
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {string} format - 目标格式 ('png'|'jpg'|'bmp'|'gif'|'webp')
   * @param {number} [quality] - 输出质量 (1-100，可选，默认85)
   * @returns {Promise<boolean>}
   */
  async convert(input, output, format, quality, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).convert(input, output, format, quality ?? 85, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Convert', {
      input,
      output,
      format,
      quality
    })
    return this._isTrueResult(result, '图片格式转换')
  }

  /**
   * 固定尺寸缩放
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} width - 目标宽度
   * @param {number} height - 目标高度
   * @param {Object} options - 缩放选项
   * @param {boolean} [options.keepAspectRatio=true] - 保持宽高比
   * @param {number} [options.quality] - JPEG 输出质量 (1-100)，不传则使用默认值
   * @returns {Promise<boolean>}
   */
  async resize(input, output, width, height, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const api = this._referenceAPI ??= new ReferenceImageAPI(this.transport)
      api._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
      if (width === 0 && Number.isSafeInteger(height) && height > 0 || height === 0 && Number.isSafeInteger(width) && width > 0) {
        const info = await api.getInfo(input, { ...(options.signal ? { signal: options.signal } : {}) })
        if (width === 0) width = Math.max(1, Math.round(info.width * height / info.height))
        else height = Math.max(1, Math.round(info.height * width / info.width))
      }
      await api.resize(input, output, width, height, options)
      return true
    }
    if (Object.keys(options).some(key => !['keepAspectRatio', 'quality'].includes(key))) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const params = {
      input,
      output,
      width,
      height,
      keepAspectRatio: options.keepAspectRatio !== false
    }
    // 透传 quality 参数给 DLL，用于控制 JPEG 输出质量
    if (options.quality != null) {
      params.quality = options.quality
    }
    const result = await this._callAsync('Resize', params)
    return this._isTrueResult(result, '图片缩放')
  }

  /**
   * 按百分比缩放
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} scaleX - 水平缩放比例 (0.1-5.0)
   * @param {number} scaleY - 垂直缩放比例 (0.1-5.0)
   * @returns {Promise<boolean>}
   */
  async scale(input, output, scaleX, scaleY = scaleX, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).scale(input, output, scaleX, scaleY, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Scale', {
      input,
      output,
      scaleX: scaleX * 100, // 转换为百分比
      scaleY: scaleY * 100
    })
    return this._isTrueResult(result, '图片按比例缩放')
  }

  /**
   * 自由裁剪
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {Object} rect - 裁剪区域 {x, y, width, height}
   * @returns {Promise<boolean>}
   */
  async crop(input, output, rect, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).crop(input, output, rect, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Crop', {
      input,
      output,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    })
    return this._isTrueResult(result, '图片裁剪')
  }

  /**
   * 旋转图片
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} angle - 旋转角度 (90, 180, 270 或任意角度)
   * @returns {Promise<boolean>}
   */
  async rotate(input, output, angle, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).rotate(input, output, angle, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Rotate', {
      input,
      output,
      angle
    })
    return this._isTrueResult(result, '图片旋转')
  }

  /**
   * 翻转图片
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {string} direction - 翻转方向 ('horizontal'|'vertical')
   * @returns {Promise<boolean>}
   */
  async flip(input, output, direction = 'horizontal', options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).flip(input, output, direction, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Flip', {
      input,
      output,
      direction
    })
    return this._isTrueResult(result, '图片翻转')
  }

  /**
   * 压缩图片（仅JPG格式支持质量压缩）
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} quality - 质量 (0-100，仅对JPG有效)
   * @returns {Promise<boolean>}
   */
  async compress(input, output, quality = 85, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).compress(input, output, quality, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Compress', {
        input,
        output,
        quality
      }
    )
    return this._isTrueResult(result, '图片压缩')
  }

  /**
   * PNG无损压缩
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} compressionLevel - 压缩级别 (0-9，默认6)
   * @param {boolean} preserveAlpha - 是否保留透明通道 (默认true)
   * @returns {Promise<boolean>}
   */
  async compressPNG(input, output, compressionLevel = 6, preserveAlpha = true) {
    const result = await this._callAsync('CompressPNG', {
        input,
        output,
        compressionLevel,
        preserveAlpha
      }
    )
    return this._isTrueResult(result, 'PNG 压缩')
  }

  /**
   * PNG有损压缩 (使用pngquant算法)
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {number} quality - 质量 (0-100，100为无损，推荐65-80)
   * @returns {Promise<boolean>}
   */
  async compressPNGLossy(input, output, quality = 80) {
    const result = await this._callAsync('CompressPNGLossy', {
        input,
        output,
        quality
      }
    )
    return this._isTrueResult(result, 'PNG 有损压缩')
  }

  /**
   * 添加图片水印
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {string} watermark - 水印图片路径
   * @param {Object} options - 水印选项
   * @param {string} [options.position='center'] - 位置 ('center'|'top-left'|'top-right'|'bottom-left'|'bottom-right')
   * @param {number} [options.opacity=255] - 透明度 (0-255)
   * @returns {Promise<boolean>}
   */
  async watermark(input, output, watermark, options = {}) {
    const result = await this._callAsync('Watermark', {
        input,
        output,
        watermark,
        position: options.position || 'center',
        opacity: Math.round((options.opacity ?? 1.0) * 255) // 转换为0-255范围
      }
    )
    return this._isTrueResult(result, '图片水印')
  }

  /**
   * 添加文字标注
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {string} text - 文字内容
   * @param {Object} options - 文字选项
   * @param {number} [options.x=10] - X坐标
   * @param {number} [options.y=10] - Y坐标
   * @param {string} [options.fontName='Arial'] - 字体名称
   * @param {number} [options.fontSize=24] - 字体大小
   * @param {string|number} [options.color='#000000'] - 文字颜色
   * @returns {Promise<boolean>}
   */
  async textOut(input, output, text, options = {}) {
    // TextOut 使用 Delphi TColor（BGR 格式），需要将 RGB 转为 BGR
    const rgbColor = this._colorToInt(options.color || '#000000')
    const r = (rgbColor >> 16) & 0xff
    const g = (rgbColor >> 8) & 0xff
    const b = rgbColor & 0xff
    const bgrColor = (b << 16) | (g << 8) | r

    const result = await this._callAsync('TextOut', {
        input,
        output,
        text,
        x: options.x || 10,
        y: options.y || 10,
        fontName: options.fontName || 'Arial',
        fontSize: options.fontSize || 24,
        color: bgrColor
      }
    )
    return this._isTrueResult(result, '图片文字标注')
  }

  /**
   * 图像拼接
   * @param {string[]} images - 要拼接的图片路径数组
   * @param {string} output - 输出文件路径
   * @param {string} direction - 拼接方向 ('horizontal'|'vertical')
   * @returns {Promise<boolean>}
   */
  async concat(images, output, direction = 'horizontal') {
    const result = await this._callAsync('Concat', {
      images: images.join(','),
      output,
      direction
    })
    return this._isTrueResult(result, '图片拼接')
  }

  /**
   * 添加边框
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {Object} options - 边框选项
   * @param {number} [options.borderWidth=10] - 边框宽度(px)
   * @param {number} [options.padding=5] - 内边距(px)
   * @param {string|number} [options.borderColor='#000000'] - 边框颜色
   * @param {string|number} [options.backgroundColor='#ffffff'] - 背景颜色
   * @param {number} [options.opacity=1.0] - 边框不透明度(0-1)
   * @returns {Promise<boolean>}
   */
  async addBorder(input, output, options = {}) {
    const result = await this._callAsync('AddBorder', {
        input,
        output,
        borderWidth: options.borderWidth ?? 10,
        padding: options.padding ?? 5,
        borderColor: this._colorToInt(options.borderColor ?? '#000000'),
        backgroundColor: this._colorToInt(options.backgroundColor ?? '#ffffff'),
        opacity: Math.round((options.opacity ?? 1.0) * 255)
      }
    )
    return this._isTrueResult(result, '图片边框')
  }

  /**
   * 设置圆角
   * @param {string} input - 输入文件路径
   * @param {string} output - 输出文件路径
   * @param {Object} options - 圆角选项
   * @param {number} [options.radius=20] - 统一圆角半径(px)
   * @param {number} [options.radiusLT] - 左上角圆角半径(px)
   * @param {number} [options.radiusRT] - 右上角圆角半径(px)
   * @param {number} [options.radiusLB] - 左下角圆角半径(px)
   * @param {number} [options.radiusRB] - 右下角圆角半径(px)
   * @param {string|number} [options.backgroundColor='#ffffff'] - 背景颜色
   * @returns {Promise<boolean>}
   */
  async roundCorners(input, output, options = {}) {
    const result = await this._callAsync('RoundCorners', {
        input,
        output,
        radius: options.radius ?? 20,
        radiusLT: options.radiusLT ?? -1,
        radiusRT: options.radiusRT ?? -1,
        radiusLB: options.radiusLB ?? -1,
        radiusRB: options.radiusRB ?? -1,
        backgroundColor: this._colorToInt(options.backgroundColor ?? '#ffffff')
      }
    )
    return this._isTrueResult(result, '图片圆角')
  }

  /**
   * 图片转PDF
   * @param {string[]} images - 要转换的图片路径数组（顺序即PDF页顺序）
   * @param {string} output - 输出PDF文件路径
   * @returns {Promise<boolean>}
   */
  async previewGIF(images, options = {}) {
    if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('GIF预览需要引用图片处理器'), { code: 'NOT_SUPPORTED' })
    return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).previewGIF(images, options)
  }
  async imagesToGIF(images, output, options = {}) {
    if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('真实GIF编码需要引用图片处理器'), { code: 'NOT_SUPPORTED' })
    await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imagesToGIF(images, output, options)
    return true
  }

  async imagesToPDF(images, output, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) { await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imagesToPDF(images, output, options); return true }
    if (Object.keys(options).length) { const error = new Error('当前图片桥不支持新增PDF请求选项'); error.code = 'NOT_SUPPORTED'; throw error }
    const result = await this._callAsync('ImagesToPDF', {
        images: images.join(','),
        output
      }
    )
    return this._isTrueResult(result, '图片转 PDF')
  }

  /**
   * 生成二维码
   * @param {string} text - 要编码的文本内容
   * @param {string} output - 输出图片路径
   * @param {Object} options - 生成选项
   * @param {number} [options.size=256] - 二维码尺寸 (像素)
   * @returns {Promise<boolean>}
   */
  async generateQR(text, output, options = {}) {
    const result = await this._callAsync('GenerateQR', {
        text,
        output,
        size: options.size || 256
      }
    )
    return this._isTrueResult(result, '二维码生成')
  }

  /**
   * 解码二维码
   * @param {string} input - 包含二维码的图片路径
   * @returns {Promise<string>} 解码结果文本
   */
  async decodeQR(input) {
    const result = await this._callAsync('DecodeQR', {
        input
      }
    )
    return this._unwrapResult(result, '二维码解码')
  }

  /**
   * SVG转PNG
   * @param {string} input - 输入SVG文件路径
   * @param {string} output - 输出PNG文件路径
   * @param {number} width - 目标宽度
   * @param {number} height - 目标高度
   * @param {boolean} [keepAspectRatio=true] - 保持宽高比
   * @returns {Promise<boolean>}
   */
  async svgToPng(input, output, width, height, keepAspectRatio = true) {
    const result = await this._callAsync('SvgToPng', {
        input,
        output,
        width,
        height,
        keepAspectRatio
      }
    )
    return this._isTrueResult(result, 'SVG 转 PNG')
  }

  /**
   * 获取图片信息
   * @param {string} path - 图片路径
   * @returns {Promise<Object>} {width, height, format, size}
   */
  async getInfo(path, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).getInfo(path, options)
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('GetInfo', {
        path
      }
    )
    return this._unwrapResult(result, '获取图片信息')
  }

  /**
   * 读取图片为 Data URL（用于前端显示）
   * ⚠️ 推荐使用 ztools.protocol.readFileAsDataURL() 代替，性能更好
   * @deprecated 使用 ztools.protocol.readFileAsDataURL(path) 代替
   * @param {string} path - 图片路径
   * @returns {Promise<string>} Data URL
   */
  async readAsDataURL(path) {
    try {
      // 新方案：使用 ztools:// 协议，性能提升3-10倍
      if (window.ztools && window.ztools.protocol) {
        return await window.ztools.protocol.readFileAsDataURL(path)
      }

      // 向后兼容：旧方案（Base64传输）
      const binaryData = await window.ztools.fs.readFileAsBinary(path)
      const mimeType = await this._getMimeType(path)
      const uint8Array = new Uint8Array(binaryData)
      const btoaData = uint8Array.reduce(
        (acc, i) => (acc += String.fromCharCode.apply(null, [i])),
        ''
      )
      const base64 = btoa(btoaData)
      return `data:${mimeType};base64,${base64}`
    } catch (error) {
      console.error('[image.readAsDataURL] 读取图片失败:', error)
      throw error
    }
  }

  /**
   * 读取图片为 Blob（用于前端处理）
   * ⚠️ 推荐使用 ztools.protocol.readFileAsBlob() 代替，性能更好
   * @deprecated 使用 ztools.protocol.readFileAsBlob(path) 代替
   * @param {string} path - 图片路径
   * @returns {Promise<Blob>} Blob 对象
   */
  async readAsBlob(path) {
    try {
      // 新方案：使用 ztools:// 协议，性能提升3-10倍
      if (window.ztools && window.ztools.protocol) {
        return await window.ztools.protocol.readFileAsBlob(path)
      }

      // 向后兼容：旧方案（Base64传输）
      console.log('[image.readAsBlob] 开始读取:', path)
      const binaryData = await window.ztools.fs.readFileAsBinary(path)
      console.log('[image.readAsBlob] 读取完成，二进制长度:', binaryData.length)

      const mimeType = await this._getMimeType(path)
      console.log('[image.readAsBlob] MIME类型:', mimeType)

      console.log('[image.readAsBlob] 开始创建Blob...')
      const blob = new Blob([binaryData], { type: mimeType })
      console.log('[image.readAsBlob] Blob创建成功，大小:', blob.size)

      return blob
    } catch (error) {
      console.error('[image.readAsBlob] 读取图片失败:', error)
      throw error
    }
  }

  /**
   * 读取大图片为 Blob（支持进度回调）
   * 推荐用于大文件读取，可以实时显示加载进度
   *
   * @param {string} path - 图片路径
   * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
   * @returns {Promise<Blob>} Blob 对象
   *
   * @example
   * const blob = await ztools.image.readAsBlobWithProgress(
   *   'C:/large-photo.jpg',
   *   (loaded, total) => {
   *     const percent = (loaded / total * 100).toFixed(2)
   *     console.log(`加载进度: ${percent}%`)
   *     updateProgressBar(percent)
   *   }
   * )
   * const url = URL.createObjectURL(blob)
   * document.querySelector('img').src = url
   */
  async readAsBlobWithProgress(path, onProgress) {
    try {
      // 使用 ztools:// 协议的进度读取
      if (window.ztools && window.ztools.protocol) {
        return await window.ztools.protocol.readFileAsBlobWithProgress(
          path,
          onProgress
        )
      }

      // 降级：使用旧方案（无进度支持）
      console.warn(
        '[image.readAsBlobWithProgress] ztools.protocol 不可用，降级为无进度读取'
      )
      return await this.readAsBlob(path)
    } catch (error) {
      console.error('[image.readAsBlobWithProgress] 读取图片失败:', error)
      throw error
    }
  }

  /**
   * 读取大图片为 Data URL（支持进度回调）
   * ⚠️ 注意：Data URL 会将文件编码为 Base64，大文件不推荐使用
   *
   * @param {string} path - 图片路径
   * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
   * @returns {Promise<string>} Data URL
   *
   * @example
   * const dataUrl = await ztools.image.readAsDataURLWithProgress(
   *   'C:/large-photo.jpg',
   *   (loaded, total) => {
   *     const percent = Math.round(loaded / total * 100)
   *     progressElement.textContent = `${percent}%`
   *   }
   * )
   * document.querySelector('img').src = dataUrl
   */
  async readAsDataURLWithProgress(path, onProgress) {
    try {
      // 使用 ztools:// 协议的进度读取
      if (window.ztools && window.ztools.protocol) {
        return await window.ztools.protocol.readFileAsDataURLWithProgress(
          path,
          onProgress
        )
      }

      // 降级：使用旧方案（无进度支持）
      console.warn(
        '[image.readAsDataURLWithProgress] ztools.protocol 不可用，降级为无进度读取'
      )
      return await this.readAsDataURL(path)
    } catch (error) {
      console.error('[image.readAsDataURLWithProgress] 读取图片失败:', error)
      throw error
    }
  }

  /**
   * 图片转BASE64（已改为返回文件路径，避免通过CEF传递Base64数据）
   * ⚠️ 新方案：返回文件路径，前端使用 ztools.protocol.fileUrl() 获取图片URL
   *
   * @param {string} input - 输入文件路径
   * @param {string} [format] - 输出格式 ('png'|'jpg'|'bmp'|'gif')，不指定则从文件扩展名推断
   * @returns {Promise<Object>} {filePath, mimeType}
   *
   * @example
   * // 获取图片路径信息
   * const { filePath, mimeType } = await ztools.image.imageToBase64('C:/photo.jpg')
   * // 方式1: 使用 ztools:// 协议（推荐，高性能）
   * const imgUrl = ztools.protocol.fileUrl(filePath)
   * document.querySelector('img').src = imgUrl
   * // 方式2: 读取为 Data URL
   * const dataUrl = await ztools.protocol.readFileAsDataURL(filePath)
   * document.querySelector('img').src = dataUrl
   */
  async imageToBase64(input, format, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      if (format !== undefined) throw Object.assign(new Error('引用编码保留原始PNG/JPEG格式'), { code: 'INVALID_REQUEST' })
      return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imageToBase64(input, options)
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('ImageToBase64', {
        input,
        format
      }
    )
    const payload = this._unwrapResult(result, '图片转 Base64')

    // 新方案：返回 {filePath, mimeType}
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload

    // 检查返回格式，向后兼容旧版本
    if (data.filePath) {
      // 新版本：返回文件路径
      return data
    } else if (data.base64) {
      // 旧版本：返回 Base64（不推荐）
      console.warn(
        '[image.imageToBase64] 检测到旧版本返回格式，建议升级 ImagePlugin'
      )
      return data
    }

    return data
  }

  /**
   * BASE64转图片（已改为文件路径转图片，避免通过CEF传递Base64数据）
   * ⚠️ 新方案：接收输入文件路径和输出文件路径
   *
   * @param {string} input - 输入文件路径（新方案）或 BASE64字符串（旧方案，向后兼容）
   * @param {string} output - 输出文件路径
   * @param {string} [format] - 输出格式 ('png'|'jpg'|'bmp'|'gif')，不指定则从文件扩展名推断
   * @returns {Promise<boolean>}
   *
   * @example
   * // 新方案：文件路径转换（推荐）
   * await ztools.image.base64ToImage('C:/input.png', 'C:/output.jpg', 'jpg')
   *
   * // 旧方案：如果前端有 Base64 字符串，需要先保存为临时文件
   * const tempFile = await ztools.sys.getPath('temp') + '/temp_' + Date.now() + '.png'
   * // 先将 Base64 写入临时文件（使用 fs API）
   * await ztools.fs.writeFile(tempFile, base64Data, { encoding: 'base64' })
   * // 再调用此函数转换格式
   * await ztools.image.base64ToImage(tempFile, output, format)
   */
  async base64ToImage(input, output, format, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).base64ToImage(input, output, format, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
    const result = await this._callAsync('Base64ToImage', {
        input, // 新方案：传入文件路径
        output,
        format
      }
    )
    return this._isTrueResult(result, 'Base64 转图片')
  }

  /**
   * 获取文件 MIME 类型（内部方法）
   * @private
   * @param {string} path - 文件路径
   * @returns {Promise<string>} MIME 类型
   */
  async _getMimeType(path) {
    const extension = path.toLowerCase().split('.').pop()
    const mimeTypes = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      ico: 'image/x-icon',
      svg: 'image/svg+xml'
    }
    return mimeTypes[extension] || 'application/octet-stream'
  }

  /**
   * 颜色转换为整数（内部方法）
   * @private
   * @param {string|number} color - 颜色值
   * @returns {number} 颜色整数值
   */
  _colorToInt(color) {
    if (typeof color === 'number') {
      return color
    }
    if (typeof color === 'string') {
      if (color.startsWith('#')) {
        // 十六进制颜色
        const hex = color.substring(1)
        return parseInt(hex, 16)
      }
      // 颜色名称映射（简化版）
      const colorMap = {
        black: 0x000000,
        white: 0xffffff,
        red: 0xff0000,
        green: 0x00ff00,
        blue: 0x0000ff,
        yellow: 0xffff00,
        cyan: 0x00ffff,
        magenta: 0xff00ff
      }
      return colorMap[color.toLowerCase()] || 0x000000
    }
    return 0x000000
  }
}

export default ImageAPI
