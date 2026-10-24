import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { MacVisionRunner } from '../../src/main/platform/macos/vision-runner.js'
const request = { version: 1 as const, operation: 'languages' as const }, signal = () => new AbortController().signal
function runner(script: string, timeoutMs = 10000) {
  let pid: number | undefined, closed = false
  const value = new MacVisionRunner(process.execPath, { platform: 'darwin', timeoutMs, spawn: () => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe', shell: false, windowsHide: true }); pid = child.pid; child.once('close', () => { closed = true }); return child
  } })
  return { value, pid: () => pid, closed: () => closed }
}
test('Vision runner refuses Windows and preaborted calls without launching any child', async () => {
  let calls = 0; const r = new MacVisionRunner(process.execPath, { platform: 'win32', spawn: () => { calls++; throw new Error('must not launch') } })
  await assert.rejects(r.run(request, signal()), { code: 'NOT_SUPPORTED' }); assert.equal(calls, 0)
  const c = new AbortController(); c.abort(); const f = runner('throw Error()'); await assert.rejects(f.value.run(request, c.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.pid(), undefined)
})
test('Vision private protocol writes stdin and waits for actual owned process exit', async () => {
  const f = runner(`let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const q=JSON.parse(s);if(q.operation!=='languages')process.exit(3);process.stdout.write(JSON.stringify({version:1,success:true,provider:'apple-vision-local',revision:3,languages:['en-US']}));setTimeout(()=>process.exit(0),30)})`)
  assert.equal((await f.value.run(request, signal()) as { success: boolean }).success, true); assert.equal(f.closed(), true)
})
test('Vision runner cancellation kills only its owned helper and drains before rejection', async () => {
  const f = runner('process.stdin.resume();setInterval(()=>{},1000)'), controller = new AbortController()
  const pending = f.value.run(request, controller.signal); const rejected = assert.rejects(pending, { code: 'CALLER_DESTROYED' }); controller.abort(); await rejected; assert.equal(f.closed(), true)
})
test('Vision timeout is bounded and waits for helper close', async () => {
  const f = runner('process.stdin.resume();setInterval(()=>{},1000)', 50); await assert.rejects(f.value.run(request, signal()), { code: 'REQUEST_TIMEOUT' }); assert.equal(f.closed(), true)
})
test('Vision rejects malformed/duplicate/nonzero/oversized outputs and unsupported language honestly', async () => {
  for (const script of [`process.stdout.write('not-json')`, `process.stdout.write('{"version":1,"success":true}{"version":1}')`, `process.stdout.write('{"version":1,"success":true}');process.exitCode=1`, `process.stdout.write('x'.repeat(4*1024*1024+1))`]) {
    const f = runner(script); await assert.rejects(f.value.run(request, signal()), { code: 'FILE_ERROR' }); assert.equal(f.closed(), true)
  }
  const f = runner(`process.stdout.write('{"version":1,"success":false,"code":"LANGUAGE_UNSUPPORTED"}');process.exitCode=1`); await assert.rejects(f.value.run(request, signal()), { code: 'INVALID_REQUEST' })
})
