import net from 'node:net'
import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'

// Only local, dynamically allocated ports. Stop closes only objects created by this call.
export async function startLoopbackFixtures() {
  const runId = randomUUID(), resources = [], endpoints = [], unavailable = []
  let stopPromise
  const close = resource => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('FIXTURE_CLOSE_TIMEOUT')), 3000)
    const done = error => {
      clearTimeout(timer)
      if (error && !['ERR_SERVER_NOT_RUNNING', 'ERR_SOCKET_DGRAM_NOT_RUNNING'].includes(error.code)) reject(error)
      else resolve()
    }
    try {
      if (resource.kind === 'tcp') {
        for (const socket of resource.clients) socket.destroy()
        resource.server.close(done)
      } else resource.server.close(() => done())
    } catch (error) { done(error) }
  })
  const stop = () => stopPromise ??= (async () => {
    const results = await Promise.allSettled(resources.map(close))
    if (results.some(result => result.status === 'rejected')) throw new Error('FIXTURE_CLEANUP_FAILED')
    return { status: 'OWNED_RESOURCES_CLOSED', runId }
  })()
  try {
    for (const host of ['127.0.0.1', '::1']) {
      for (const kind of ['tcp', 'udp']) {
        let resource
        if (kind === 'tcp') {
          const clients = new Set()
          const server = net.createServer(socket => {
            if (clients.size >= 16) { socket.destroy(); return }
            clients.add(socket)
            socket.setTimeout(1000, () => socket.destroy())
            socket.on('error', () => {})
            socket.on('close', () => clients.delete(socket))
            let bytes = 0
            socket.on('data', data => {
              bytes += data.length
              if (bytes > 4096) socket.destroy()
              else socket.end(data)
            })
          })
          resource = { kind, server, clients }
        } else {
          const server = dgram.createSocket(host === '::1' ? 'udp6' : 'udp4')
          server.on('message', (data, remote) => {
            if (data.length <= 4096 && ['127.0.0.1', '::1'].includes(remote.address)) {
              server.send(data, remote.port, remote.address, () => {})
            }
          })
          resource = { kind, server }
        }
        resources.push(resource)
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('FIXTURE_LISTEN_TIMEOUT')), 3000)
            const onError = error => { clearTimeout(timer); reject(error) }
            resource.server.once('error', onError)
            const ready = () => { clearTimeout(timer); resource.server.off('error', onError); resolve() }
            if (kind === 'tcp') resource.server.listen({ host, port: 0, exclusive: true }, ready)
            else resource.server.bind({ address: host, port: 0, exclusive: true }, ready)
          })
        } catch (error) {
          // A missing IPv6 loopback is recorded as NOT_RUN, never as an empty PASS.
          if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) {
            unavailable.push({ host, kind, status: 'NOT_RUN', code: error.code })
            continue
          }
          throw error
        }
        resource.server.on('error', () => {})
        const address = resource.server.address()
        endpoints.push({ host, port: address.port, kind, family: host === '::1' ? 'IPv6' : 'IPv4', ownedPid: process.pid })
      }
    }
    return { runId, endpoints, unavailable, stop }
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}
