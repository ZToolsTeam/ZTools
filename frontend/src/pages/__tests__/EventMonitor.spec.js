import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref, KeepAlive } from 'vue'
import EventMonitor from '../EventMonitor.vue'

describe('EventMonitor 生命周期与预计算渲染', () => {
  let handlers
  let onMock
  let offMock

  beforeEach(() => {
    handlers = new Set()
    onMock = vi.fn((event, fn) => {
      if (event === '*') handlers.add(fn)
    })
    offMock = vi.fn((event, fn) => {
      if (event === '*') handlers.delete(fn)
    })
    window.ztools = {
      events: {
        on: onMock,
        off: offMock,
        emit: vi.fn()
      },
      sys: {
        setDarkMode: vi.fn()
      }
    }
  })

  afterEach(() => {
    delete window.ztools
    vi.restoreAllMocks()
  })

  it('KeepAlive 挂载不重复注册，失活自动注销监听，重新激活后恢复并预计算 _seq/_formatted/_timeLabel', async () => {
    const active = ref(true)
    const Host = defineComponent({
      components: { KeepAlive, EventMonitor },
      setup: () => ({ active }),
      template: '<KeepAlive><EventMonitor v-if="active" /></KeepAlive>'
    })

    const wrapper = mount(Host)
    try {
      await flushPromises()
      // onMounted + onActivated 不重复注册
      expect(onMock).toHaveBeenCalledTimes(1)
      expect(handlers.size).toBe(1)

      const listener = [...handlers][0]
      listener({ type: 'plugin.loaded', timestamp: 1700000000000, payload: { id: 'a' } })
      listener({ type: 'plugin.ready', timestamp: 1700000001000, payload: { id: 'b' } })
      await flushPromises()

      const monitor = wrapper.findComponent(EventMonitor)
      expect(monitor.vm.events).toHaveLength(2)
      expect(monitor.vm.events[0]._seq).toBe(2)
      expect(monitor.vm.events[1]._seq).toBe(1)
      expect(monitor.vm.events[0]._formatted).toContain('"plugin.ready"')
      expect(monitor.vm.events[0]._formatted).not.toContain('"_seq"')
      expect(typeof monitor.vm.events[0]._timeLabel).toBe('string')
      expect(monitor.vm.events[0]._timeLabel.length).toBeGreaterThan(0)

      // 失活后注销通配事件监听，避免后台空转
      active.value = false
      await flushPromises()
      expect(offMock).toHaveBeenCalledTimes(1)
      expect(handlers.size).toBe(0)

      // 重新激活后重新订阅
      active.value = true
      await flushPromises()
      expect(onMock).toHaveBeenCalledTimes(2)
      expect(handlers.size).toBe(1)
    } finally {
      wrapper.unmount()
      expect(handlers.size).toBe(0)
    }
  })
})
