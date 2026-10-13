(() => {
  const output = document.getElementById('result')
  let sequence = 0

  function render(action, ok, value) {
    sequence += 1
    output.dataset.sequence = String(sequence)
    output.textContent = JSON.stringify({ sequence, action, ok, ...(ok ? { value } : { code: value }) })
  }

  async function perform(action, work) {
    try { render(action, true, await work()) }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code)
        ? error.code
        : typeof error?.message === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.message) ? error.message : 'F11_API_CALL_FAILED'
      render(action, false, code)
    }
  }

  function positiveInteger(id) {
    const value = Number(document.getElementById(id).value)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('F11_UI_PID_INVALID')
    return value
  }

  function boundedInteger(id, min, max) {
    const value = Number(document.getElementById(id).value)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('F11_UI_NUMBER_OUT_OF_RANGE')
    return value
  }

  function summarizeRows(rows) {
    const mainPid = Number(document.getElementById('main-pid').value)
    const fixturePid = Number(document.getElementById('fixture-pid').value)
    const wanted = new Set([mainPid, fixturePid].filter(value => Number.isSafeInteger(value) && value > 0))
    const matchingRows = rows.filter(row => wanted.has(row?.pid)).map(row => ({
      pid: row.pid,
      role: row.pid === mainPid ? 'isolated-main' : 'owned-fixture',
      fieldAvailability: {
        path: typeof row.fieldAvailability?.path === 'boolean' ? row.fieldAvailability.path : null,
        cpuUsage: typeof row.fieldAvailability?.cpuUsage === 'boolean' ? row.fieldAvailability.cpuUsage : null,
        memoryUsage: typeof row.fieldAvailability?.memoryUsage === 'boolean' ? row.fieldAvailability.memoryUsage : null
      }
    }))
    return { totalCount: rows.length, mainIncluded: matchingRows.some(row => row.role === 'isolated-main'),
      fixtureIncluded: fixturePid > 0 && matchingRows.some(row => row.role === 'owned-fixture'), matchingRows }
  }

  document.querySelector('[data-action="choose-executable"]').addEventListener('click', () => perform('choose-executable', async () => {
    const result = await window.ztools.win.showOpenDialog({ title: 'F11 TEST ONLY — choose the process fixture',
      filters: 'Executable (*.exe)|*.exe', properties: ['openFile'] })
    if (!result || result.canceled !== false) throw new Error('F11_PUBLIC_CHOOSER_CANCELLED')
    let selectedPath
    if (typeof result.filePath === 'string' && result.filePath) selectedPath = result.filePath
    else if (Array.isArray(result.filePaths) && result.filePaths.length === 1) {
      const item = result.filePaths[0]
      selectedPath = typeof item === 'string' ? item : item?.path
    }
    if (typeof selectedPath !== 'string' || !selectedPath) throw new Error('F11_PUBLIC_CHOOSER_RESULT_INVALID')
    document.getElementById('exe-path').value = selectedPath
    return { canceled: false, filePath: result.filePath, filePaths: result.filePaths,
      fileUrlPresent: typeof result.fileUrl === 'string' || typeof result.filePaths?.[0]?.fileUrl === 'string',
      resultKeys: Object.keys(result).sort() }
  }))

  document.querySelector('[data-action="start"]').addEventListener('click', () => perform('start', async () => {
    const executable = document.getElementById('exe-path').value
    if (!executable || executable.length > 2048) throw new Error('F11_UI_EXECUTABLE_INVALID')
    const mode = document.getElementById('mode').value
    const duration = mode === 'hold' ? boundedInteger('duration', 60_000, 120_000) : boundedInteger('duration', 100, 120_000)
    const exitCode = boundedInteger('exit-code', 0, 255)
    const args = mode === 'hold' ? ['hold', String(duration)] : ['exit', String(duration), String(exitCode)]
    return await window.ztools.process.start(executable, args, { show: false })
  }))

  document.querySelector('[data-action="list"]').addEventListener('click', () => perform('list', async () => {
    const rows = await window.ztools.process.list()
    if (!Array.isArray(rows) || rows.length > 10_000) throw new Error('F11_PROCESS_LIST_SHAPE_INVALID')
    return summarizeRows(rows)
  }))

  document.querySelector('[data-action="info"]').addEventListener('click', () => perform('info', async () => {
    const pid = positiveInteger('main-pid')
    const response = await window.ztools.process.getInfo(pid)
    return response?.success === true && response?.data?.pid === pid
      ? { success: true, data: { pid, fieldAvailability: response.data.fieldAvailability,
        fieldAvailabilityValid: ['path', 'cpuUsage', 'memoryUsage'].every(key => typeof response.data.fieldAvailability?.[key] === 'boolean') },
        responseKeys: Object.keys(response).sort(), dataKeys: Object.keys(response.data).sort() }
      : { success: response?.success, data: { pid: response?.data?.pid, fieldAvailability: response?.data?.fieldAvailability } }
  }))

  document.querySelector('[data-action="exists"]').addEventListener('click', () => perform('exists', async () => {
    const response = await window.ztools.process.exists(positiveInteger('pid'))
    return response
  }))

  document.querySelector('[data-action="wait"]').addEventListener('click', () => perform('wait', async () => {
    const timeout = boundedInteger('timeout', 1, 30_000)
    return await window.ztools.process.wait(positiveInteger('pid'), timeout)
  }))

  document.querySelector('[data-action="kill-owned"]').addEventListener('click', () => perform('kill-owned', async () => {
    return await window.ztools.process.kill(positiveInteger('pid'), true)
  }))

  document.querySelector('[data-action="kill-main"]').addEventListener('click', () => perform('kill-main', async () => {
    return await window.ztools.process.kill(positiveInteger('pid'), false)
  }))

  render('ready', true, { testOnly: true, sdkContractVersion: 1,
    processApi: ['list', 'getInfo', 'exists', 'start', 'wait', 'kill'], chooser: 'window.ztools.win.showOpenDialog' })
})()
