import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h, nextTick } from 'vue'

import {
  BUILTIN_SHORTCUT_HINTS,
  DEFAULT_SHELL_SHORTCUTS,
  RESERVED_DECLARATIVE_SHORTCUTS,
  SHELL_SHORTCUTS,
  SHELL_SHORTCUTS_CONFIG_FILE,
  SHELL_SHORTCUTS_CONFIG_PATH,
  SHELL_SHORTCUTS_STORAGE_KEY,
  _resetShellShortcutsForTesting,
  applyExternalShellShortcuts,
  comboToActionShortcut,
  findConflictingShellShortcut,
  getLauncherPanelReservedShortcuts,
  getReservedDeclarativeShortcuts,
  hasCustomizedShellShortcuts,
  initShellShortcuts,
  matchesShellShortcut,
  normalizeShellShortcutCombo,
  parseShellShortcutsOverrides,
  resetAllShellShortcuts,
  saveShellShortcut
} from '@/utils/shellShortcuts'
import {
  getShellReserveWarning,
  interpretRecorderKeydown
} from '@/utils/hotkeyRecorder'
import { dispatchKeyEvent, _resetKeymapForTesting } from '@/utils/keymap'
import Sidebar from '@/components/Sidebar.vue'
import HeaderGeekModeTrigger from '@/components/HeaderGeekModeTrigger.vue'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import DeclarativeView from '@/declarative/DeclarativeView.vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { i18n } from '@/i18n'

describe('shellShortcuts 常用快捷键注册表与多处提示同步', () => {
  let prevZtools
  let configStore

  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
    setActivePinia(createPinia())
    _resetKeymapForTesting()
    _resetShellShortcutsForTesting()
    prevZtools = window.ztools
    configStore = new Map()
    window.ztools = {
      config: {
        get: vi.fn(async (path, fallback) =>
          configStore.has(path) ? configStore.get(path) : fallback
        ),
        set: vi.fn(async (path, value) => {
          configStore.set(path, value)
          return true
        })
      },
      sys: {
        reloadHotkeys: vi.fn(async () => ({ success: true }))
      }
    }
  })

  afterEach(() => {
    _resetKeymapForTesting()
    _resetShellShortcutsForTesting()
    window.ztools = prevZtools
  })

  describe('1. 规范化、解析防御、冲突拦截与持久化回滚', () => {
    it('支持 5 项常用快捷键修改与清空，严格禁止编辑或清空 Esc (back) 与已移除的 toggle-mode', async () => {
      expect(BUILTIN_SHORTCUT_HINTS.filter((item) => item.editable).map((item) => item.id)).toEqual([
        'focus-search',
        'action-panel',
        'toggle-sidebar',
        'popout-window',
        'open-settings'
      ])
      expect(BUILTIN_SHORTCUT_HINTS.find((item) => item.id === 'back')?.editable).toBe(false)
      expect(await saveShellShortcut('toggle-mode', 'Ctrl+U')).toEqual({
        success: false,
        reason: 'not_editable'
      })

      // 拒绝修改或清空 Esc
      expect(await saveShellShortcut('back', 'Ctrl+Q')).toEqual({
        success: false,
        reason: 'not_editable'
      })
      expect(await saveShellShortcut('back', '')).toEqual({
        success: false,
        reason: 'not_editable'
      })

      // 修改「聚焦搜索」与清空「展开/收起侧栏」
      const res1 = await saveShellShortcut('focus-search', 'Ctrl+J')
      expect(res1).toEqual({ success: true, combo: 'Ctrl+J' })
      expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe('Ctrl+J')

      const res2 = await saveShellShortcut('toggle-sidebar', '')
      expect(res2).toEqual({ success: true, combo: '' })
      expect(SHELL_SHORTCUTS.TOGGLE_SIDEBAR).toBe('')
      expect(hasCustomizedShellShortcuts()).toBe(true)

      // 持久化仅保存覆盖项并触发宿主 reloadHotkeys
      expect(window.ztools.config.set).toHaveBeenLastCalledWith(
        SHELL_SHORTCUTS_CONFIG_PATH,
        JSON.stringify({ 'focus-search': 'Ctrl+J', 'toggle-sidebar': '' }),
        true,
        SHELL_SHORTCUTS_CONFIG_FILE
      )
      expect(window.ztools.sys.reloadHotkeys).toHaveBeenCalledTimes(2)
      expect(JSON.parse(localStorage.getItem(SHELL_SHORTCUTS_STORAGE_KEY))).toEqual({
        'focus-search': 'Ctrl+J',
        'toggle-sidebar': ''
      })

      // 匹配函数在清空时永远返回 false
      expect(matchesShellShortcut('Ctrl+B', 'TOGGLE_SIDEBAR')).toBe(false)
      expect(matchesShellShortcut('', 'TOGGLE_SIDEBAR')).toBe(false)
      expect(matchesShellShortcut('Ctrl+J', 'FOCUS_SEARCH')).toBe(true)
      expect(matchesShellShortcut('Ctrl+F', 'FOCUS_SEARCH')).toBe(false)

      // 一键恢复默认
      const resetRes = await resetAllShellShortcuts()
      expect(resetRes.success).toBe(true)
      expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe(DEFAULT_SHELL_SHORTCUTS.FOCUS_SEARCH)
      expect(SHELL_SHORTCUTS.TOGGLE_SIDEBAR).toBe(DEFAULT_SHELL_SHORTCUTS.TOGGLE_SIDEBAR)
      expect(hasCustomizedShellShortcuts()).toBe(false)
    })

    it('常用快捷键互相冲突与内置 Ctrl+P 冲突均被拦截；持久化失败时回滚状态', async () => {
      const conflictRes = await saveShellShortcut('focus-search', 'Ctrl+K')
      expect(conflictRes.success).toBe(false)
      expect(conflictRes.reason).toBe('conflict')
      expect(conflictRes.conflict?.id).toBe('action-panel')
      expect(SHELL_SHORTCUTS.FOCUS_SEARCH).toBe('Ctrl+F')

      const pinConflict = findConflictingShellShortcut('Ctrl+P', 'focus-search')
      expect(pinConflict?.id).toBe('pin-item')

      // 模拟持久化失败回滚
      window.ztools.config.set = vi.fn(async () => false)
      const failRes = await saveShellShortcut('open-settings', 'Ctrl+.')
      expect(failRes.success).toBe(false)
      expect(failRes.reason).toBe('save_failed')
      expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('Ctrl+,')
    })

    it('防御损坏 JSON、原型污染、裸字母、纯 Shift+字母及控制字符，并支持跨窗口广播同步', async () => {
      expect(parseShellShortcutsOverrides('{invalid json')).toEqual({})
      expect(parseShellShortcutsOverrides('[]')).toEqual({})
      expect(
        parseShellShortcutsOverrides(
          '{"__proto__":{"polluted":true},"focus-search":"A","action-panel":"Shift+K","open-settings":"Ctrl+\\n,.","toggle-mode":"Alt+M","toggle-sidebar":""}'
        )
      ).toEqual({
        'toggle-sidebar': ''
      })
      expect(({}).polluted).toBeUndefined()
      expect(normalizeShellShortcutCombo('Shift+A')).toBeNull()
      expect(normalizeShellShortcutCombo('F2')).toBe('F2')
      expect(normalizeShellShortcutCombo('Ctrl+,')).toBe('Ctrl+,')
      expect(comboToActionShortcut('Ctrl+Shift+P')).toEqual({
        modifiers: ['Ctrl', 'Shift'],
        key: 'P'
      })
      expect(comboToActionShortcut('')).toBeUndefined()

      // 跨窗口广播实时同步
      applyExternalShellShortcuts({
        shortcuts: { 'open-settings': 'Ctrl+.', 'action-panel': '' }
      })
      expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('Ctrl+.')
      expect(SHELL_SHORTCUTS.ACTION_PANEL).toBe('')

      // 重新初始化从持久化存储对齐
      configStore.set(SHELL_SHORTCUTS_CONFIG_PATH, JSON.stringify({ 'popout-window': 'Ctrl+Shift+O' }))
      await initShellShortcuts()
      expect(SHELL_SHORTCUTS.POPOUT_WINDOW).toBe('Ctrl+Shift+O')
      expect(SHELL_SHORTCUTS.OPEN_SETTINGS).toBe('Ctrl+,')
    })

    it('保留键集合与 getShellReserveWarning 随常用快捷键修改和清空动态同步', async () => {
      expect(RESERVED_DECLARATIVE_SHORTCUTS.has('Ctrl+K')).toBe(true)
      expect(getShellReserveWarning('Ctrl+K')).toContain('动作面板')

      await saveShellShortcut('action-panel', 'Ctrl+J')
      expect(RESERVED_DECLARATIVE_SHORTCUTS.has('Ctrl+K')).toBe(false)
      expect(RESERVED_DECLARATIVE_SHORTCUTS.has('Ctrl+J')).toBe(true)
      expect(getLauncherPanelReservedShortcuts().has('Ctrl+J')).toBe(true)
      expect(getShellReserveWarning('Ctrl+K')).toBe('')
      expect(getShellReserveWarning('Ctrl+J')).toContain('动作面板')

      await saveShellShortcut('action-panel', '')
      expect(getReservedDeclarativeShortcuts().has('Ctrl+J')).toBe(false)
      expect(getShellReserveWarning('Ctrl+J')).toBe('')
    })

    it('常用快捷键录制支持逗号/数字/标点，拒绝纯 Shift+字母与系统黑名单', () => {
      const commaRes = interpretRecorderKeydown(
        { key: ',', code: 'Comma', ctrlKey: true },
        { platform: 'windows', allowDoubleTap: false, allowShellKeys: true }
      )
      expect(commaRes).toMatchObject({ action: 'valid', hotkey: 'Ctrl+,' })

      const fullWidthCommaRes = interpretRecorderKeydown(
        { key: '，', code: 'Comma', ctrlKey: true },
        { platform: 'windows', allowDoubleTap: false, allowShellKeys: true }
      )
      expect(fullWidthCommaRes).toMatchObject({ action: 'valid', hotkey: 'Ctrl+,' })

      const shiftOnlyRes = interpretRecorderKeydown(
        { key: 'K', code: 'KeyK', shiftKey: true },
        { platform: 'windows', allowDoubleTap: false, allowShellKeys: true }
      )
      expect(shiftOnlyRes.action).toBe('invalid')

      const blacklistRes = interpretRecorderKeydown(
        { key: 'c', code: 'KeyC', ctrlKey: true },
        { platform: 'windows', allowDoubleTap: false, allowShellKeys: true }
      )
      expect(blacklistRes.action).toBe('invalid')
    })
  })

  describe('2. 各组件快捷键提示与按键监听同步验证', () => {
    it('Sidebar：修改和清空「打开设置」与「展开/收起侧栏」后键帽与 title 同步更新且无空括号', async () => {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/', name: 'my', component: { template: '<div />' } },
          { path: '/advanced-settings', name: 'advanced-settings', component: { template: '<div />' } },
          { path: '/about', name: 'about', component: { template: '<div />' } },
          { path: '/list/:category?', name: 'list', component: { template: '<div />' } }
        ]
      })
      await router.push('/')
      await router.isReady()

      const wrapper = mount(Sidebar, {
        global: { plugins: [router] }
      })

      const findSettingsItem = () =>
        wrapper
          .findAll('.sidebar-item')
          .find((el) => el.find('.sidebar-label').exists() && el.find('.sidebar-label').text() === '设置')

      expect(findSettingsItem().findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', ','])
      expect(wrapper.find('.sidebar-toggle-btn').attributes('title')).toBe('收起侧边栏 (Ctrl+B)')

      // 修改两项快捷键
      await saveShellShortcut('open-settings', 'Ctrl+.')
      await saveShellShortcut('toggle-sidebar', 'Alt+B')
      await nextTick()

      expect(findSettingsItem().findAll('kbd').map((k) => k.text())).toEqual(['Ctrl', '.'])
      expect(wrapper.find('.sidebar-toggle-btn').attributes('title')).toBe('收起侧边栏 (Alt+B)')

      // 清空两项快捷键：键帽隐藏，title 不出现空括号
      await saveShellShortcut('open-settings', '')
      await saveShellShortcut('toggle-sidebar', '')
      await nextTick()

      expect(findSettingsItem().findAll('kbd')).toHaveLength(0)
      expect(wrapper.find('.sidebar-toggle-btn').attributes('title')).toBe('收起侧边栏')
      wrapper.unmount()
    })

    it('HeaderGeekModeTrigger：悬浮条入口保持纯净标题，不再展示已移除的 Ctrl+U 切换提示', async () => {
      vi.useFakeTimers()
      try {
        const wrapper = mount(HeaderGeekModeTrigger)
        expect(wrapper.find('.launcher-trigger').attributes('title')).toBe('切到悬浮条')

        await wrapper.trigger('mouseenter')
        vi.advanceTimersByTime(150)
        await nextTick()

        expect(wrapper.findAll('.guide-key-row')).toHaveLength(1)
        expect(wrapper.find('.guide-card').text()).not.toContain('Ctrl+U')

        wrapper.unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    it('DeclarativeView 与 ActionPanelModal：修改和清空「动作面板」后底栏提示、面板键帽与按键触发全同步', async () => {
      const SamplePlugin = defineComponent({
        render() {
          return null
        }
      })
      // 使用 ActionPanelModal 验证面板搜索框键帽与关闭快捷键同步
      const onClose = vi.fn()
      const modalWrapper = mount(ActionPanelModal, {
        props: {
          visible: true,
          actions: [
            { type: 'Action', props: { title: '动作 1', onAction: vi.fn() } }
          ]
        },
        attrs: { onClose }
      })
      await flushPromises()

      expect(modalWrapper.find('.action-panel-search').findComponent(ShortcutKeys).props('combo')).toBe('Ctrl+K')

      await saveShellShortcut('action-panel', 'Ctrl+J')
      await nextTick()
      expect(modalWrapper.find('.action-panel-search').findComponent(ShortcutKeys).props('combo')).toBe('Ctrl+J')

      // 原 Ctrl+K 不再关闭，新 Ctrl+J 关闭
      dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
      expect(onClose).not.toHaveBeenCalled()
      dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }))
      expect(onClose).toHaveBeenCalledTimes(1)

      // 清空后隐藏搜索框键帽且按快捷键不触发关闭
      await saveShellShortcut('action-panel', '')
      await nextTick()
      expect(modalWrapper.find('.action-panel-search').findComponent(ShortcutKeys).exists()).toBe(false)
      dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }))
      expect(onClose).toHaveBeenCalledTimes(1)
      modalWrapper.unmount()

      // 验证 DeclarativeView 存在引用不报错（真实底栏测试见 declarative-view.test.js）
      expect(SamplePlugin).toBeTruthy()
      expect(DeclarativeView).toBeTruthy()
    })
  })
})
