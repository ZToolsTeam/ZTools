/**
 * Database API - 存储/数据库操作
 * 封装存储相关的业务逻辑
 */
class DatabaseAPI {
  static arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer)
    const chunks = []
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
    }
    return btoa(chunks.join(''))
  }

  constructor(transport) {
    this.transport = transport
    this._currentPluginId = null
  }

  /**
   * 设置当前插件ID（用于便捷API）
   * @param {string} pluginId - 插件ID
   */
  async setPluginId(pluginId) {
    this._currentPluginId = pluginId
  }

  /**
   * 获取存储的值（带插件ID参数）
   * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
   * @param {string} key - 键名（可选）
   * @returns {Promise<any>} 存储的值,不存在返回null
   */
  async get(pluginIdOrKey, key) {
    try {
      let pluginId, actualKey

      if (key !== undefined) {
        // 两个参数：get(pluginId, key)
        pluginId = pluginIdOrKey
        actualKey = key
      } else if (this._currentPluginId) {
        // 一个参数且已设置 pluginId：get(key)
        pluginId = this._currentPluginId
        actualKey = pluginIdOrKey
      } else {
        return null
      }

      const r = await this.transport.call('db_get', {
        plugin_id: pluginId,
        key: actualKey
      })
      if (r && r.success === true && r.data !== undefined) {
        // 尝试解析 JSON，如果失败则返回原始字符串
        if (typeof r.data === 'string') {
          try {
            return JSON.parse(r.data)
          } catch {
            return r.data
          }
        }
        return r.data
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 存储文档（uTools 风格）
   * @param {object} doc - 文档对象，必须包含 _id 字段
   * @returns {Promise<object>} 存储的文档
   */
  async put(doc) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }
    if (!doc || !doc._id) {
      throw new Error('Document must have _id field')
    }

    const key = doc._id
    const value = doc

    const r = await this.transport.call('db_put', {
      plugin_id: this._currentPluginId,
      key,
      value
    })

    if (r && r.success === true) {
      return doc
    }
    throw new Error(r?.error || 'Put failed')
  }

  /**
   * 删除文档（uTools 风格）
   * @param {string} id - 文档ID
   * @returns {Promise<object>} 删除结果
   */
  async remove(id) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    const r = await this.transport.call('db_delete', {
      plugin_id: this._currentPluginId,
      key: id
    })

    if (r && r.success === true) {
      return { ok: true, id }
    }
    throw new Error(r?.error || 'Remove failed')
  }

  /**
   * 设置存储的值
   * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
   * @param {string} keyOrValue - 键名 或 值（如果第一个参数是 key）
   * @param {any} value - 值（可选）
   * @returns {Promise<boolean>}
   */
  async set(pluginIdOrKey, keyOrValue, value) {
    let pluginId, key, actualValue

    if (value !== undefined) {
      // 三个参数：set(pluginId, key, value)
      pluginId = pluginIdOrKey
      key = keyOrValue
      actualValue = value
    } else if (this._currentPluginId) {
      // 两个参数且已设置 pluginId：set(key, value)
      pluginId = this._currentPluginId
      key = pluginIdOrKey
      actualValue = keyOrValue
    } else {
      throw new Error(
        'Please call setPluginId() first or provide pluginId as first parameter'
      )
    }

    const r = await this.transport.call('db_put', {
      plugin_id: pluginId,
      key,
      value: actualValue
    })
    return r && r.success === true
  }

  /**
   * 删除存储的值
   * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
   * @param {string} key - 键名（可选）
   * @returns {Promise<boolean>}
   */
  async delete(pluginIdOrKey, key) {
    let pluginId, actualKey

    if (key !== undefined) {
      // 两个参数：delete(pluginId, key)
      pluginId = pluginIdOrKey
      actualKey = key
    } else if (this._currentPluginId) {
      // 一个参数且已设置 pluginId：delete(key)
      pluginId = this._currentPluginId
      actualKey = pluginIdOrKey
    } else {
      throw new Error(
        'Please call setPluginId() first or provide pluginId as first parameter'
      )
    }

    const r = await this.transport.call('db_delete', {
      plugin_id: pluginId,
      key: actualKey
    })
    return r && r.success === true
  }

  /**
   * 获取所有文档（uTools 风格）
   * @param {string} prefix - 可选的前缀过滤
   * @returns {Promise<Array>} 文档数组
   */
  async allDocs(prefix = '') {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    const r = await this.transport.call('db_query', {
      plugin_id: this._currentPluginId,
      prefix: prefix || '',
      limit: 0 // 0 表示不限制
    })

    if (r && r.success === true && Array.isArray(r.data)) {
      // 将结果转换为文档格式 (兼容 uTools)
      return r.data.map((item) => {
        try {
          // 如果 value 是 JSON 字符串，解析它
          const doc =
            typeof item.value === 'string' ? JSON.parse(item.value) : item.value
          // 确保包含 _id
          if (!doc._id) {
            doc._id = item.key
          }
          return doc
        } catch {
          // 如果不是 JSON，返回简单对象
          return {
            _id: item.key,
            value: item.value
          }
        }
      })
    }
    throw new Error(typeof r?.error === 'string' && r.error.trim()
      ? r.error
      : 'Database query failed or returned invalid documents')
  }

  /**
   * 批量操作（uTools 风格）
   * @param {Array<object>} docs - 文档数组
   * @returns {Promise<Array>} 操作结果
   */
  async bulkDocs(docs) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    if (!Array.isArray(docs) || docs.length === 0) {
      return []
    }

    const operations = docs.map((doc) => ({
      op: 'put',
      key: doc._id,
      value: JSON.stringify(doc)
    }))

    const r = await this.transport.call('db_batch', {
      plugin_id: this._currentPluginId,
      operations
    })

    if (r && r.success === true) {
      return docs.map((doc) => ({ ok: true, id: doc._id }))
    }
    throw new Error(r?.error || 'Batch operation failed')
  }

  /**
   * 添加附件（uTools 风格）
   * @param {string} docId - 文档ID
   * @param {string|ArrayBuffer|Blob} attachment - 附件数据
   * @param {string} type - MIME类型
   * @returns {Promise<object>}
   */
  async postAttachment(docId, attachment, type) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    // 将附件转换为 base64
    let base64Data
    if (typeof attachment === 'string') {
      // 如果已经是 data URL，提取 base64 部分
      if (attachment.startsWith('data:')) {
        base64Data = attachment.split(',')[1]
      } else {
        base64Data = btoa(attachment)
      }
    } else if (attachment instanceof ArrayBuffer) {
      base64Data = DatabaseAPI.arrayBufferToBase64(attachment)
    } else if (attachment instanceof Blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = async (e) => {
          const base64 = e.target.result.split(',')[1]
          try {
            const result = await this._storeAttachment(docId, base64, type)
            resolve(result)
          } catch (error) {
            reject(error)
          }
        }
        reader.onerror = reject
        reader.readAsDataURL(attachment)
      })
    }

    return await this._storeAttachment(docId, base64Data, type)
  }

  /**
   * 存储附件的内部方法
   */
  async _storeAttachment(docId, base64Data, type) {
    // 存储附件数据和类型
    const attachmentKey = `attachment:${docId}`
    const typeKey = `attachment_type:${docId}`

    await this.put({
      _id: attachmentKey,
      data: base64Data
    })

    await this.put({
      _id: typeKey,
      type: type
    })

    return { ok: true, id: docId }
  }

  /**
   * 获取附件（uTools 风格）
   * @param {string} docId - 文档ID
   * @returns {Promise<string>} Base64编码的附件数据
   */
  async getAttachment(docId) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    const attachmentKey = `attachment:${docId}`
    const doc = await this.get(attachmentKey)

    return doc ? doc.data : null
  }

  /**
   * 获取附件类型（uTools 风格）
   * @param {string} docId - 文档ID
   * @returns {Promise<string>} MIME类型
   */
  async getAttachmentType(docId) {
    if (!this._currentPluginId) {
      throw new Error('Please call setPluginId() first')
    }

    const typeKey = `attachment_type:${docId}`
    const doc = await this.get(typeKey)

    return doc ? doc.type : null
  }

  /**
   * 存储加密数据
   * @param {string} pluginIdOrKey - 插件ID 或 键名
   * @param {string} keyOrValue - 键名 或 值
   * @param {string} [value] - 值
   * @returns {Promise<boolean>}
   */
  async putSecure(pluginIdOrKey, keyOrValue, value) {
    let pluginId, key, actualValue

    if (value !== undefined) {
      // 三个参数：putSecure(pluginId, key, value)
      pluginId = pluginIdOrKey
      key = keyOrValue
      actualValue = value
    } else if (this._currentPluginId) {
      // 两个参数且已设置 pluginId：putSecure(key, value)
      pluginId = this._currentPluginId
      key = pluginIdOrKey
      actualValue = keyOrValue
    } else {
      throw new Error(
        'Please call setPluginId() first or provide pluginId as first parameter'
      )
    }

    const r = await this.transport.call('db_put_secure', {
      plugin_id: pluginId,
      key,
      value: actualValue
    })
    return r && r.success === true
  }

  /**
   * 读取加密数据
   * @param {string} pluginIdOrKey - 插件ID 或 键名
   * @param {string} [key] - 键名
   * @returns {Promise<string>} 解密后的值
   */
  async getSecure(pluginIdOrKey, key) {
    let pluginId, actualKey

    if (key !== undefined) {
      // 两个参数：getSecure(pluginId, key)
      pluginId = pluginIdOrKey
      actualKey = key
    } else if (this._currentPluginId) {
      // 一个参数且已设置 pluginId：getSecure(key)
      pluginId = this._currentPluginId
      actualKey = pluginIdOrKey
    } else {
      throw new Error(
        'Please call setPluginId() first or provide pluginId as first parameter'
      )
    }

    const r = await this.transport.call('db_get_secure', {
      plugin_id: pluginId,
      key: actualKey
    })

    if (r && r.success === true && r.data !== undefined) {
      return r.data
    }
    return null
  }
}

export default DatabaseAPI
