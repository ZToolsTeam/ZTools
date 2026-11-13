import assert from 'node:assert/strict'
import net from 'node:net'
import dgram from 'node:dgram'
import test from 'node:test'
import { startLoopbackFixtures } from './macos-loopback-fixtures.mjs'

test('owned TCP/UDP IPv4/IPv6 fixtures echo locally and stop every open resource', async () => {
  const fixture = await startLoopbackFixtures()
  try {
    assert.ok(fixture.endpoints.some(e => e.kind === 'tcp' && e.family === 'IPv4'))
    assert.ok(fixture.endpoints.some(e => e.kind === 'udp' && e.family === 'IPv4'))
    for (const endpoint of fixture.endpoints) {
      const response = await new Promise((resolve, reject) => {
        const socket = endpoint.kind === 'tcp' ? net.createConnection({ host: endpoint.host, port: endpoint.port }) : dgram.createSocket(endpoint.family === 'IPv6' ? 'udp6' : 'udp4')
        const dispose = () => endpoint.kind === 'tcp' ? socket.destroy() : socket.close()
        const timer = setTimeout(() => { dispose(); reject(new Error('echo timeout')) }, 2000)
        socket.once('error', error => { clearTimeout(timer); dispose(); reject(error) })
        socket.once(endpoint.kind === 'tcp' ? 'data' : 'message', data => { clearTimeout(timer); dispose(); resolve(data.toString()) })
        if (endpoint.kind === 'tcp') socket.once('connect', () => socket.write('synthetic'))
        else socket.send('synthetic', endpoint.port, endpoint.host)
      })
      assert.equal(response, 'synthetic')
      assert.equal(endpoint.ownedPid, process.pid)
    }
  } finally { assert.equal((await fixture.stop()).status, 'OWNED_RESOURCES_CLOSED') }
  assert.equal((await fixture.stop()).status, 'OWNED_RESOURCES_CLOSED')
  for (const endpoint of fixture.endpoints.filter(e => e.kind === 'tcp')) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
      socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error) })
      socket.once('connect', () => { socket.destroy(); reject(new Error('owned port leaked')) })
    })
  }
})
