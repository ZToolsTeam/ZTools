import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
function fixture(call: (method:string,params:unknown)=>Promise<unknown>) {
 const source=fs.readFileSync('../frontend/public/js/cef-ipc/src/api/process.js','utf8').replace(/^export .+$/mg,'')
 const Api=vm.runInNewContext(source+String.fromCharCode(10)+'ProcessAPI',{window:{},console}) as new(transport:unknown)=>{list():Promise<unknown[]>}
 return new Api({call})
}
test('public process list forwards the existing method and retains field availability',async()=>{
 const rows=[{pid:42,name:'Fixture',cpuUsage:220.5,memoryUsage:1024,path:'',fieldAvailability:{path:false,cpuUsage:true,memoryUsage:true}}]
 const api=fixture(async(method,params)=>{assert.equal(method,'process_list');assert.equal(JSON.stringify(params),'{}');return {success:true,data:rows}})
 assert.equal(await api.list(),rows)
})
test('public process list rejects failed/missing/oversized payloads instead of a fake empty list',async()=>{
 for(const response of [undefined,{success:false,data:[]},{success:true},{success:true,data:{}},{success:true,data:Array(10001).fill(null)}]) {
  await assert.rejects(fixture(async()=>response).list(),{code:'PROCESS_ERROR'})
 }
 assert.equal((await fixture(async()=>({success:true,data:[]})).list()).length,0)
})
test('public process list preserves the native provider permission error',async()=>{
 const error=Object.assign(new Error('denied'),{code:'PERMISSION_DENIED'})
 await assert.rejects(fixture(async()=>{throw error}).list(),error)
})
