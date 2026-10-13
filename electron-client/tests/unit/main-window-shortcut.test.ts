import assert from 'node:assert/strict'
import test from 'node:test'
import {
  handleMainWindowBeforeInputEvent,
  type BeforeInputEventLike,
  type InputDetailsLike
} from '../../src/main/windows/main-window.js'
import {
  handleLauncherBeforeInputEvent,
  type LauncherInputController
} from '../../src/main/windows/launcher-controller.js'

function createMockEvent(): { preventDefault: () => void; isPrevented: () => boolean } {
  let prevented = false
  return {
    preventDefault: () => { prevented = true },
    isPrevented: () => prevented
  }
}

test('【对标 Raycast 标杆实现】主窗口与极客条 Alt+Space 消息拦截与防穿透测试套件', async (t) => {
  await t.test('1. [Happy Path] 主窗口前台按下 Alt+Space 必须调用 preventDefault 阻断原生系统菜单并切换极客条', () => {
    let launcherToggled = false
    const event = createMockEvent()
    const input: InputDetailsLike = { alt: true, key: ' ', code: 'Space', type: 'keyDown' }

    const handled = handleMainWindowBeforeInputEvent(event, input, {
      onToggleLauncher: () => { launcherToggled = true },
      isDestroyed: () => false
    })

    assert.equal(handled, true, 'Alt+Space 必须被成功接管')
    assert.equal(event.isPrevented(), true, '必须调用 event.preventDefault() 彻底切断向 Windows 系统菜单的消息传递')
    assert.equal(launcherToggled, true, '必须触发切换到极客条模式')
  })

  await t.test('2. [Happy Path] 极客条前台按下 Alt+Space 必须阻断原生菜单并 Toggle 隐藏收起', () => {
    let hidden = false
    const event = createMockEvent()
    const input: InputDetailsLike = { alt: true, key: ' ', code: 'Space', type: 'keyDown' }
    const controller: LauncherInputController = {
      hide: () => { hidden = true }
    }

    const handled = handleLauncherBeforeInputEvent(event, input, controller)

    assert.equal(handled, true, 'Alt+Space 必须被极客条接管')
    assert.equal(event.isPrevented(), true, '极客条内必须调用 event.preventDefault() 阻止系统菜单')
    assert.equal(hidden, true, '极客条内必须触发收起隐藏 (Toggle Hide)')
  })

  await t.test('3. [Beyond Happy Path - 时序与按键生命周期] Alt+Space 的 keyUp 阶段必须阻止系统菜单但不得重复触发动作', () => {
    let toggleCallCount = 0
    const event = createMockEvent()
    const input: InputDetailsLike = { alt: true, key: ' ', code: 'Space', type: 'keyUp' }

    const handled = handleMainWindowBeforeInputEvent(event, input, {
      onToggleLauncher: () => { toggleCallCount++ },
      isDestroyed: () => false
    })

    assert.equal(handled, true, 'keyUp 同样属于 Alt+Space 按键序列')
    assert.equal(event.isPrevented(), true, '松开按键时也必须 preventDefault 防止 Windows 捕获后弹出菜单')
    assert.equal(toggleCallCount, 0, 'keyUp 不得重复触发切换逻辑')
  })

  await t.test('4. [Beyond Happy Path - 键位边界隔离] 非 Alt+Space 的按键严禁被误伤拦截', () => {
    const testCases: InputDetailsLike[] = [
      { alt: false, key: ' ', code: 'Space', type: 'keyDown' },          // 单独按空格
      { alt: false, control: true, key: ' ', code: 'Space', type: 'keyDown' }, // Ctrl+Space
      { alt: true, key: 'F4', code: 'F4', type: 'keyDown' },             // Alt+F4 系统关闭
      { alt: true, key: 'Tab', code: 'Tab', type: 'keyDown' },           // Alt+Tab 任务切换
      { alt: false, key: 'a', code: 'KeyA', type: 'keyDown' },           // 普通输入
      { alt: true, key: 'Enter', code: 'Enter', type: 'keyDown' }        // Alt+Enter
    ]

    for (const testCase of testCases) {
      const event = createMockEvent()
      let toggleCalled = false

      const handled = handleMainWindowBeforeInputEvent(event, testCase, {
        onToggleLauncher: () => { toggleCalled = true },
        isDestroyed: () => false
      })

      assert.equal(handled, false, `按键 ${JSON.stringify(testCase)} 不应被拦截`)
      assert.equal(event.isPrevented(), false, `按键 ${JSON.stringify(testCase)} 绝不能被 preventDefault`)
      assert.equal(toggleCalled, false, '非 Alt+Space 不应触发切换')
    }
  })

  await t.test('5. [Beyond Happy Path - 窗口销毁与异常防御] 已销毁窗口下不得调用 IPC 发送', () => {
    let ipcSent = false
    const event = createMockEvent()
    const input: InputDetailsLike = { alt: true, key: ' ', code: 'Space', type: 'keyDown' }

    const handled = handleMainWindowBeforeInputEvent(event, input, {
      isDestroyed: () => true, // 窗口已销毁
      sendIpc: () => { ipcSent = true }
    })

    assert.equal(handled, true, '事件依然被拦截，防止系统残余')
    assert.equal(event.isPrevented(), true, '依然阻止默认行为')
    assert.equal(ipcSent, false, '窗口已销毁时不应发送 IPC 导致报错')
  })

  await t.test('6. [Beyond Happy Path - 畸形参数防御] 传入 null / undefined / 空字段时安全兜底', () => {
    const event = createMockEvent()
    const handledNull = handleMainWindowBeforeInputEvent(event, {}, {})
    assert.equal(handledNull, false)
    assert.equal(event.isPrevented(), false)

    const launcherHandledNull = handleLauncherBeforeInputEvent(event, {}, { hide: () => {} })
    assert.equal(launcherHandledNull, false)
  })
})
