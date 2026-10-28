import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMacHotkey, parseHotkeyProbeRequest, type HotkeyProbeResult } from '../../src/contracts/hotkey-probe.js'
import { HotkeyProbeService, nativeHotkeyProbe } from '../../src/main/services/hotkey-probe-service.js'
import { SystemRegistryHostPluginHandler } from '../../src/main/services/host-plugins/system-registry-host.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'
function fixture() {
  const held = new Set(['Command+Space']), calls: string[][] = []
  const state = { ready: true, suspended: false, pending: false, fail: false }
  let finish: () => void = () => undefined
  const service = new HotkeyProbeService(async combos => {
    calls.push(combos)
    if (state.pending) await new Promise<void>(r => { finish=r })
    if (state.fail) throw new Error('系统检测失败')
    return combos.map(combo => ({ combo, status: combo==='Control+Space'?'system':'registered' } as HotkeyProbeResult))
  }, {isRegistered:c=>held.has(c),isSuspended:()=>state.suspended},()=>state.ready,'darwin')
  const call = (combos: string[], signal?: AbortSignal) => service.probe({ combos }, signal)
  return { held, calls, state, service, call, finish:()=>finish() }
}
test('Mac Cmd/Ctrl保持独立，别名/符号/按键规范化，Plus和F20可用', () => {
  assert.equal(normalizeMacHotkey(' Cmd + Option + K '),'Alt+Command+K')
  assert.equal(normalizeMacHotkey('Control+K'),'Control+K');assert.equal(normalizeMacHotkey('⌘+⇧+p'),'Shift+Command+P')
  assert.equal(normalizeMacHotkey('cmd+enter'),'Command+Return');assert.equal(normalizeMacHotkey('Ctrl+Plus'),'Control+Plus');assert.equal(normalizeMacHotkey('f20'),'F20')
  assert.deepEqual(parseHotkeyProbeRequest({combos:['Cmd+K','Command+K']}),['Command+K'])
  for(const combo of ['', 'Ctrl++','Win+L','CmdOrCtrl+A','Cmd+Ctrl+Shift','Cmd+⌘+K','Cmd+X+Y','F21','Alt+W+F+F','A','Cmd+K\n','Cmd+__proto__'])assert.throws(()=>normalizeMacHotkey(combo))
})
test('严格参数/完整批次先校验，不在遇到错误前做部分注册', async () => {
  const f=fixture()
  for(const value of [null,[],{}, {combos:[]},{combos:['Cmd+P'],mockProbed:[]},{combos:Array(33).fill('Cmd+P')},{combos:[4]},{combos:['Cmd+'+'A'.repeat(129)]}])await assert.rejects(f.service.probe(value))
  await assert.rejects(f.call(['Cmd+P','Cmd++']));assert.deepEqual(f.calls,[])
})
test('协议→服务→原生端口：已有绑定不注册不撤销，系统分配如实返回', async () => {
  const f=fixture(), result=await f.call(['Cmd+Space','Ctrl+Space','Shift+Cmd+P'])
  assert.deepEqual(result.results.map(r=>r.status),['owned','system','registered'])
  assert.deepEqual([...f.held],['Command+Space']);assert.deepEqual(f.calls,[['Control+Space','Shift+Command+P']])
})
test('并发请求互斥，失败/取消清理busy，迟到结果丢弃', async () => {
  const f=fixture();f.state.pending=true;const abort=new AbortController(), pending=f.call(['Cmd+P'],abort.signal)
  await assert.rejects(f.call(['Cmd+K']),/正在检测/);abort.abort();f.finish();await assert.rejects(pending,/取消/)
  f.state.pending=false;f.state.fail=true;await assert.rejects(f.call(['Cmd+P']),/系统检测失败/);f.state.fail=false;assert.equal((await f.call(['Cmd+P'])).success,true)
})
test('取消、未ready、暂停不探测；原生文件缺失明确失败', async () => {
  const f=fixture(), abort=new AbortController();abort.abort();await assert.rejects(f.call(['Cmd+P'],abort.signal),/取消/)
  f.state.ready=false;await assert.rejects(f.call(['Cmd+P']),/就绪/);f.state.ready=true;f.state.suspended=true;await assert.rejects(f.call(['Cmd+P']),/暂停/);assert.deepEqual(f.calls,[])
  await assert.rejects(nativeHotkeyProbe('/nonexistent-ztools-hotkey-component')(['Command+P']),/ENOENT/)
})
test('Mac旧DLL兼容入口失败关闭，不接受假探测和假结束进程', {skip:process.platform!=='darwin'}, async()=>{
  const handler=new SystemRegistryHostPluginHandler({} as HostPluginContext)
  for(const fn of ['probeHotkeys','killSuspectProcess']) {
    const result=await handler.handleHotkeyRadar(fn,{pid:99999,mockProbed:[{isOccupied:false}],simulateOnly:true}) as {success:boolean;error:string}
    assert.equal(result.success,false);assert.match(result.error,/旧接口不支持/)
  }
})
