import test from 'node:test'
import assert from 'node:assert/strict'
import { listSystemVolumes, type VolumeDependencies } from '../../src/main/services/volume-service.js'

function macDeps(failing = ''): VolumeDependencies {
  return {
    async run(file) {
      if (file.endsWith('diskutil')) return 'plist'
      return JSON.stringify({ AllDisksAndPartitions: [
        { Content: 'Apple_APFS_Container', DeviceIdentifier: 'disk3', APFSVolumes: [
          { MountPoint: '/', VolumeName: 'System' },
          { MountPoint: '/System/Volumes/Data', VolumeName: 'Data' },
          { MountPoint: '/System/Volumes/VM', VolumeName: 'VM' },
          { MountPoint: '/Volumes/工作盘', VolumeName: '工作盘', MountedSnapshots: [{ SnapshotMountPoint: '/Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb' }] }
        ] },
        { Content: 'Apple_APFS_Container', DeviceIdentifier: 'disk7', APFSVolumes: [{ MountPoint: '/Volumes/外置盘', VolumeName: '外置盘' }] }
      ] })
    },
    async statfs(target) { if (target === failing) throw new Error('EACCES'); return { blocks: 100, bsize: 1024, bfree: 40, bavail: 35 } }
  }
}
test('挂载卷：macOS过滤 /System/Volumes/* 与快照，保留真实用户卷且同容器共享组', async () => {
  const result = await listSystemVolumes('darwin', macDeps())
  assert.deepEqual(result.volumes.map(v => v.path), ['/', '/Volumes/外置盘', '/Volumes/工作盘'])
  assert.equal(result.partial, false)
  assert.equal(result.volumes.find(v => v.path === '/')?.capacityGroup, 'disk3')
  assert.equal(result.volumes.find(v => v.path === '/Volumes/工作盘')?.capacityGroup, 'disk3')
  assert.equal(result.volumes.find(v => v.path === '/Volumes/外置盘')?.capacityGroup, 'disk7')
  assert.equal(result.volumes[0]?.totalBytes, 102400)
})
test('挂载卷：Windows包含Z盘和目录挂载点，过滤未挂载的 EFI/恢复分区 Volume GUID', async () => {
  const result = await listSystemVolumes('win32', { ...macDeps(), run: async () => JSON.stringify([
    { Name: '\\\\?\\Volume{d6386274-0000-0000-0000-100000000000}\\', Capacity: 104857600, FreeSpace: 50000000, FileSystem: 'FAT32', DeviceID: 'efi' },
    { Name: 'Z:\\', Capacity: 100, FreeSpace: 40, FileSystem: 'NTFS', DeviceID: 'v1' },
    { Name: 'C:\\mount\\', Capacity: 200, FreeSpace: 50, FileSystem: 'ReFS', DeviceID: 'v2' }
  ]) })
  assert.deepEqual(result.volumes.map(v => v.path), ['Z:\\', 'C:\\mount\\'])
  assert.equal(result.volumes[1]?.fileSystem, 'ReFS')
})
test('挂载卷：单卷无权限标partial，命令失败/损坏载荷不伪装空成功', async () => {
  const partial = await listSystemVolumes('darwin', macDeps('/Volumes/外置盘'))
  assert.equal(partial.partial, true)
  assert.match(partial.errors[0]!, /EACCES/)
  await assert.rejects(listSystemVolumes('darwin', { ...macDeps(), run: async () => { throw new Error('timeout') } }), /timeout/)
  await assert.rejects(listSystemVolumes('win32', { ...macDeps(), run: async () => '{' }))
})
test('挂载卷：Windows 单卷容量为 null（如 BitLocker 锁定）只标 partial，不按 0 显示成已用 100%，也不连累其它卷', async () => {
  const result = await listSystemVolumes('win32', { ...macDeps(), run: async () => JSON.stringify([
    { Name: 'C:\\', Capacity: 1000, FreeSpace: 400, FileSystem: 'NTFS', DeviceID: 'c' },
    { Name: 'D:\\', Capacity: 2000, FreeSpace: null, FileSystem: 'NTFS', DeviceID: 'd' },
    { Name: 'E:\\', Capacity: '3000', FreeSpace: 10, FileSystem: 'NTFS', DeviceID: 'e' },
    { Name: 'F:\\', Capacity: 100, FreeSpace: 200, FileSystem: 'NTFS', DeviceID: 'f' },
    { Name: 'relative', Capacity: 100, FreeSpace: 10 },
    'garbage'
  ]) })
  assert.deepEqual(result.volumes.map(v => v.path), ['C:\\'])
  assert.equal(result.volumes[0]?.usedBytes, 600)
  assert.equal(result.partial, true)
  assert.deepEqual(result.errors, ['D:\\: 卷容量读取失败', 'E:\\: 卷容量读取失败', 'F:\\: 卷容量读取失败', '挂载卷路径无效', '挂载卷数据无效'])
})
test('挂载卷：Windows 空输出 / 全部卷失败 / 命令失败如实报错', async () => {
  await assert.rejects(listSystemVolumes('win32', { ...macDeps(), run: async () => '' }), /没有读取到已挂载卷/)
  await assert.rejects(listSystemVolumes('win32', { ...macDeps(), run: async () => '\uFEFF{"Name":"C:\\\\","Capacity":100,"FreeSpace":null}' }), /C:\\: 卷容量读取失败/)
  await assert.rejects(listSystemVolumes('win32', { ...macDeps(), run: async () => 'Get-CimInstance : 拒绝访问' }), /不是有效 JSON/)
  await assert.rejects(listSystemVolumes('win32', { ...macDeps(), run: async () => { throw Object.assign(new Error('Command failed'), { code: 1 }) } }), /Command failed/)
})
