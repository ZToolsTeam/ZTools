/**
 * FileSystem API - 文件系统操作
 * CEF 使用 V8 ArrayBuffer，Electron 使用受控异步 IPC。
 */
const MAX_STREAM_FILE_BYTES = 4 * 1024 * 1024 * 1024

function bytesToBase64(bytes) {
  const chunkSize = 24 * 1024
  const binaryChunks = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binaryChunks.push(String.fromCharCode(...chunk))
  }
  return btoa(binaryChunks.join(''))
}

function base64ToBytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function encodeContent(content) {
  if (typeof content === 'string') {
    return { encoding: 'utf8', content }
  }
  if (content instanceof ArrayBuffer) {
    return { encoding: 'base64', content: bytesToBase64(new Uint8Array(content)) }
  }
  if (content instanceof Uint8Array) {
    return { encoding: 'base64', content: bytesToBase64(content) }
  }
  throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
}

function fileOperationError(action, error) {
  const wrapped = new Error(`${action}: ${error?.message || String(error)}`)
  if (error?.code) wrapped.code = error.code
  wrapped.cause = error
  return wrapped
}

function normalizeChunkSize(value, fallback) {
  const requested = Number.isInteger(value) ? value : fallback
  return Math.max(1, Math.min(2 * 1024 * 1024, requested))
}

function mergeByteChunks(chunks, totalSize) {
  const merged = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (offset !== totalSize) throw new Error('Read file returned an incomplete stream')
  return merged
}

async function readElectronChunks(transport, method, baseParams, chunkSize, onProgress) {
  const chunks = []
  const size = normalizeChunkSize(chunkSize, 2 * 1024 * 1024)
  let offset = 0
  let totalSize
  while (totalSize === undefined || offset < totalSize) {
    const result = await transport.call(method, {
      ...baseParams,
      offset,
      length: size
    })
    if (
      !result?.success ||
      !Number.isSafeInteger(result.totalSize) ||
      result.totalSize < 0 ||
      result.totalSize > MAX_STREAM_FILE_BYTES ||
      !Number.isSafeInteger(result.size) ||
      typeof result.content !== 'string'
    ) {
      throw new Error('Read file chunk returned invalid data')
    }
    if (result.offset !== offset || result.size < 0 || result.size > size) {
      throw new Error('Read file chunk returned an invalid offset')
    }
    totalSize = result.totalSize
    const chunk = base64ToBytes(result.content)
    if (chunk.byteLength !== result.size || offset + chunk.byteLength > totalSize) {
      throw new Error('Read file chunk returned an invalid size')
    }
    if (chunk.byteLength > 0) chunks.push(chunk)
    offset += chunk.byteLength
    onProgress?.(offset, totalSize)
    if (chunk.byteLength === 0) break
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (totalSize === undefined) totalSize = 0
  return mergeByteChunks(chunks, totalSize)
}

async function writeElectronChunks(
  transport,
  methods,
  startParams,
  bytes,
  chunkSize,
  onProgress
) {
  const started = await transport.call(methods.start, {
    ...startParams,
    totalSize: bytes.byteLength
  })
  if (!started?.success || typeof started.handle !== 'string') {
    throw new Error('Write file stream could not be started')
  }
  const handle = started.handle
  try {
    if (
      started.totalSize !== undefined &&
      (!Number.isSafeInteger(started.totalSize) || started.totalSize !== bytes.byteLength)
    ) {
      throw new Error('Write file stream returned an invalid total size')
    }
    const size = normalizeChunkSize(chunkSize, 2 * 1024 * 1024)
    let offset = 0
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))
      const result = await transport.call(methods.chunk, {
        handle,
        offset,
        content: bytesToBase64(chunk)
      })
      if (
        !result?.success ||
        result.written !== offset + chunk.byteLength ||
        (result.totalSize !== undefined &&
          (!Number.isSafeInteger(result.totalSize) || result.totalSize !== bytes.byteLength))
      ) {
        throw new Error('Write file chunk returned invalid data')
      }
      offset += chunk.byteLength
      onProgress?.(offset, bytes.byteLength)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const finished = await transport.call(methods.end, { handle })
    if (
      !finished?.success ||
      finished.size !== bytes.byteLength ||
      (finished.totalSize !== undefined &&
        (!Number.isSafeInteger(finished.totalSize) || finished.totalSize !== bytes.byteLength))
    ) {
      throw new Error('Write file stream could not be committed')
    }
    if (bytes.byteLength === 0) onProgress?.(0, 0)
    return true
  } catch (error) {
    await transport.call(methods.cancel, { handle }).catch(() => undefined)
    throw error
  }
}

function contentToBytes(content) {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  if (content instanceof Uint8Array) return content
  throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
}

class FileSystemAPI {
  constructor(transport) {
    this.transport = transport

    // 验证 V8 ArrayBuffer 方法是否可用
    this.useV8ArrayBuffer =
      typeof window._readFileArrayBuffer === 'function' &&
      typeof window._writeFileArrayBuffer === 'function' &&
      typeof window._readFileArrayBufferChunk === 'function' &&
      typeof window._getFileSize === 'function'

    if (!this.useV8ArrayBuffer) {
      // console.warn('[fs] V8 ArrayBuffer methods not available. Using transport fallback.')
    } else {
      // console.log('[fs] V8 ArrayBuffer 已启用（高性能零拷贝模式，支持大文件分块读取）')
    }
  }

  // ============ 文件操作 ============

  /**
   * 读取文件内容
   * 使用 V8 ArrayBuffer 直接传输（零拷贝）
   * 支持大文件分块读取和进度回调
   * @param {string} path - 文件路径
   * @param {object} options - 选项
   * @param {function} options.onProgress - 进度回调函数 (read, total) => void
   * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接读取
   * @returns {Promise<string>} 文件内容（文本）
   */
  async readFile(path, options = {}) {
    try {
      const { onProgress, chunkSize = 2 * 1024 * 1024 } = options

      if (this.transport.isElectronEnvironment()) {
        const bytes = await readElectronChunks(
          this.transport,
          'filesystem_read_file_chunk',
          { path },
          chunkSize,
          onProgress
        )
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      }

      // 获取文件大小
      const fileSize = window._getFileSize(path)
      if (fileSize < 0) {
        throw new Error('File not found or cannot get file size')
      }

      // 小文件直接读取（性能优化）
      if (fileSize <= chunkSize) {
        const arrayBuffer = window._readFileArrayBuffer(path)
        if (onProgress) {
          onProgress(fileSize, fileSize)
        }
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
          arrayBuffer
        )
        return decoded
      }

      // 大文件分块读取
      const chunks = []
      let offset = 0
      const defaultChunkSize = 2 * 1024 * 1024 // 2MB per chunk

      while (offset < fileSize) {
        const currentChunkSize = Math.min(defaultChunkSize, fileSize - offset)
        const chunkBuffer = window._readFileArrayBufferChunk(
          path,
          offset,
          currentChunkSize
        )
        const chunk = new Uint8Array(chunkBuffer)
        chunks.push(chunk)
        offset += currentChunkSize

        // 报告进度
        if (onProgress) {
          onProgress(offset, fileSize)
        }

        // 让出控制权，避免阻塞主线程
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // 合并所有块
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const merged = new Uint8Array(totalLength)
      let position = 0
      for (const chunk of chunks) {
        merged.set(chunk, position)
        position += chunk.length
      }

      // 解码为 UTF-8 文本
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        merged.buffer
      )
      return decoded
    } catch (error) {
      throw fileOperationError('Read file failed', error)
    }
  }

  /**
   * 读取文件为二进制数据
   * 使用 V8 ArrayBuffer 直接传输（零拷贝）
   * 支持大文件分块读取和进度回调
   * 适合读取图片、音频、视频等二进制文件
   * @param {string} path - 文件路径
   * @param {object} options - 选项
   * @param {function} options.onProgress - 进度回调函数 (read, total) => void
   * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接读取
   * @returns {Promise<Uint8Array>} 二进制数据
   */
  async readFileAsBinary(path, options = {}) {
    try {
      const { onProgress, chunkSize = 5 * 1024 * 1024 } = options

      if (this.transport.isElectronEnvironment()) {
        return await readElectronChunks(
          this.transport,
          'filesystem_read_file_chunk',
          { path },
          chunkSize,
          onProgress
        )
      }

      // 获取文件大小
      const fileSize = window._getFileSize(path)
      if (fileSize < 0) {
        throw new Error('File not found or cannot get file size')
      }

      // 小文件直接读取（性能优化）
      if (fileSize <= chunkSize) {
        const arrayBuffer = window._readFileArrayBuffer(path)
        if (onProgress) {
          onProgress(fileSize, fileSize)
        }
        return new Uint8Array(arrayBuffer)
      }

      // 大文件分块读取
      const chunks = []
      let offset = 0
      const defaultChunkSize = 5 * 1024 * 1024 // 2MB per chunk

      while (offset < fileSize) {
        const currentChunkSize = Math.min(defaultChunkSize, fileSize - offset)
        const chunkBuffer = window._readFileArrayBufferChunk(
          path,
          offset,
          currentChunkSize
        )
        const chunk = new Uint8Array(chunkBuffer)
        chunks.push(chunk)
        offset += currentChunkSize

        // 报告进度
        if (onProgress) {
          onProgress(offset, fileSize)
        }

        // 让出控制权，避免阻塞主线程
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // 合并所有块
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const merged = new Uint8Array(totalLength)
      let position = 0
      for (const chunk of chunks) {
        merged.set(chunk, position)
        position += chunk.length
      }

      return merged
    } catch (error) {
      throw fileOperationError('Read file as binary failed', error)
    }
  }

  /**
   * 写入文件内容
   * 使用 V8 ArrayBuffer 直接传输（零拷贝）
   * 支持大文件分块写入和进度回调
   * @param {string} path - 文件路径
   * @param {string|ArrayBuffer|Uint8Array} content - 文件内容
   * @param {object} options - 选项
   * @param {function} options.onProgress - 进度回调函数 (written, total) => void
   * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接写入
   * @returns {Promise<boolean>}
   */
  async writeFile(path, content, options = {}) {
    try {
      const { onProgress, chunkSize = 2 * 1024 * 1024 } = options

      if (this.transport.isElectronEnvironment()) {
        if (options.overwrite === false) {
          // The streaming start API currently has replace semantics only. Keep
          // no-overwrite writes on the host's atomic exclusive-write endpoint.
          const encoded = encodeContent(content)
          const result = await this.transport.call('filesystem_write_file', {
            path,
            ...encoded,
            overwrite: false
          })
          if (!result?.success || !Number.isSafeInteger(result.size)) {
            throw new Error('Write file returned invalid data')
          }
          onProgress?.(result.size, result.size)
          return true
        }

        return await writeElectronChunks(
          this.transport,
          {
            start: 'filesystem_write_file_start',
            chunk: 'filesystem_write_file_chunk',
            end: 'filesystem_write_file_end',
            cancel: 'filesystem_write_file_cancel'
          },
          { path },
          contentToBytes(content),
          chunkSize,
          onProgress
        )
      }

      if (options.overwrite === false) {
        const error = new Error('当前宿主不支持原子禁止覆盖写入')
        error.code = 'NOT_SUPPORTED'
        throw error
      }

      let uint8Array
      // 统一转换为 Uint8Array
      if (typeof content === 'string') {
        const encoder = new TextEncoder()
        uint8Array = encoder.encode(content)
      } else if (content instanceof ArrayBuffer) {
        uint8Array = new Uint8Array(content)
      } else if (content instanceof Uint8Array) {
        uint8Array = content
      } else {
        throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
      }

      const totalSize = uint8Array.length

      // 小文件直接写入（性能优化）
      if (totalSize <= chunkSize) {
        // 方案A：传入普通 JS 数组 [0..255]，由 Delphi 端按字节写入
        const byteArray = Array.from(uint8Array)
        const success = window._writeFileArrayBuffer(path, byteArray)
        if (!success) {
          throw new Error('Write file returned false')
        }
        if (onProgress) {
          onProgress(totalSize, totalSize)
        }
        return true
      }

      // 大文件分块写入模拟进度（实际写入仍然一次性）
      const defaultChunkSize = 2 * 1024 * 1024 // 2MB per chunk
      let offset = 0

      while (offset < totalSize) {
        const currentChunkSize = Math.min(defaultChunkSize, totalSize - offset)
        offset += currentChunkSize

        if (onProgress) {
          onProgress(offset, totalSize)
        }

        // 让出控制权
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      // 实际写入（一次性）
      const byteArray = Array.from(uint8Array)
      const success = window._writeFileArrayBuffer(path, byteArray)
      if (!success) {
        throw new Error('Write file returned false')
      }

      return true
    } catch (error) {
      throw fileOperationError('Write file failed', error)
    }
  }

  // ============ Cache 目录封装 ============

  /**
   * 获取当前插件的 Cache 基础目录
   * 形如: bin\Cache\<pluginId>
   * @returns {Promise<string>}
   * @private
   */
  async _getCacheBaseDir() {
    if (this._cacheBaseDir) {
      return this._cacheBaseDir
    }

    try {
      const r = await this.transport.call('get_system_info', {})
      if (r && r.success) {
        let cacheRoot = r.cachePath || ''

        // 后端未显式提供 cachePath 时, 退化为 binPath + 'Cache\'
        if (!cacheRoot && r.binPath) {
          const bin = r.binPath
          const sep = bin.endsWith('\\') || bin.endsWith('/') ? '' : '\\'
          cacheRoot = `${bin}${sep}Cache\\`
        }

        if (!cacheRoot) {
          cacheRoot = 'Cache\\'
        }

        const pluginId = window.__ztools_plugin_id || 'main'
        const base =
          cacheRoot.endsWith('\\') || cacheRoot.endsWith('/')
            ? cacheRoot
            : `${cacheRoot}\\`
        this._cacheBaseDir = `${base}${pluginId}`
        return this._cacheBaseDir
      }
    } catch (e) {
      // 忽略错误, 走降级路径
    }

    // 最坏情况: 使用相对 Cache\<pluginId>
    const pluginId = window.__ztools_plugin_id || 'main'
    this._cacheBaseDir = `Cache\\${pluginId}`
    return this._cacheBaseDir
  }

  /**
   * 写入当前插件的 Cache 文件
   * 最终路径: bin\Cache\<pluginId>\relativePath
   * @param {string} relativePath - 相对于插件 Cache 根目录的路径
   * @param {string|ArrayBuffer|Uint8Array} content - 文件内容
   * @param {object} options - 透传给 writeFile 的参数
   */
  async writeCache(relativePath, content, options = {}) {
    if (this.transport.isElectronEnvironment()) {
      try {
        if (options.overwrite === false) {
          const error = new Error('当前宿主缓存写入接口不支持原子禁止覆盖')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        return await writeElectronChunks(
          this.transport,
          {
            start: 'filesystem_write_cache_start',
            chunk: 'filesystem_write_cache_chunk',
            end: 'filesystem_write_cache_end',
            cancel: 'filesystem_write_cache_cancel'
          },
          { relativePath },
          contentToBytes(content),
          options.chunkSize,
          options.onProgress
        )
      } catch (error) {
        throw fileOperationError('Write cache failed', error)
      }
    }

    const baseDir = await this._getCacheBaseDir()
    const rel = (relativePath || '')
      .trim()
      .replace(/[\\/]+/g, '\\')
      .replace(/^\\+/, '')

    const fullPath = rel ? `${baseDir}\\${rel}` : baseDir

    // 确保目录存在
    const lastSlash = fullPath.lastIndexOf('\\')
    if (lastSlash > 0) {
      const dir = fullPath.slice(0, lastSlash)
      try {
        const exists = await this.directoryExists(dir)
        if (!exists) {
          await this.createDirectory(dir)
        }
      } catch (_) {
        // 目录检查失败时交由后续写入报错
      }
    }

    return this.writeFile(fullPath, content, options)
  }

  /**
   * 读取当前插件的 Cache 文件
   * @param {string} relativePath - 相对于插件 Cache 根目录的路径
   * @param {object} options - 同 readFile
   * @returns {Promise<string>}
   */
  async readCache(relativePath, options = {}) {
    if (this.transport.isElectronEnvironment()) {
      try {
        const bytes = await readElectronChunks(
          this.transport,
          'filesystem_read_cache_chunk',
          { relativePath },
          options.chunkSize,
          options.onProgress
        )
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (error) {
        throw fileOperationError('Read cache failed', error)
      }
    }

    const baseDir = await this._getCacheBaseDir()
    const rel = (relativePath || '')
      .trim()
      .replace(/[\\/]+/g, '\\')
      .replace(/^\\+/, '')

    const fullPath = rel ? `${baseDir}\\${rel}` : baseDir
    return this.readFile(fullPath, options)
  }

  /**
   * 删除文件
   * @param {string} path - 文件路径
   * @returns {Promise<boolean>}
   */
  async deleteFile(path) {
    const r = await this.transport.call('filesystem_delete_file', { path })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Delete file failed')
  }

  /**
   * 复制文件
   * @param {string} sourcePath - 源文件路径
   * @param {string} destPath - 目标文件路径
   * @returns {Promise<boolean>}
   */
  async copyFile(sourcePath, destPath) {
    const r = await this.transport.call('filesystem_copy_file', {
      sourcePath,
      destPath
    })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Copy file failed')
  }

  /**
   * 移动文件
   * @param {string} sourcePath - 源文件路径
   * @param {string} destPath - 目标文件路径
   * @returns {Promise<boolean>}
   */
  async moveFile(sourcePath, destPath) {
    const r = await this.transport.call('filesystem_move_file', {
      sourcePath,
      destPath
    })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Move file failed')
  }

  /**
   * 检查文件是否存在
   * @param {string} path - 文件路径
   * @returns {Promise<boolean>}
   */
  async fileExists(path) {
    const r = await this.transport.call('filesystem_file_exists', { path })
    if (r && r.success) {
      return r.exists || false
    }
    return false
  }

  /**
   * 获取文件大小
   * @param {string} path - 文件路径
   * @returns {Promise<number>} 文件大小(字节),-1表示失败
   */
  async getFileSize(path) {
    const r = await this.transport.call('filesystem_get_file_size', { path })
    if (r && r.success && r.size !== undefined) {
      return r.size
    }
    return -1
  }

  // ============ 目录操作 ============

  /**
   * 创建目录
   * @param {string} path - 目录路径
   * @returns {Promise<boolean>}
   */
  async createDirectory(path) {
    const r = await this.transport.call('filesystem_create_directory', { path })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Create directory failed')
  }

  /**
   * 删除目录
   * @param {string} path - 目录路径
   * @returns {Promise<boolean>}
   */
  async deleteDirectory(path) {
    const r = await this.transport.call('filesystem_delete_directory', { path })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Delete directory failed')
  }

  /**
   * 检查目录是否存在
   * @param {string} path - 目录路径
   * @returns {Promise<boolean>}
   */
  async directoryExists(path) {
    const r = await this.transport.call('filesystem_directory_exists', { path })
    if (r && r.success) {
      return r.exists || false
    }
    return false
  }

  /**
   * 获取目录内容
   * @param {string} path - 目录路径
   * @returns {Promise<Array>} 文件和目录列表
   */
  async getDirectoryContents(path) {
    const r = await this.transport.call('filesystem_get_directory_contents', {
      path
    })
    if (r && r.success && r.files) {
      return r.files
    }
    throw new Error(r?.error || 'Get directory contents failed')
  }

  /**
   * 获取当前工作目录
   * @returns {Promise<string>}
   */
  async getCurrentDirectory() {
    const r = await this.transport.call('filesystem_get_current_directory', {})
    if (r && r.success && r.path) {
      return r.path
    }
    throw new Error(r?.error || 'Get current directory failed')
  }

  /**
   * 设置当前工作目录
   * @param {string} path - 目录路径
   * @returns {Promise<boolean>}
   */
  async setCurrentDirectory(path) {
    const r = await this.transport.call('filesystem_set_current_directory', {
      path
    })
    if (r && r.success) {
      return true
    }
    throw new Error(r?.error || 'Set current directory failed')
  }

  // ============ 文件查找 ============

  /**
   * 查找文件
   * @param {string} path - 搜索路径
   * @param {string} pattern - 文件模式,默认 '*.*'
   * @returns {Promise<Array>} 文件列表
   */
  async findFiles(path, pattern = '*.*') {
    const r = await this.transport.call('filesystem_find_files', {
      path,
      pattern
    })
    if (r && r.success && r.files) {
      return r.files
    }
    throw new Error(r?.error || 'Find files failed')
  }

  /**
   * 查找目录
   * @param {string} path - 搜索路径
   * @param {string} pattern - 目录模式,默认 '*'
   * @returns {Promise<Array>} 目录列表
   */
  async findDirectories(path, pattern = '*') {
    const r = await this.transport.call('filesystem_find_directories', {
      path,
      pattern
    })
    if (r && r.success && r.files) {
      return r.files
    }
    throw new Error(r?.error || 'Find directories failed')
  }

  // ============ 路径操作 ============

  /**
   * 获取完整路径
   * @param {string} path - 相对或绝对路径
   * @returns {Promise<string>}
   */
  async getFullPath(path) {
    const r = await this.transport.call('filesystem_get_full_path', { path })
    if (r && r.success && r.path) {
      return r.path
    }
    throw new Error(r?.error || 'Get full path failed')
  }

  /**
   * 合并路径
   * @param {string} path1 - 路径1
   * @param {string} path2 - 路径2
   * @returns {Promise<string>}
   */
  async combinePath(path1, path2) {
    const r = await this.transport.call('filesystem_combine_path', {
      path1,
      path2
    })
    if (r && r.success && r.path) {
      return r.path
    }
    throw new Error(r?.error || 'Combine path failed')
  }

  /**
   * 获取文件名
   * @param {string} path - 文件路径
   * @returns {Promise<string>}
   */
  async getFileName(path) {
    const r = await this.transport.call('filesystem_get_file_name', { path })
    if (r && r.success && r.name !== undefined) {
      return r.name
    }
    throw new Error(r?.error || 'Get file name failed')
  }

  /**
   * 获取文件扩展名
   * @param {string} path - 文件路径
   * @returns {Promise<string>}
   */
  async getExtension(path) {
    const r = await this.transport.call('filesystem_get_extension', { path })
    if (r && r.success && r.extension !== undefined) {
      return r.extension
    }
    throw new Error(r?.error || 'Get extension failed')
  }

  /**
   * 获取父目录
   * @param {string} path - 路径
   * @returns {Promise<string>}
   */
  async getParentDirectory(path) {
    const r = await this.transport.call('filesystem_get_parent_directory', {
      path
    })
    if (r && r.success && r.path !== undefined) {
      return r.path
    }
    throw new Error(r?.error || 'Get parent directory failed')
  }
}

export default FileSystemAPI
