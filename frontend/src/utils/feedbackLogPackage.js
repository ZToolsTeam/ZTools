const formatDateCompact = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

const formatDateDashed = (date) => {
  const value = formatDateCompact(date)
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

const normalizePath = (path) => (path || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '')

// ZipAPI 只有传入进度回调时才会使用 DLL 插件的后台任务通道。
// 反馈日志可能较大，必须显式走异步压缩，避免阻塞客户端主线程。
const keepZipCompressionAsync = () => {}

const pathJoin = (...parts) =>
  parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== '')
    .join('\\')
    .replace(/[\\/]+/g, '\\')

const parseMainLogDateTime = (file) => {
  const name = file?.name || ''
  const mainMatch = name.match(/^info-(\d{8})(\d{6})(?:\d{3})?-PID\d+\.log$/i)
  if (mainMatch) {
    const rawDate = mainMatch[1]
    const rawTime = mainMatch[2]
    return new Date(
      Number(rawDate.slice(0, 4)),
      Number(rawDate.slice(4, 6)) - 1,
      Number(rawDate.slice(6, 8)),
      Number(rawTime.slice(0, 2)),
      Number(rawTime.slice(2, 4)),
      Number(rawTime.slice(4, 6))
    )
  }

  const modified = new Date(file?.lastModified || '')
  return Number.isNaN(modified.getTime()) ? new Date(0) : modified
}

const listLogFiles = async (ztools, directory) => {
  try {
    if (!directory || !(await ztools.fs.directoryExists(directory))) {
      return []
    }

    const files = await ztools.fs.getDirectoryContents(directory)
    return files
      .filter((file) => !file.isDirectory)
      .map((file) => ({
        ...file,
        directory,
        path: pathJoin(directory, file.name)
      }))
  } catch (err) {
    console.warn('[feedback] 读取日志目录失败:', directory, err)
    return []
  }
}

const collectFeedbackLogFiles = async (ztools, feedbackTime) => {
  const today = formatDateCompact(feedbackTime)
  const todayDashed = formatDateDashed(feedbackTime)
  const [currentDirValue, appDirValue, tempDirValue] = await Promise.all([
    ztools.fs.getCurrentDirectory(),
    ztools.sys.getPath('app'),
    ztools.sys.getPath('temp')
  ])
  const currentDir = normalizePath(currentDirValue)
  const appDir = normalizePath(appDirValue)
  const tempDir = normalizePath(tempDirValue)
  const parentDir = normalizePath(await ztools.fs.getParentDirectory(currentDir))

  const logDirs = Array.from(
    new Set(
      [
        appDir ? pathJoin(appDir, 'Log') : '',
        pathJoin(currentDir, 'Log'),
        pathJoin(parentDir, 'Log'),
        pathJoin(currentDir, 'win10_log'),
        pathJoin(parentDir, 'win10_log')
      ]
        .map(normalizePath)
        .filter(Boolean)
    )
  )
  const runtimeFiles = (await Promise.all(logDirs.map((dir) => listLogFiles(ztools, dir)))).flat()
  const tempFiles = await listLogFiles(ztools, tempDir)

  const pluginLogs = runtimeFiles.filter((file) =>
    new RegExp(`Plugin_${today}\\.log$`, 'i').test(file.name)
  )

  const serviceLogs = runtimeFiles.filter((file) =>
    file.name.toLowerCase() === `ZToolsService_${todayDashed}.log`.toLowerCase()
  )

  const mainLogs = runtimeFiles
    .filter((file) => new RegExp(`^info-${today}\\d{6,9}-PID\\d+\\.log$`, 'i').test(file.name))
    .sort(
      (a, b) =>
        Math.abs(parseMainLogDateTime(a).getTime() - feedbackTime.getTime()) -
        Math.abs(parseMainLogDateTime(b).getTime() - feedbackTime.getTime())
    )
    .slice(0, 10)

  const installerLogs = tempFiles.filter((file) =>
    new RegExp(`^ztools_setup_${today}\\d{6}.*\\.log$`, 'i').test(file.name)
  )

  return [
    ...mainLogs.map((file) => ({ ...file, category: 'main' })),
    ...pluginLogs.map((file) => ({ ...file, category: 'plugin' })),
    ...serviceLogs.map((file) => ({ ...file, category: 'service' })),
    ...installerLogs.map((file) => ({ ...file, category: 'installer' }))
  ]
}

const copyLogsToStaging = async (ztools, files, stagingRoot) => {
  const usedNames = new Set()
  const stagedFiles = []

  for (const file of files) {
    const safeName = (file.name || 'log.log').replace(/[\\/:*?"<>|]/g, '_')
    let finalName = safeName
    let suffix = 1

    while (usedNames.has(finalName.toLowerCase())) {
      const dotIndex = safeName.lastIndexOf('.')
      const baseName = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName
      const extension = dotIndex > 0 ? safeName.slice(dotIndex) : ''
      finalName = `${baseName}_${file.category}_${suffix}${extension}`
      suffix += 1
    }

    usedNames.add(finalName.toLowerCase())
    const stagedPath = pathJoin(stagingRoot, finalName)
    await ztools.fs.copyFile(file.path, stagedPath)
    stagedFiles.push(stagedPath)
  }

  return stagedFiles
}

export const buildFeedbackLogPackage = async (ztools, feedbackTime = new Date()) => {
  if (!ztools?.fs || !ztools?.sys || !ztools?.zip || !ztools?.protocol) {
    throw new Error('当前环境不支持自动打包日志')
  }

  const files = await collectFeedbackLogFiles(ztools, feedbackTime)
  if (files.length === 0) {
    throw new Error('未找到反馈当天可打包的日志文件')
  }

  const tempDir = normalizePath(await ztools.sys.getPath('temp'))
  const dateText = formatDateCompact(feedbackTime)
  const stamp = `${dateText}${String(feedbackTime.getHours()).padStart(2, '0')}${String(feedbackTime.getMinutes()).padStart(2, '0')}${String(feedbackTime.getSeconds()).padStart(2, '0')}`
  const stagingRoot = pathJoin(tempDir, 'ZTools', `feedback-logs-${stamp}-${Date.now()}`)
  const outputZip = pathJoin(tempDir, 'ZTools', `ztools-feedback-logs-${stamp}.zip`)

  await ztools.fs.createDirectory(stagingRoot)
  const stagedFiles = await copyLogsToStaging(ztools, files, stagingRoot)

  try {
    const compressed = await ztools.zip.compress({
      sources: stagedFiles,
      output: outputZip,
      format: 'zip',
      level: 6,
      storePaths: false,
      onProgress: keepZipCompressionAsync
    })

    if (!compressed) {
      throw new Error('日志压缩失败')
    }

    const blob = await ztools.protocol.readFileAsBlob(outputZip)
    return new File([blob], `ztools-feedback-logs-${stamp}.zip`, {
      type: 'application/zip'
    })
  } finally {
    try {
      await ztools.fs.deleteFile(outputZip)
    } catch (err) {
      console.warn('[feedback] 清理日志临时压缩包失败:', err)
    }

    try {
      await ztools.fs.deleteDirectory(stagingRoot)
    } catch (err) {
      console.warn('[feedback] 清理日志临时目录失败:', err)
    }
  }
}
