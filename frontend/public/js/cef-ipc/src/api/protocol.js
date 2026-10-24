/**
 * ZTools 自定义协议 API
 *
 * 提供高性能的本地文件访问能力，无需Base64编码
 *
 * 协议格式:
 * - ztools://file/绝对路径     - 读取任意本地文件
 * - ztools://cache/相对路径    - 读取Cache目录文件
 * - ztools://temp/相对路径     - 读取临时文件
 *
 * 使用场景:
 * 1. 图片/视频预览: <img src="ztools://file/C:/image.jpg">
 * 2. Fetch API: await fetch('ztools://cache/data.json')
 * 3. Blob处理: const blob = await fetch(url).then(r => r.blob())
 */

class ZToolsProtocol {
  static encodePath(pathValue) {
    return pathValue
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
  }

  /**
   * 将本地文件路径转换为 ztools:// 协议URL
   * @param {string} filePath - 本地文件绝对路径
   * @returns {string} ztools:// 协议URL
   */
  static fileUrl(filePath) {
    if (typeof filePath === 'string' && /^ztools:\/\/file\//i.test(filePath)) {
      return filePath
    }
    // 规范化路径分隔符
    const normalizedPath = filePath.replace(/\\/g, '/')
    return `ztools://file/${this.encodePath(normalizedPath)}`
  }

  /**
   * 将Cache目录相对路径转换为 ztools:// 协议URL
   * @param {string} relativePath - 相对于Cache目录的路径
   * @returns {string} ztools:// 协议URL
   */
  static cacheUrl(relativePath) {
    const raw = (relativePath || '').toString()
    let normalizedPath = raw.replace(/\\/g, '/')
    // 去掉开头多余的分隔符
    normalizedPath = normalizedPath.replace(/^\/+/, '')

    // 旧版 CEF 目录需要显式插件前缀；Electron session 已经按插件隔离。
    let pluginPrefix = ''
    try {
      const isElectron = typeof window !== 'undefined' && !!window.__ztoolsElectron?.transport
      if (!isElectron && typeof window !== 'undefined' && window.__ztools_plugin_id) {
        pluginPrefix = `${window.__ztools_plugin_id}/`
      }
    } catch (_) {
      // 忽略环境检测错误, 退化为全局Cache
    }

    return `ztools://cache/${this.encodePath(`${pluginPrefix}${normalizedPath}`)}`
  }

  /**
   * 将临时目录相对路径转换为 ztools:// 协议URL
   * @param {string} relativePath - 相对于临时目录的路径
   * @returns {string} ztools:// 协议URL
   */
  static tempUrl(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/')
    return `ztools://temp/${this.encodePath(normalizedPath)}`
  }

  /**
   * 读取文件为文本（使用自定义协议，高性能）
   * @param {string} filePath - 本地文件路径
   * @returns {Promise<string>} 文件内容
   */
  static async readFileAsText(filePath) {
    const url = this.fileUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to read file: ${response.status} ${response.statusText}`
      )
    }
    return await response.text()
  }

  /**
   * 读取文件为二进制（使用自定义协议，高性能）
   * @param {string} filePath - 本地文件路径
   * @returns {Promise<ArrayBuffer>} 文件二进制数据
   */
  static async readFileAsArrayBuffer(filePath) {
    const url = this.fileUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to read file: ${response.status} ${response.statusText}`
      )
    }
    return await response.arrayBuffer()
  }

  /**
   * 读取文件为Blob（使用自定义协议，高性能）
   * @param {string} filePath - 本地文件路径
   * @returns {Promise<Blob>} 文件Blob对象
   */
  static async readFileAsBlob(filePath) {
    const url = this.fileUrl(filePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to read file: ${response.status} ${response.statusText}`
      )
    }
    return await response.blob()
  }

  /**
   * 读取文件为Data URL（使用自定义协议）
   * @param {string} filePath - 本地文件路径
   * @returns {Promise<string>} Data URL
   */
  static async readFileAsDataURL(filePath) {
    const blob = await this.readFileAsBlob(filePath)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * 读取Cache文件为文本
   * @param {string} relativePath - 相对于Cache目录的路径
   * @returns {Promise<string>} 文件内容
   */
  static async readCacheAsText(relativePath) {
    const url = this.cacheUrl(relativePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to read cache file: ${response.status} ${response.statusText}`
      )
    }
    return await response.text()
  }

  /**
   * 读取Cache文件为JSON
   * @param {string} relativePath - 相对于Cache目录的路径
   * @returns {Promise<any>} JSON对象
   */
  static async readCacheAsJSON(relativePath) {
    const url = this.cacheUrl(relativePath)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `Failed to read cache file: ${response.status} ${response.statusText}`
      )
    }
    return await response.json()
  }

  /**
   * 检查文件是否可访问（通过尝试读取）
   * @param {string} filePath - 本地文件路径
   * @returns {Promise<boolean>} 是否可访问
   */
  static async fileExists(filePath) {
    try {
      const url = this.fileUrl(filePath)
      const response = await fetch(url, { method: 'HEAD' })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * 读取大文件为Blob（支持进度回调）
   * ⚠️ 注意：fetch API 的进度监控需要使用 ReadableStream
   *
   * @param {string} filePath - 本地文件路径
   * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
   * @returns {Promise<Blob>} 文件Blob对象
   *
   * @example
   * const blob = await ztools.protocol.readFileAsBlobWithProgress(
   *   'C:/large-video.mp4',
   *   (loaded, total) => {
   *     const percent = (loaded / total * 100).toFixed(2)
   *     console.log(`下载进度: ${percent}%`)
   *   }
   * )
   */
  static async readFileAsBlobWithProgress(filePath, onProgress) {
    const url = this.fileUrl(filePath)
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(
        `Failed to read file: ${response.status} ${response.statusText}`
      )
    }

    // 如果没有提供进度回调，直接返回Blob
    if (!onProgress) {
      return await response.blob()
    }

    // 获取文件总大小
    const contentLength = response.headers.get('Content-Length')
    const total = parseInt(contentLength, 10)

    if (!contentLength || isNaN(total)) {
      // 无法获取文件大小，降级为普通读取
      console.warn('[protocol] 无法获取文件大小，进度回调不可用')
      return await response.blob()
    }

    // 使用 ReadableStream 读取数据并报告进度
    const reader = response.body.getReader()
    const chunks = []
    let loaded = 0

    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      chunks.push(value)
      loaded += value.length

      // 调用进度回调
      try {
        onProgress(loaded, total)
      } catch (error) {
        console.error('[protocol] 进度回调错误:', error)
      }
    }

    // 合并所有 chunks 为 Blob
    const mimeType =
      response.headers.get('Content-Type') || 'application/octet-stream'
    return new Blob(chunks, { type: mimeType })
  }

  /**
   * 读取大文件为ArrayBuffer（支持进度回调）
   *
   * @param {string} filePath - 本地文件路径
   * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
   * @returns {Promise<ArrayBuffer>} 文件二进制数据
   *
   * @example
   * const buffer = await ztools.protocol.readFileAsArrayBufferWithProgress(
   *   'C:/large-file.bin',
   *   (loaded, total) => {
   *     console.log(`已加载: ${loaded} / ${total} 字节`)
   *   }
   * )
   */
  static async readFileAsArrayBufferWithProgress(filePath, onProgress) {
    const blob = await this.readFileAsBlobWithProgress(filePath, onProgress)
    return await blob.arrayBuffer()
  }

  /**
   * 读取大文件为Data URL（支持进度回调）
   * ⚠️ 注意：Data URL 会将文件编码为 Base64，大文件不推荐使用
   *
   * @param {string} filePath - 本地文件路径
   * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
   * @returns {Promise<string>} Data URL
   *
   * @example
   * const dataUrl = await ztools.protocol.readFileAsDataURLWithProgress(
   *   'C:/photo.jpg',
   *   (loaded, total) => {
   *     const percent = Math.round(loaded / total * 100)
   *     updateProgressBar(percent)
   *   }
   * )
   */
  static async readFileAsDataURLWithProgress(filePath, onProgress) {
    const blob = await this.readFileAsBlobWithProgress(filePath, onProgress)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }
}

// 导出为ES模块
export default ZToolsProtocol
