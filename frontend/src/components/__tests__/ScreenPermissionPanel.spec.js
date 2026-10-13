import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import ScreenPermissionPanel from '../ScreenPermissionPanel.vue'

const grant = {
  grantId: 'opaque-grant-id-0123456789abcdef',
  capability: 'screen.capture',
  pluginId: 'sample-plugin',
  pluginName: 'Sample <Plugin>',
  grantedAt: 10
}

const ButtonStub = defineComponent({
  props: ['loading', 'disabled', 'danger', 'size'],
  emits: ['click'],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
})

describe('ScreenPermissionPanel', () => {
  let originalZtools

  afterEach(() => {
    window.ztools = originalZtools
  })

  function fixture(overrides = {}) {
    originalZtools = window.ztools
    const listeners = new Map()
    const lists = overrides.listCapabilityGrants || vi.fn()
      .mockResolvedValueOnce({ success: true, grants: [grant] })
      .mockResolvedValue({ success: true, grants: [] })
    const revoke = overrides.revokeCapabilityGrant || vi.fn().mockResolvedValue({ success: true, revoked: true })
    const sdk = {
      isElectron: () => true,
      sys: {
        getCapability: vi.fn().mockResolvedValue({
          contractVersion: 1,
          capability: 'screen.capture',
          implementation: 'supported',
          authorization: 'unknown',
          osPermission: 'not-required',
          revision: 1,
          target: { platform: 'windows', runtime: 'electron', arch: 'x64' }
        }),
        listCapabilityGrants: lists,
        revokeCapabilityGrant: revoke
      },
      events: {
        on: vi.fn((name, listener) => listeners.set(listener, name)),
        off: vi.fn(listener => listeners.delete(listener))
      }
    }
    window.ztools = sdk
    const wrapper = mount(ScreenPermissionPanel, {
      global: {
        stubs: {
          ACard: { props: ['title'], template: '<section><slot /></section>' },
          ASpace: { props: ['direction'], template: '<div><slot /></div>' },
          AAlert: { props: ['message'], template: '<p>{{ message }}</p>' },
          AButton: ButtonStub
        }
      }
    })
    return { sdk, listeners, wrapper }
  }

  it('shows OS state separately from instance grants and revokes only through Main management', async () => {
    const f = fixture()
    await flushPromises()
    expect(f.wrapper.get('[data-testid="screen-permission-status"]').text()).toContain('无需申请')
    expect(f.wrapper.get('[data-testid="screen-authorization-status"]').text()).toContain('单独管理')
    expect(f.wrapper.get('[data-testid="screen-authorization-status"]').text()).not.toContain('状态未知')
    expect(f.wrapper.findAll('[data-testid="screen-permission-grant"]')).toHaveLength(1)
    expect(f.wrapper.get('[data-testid="screen-permission-grant-plugin"]').text()).toBe('Sample <Plugin>')

    await f.wrapper.get('[data-testid="screen-permission-grant-revoke"]').trigger('click')
    await flushPromises()
    expect(f.sdk.sys.revokeCapabilityGrant).toHaveBeenCalledWith(grant.grantId)
    expect(f.sdk.sys.listCapabilityGrants).toHaveBeenCalledTimes(2)
    expect(f.wrapper.text()).toContain('当前没有已授权的插件')
    f.wrapper.unmount()
    expect(f.sdk.events.off).toHaveBeenCalledTimes(2)
  })

  it('refreshes the instance grant list only after a host permission event', async () => {
    const f = fixture()
    await flushPromises()
    const listeners = [...f.listeners.keys()].filter(listener => f.listeners.get(listener) === 'runtime_permission_changed')
    expect(listeners).toHaveLength(2)
    for (const listener of listeners) listener({ source: { kind: 'plugin' }, payload: { capability: 'screen.capture' } })
    await flushPromises()
    expect(f.sdk.sys.listCapabilityGrants).toHaveBeenCalledTimes(1)
    for (const listener of listeners) listener({ source: { kind: 'host' }, payload: { capability: 'screen.capture', revision: 2 } })
    await flushPromises()
    expect(f.sdk.sys.listCapabilityGrants).toHaveBeenCalledTimes(2)
    f.wrapper.unmount()
  })

  it('serializes revoke clicks for one grant and lets the latest refresh response win', async () => {
    let resolveRevoke
    let resolveFirstList
    let resolveSecondList
    const lists = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirstList = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecondList = resolve }))
      .mockResolvedValue({ success: true, grants: [] })
    const revoke = vi.fn(() => new Promise(resolve => { resolveRevoke = resolve }))
    const f = fixture({ listCapabilityGrants: lists, revokeCapabilityGrant: revoke })
    await flushPromises()
    const listeners = [...f.listeners.keys()].filter(listener => f.listeners.get(listener) === 'runtime_permission_changed')
    for (const listener of listeners) listener({ source: { kind: 'host' }, payload: { capability: 'screen.capture', revision: 2 } })
    expect(lists).toHaveBeenCalledTimes(2)
    resolveSecondList({ success: true, grants: [grant] })
    await flushPromises()
    resolveFirstList({ success: true, grants: [{ ...grant, pluginName: 'Stale plugin' }] })
    await flushPromises()
    expect(f.wrapper.get('[data-testid="screen-permission-grant-plugin"]').text()).toBe(grant.pluginName)

    const button = f.wrapper.get('[data-testid="screen-permission-grant-revoke"]')
    await button.trigger('click')
    await button.trigger('click')
    expect(revoke).toHaveBeenCalledTimes(1)
    resolveRevoke({ success: true, revoked: true })
    await flushPromises()
    expect(lists).toHaveBeenCalledTimes(3)
    f.wrapper.unmount()
  })

  it('ignores a revoke completion after the settings panel is unmounted', async () => {
    let resolveRevoke
    const lists = vi.fn().mockResolvedValue({ success: true, grants: [grant] })
    const revoke = vi.fn(() => new Promise(resolve => { resolveRevoke = resolve }))
    const f = fixture({ listCapabilityGrants: lists, revokeCapabilityGrant: revoke })
    await flushPromises()
    await f.wrapper.get('[data-testid="screen-permission-grant-revoke"]').trigger('click')
    expect(revoke).toHaveBeenCalledTimes(1)
    f.wrapper.unmount()
    resolveRevoke({ success: true, revoked: true })
    await flushPromises()
    expect(lists).toHaveBeenCalledTimes(1)
  })

  it('handles revoke failure gracefully and displays user-friendly error message', async () => {
    const lists = vi.fn().mockResolvedValue({ success: true, grants: [grant] })
    const revoke = vi.fn().mockRejectedValue(new Error('IPC管道断开连接'))
    const f = fixture({ listCapabilityGrants: lists, revokeCapabilityGrant: revoke })
    await flushPromises()

    await f.wrapper.get('[data-testid="screen-permission-grant-revoke"]').trigger('click')
    await flushPromises()

    expect(f.wrapper.text()).toContain('撤销失败：IPC管道断开连接')
    f.wrapper.unmount()
  })

  it('handles grant listing failure gracefully and displays friendly error', async () => {
    const lists = vi.fn().mockRejectedValue(new Error('Network error'))
    const f = fixture({ listCapabilityGrants: lists })
    await flushPromises()

    expect(f.wrapper.text()).toContain('获取已授权插件失败')
    f.wrapper.unmount()
  })
})
