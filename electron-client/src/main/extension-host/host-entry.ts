/**
 * ZTools M2-1: 扩展宿主进程独立执行入口 (Extension Host Process Entry)
 *
 * 扩展引擎调度器，作为 utilityProcess 独立进程运行：
 * - 维护 WorkerPool 实例；
 * - 接受主进程通过 IPC 分发的插件运行指令与回调调度；
 * - 将 Worker 渲染产生的视图树/空渲染事件实时转发给主进程。
 */

import { WorkerPool, PooledWorker } from './worker-pool.js'

interface ProcessParentPort {
  postMessage(data: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

interface HostIncomingMessage {
  id?: string
  type?: string
  action?: string
  payload?: Record<string, unknown>
}

function getParentChannel() {
  const pp = (process as unknown as { parentPort?: ProcessParentPort }).parentPort
  if (pp && typeof pp.postMessage === 'function') {
    return {
      send: (data: unknown) => pp.postMessage(data),
      on: (fn: (data: unknown) => void) => pp.on('message', (e) => fn(e.data))
    }
  }
  return {
    send: (data: unknown) => (process.send ? process.send(data) : undefined),
    on: (fn: (data: unknown) => void) => process.on('message', fn)
  }
}

const parentChannel = getParentChannel()
const pool = new WorkerPool({ poolSize: 1 })
const activeSessions = new Map<string, PooledWorker>()

parentChannel.on(async (rawMsg: unknown) => {
  if (!rawMsg || typeof rawMsg !== 'object') return

  const { id, type, action, payload } = rawMsg as HostIncomingMessage

  if (type === 'notify' && action === 'terminate') {
    await pool.close()
    process.exit(0)
  }

  if (type === 'request') {
    try {
      switch (action) {
        case 'ping': {
          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: { pong: true, pid: process.pid, timestamp: Date.now() }
          })
          return
        }

        case 'startCommand': {
          const {
            sessionId,
            mode,
            entryPath,
            exportName,
            extensionId,
            commandName,
            arguments: cmdArgs,
            preferences,
            supportDir,
            cacheDir,
            locale
          } = payload || {}
          const worker = await pool.getFromPool()
          if (typeof sessionId === 'string' && sessionId) {
            activeSessions.set(sessionId, worker)
          }

          // 转发 Worker 抛出的视图更新或通知
          worker.onNotify = (notifyAction, notifyPayload) => {
            parentChannel.send({
              type: 'notify',
              action: notifyAction,
              sessionId,
              payload: notifyPayload
            })
          }

          const initResult = await worker.postRequest('initialize', {
            mode: mode || 'view',
            entryPath,
            exportName,
            extensionId,
            commandName,
            arguments: cmdArgs,
            preferences,
            supportDir,
            cacheDir,
            ...(typeof locale === 'string' && locale.trim() ? { locale } : {})
          })

          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: initResult
          })
          return
        }

        case 'updateLocale': {
          const nextLocale = typeof payload?.locale === 'string' ? payload.locale : ''
          const workers = [...activeSessions.values()].filter(worker => !worker.isTerminated)
          await Promise.allSettled(
            workers.map(worker => worker.postRequest('updateLocale', { locale: nextLocale }))
          )
          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: { updated: workers.length, locale: nextLocale }
          })
          return
        }

        case 'nativeCallback': {
          const { sessionId, callbackId, args } = payload || {}
          const worker = typeof sessionId === 'string' ? activeSessions.get(sessionId) : null
          if (!worker) {
            parentChannel.send({
              type: 'result',
              id,
              success: false,
              error: { code: 'SESSION_NOT_FOUND', message: `未找到活跃会话: ${String(sessionId ?? '')}` }
            })
            return
          }

          const cbResult = await worker.postRequest('nativeCallback', {
            callbackId,
            args
          })

          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: cbResult
          })
          return
        }

        case 'terminateSession': {
          const { sessionId } = payload || {}
          const worker = typeof sessionId === 'string' ? activeSessions.get(sessionId) : null
          if (worker) {
            activeSessions.delete(sessionId as string)
            await worker.terminate()
          }
          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: { terminated: true }
          })
          return
        }

        case 'terminate': {
          await pool.close()
          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: { stopped: true }
          })
          process.exit(0)
        }

        default: {
          parentChannel.send({
            type: 'result',
            id,
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `未知的宿主指令: ${String(action ?? '')}` }
          })
          return
        }
      }
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : null
      const errCode = typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code ?? 'HOST_ERROR')
        : 'HOST_ERROR'
      parentChannel.send({
        type: 'result',
        id,
        success: false,
        error: {
          code: errCode,
          message: errObj?.message || String(err),
          stack: errObj?.stack
        }
      })
    }
  }
})

// 预热 Worker 池
void pool.warmUpPool()

// 告知父进程宿主准备就绪
parentChannel.send({
  type: 'notify',
  action: 'ready',
  payload: { pid: process.pid }
})
