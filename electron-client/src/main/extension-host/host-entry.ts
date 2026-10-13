/**
 * ZTools M2-1: 扩展宿主进程独立执行入口 (Extension Host Process Entry)
 *
 * 对应 Raycast 的 node.exe 扩展引擎调度器，作为 utilityProcess 独立进程运行：
 * - 维护 WorkerPool 实例；
 * - 接受主进程通过 IPC 分发的插件运行指令与回调调度；
 * - 将 Worker 渲染产生的视图树/空渲染事件实时转发给主进程。
 */

import { WorkerPool, PooledWorker } from './worker-pool.js'

function getParentChannel() {
  const pp = (process as any).parentPort
  if (pp && typeof pp.postMessage === 'function') {
    return {
      send: (data: unknown) => pp.postMessage(data),
      on: (fn: (data: unknown) => void) => pp.on('message', (e: any) => fn(e.data))
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

parentChannel.on(async (msg: any) => {
  if (!msg || typeof msg !== 'object') return

  const { id, type, action, payload } = msg

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
          const { sessionId, mode, entryPath, exportName, extensionId, commandName, arguments: cmdArgs, preferences, supportDir, cacheDir } = payload || {}
          const worker = await pool.getFromPool()
          if (sessionId) {
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
            cacheDir
          })

          parentChannel.send({
            type: 'result',
            id,
            success: true,
            data: initResult
          })
          return
        }

        case 'nativeCallback': {
          const { sessionId, callbackId, args } = payload || {}
          const worker = sessionId ? activeSessions.get(sessionId) : null
          if (!worker) {
            parentChannel.send({
              type: 'result',
              id,
              success: false,
              error: { code: 'SESSION_NOT_FOUND', message: `未找到活跃会话: ${sessionId}` }
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
          const worker = sessionId ? activeSessions.get(sessionId) : null
          if (worker) {
            activeSessions.delete(sessionId)
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
            error: { code: 'UNKNOWN_ACTION', message: `未知的宿主指令: ${action}` }
          })
          return
        }
      }
    } catch (err: any) {
      parentChannel.send({
        type: 'result',
        id,
        success: false,
        error: {
          code: err.code || 'HOST_ERROR',
          message: err.message || String(err),
          stack: err.stack
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
