import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import type { WebContents } from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams, type EventEnvelopeParams } from '../../src/contracts/method-params.js'
import { applyHostRecorderCaptureEvent, authorizeIpcRequest } from '../../src/main/ipc/router.js'
import { DeclarativePluginAttributionService } from '../../src/main/services/declarative-plugin-attribution-service.js'
import { EventService } from '../../src/main/services/event-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'
import { FakeWebContents } from '../helpers/user-info-router-harness.js'

interface RendererEventsInstance {
  emit(eventType: string, payload?: unknown, options?: Record<string, unknown>): Promise<unknown>
  publish(channel: string, eventType: string, payload?: unknown, options?: Record<string, unknown>): Promise<unknown>
}

type RendererEventsConstructor = new (transport: {
  _debug?: boolean
  call(method: string, params: unknown): Promise<unknown>
}) => RendererEventsInstance

async function loadRealRendererEventsClass(): Promise<RendererEventsConstructor> {
  // 从 out-test/tests/unit/ 向上三级回到 electron-client 根目录，再读取前端真实的 events.js 源码
  const repoRoot = path.resolve(__dirname, '../../../..')
  const eventsSourcePath = path.join(repoRoot, 'frontend/public/js/cef-ipc/src/core/events.js')
  const source = await fs.readFile(eventsSourcePath, 'utf8')
  const cjsTransformed = source.replace(/export\s+default\s+Events\s*;?\s*$/, 'module.exports = Events;\n')
  const sandbox = {
    module: { exports: {} as unknown },
    exports: {},
    Date,
    Math,
    Map,
    Set,
    Promise,
    TypeError,
    Error,
    console,
    setTimeout,
    clearTimeout
  }
  vm.runInNewContext(cjsTransformed, sandbox, { filename: eventsSourcePath })
  return sandbox.module.exports as RendererEventsConstructor
}

test('回归防线：误将 events.publish 当作 events.emit 调用时会被 validateMethodParams 在 path=type 处拦截', async () => {
  const Events = await loadRealRendererEventsClass()
  let capturedMethod = ''
  let capturedParams: unknown
  const events = new Events({
    _debug: false,
    async call(method: string, params: unknown) {
      capturedMethod = method
      capturedParams = structuredClone(params)
      return { success: true }
    }
  })

  await events.publish('hotkey_recorder_active', { active: true } as unknown as string)
  assert.equal(capturedMethod, 'event_publish')
  assert.throws(
    () => validateMethodParams('event_publish', capturedParams),
    (error: unknown) =>
      error instanceof ZToolsError &&
      error.code === errorCodes.invalidRequest &&
      error.message === 'type is invalid' &&
      (error.details as { path?: string } | undefined)?.path === 'type'
  )
})

test('真实契约：前端 Events.emit(hotkey_recorder_active) 完整通过 IPC 路由管线并驱动主进程录制捕获开关', async () => {
  const Events = await loadRealRendererEventsClass()
  const registry = new WindowRegistry()
  const eventService = new EventService({
    send: () => true,
    onRemoved: (listener) => registry.onRemoved(listener)
  })
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: async () => undefined,
    readInstalled: async (pluginId) => ({ id: pluginId, version: '1.0.0', permissions: [] }),
    isRevoked: async () => ({ revoked: false })
  })
  const mainSender = new FakeWebContents(1)
  const mainCaller = registry.registerMain(mainSender as unknown as WebContents)

  const captureStates: boolean[] = []
  const triggers = {
    setRecorderCaptureActive(active: boolean) {
      captureStates.push(active)
    }
  }

  let seq = 0
  const dispatchThroughRouterPipeline = async (
    sender: FakeWebContents,
    method: string,
    params: unknown,
    pluginSession?: unknown
  ) => {
    seq += 1
    const rawEnvelope = structuredClone({
      messageId: `js_contract_${seq}_${method}`,
      method,
      params,
      ...(pluginSession === undefined ? {} : { pluginSession })
    })
    const request = parseRequest(rawEnvelope)
    let caller: CallerIdentity | undefined = registry.get(sender.id)
    assert.ok(caller)
    caller = attribution.attributeCaller(caller, request)
    authorizeIpcRequest(caller, request, sender)
    validateMethodParams(request.method, request.params)
    applyHostRecorderCaptureEvent(request.params as EventEnvelopeParams, caller, triggers)
    return eventService.publish(request.params as EventEnvelopeParams, caller)
  }

  try {
    const rendererEvents = new Events({
      _debug: false,
      call: (method: string, params: unknown) => dispatchThroughRouterPipeline(mainSender, method, params)
    })

    await rendererEvents.emit('hotkey_recorder_active', { active: true })
    await rendererEvents.emit('hotkey_recorder_active', { active: false })

    assert.deepEqual(captureStates, [true, false])

    // 声明式插件会话（attributedPlugin）即使复用主窗口发同名事件，也不得篡改宿主的快捷键录制捕获状态
    const opened = await attribution.open(mainCaller, { pluginId: 'kill-process' })
    const pluginEvents = new Events({
      _debug: false,
      call: (method: string, params: unknown) =>
        dispatchThroughRouterPipeline(mainSender, method, params, opened.data.token)
    })
    await pluginEvents.emit('hotkey_recorder_active', { active: true })
    assert.deepEqual(captureStates, [true, false])
  } finally {
    attribution.stop()
    eventService.stop()
  }
})
