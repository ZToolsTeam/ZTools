import { describe, expect, it, vi } from 'vitest'
import PluginAPI from '../../../public/js/cef-ipc/src/api/plugin'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update'

describe('插件安装完整性契约', () => {
  it('安装请求允许不提供 SHA-256', async () => {
    const transport = { call: vi.fn().mockResolvedValue({ success: true }) }
    const api = new PluginAPI(transport)

    await api.install('plugin.test', 'https://cdn.example/plugin.zip', {
      version: '1.2.3',
      fileSize: 1234,
    })

    expect(transport.call).toHaveBeenCalledWith('plugin_install', {
      pluginId: 'plugin.test',
      url: 'https://cdn.example/plugin.zip',
      version: '1.2.3',
      fileSize: 1234,
      checksum: ''
    })
  })

  it('更新请求兼容 snake_case 并允许不提供 SHA-256', async () => {
    const transport = { call: vi.fn().mockResolvedValue({ success: true }) }
    const api = new UpdateAPI(transport)

    await expect(
      api.downloadPlugin('plugin.test', {
        download_url: 'https://cdn.example/plugin.zip',
        version: '2.0.0',
        file_size: 5678
      })
    ).resolves.toBe(true)

    expect(transport.call).toHaveBeenCalledWith('plugin_update', {
      pluginId: 'plugin.test',
      url: 'https://cdn.example/plugin.zip',
      version: '2.0.0',
      fileSize: 5678,
      checksum: ''
    })
  })

  it('应用更新先下载再启动外部安装器', async () => {
    const transport = {
      call: vi.fn()
        .mockResolvedValueOnce({ success: true, operationId: 'download-1', status: 'downloaded' })
        .mockResolvedValueOnce({ success: true, operationId: 'download-1', state: 'started', restartRequired: true })
    }
    const api = new UpdateAPI(transport)
    const info = {
      version: '2.0.0',
      downloadUrl: 'https://cdn.example/ZToolsSetup.exe',
      checksum: 'c'.repeat(64),
      fileSize: 2048
    }

    await expect(api.downloadAndInstall(info)).resolves.toMatchObject({
      success: true,
      state: 'started'
    })
    expect(transport.call).toHaveBeenNthCalledWith(1, 'update_download_start', {
      type: 'app',
      ...info
    })
    expect(transport.call).toHaveBeenNthCalledWith(2, 'update_install_start', {
      type: 'app',
      ...info
    }, { timeout: Infinity })
  })

  it('历史数据恢复只透传明确的资产列表', async () => {
    const transport = { call: vi.fn().mockResolvedValue({ success: true }) }
    const api = new PluginAPI(transport)

    await api.listPreservedData('plugin.test')
    await api.restorePreservedData('plugin.test', 'snapshot-1', ['user-data.json', 'settings'])

    expect(transport.call).toHaveBeenNthCalledWith(1, 'plugin_data_list', {
      pluginId: 'plugin.test'
    })
    expect(transport.call).toHaveBeenNthCalledWith(2, 'plugin_data_restore', {
      pluginId: 'plugin.test',
      preservationId: 'snapshot-1',
      assets: ['user-data.json', 'settings']
    })
  })
})
