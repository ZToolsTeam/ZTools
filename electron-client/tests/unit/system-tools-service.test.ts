import assert from 'node:assert/strict'
import test from 'node:test'
import { SystemToolsService } from '../../src/main/services/system-tools-service.js'

test('lists the legacy allowlisted system tool targets', async () => {
  const service = new SystemToolsService({
    openExternal: async () => undefined,
    launchProcess: async () => ''
  }, 'win32')

  const result = await service.listTargets()
  assert.equal(result.success, true)
  assert.equal(result.os.isWindows11, result.os.build >= 22000)
  assert.ok(result.targets.length >= 40)
  assert.equal(result.targets.find((target) => target.id === 'this_pc')?.name, '此电脑')
  assert.equal(result.targets.find((target) => target.id === 'settings')?.category, 'core')
})

test('opens only fixed system tool candidates without shell arguments', async () => {
  const externalUrls: string[] = []
  const launches: Array<{ file: string; args: readonly string[] }> = []
  const service = new SystemToolsService({
    openExternal: async (url) => { externalUrls.push(url) },
    launchProcess: async (file, args) => {
      launches.push({ file, args })
      return ''
    }
  }, 'win32')

  const settings = await service.openTarget('settings')
  assert.equal(settings.launcher, 'settings_uri')
  assert.deepEqual(externalUrls, ['ms-settings:'])

  const thisPc = await service.openTarget('this_pc')
  assert.equal(thisPc.launcher, 'primary')
  assert.equal(launches[0]?.args[0], 'shell:MyComputerFolder')
  assert.equal(launches[0]?.file.toLowerCase().endsWith('explorer.exe'), true)

  await assert.rejects(service.openTarget('not-a-real-target'), /未知系统工具/)
})

test('reads and caches icons only for fixed system tool ids', async () => {
  const iconSources: string[] = []
  const service = new SystemToolsService({
    openExternal: async () => undefined,
    launchProcess: async () => ''
  }, 'win32', async (source) => {
    iconSources.push(source)
    return 'data:image/png;base64,AA=='
  })

  assert.equal(await service.getIcon('not-a-real-target'), '')
  assert.equal(await service.getIcon('this_pc'), 'data:image/png;base64,AA==')
  assert.equal(await service.getIcon('this_pc'), 'data:image/png;base64,AA==')
  assert.equal(iconSources.length, 1)
  assert.match(iconSources[0] ?? '', /shell:MyComputerFolder/)
})
