import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SDK_RUNTIME_PATH = path.join(REPO_ROOT, 'packages', 'api', 'runtime', 'ztools-api.js')

/**
 * 构造最小浏览器/Electron 沙箱加载真实打包产物 packages/api/runtime/ztools-api.js，
 * 端到端验证插件侧拿到的 ToolRuntime 错误结构（directIpc + transport 双通道）、normalizeError 与 onProgress。
 */
function loadSdkInSandbox({ directIpc = {}, transportMethods = {} } = {}) {
  let messageCallback = null
  const subscribedKeys = new Set()

  const methods = {
    app_ready: async ({ messageId }) => ({ messageId, success: true, data: { ok: true } }),
    event_subscribe: async ({ messageId, params }) => {
      subscribedKeys.add(params.key)
      return { messageId, success: true, data: { success: true } }
    },
    event_unsubscribe: async ({ messageId, params }) => {
      subscribedKeys.delete(params.key)
      return { messageId, success: true, data: { success: true } }
    },
    ...transportMethods
  }

  const windowObj = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    __ztoolsElectron: {
      contractVersion: 1,
      ipc: directIpc,
      transport: {
        methods,
        setMessageCallback: (cb) => {
          messageCallback = cb
        }
      }
    }
  }

  const sandbox = {
    window: windowObj,
    navigator: { userAgent: 'ZToolsTest/1.3.0.0', language: 'zh-CN' },
    document: { documentElement: { lang: 'zh-CN' } },
    globalThis: null,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Error,
    TypeError,
    Object,
    Array,
    Map,
    Set,
    Date,
    Math,
    JSON,
    RegExp,
    Number,
    String,
    Boolean
  }
  sandbox.globalThis = sandbox

  const sdkCode = fs.readFileSync(SDK_RUNTIME_PATH, 'utf8')
  vm.runInNewContext(sdkCode, sandbox, { filename: 'ztools-api.js' })

  return {
    ztools: windowObj.ztools,
    subscribedKeys,
    emitHostEvent: (type, payload) => {
      assert.equal(typeof messageCallback, 'function', 'SDK 必须已注册 Electron 消息回调')
      messageCallback('event_envelope', {
        envelope: {
          type,
          payload,
          timestamp: Date.now()
        }
      })
    }
  }
}

test('SDK ToolRuntime：directIpc 与 Transport 双通道完整透传 toolCode / stage / retryable / userAction 与 normalizeError', async () => {
  const provisionDetails = {
    toolCode: 'TOOL_CAPABILITY_PROVISION_FAILED',
    stage: 'provisioning',
    retryable: true,
    userAction: 'check_network',
    primitiveId: 'download.stream',
    attempts: 3,
    detail: 'HTTP 503'
  }
  const timeoutDetails = {
    toolCode: 'TOOL_EXECUTION_TIMEOUT',
    stage: 'executing',
    retryable: true,
    userAction: 'retry',
    primitiveId: 'media.transcode',
    timedOut: true
  }

  const { ztools } = loadSdkInSandbox({
    directIpc: {
      tool_runtime_ensure: async () => ({
        success: false,
        error: {
          code: 'NETWORK_ERROR',
          message: '运行组件下载或准备失败，请检查网络连接后重试',
          details: provisionDetails
        }
      })
    },
    transportMethods: {
      tool_media_transcode_run: async ({ messageId }) => ({
        messageId,
        success: false,
        error: {
          code: 'REQUEST_TIMEOUT',
          message: '任务执行超时，请稍后重试',
          details: timeoutDetails
        }
      })
    }
  })

  // 1. directIpc 通道（tool_runtime_ensure）
  let directErr = null
  try {
    await ztools.toolRuntime.ensure('download.stream')
  } catch (err) {
    directErr = err
  }
  assert.ok(directErr instanceof Error)
  assert.equal(directErr.code, 'NETWORK_ERROR')
  assert.equal(directErr.toolCode, 'TOOL_CAPABILITY_PROVISION_FAILED')
  assert.equal(directErr.stage, 'provisioning')
  assert.equal(directErr.retryable, true)
  assert.equal(directErr.userAction, 'check_network')
  assert.equal(directErr.primitiveId, 'download.stream')
  assert.equal(directErr.attempts, 3)
  assert.deepEqual({ ...directErr.details }, provisionDetails)

  const normalizedDirect = ztools.toolRuntime.normalizeError(directErr)
  assert.equal(normalizedDirect.toolCode, ztools.toolRuntime.ERROR_CODES.capabilityProvisionFailed)
  assert.equal(normalizedDirect.userAction, 'check_network')
  assert.equal(normalizedDirect.retryable, true)
  assert.equal(normalizedDirect.detail, 'HTTP 503')

  // 2. Transport 通道（tool_media_transcode_run）
  let transportErr = null
  try {
    await ztools.toolRuntime.media.transcode({ input: { path: 'a.mp4' }, output: { path: 'b.mp4' }, container: 'mp4' })
  } catch (err) {
    transportErr = err
  }
  assert.ok(transportErr instanceof Error)
  assert.equal(transportErr.code, 'REQUEST_TIMEOUT')
  assert.equal(transportErr.toolCode, 'TOOL_EXECUTION_TIMEOUT')
  assert.equal(transportErr.timedOut, true)
  assert.equal(transportErr.userAction, 'retry')

  const normalizedTransport = ztools.toolRuntime.normalizeError(transportErr)
  assert.equal(normalizedTransport.toolCode, ztools.toolRuntime.ERROR_CODES.executionTimeout)
  assert.equal(normalizedTransport.timedOut, true)
  assert.equal(normalizedTransport.primitiveId, 'media.transcode')

  // 3. 普通未结构化 Error 也能安全规整为 UI 展示对象
  const normalizedPlain = ztools.toolRuntime.normalizeError(Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' }))
  assert.equal(normalizedPlain.code, 'PERMISSION_DENIED')
  assert.equal(normalizedPlain.userAction, 'check_permissions')
  assert.equal(normalizedPlain.retryable, false)
})

test('SDK ToolRuntime：onProgress 正确订阅、按 primitiveId/taskId 过滤并幂等注销', async () => {
  const { ztools, subscribedKeys, emitHostEvent } = loadSdkInSandbox()
  const received = []
  const unsubscribe = ztools.toolRuntime.onProgress(
    (event) => received.push(event),
    { primitiveId: 'media.transcode', taskId: 'task-42' }
  )

  // 等待微任务让 event_subscribe 完成
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(subscribedKeys.has('tool_runtime_progress'), true)

  // 不匹配的任务应被过滤
  emitHostEvent('tool_runtime_progress', {
    taskId: 'task-99',
    primitiveId: 'download.stream',
    phase: 'provisioning',
    stage: 'downloading',
    percent: 25
  })
  // 匹配的任务应触发回调
  emitHostEvent('tool_runtime_progress', {
    taskId: 'task-42',
    primitiveId: 'media.transcode',
    phase: 'provisioning',
    stage: 'retrying',
    percent: 0
  })
  emitHostEvent('tool_runtime_progress', {
    taskId: 'task-42',
    primitiveId: 'media.transcode',
    phase: 'failed',
    errorCode: 'TOOL_EXECUTION_TIMEOUT',
    retryable: true,
    userAction: 'retry',
    message: 'Media transcode timed out'
  })

  assert.equal(received.length, 2)
  assert.equal(received[0].stage, 'retrying')
  assert.equal(received[1].phase, 'failed')
  assert.equal(received[1].errorCode, 'TOOL_EXECUTION_TIMEOUT')
  assert.equal(received[1].userAction, 'retry')

  // 幂等注销后不再接收事件
  unsubscribe()
  unsubscribe()
  emitHostEvent('tool_runtime_progress', {
    taskId: 'task-42',
    primitiveId: 'media.transcode',
    phase: 'completed',
    percent: 100
  })
  assert.equal(received.length, 2)
})
