/**
 * OCR API - 文字识别
 * 直接调用服务器 OCR 进行文字识别
 */
class OCRAPI {
  constructor(transport) {
    this.transport = transport
    this.ocrServerUrl = 'http://localhost:8001/api/services/ocr/recognize'
    this.remotePollInterval = 2000
    this.remotePollTimeout = 120000
    this.remoteDllCallTimeout = 60000
  }

  /** Contract 2: local Vision only; never routes through DLL/cloud/token code. */
  recognizeLocal(file, options = {}) {
    return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).recognize(file, options)
  }
  getLocalLanguages(options = {}) {
    return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).languages(options)
  }

  async _withAuthToken(params = {}) {
    const payload = { ...params }
    try {
      if (!payload.token && window.ztools?.user?.getToken) {
        const token = await window.ztools.user.getToken()
        if (token) {
          payload.token = token
        }
      }
    } catch (error) {
      console.warn('[OCR] 获取用户 token 失败，将仅使用本地识别:', error)
    }
    return payload
  }

  /**
   * 单张图片OCR识别
   * @param {Object} params
   * @param {string} params.imagePath - 图片文件路径
   * @param {string} [params.language] - 识别语言
   * @returns {Promise<any>}
   */
  async getOrcRes(params) {
    const payload = await this._withAuthToken(params)
    const result = await window.ztools.dllplugin.call(
      'ImageOcrPlugin',
      'PerformOcr',
      payload,
      { timeout: payload.dllCallTimeout || this.remoteDllCallTimeout }
    )
    return await this._resolveRemoteTaskResult(result, payload)
  }

  /**
   * 批量OCR识别
   * @param {Object} params
   * @param {string[]} params.images - 图片文件路径数组
   * @param {string} [params.outputDir] - 结果输出目录（可选）
   * @returns {Promise<{success: boolean, data: {results: Array, total: number, successCount: number, failCount: number}}>}
   */
  async batchOcr(params) {
    const payload = await this._withAuthToken(params)
    const images = Array.isArray(payload.images) ? payload.images : []
    const results = []
    let successCount = 0
    let failCount = 0

    for (const imagePath of images) {
      const startTime = Date.now()
      try {
        const result = await this.getOrcRes({
          ...payload,
          imagePath
        })
        if (!result?.success) {
          throw new Error(result?.error || '识别失败')
        }
        const text = this._extractTextFromOcrData(result?.data)
        results.push({
          imagePath,
          success: true,
          text,
          data: result?.data,
          engine: result?.engine || 'unknown',
          elapsed: Date.now() - startTime
        })
        successCount++
      } catch (error) {
        results.push({
          imagePath,
          success: false,
          error: error.message || '识别失败',
          elapsed: Date.now() - startTime
        })
        failCount++
      }
    }

    return {
      success: failCount === 0,
      data: {
        results,
        total: images.length,
        successCount,
        failCount
      }
    }
  }

  _extractTextFromOcrData(data) {
    if (!data) return ''
    if (Array.isArray(data.ocr_response)) {
      return data.ocr_response
        .map((item) => (typeof item?.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
    }
    if (typeof data.text === 'string') return data.text
    if (typeof data === 'string') return data
    return ''
  }

  async _callOcrDll(params, timeout) {
    return await window.ztools.dllplugin.call(
      'ImageOcrPlugin',
      'PerformOcr',
      params,
      { timeout: timeout || this.remoteDllCallTimeout }
    )
  }

  async _waitRemoteTask(serialNo, token, options = {}) {
    const timeout = options.timeout || this.remotePollTimeout
    const pollInterval = options.pollInterval || this.remotePollInterval
    const startTime = Date.now()

    while (true) {
      if (timeout > 0 && Date.now() - startTime > timeout) {
        throw new Error('远端OCR任务等待超时')
      }

      const result = await this._callOcrDll(
        {
          serial_no: serialNo,
          token
        },
        options.dllCallTimeout
      )

      if (!result?.success) {
        throw new Error(result?.error || '远端OCR任务失败')
      }
      if (!result?.async || result?.completed) {
        return result
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }
  }

  async _startRemoteDownload(taskResult, token, options = {}) {
    const resultPath =
      taskResult?.data?.result_path ||
      taskResult?.task?.result?.path ||
      (typeof taskResult?.task?.result === 'string' ? taskResult.task.result : '')

    if (!resultPath) {
      throw new Error('远端OCR任务完成但未返回结果路径')
    }

    const result = await this._callOcrDll(
      {
        action: 'startDownload',
        result_path: resultPath,
        serial_no: taskResult?.data?.serial_no,
        token
      },
      options.dllCallTimeout
    )

    if (!result?.success) {
      throw new Error(result?.error || '启动远端OCR结果下载失败')
    }

    const downloadTaskId = result?.data?.download_task_id
    if (!downloadTaskId) {
      throw new Error('远端OCR结果下载未返回任务编号')
    }
    return downloadTaskId
  }

  async _waitRemoteDownload(downloadTaskId, token, options = {}) {
    const timeout = options.timeout || this.remotePollTimeout
    const pollInterval = options.pollInterval || this.remotePollInterval
    const startTime = Date.now()

    while (true) {
      if (timeout > 0 && Date.now() - startTime > timeout) {
        throw new Error('远端OCR结果下载等待超时')
      }

      const result = await this._callOcrDll(
        {
          action: 'pollDownload',
          download_task_id: downloadTaskId,
          token
        },
        options.dllCallTimeout
      )

      if (!result?.success) {
        throw new Error(result?.error || '远端OCR结果下载失败')
      }
      if (result?.completed) {
        return result
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }
  }

  async _getRemoteDownloadResult(downloadTaskId, token, options = {}) {
    const result = await this._callOcrDll(
      {
        action: 'getDownloadResult',
        download_task_id: downloadTaskId,
        token
      },
      options.dllCallTimeout
    )

    if (!result?.success) {
      throw new Error(result?.error || '获取远端OCR结果失败')
    }
    return result
  }

  async _resolveRemoteTaskResult(result, payload) {
    const serialNo = result?.data?.serial_no
    if (!result?.async || !serialNo) {
      return result
    }

    const taskResult = await this._waitRemoteTask(serialNo, payload.token, {
      timeout: payload.timeout,
      pollInterval: payload.pollInterval,
      dllCallTimeout: payload.dllCallTimeout
    })
    if (!taskResult?.requiresDownload) {
      return {
        ...taskResult,
        fallbackReason: result.fallbackReason,
        localError: result.localError
      }
    }

    const downloadTaskId = await this._startRemoteDownload(taskResult, payload.token, {
      dllCallTimeout: payload.dllCallTimeout
    })
    await this._waitRemoteDownload(downloadTaskId, payload.token, {
      timeout: payload.timeout,
      pollInterval: payload.pollInterval,
      dllCallTimeout: payload.dllCallTimeout
    })
    const remoteResult = await this._getRemoteDownloadResult(downloadTaskId, payload.token, {
      dllCallTimeout: payload.dllCallTimeout
    })
    return {
      ...remoteResult,
      fallbackReason: result.fallbackReason,
      localError: result.localError
    }
  }

  /**
   * 调用 OCR 服务器 API（内部方法）
   * @private
   * @param {string} base64Image - Base64编码的图片
   * @param {string} language - 识别语言
   * @returns {Promise<{text: string, blocks: Array}>}
   */
  async _callOCRServer(base64Image, language) {
    try {
      const response = await fetch(this.ocrServerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: base64Image
        })
      })

      if (!response.ok) {
        throw new Error(
          `OCR API 请求失败: ${response.status} ${response.statusText}`
        )
      }

      const result = await response.json()

      // 返回标准格式
      return {
        text: result.text || '',
        blocks: result.blocks || []
      }
    } catch (error) {
      console.error('[OCR] API 调用失败:', error)
      throw new Error(`OCR 识别失败: ${error.message}`)
    }
  }

  /**
   * 从图片识别(Base64 或 URL)
   * @param {string} imageData - Base64编码的图片 或 图片URL
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言：'chi_sim'(简体中文)、'eng'(英文)等
   * @returns {Promise<{text: string, blocks: Array<{text: string, x: number, y: number, width: number, height: number}>}>}
   */
  async fromImage(imageData, options = {}) {
    const { language = 'chi_sim' } = options
    let base64Image = imageData

    // 判断是否为 URL
    if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
      try {
        // 下载图片并转换为 Base64
        const response = await fetch(imageData)
        if (!response.ok) {
          throw new Error(`下载图片失败: ${response.status}`)
        }
        const blob = await response.blob()
        base64Image = await this._blobToBase64(blob)
      } catch (error) {
        throw new Error(`下载图片失败: ${error.message}`)
      }
    }

    return await this._callOCRServer(base64Image, language)
  }

  /**
   * 从屏幕区域识别
   * @param {Object} rect - 屏幕区域
   * @param {number} rect.x - X坐标
   * @param {number} rect.y - Y坐标
   * @param {number} rect.width - 宽度
   * @param {number} rect.height - 高度
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言
   * @returns {Promise<{text: string, blocks: Array}>}
   */
  async fromScreen(rect, options = {}) {
    const { language = 'chi_sim' } = options

    try {
      // 调用 screen.capture 获取截图
      if (!window.ztools || !window.ztools.screen) {
        throw new Error('Screen API 不可用')
      }

      const base64Image = await window.ztools.screen.capture(rect)
      return await this._callOCRServer(base64Image, language)
    } catch (error) {
      throw new Error(`屏幕截图失败: ${error.message}`)
    }
  }

  /**
   * 从文件识别
   * @param {string} filePath - 图片文件路径
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言
   * @returns {Promise<{text: string, blocks: Array}>}
   */
  async fromFile(filePath, options = {}) {
    const { language = 'chi_sim' } = options

    try {
      // 读取文件并转换为 Base64
      if (!window.ztools || !window.ztools.fs) {
        throw new Error('FileSystem API 不可用')
      }

      const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
      const base64Image = this._arrayBufferToBase64(binaryData)

      return await this._callOCRServer(base64Image, language)
    } catch (error) {
      throw new Error(`读取文件失败: ${error.message}`)
    }
  }

  /**
   * Blob 转 Base64（内部方法）
   * @private
   */
  async _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => {
        // 移除 data URL 前缀，只保留 Base64 部分
        const base64 = reader.result.split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * ArrayBuffer/Uint8Array 转 Base64（内部方法）
   * @private
   */
  _arrayBufferToBase64(buffer) {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  // ==================== 表格识别接口 ====================

  /**
   * 调用表格识别 API（内部方法）
   * @private
   * @param {string} base64Image - Base64编码的图片
   * @param {string} language - 识别语言
   * @returns {Promise<{table: Array<Array<string>>}>}
   */
  async _callTableOCRServer(base64Image, language) {
    try {
      const tableUrl = 'http://localhost:8001/api/services/ocr/recognize-table'
      const response = await fetch(tableUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: base64Image,
          language: language
        })
      })

      if (!response.ok) {
        throw new Error(
          `表格识别 API 请求失败: ${response.status} ${response.statusText}`
        )
      }

      const result = await response.json()

      // 返回标准格式
      return {
        table: result.table || [],
        text: result.text || '',
        blocks: result.blocks || []
      }
    } catch (error) {
      console.error('[OCR Table] API 调用失败:', error)
      throw new Error(`表格识别失败: ${error.message}`)
    }
  }

  /**
   * 从图片识别表格
   * @param {string} imageData - Base64编码的图片 或 图片URL
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言
   * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
   */
  async fromImageTable(imageData, options = {}) {
    const { language = 'chi_sim' } = options
    let base64Image = imageData

    // 判断是否为 URL
    if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
      try {
        const response = await fetch(imageData)
        if (!response.ok) {
          throw new Error(`下载图片失败: ${response.status}`)
        }
        const blob = await response.blob()
        base64Image = await this._blobToBase64(blob)
      } catch (error) {
        throw new Error(`下载图片失败: ${error.message}`)
      }
    }

    return await this._callTableOCRServer(base64Image, language)
  }

  /**
   * 从屏幕区域识别表格
   * @param {Object} rect - 屏幕区域
   * @param {number} rect.x - X坐标
   * @param {number} rect.y - Y坐标
   * @param {number} rect.width - 宽度
   * @param {number} rect.height - 高度
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言
   * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
   */
  async fromScreenTable(rect, options = {}) {
    const { language = 'chi_sim' } = options

    try {
      if (!window.ztools || !window.ztools.screen) {
        throw new Error('Screen API 不可用')
      }

      const base64Image = await window.ztools.screen.capture(rect)
      return await this._callTableOCRServer(base64Image, language)
    } catch (error) {
      throw new Error(`屏幕截图失败: ${error.message}`)
    }
  }

  /**
   * 从文件识别表格
   * @param {string} filePath - 图片文件路径
   * @param {Object} [options] - 识别选项
   * @param {string} [options.language='chi_sim'] - 识别语言
   * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
   */
  async fromFileTable(filePath, options = {}) {
    const { language = 'chi_sim' } = options

    try {
      if (!window.ztools || !window.ztools.fs) {
        throw new Error('FileSystem API 不可用')
      }

      const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
      const base64Image = this._arrayBufferToBase64(binaryData)

      return await this._callTableOCRServer(base64Image, language)
    } catch (error) {
      throw new Error(`读取文件失败: ${error.message}`)
    }
  }

  // ==================== 公式识别接口 ====================

  /**
   * 调用公式识别 API（内部方法）
   * @private
   * @param {string} base64Image - Base64编码的图片
   * @returns {Promise<{latex: string, confidence: number}>}
   */
  async _callFormulaOCRServer(base64Image) {
    try {
      const formulaUrl =
        'http://localhost:8001/api/services/ocr/recognize-formula'
      const response = await fetch(formulaUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          image: base64Image
        })
      })

      if (!response.ok) {
        throw new Error(
          `公式识别 API 请求失败: ${response.status} ${response.statusText}`
        )
      }

      const result = await response.json()

      // 返回标准格式
      return {
        latex: result.latex || '',
        confidence: result.confidence || 0,
        raw: result.raw || ''
      }
    } catch (error) {
      console.error('[OCR Formula] API 调用失败:', error)
      throw new Error(`公式识别失败: ${error.message}`)
    }
  }

  /**
   * 从图片识别公式
   * @param {string} imageData - Base64编码的图片 或 图片URL
   * @param {Object} [options] - 识别选项（公式识别暂不支持语言选项）
   * @returns {Promise<{latex: string, confidence: number, raw: string}>}
   */
  async fromImageFormula(imageData, options = {}) {
    let base64Image = imageData

    // 判断是否为 URL
    if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
      try {
        const response = await fetch(imageData)
        if (!response.ok) {
          throw new Error(`下载图片失败: ${response.status}`)
        }
        const blob = await response.blob()
        base64Image = await this._blobToBase64(blob)
      } catch (error) {
        throw new Error(`下载图片失败: ${error.message}`)
      }
    }

    return await this._callFormulaOCRServer(base64Image)
  }

  /**
   * 从屏幕区域识别公式
   * @param {Object} rect - 屏幕区域
   * @param {number} rect.x - X坐标
   * @param {number} rect.y - Y坐标
   * @param {number} rect.width - 宽度
   * @param {number} rect.height - 高度
   * @param {Object} [options] - 识别选项
   * @returns {Promise<{latex: string, confidence: number, raw: string}>}
   */
  async fromScreenFormula(rect, options = {}) {
    try {
      if (!window.ztools || !window.ztools.screen) {
        throw new Error('Screen API 不可用')
      }

      const base64Image = await window.ztools.screen.capture(rect)
      return await this._callFormulaOCRServer(base64Image)
    } catch (error) {
      throw new Error(`屏幕截图失败: ${error.message}`)
    }
  }

  /**
   * 从文件识别公式
   * @param {string} filePath - 图片文件路径
   * @param {Object} [options] - 识别选项
   * @returns {Promise<{latex: string, confidence: number, raw: string}>}
   */
  async fromFileFormula(filePath, options = {}) {
    try {
      if (!window.ztools || !window.ztools.fs) {
        throw new Error('FileSystem API 不可用')
      }

      const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
      const base64Image = this._arrayBufferToBase64(binaryData)

      return await this._callFormulaOCRServer(base64Image)
    } catch (error) {
      throw new Error(`读取文件失败: ${error.message}`)
    }
  }
}

// 导出类(不导出单例,由client.js实例化)
export default OCRAPI
