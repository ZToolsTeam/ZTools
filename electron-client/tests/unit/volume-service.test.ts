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
