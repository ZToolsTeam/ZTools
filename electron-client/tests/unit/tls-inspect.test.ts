import test, { before, after, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { inspectTls, TlsInspectService } from '../../src/main/services/tls-inspect-service.js'
import { validateTlsInspectRequest, type TlsInspection } from '../../src/contracts/tls-inspect.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { canCall, type CallerIdentity } from '../../src/contracts/capabilities.js'

let directory: string, key: Buffer, cert: Buffer
const caller: CallerIdentity = { type: 'plugin', webContentsId: 701, pluginId: 'ssl-domain-check', pluginInstanceId: 'tls-test' }
const signal = () => new AbortController().signal
const request = (port: number, domain = 'fixture.example') => ({ action: 'inspect' as const, operationId: randomUUID(), domain, port, timeoutMs: 1000 })
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-tls-test-'))
  await fs.writeFile(path.join(directory, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=fixture.example\n[ext]\nsubjectAltName=DNS:fixture.example\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', path.join(directory, 'cert.cnf'), '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')], { stdio: 'ignore', timeout: 15000 })
  await fs.chmod(path.join(directory, 'key.pem'), 0o600)
  key = await fs.readFile(path.join(directory, 'key.pem')); cert = await fs.readFile(path.join(directory, 'cert.pem'))
})
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }) })
async function server(t: TestContext, plain = false) {
  const sockets = new Set<net.Socket>(), received: Buffer[] = []
  const instance = plain ? net.createServer() : tls.createServer({ key, cert }, socket => socket.on('data', data => received.push(data)))
  instance.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  // 主动取消握手时服务端可收到 reset；此事件只收集测试连接状态。
  instance.on('tlsClientError', error => { assert.ok(error instanceof Error) })
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => instance.close(() => resolve())) })
  return { port: (instance.address() as net.AddressInfo).port, received, sockets }
}
const trusted = (options: tls.ConnectionOptions) => tls.connect({ ...options, host: '127.0.0.1', ca: cert })

test('现代 IPC 参数封闭，拒绝选项注入、非数值端口与无界超时', () => {
  const valid = request(443)
  validateMethodParams('tls_inspect', valid); assert.equal(canCall('tls_inspect', caller), true)
  for (const invalid of [null, [], { ...valid, domain: 'x; touch bad' }, { ...valid, domain: 'x'.repeat(254) }, { ...valid, port: 0 }, { ...valid, port: '443' }, { ...valid, timeoutMs: 0 }, { ...valid, timeoutMs: 15001 }, { ...valid, rejectUnauthorized: false }, { action: 'cancel', operationId: valid.operationId, domain: 'x' }]) assert.throws(() => validateTlsInspectRequest(invalid))
})
test('真实 TLS 握手返回证书、协议、信任与主机名验证，不发送应用数据', async t => {
  const f = await server(t), result = await inspectTls(request(f.port), signal(), trusted)
  assert.equal(result.domain, 'fixture.example'); assert.equal(result.port, f.port)
  assert.equal(result.authorized, true); assert.equal(result.hostnameMatches, true); assert.equal(result.authorizationError, '')
  assert.equal(result.subjectCN, 'fixture.example'); assert.match(result.subjectAltName, /fixture\.example/)
  assert.match(result.protocol, /^TLSv1\.[23]$/); assert.match(result.fingerprint256, /^[A-F0-9:]+$/)
  assert.equal(result.chain.length, 1); assert.equal(result.chainTruncated, false); assert.equal(f.received.length, 0)
})
test('自签名与名称不匹配仍可诊断，但绝不标记可信', async t => {
  const f = await server(t)
  const selfSigned = await inspectTls(request(f.port), signal(), options => tls.connect({ ...options, host: '127.0.0.1' }))
  assert.equal(selfSigned.authorized, false); assert.ok(selfSigned.authorizationError); assert.equal(selfSigned.hostnameMatches, true)
  const mismatch = await inspectTls(request(f.port, 'wrong.example'), signal(), trusted)
  assert.equal(mismatch.authorized, false); assert.equal(mismatch.hostnameMatches, false); assert.match(mismatch.authorizationError, /ALTNAME/)
})
test('TCP 不完成 TLS 时整体超时；取消和启动失败不会遗留调用', async t => {
  const f = await server(t, true), start = Date.now()
  await assert.rejects(inspectTls(request(f.port), signal(), trusted), /超时/)
  assert.ok(Date.now() - start < 2500)
  const controller = new AbortController(); controller.abort()
  assert.throws(() => inspectTls(request(f.port), controller.signal, trusted))
  await assert.rejects(inspectTls(request(f.port), signal(), () => { throw new Error('fixture connect failed') }), /fixture connect failed/)
})
test('真实服务取消只作用于调用窗口，取消后可再次执行', async t => {
  const f = await server(t, true), service = new TlsInspectService(trusted), req = request(f.port)
  t.after(() => service.stop())
  const active = service.handle(req, caller, signal()), rejected = assert.rejects(active, /取消/)
  assert.deepEqual(await service.handle({ action: 'cancel', operationId: req.operationId }, { ...caller, webContentsId: 702 }, signal()), { success: true, cancelled: false })
  await assert.rejects(service.handle(req, caller, signal()), /请求过多/)
  assert.deepEqual(await service.handle({ action: 'cancel', operationId: req.operationId }, caller, signal()), { success: true, cancelled: true })
  await rejected
  const live = await server(t)
  const result = await service.handle(request(live.port), caller, signal()) as { cert: TlsInspection }
  assert.equal(result.cert.authorized, true)
})
test('窗口关闭、停止与并发上限结束真实连接；停止后不接受新请求', async t => {
  const f = await server(t, true), service = new TlsInspectService(trusted)
  t.after(() => service.stop())
  const jobs = Array.from({ length: 8 }, () => service.handle(request(f.port), caller, signal()))
  const settled = Promise.allSettled(jobs)
  await assert.rejects(service.handle(request(f.port), caller, signal()), /请求过多/)
  service.closeOwner(caller.webContentsId); await service.stop()
  assert.ok((await settled).every(result => result.status === 'rejected'))
  await assert.rejects(service.handle(request(f.port), caller, signal()), /已停止/)
})
