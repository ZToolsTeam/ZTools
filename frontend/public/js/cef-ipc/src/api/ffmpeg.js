/**
 * FFmpeg API - 音视频处理
 * 通过 FFmpegPlugin DLL 插件实现
 */
class FFmpegAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 开始屏幕录制
   * @param {Object} options - 录制选项
   * @param {string} options.type - 录制类型 ('fullscreen'|'window'|'region')
   * @param {string} options.output - 输出文件路径
   * @param {string} [options.windowTitle] - 窗口标题 (type='window'时必需)
   * @param {Object} [options.region] - 录制区域 {x, y, width, height}
   * @param {Object} [options.audio] - 音频配置
   * @param {boolean} [options.audio.system] - 是否录制系统声音
   * @param {boolean} [options.audio.microphone] - 是否录制麦克风
   * @param {string} [options.audio.systemDevice] - 系统音频设备名称
   * @param {string} [options.audio.micDevice] - 麦克风设备名称
   * @param {Object} [options.video] - 视频配置
   * @param {string} [options.video.codec='libx264'] - 编码器
   * @param {string} [options.video.preset='fast'] - 预设
   * @param {number} [options.video.crf=23] - 质量系数
   * @param {number} [options.video.fps=30] - 帧率
   * @param {boolean} [options.video.showMouse=true] - 是否显示鼠标
   * @param {number} [options.duration=0] - 录制时长(秒), 0表示手动停止
   * @returns {Promise<string>} taskId - 任务ID
   */
  async startRecording(options) {
    const result = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'StartRecording',
      options
    )
    return result.taskId
  }

  /**
   * 停止屏幕录制
   * @param {string} taskId - 任务ID
   * @param {boolean} [force=false] - 是否强制停止
   * @returns {Promise<Object>} {success, output}
   */
  async stopRecording(taskId, force = false) {
    return await window.ztools.dllplugin.call('FFmpegPlugin', 'StopRecording', {
      taskId,
      force
    })
  }

  /**
   * 获取录制进度
   * @param {string} taskId - 任务ID
   * @returns {Promise<Object>} {status, duration, size, fps}
   */
  async getRecordingProgress(taskId) {
    return await window.ztools.dllplugin.call(
      'FFmpegPlugin',
      'GetRecordingProgress',
      {
        taskId
      }
    )
  }

  /**
   * 列出音频设备
   * @returns {Promise<Object>} {system: string[], microphone: string[]}
   */
  async listAudioDevices() {
    return await window.ztools.dllplugin.call(
      'FFmpegPlugin',
      'ListAudioDevices',
      {}
    )
  }

  /**
   * 屏幕截图
   * @param {Object} options - 截图选项
   * @param {string} options.type - 截图类型 ('fullscreen'|'window'|'region')
   * @param {string} options.output - 输出文件路径
   * @param {string} [options.windowTitle] - 窗口标题
   * @param {Object} [options.region] - 截图区域 {x, y, width, height}
   * @param {string} [options.format='png'] - 图片格式
   * @param {boolean} [options.showMouse=false] - 是否显示鼠标
   * @returns {Promise<Object>} {success, output, width, height}
   */
  async captureScreen(options) {
    return await window.ztools.dllplugin.call(
      'FFmpegPlugin',
      'CaptureScreen',
      options
    )
  }

  /**
   * 音视频格式转换
   * @param {Object} options - 转换选项
   * @param {string} options.input - 输入文件路径
   * @param {string} options.output - 输出文件路径
   * @param {Object} [options.video] - 视频配置
   * @param {Object} [options.audio] - 音频配置
   * @param {Function} [options.onProgress] - 进度回调
   * @returns {Promise<string>} taskId
   */
  async convertMedia(options) {
    const taskId = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'ConvertMedia',
      options
    )

    if (options.onProgress) {
      const progressHandler = (event) => {
        if (event.taskId === taskId) {
          options.onProgress(event.percent, event.message)
        }
      }
      window.ztools.dllplugin.on('progress', progressHandler)
    }

    return taskId
  }

  /**
   * 录制音频
   * @param {Object} options - 录制选项
   * @param {string} options.output - 输出文件路径
   * @param {string} options.source - 音频源 ('system'|'microphone'|'both')
   * @param {string} [options.systemDevice] - 系统音频设备名称
   * @param {string} [options.micDevice] - 麦克风设备名称
   * @param {string} [options.format='mp3'] - 音频格式
   * @param {number} [options.bitrate=128] - 音频码率(kbps)
   * @param {number} [options.duration=0] - 录制时长(秒)
   * @returns {Promise<string>} taskId
   */
  async recordAudio(options) {
    const result = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'RecordAudio',
      options
    )
    return result.taskId
  }

  /**
   * 从视频提取帧为图片
   * @param {Object} options - 选项
   * @param {string} options.input - 输入视频路径
   * @param {string} options.output - 输出图片路径
   * @param {number|string} options.time - 时间点
   * @param {string} [options.format='png'] - 图片格式
   * @returns {Promise<Object>} {success, output}
   */
  async extractFrame(options) {
    return await window.ztools.dllplugin.call(
      'FFmpegPlugin',
      'ExtractFrame',
      options
    )
  }

  /**
   * 裁剪视频
   * @param {Object} options - 选项
   * @param {string} options.input - 输入视频
   * @param {string} options.output - 输出视频
   * @param {number|string} options.start - 开始时间
   * @param {number|string} [options.end] - 结束时间
   * @param {number} [options.duration] - 持续时长(秒)
   * @returns {Promise<string>} taskId
   */
  async trimVideo(options) {
    const result = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'TrimVideo',
      options
    )
    return result.taskId
  }

  /**
   * 合并视频
   * @param {Object} options - 选项
   * @param {string[]} options.inputs - 输入视频列表
   * @param {string} options.output - 输出视频
   * @returns {Promise<string>} taskId
   */
  async mergeVideos(options) {
    const result = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'MergeVideos',
      options
    )
    return result.taskId
  }

  /**
   * 生成GIF动图
   * @param {Object} options - 选项
   * @param {string} options.input - 输入视频
   * @param {string} options.output - 输出GIF路径
   * @param {number|string} [options.start] - 开始时间
   * @param {number} [options.duration=5] - 持续时长(秒)
   * @param {number} [options.fps=10] - 帧率
   * @param {string} [options.scale] - 缩放 '800x450'
   * @returns {Promise<string>} taskId
   */
  async createGif(options) {
    const result = await window.ztools.dllplugin.callAsync(
      'FFmpegPlugin',
      'CreateGif',
      options
    )
    return result.taskId
  }

  /**
   * 获取媒体文件信息
   * @param {string} filePath - 文件路径
   * @returns {Promise<Object>} 媒体信息
   */
  async getMediaInfo(filePath) {
    return await window.ztools.dllplugin.call('FFmpegPlugin', 'GetMediaInfo', {
      filePath
    })
  }

  /**
   * 检查FFmpeg是否已安装
   * @returns {Promise<Object>} {installed, version, path}
   */
  async checkFFmpeg() {
    return await window.ztools.dllplugin.call('FFmpegPlugin', 'CheckFFmpeg', {})
  }

  /**
   * 查询任务状态
   * @param {string} taskId - 任务ID
   * @returns {Promise<Object>} 任务信息
   */
  async queryTask(taskId) {
    return await window.ztools.dllplugin.call('FFmpegPlugin', 'QueryTask', {
      taskId
    })
  }

  /**
   * 取消任务
   * @param {string} taskId - 任务ID
   * @param {boolean} [force=false] - 是否强制取消
   * @returns {Promise<Object>} {success}
   */
  async cancelTask(taskId, force = false) {
    return await window.ztools.dllplugin.call('FFmpegPlugin', 'CancelTask', {
      taskId,
      force
    })
  }
}

export default FFmpegAPI
