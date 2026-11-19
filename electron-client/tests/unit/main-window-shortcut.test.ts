import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WM_SYSCHAR,
  acceleratorToRecorderKeyPayload,
  dispatchRecorderKeyToWebContents,
  handleMainWindowBeforeInputEvent,
  suppressWindowsSystemMenu,
  type BeforeInputEventLike,
  type InputDetailsLike,
  type RecorderKeyPayload
} from '../../src/main/windows/main-window.js'
import {
  handleLauncherBeforeInputEvent,
  type LauncherInputController
} from '../../src/main/windows/launcher-controller.js'

function createMockEvent(): BeforeInputEventLike & { isPrevented: () => boolean } {
  let prevented = false
  return {
    preventDefault: () => { prevented = true },
    isPrevented: () => prevented
  }
}

test('主窗口与极客条 Alt+Space / Ctrl+Space 消息流转及 Windows 系统菜单抑制测试套件', async (t) => {
  await t.test('1. [主窗口 Alt+Space 与 Ctrl+Space 拦截转发] 仅在录制态阻断系统菜单/IME 干扰并将 keyDown 转发至录制框', () => {
    const forwarded: RecorderKeyPayload[] = []

    // 非录制态：不再无条件吞掉 Alt+Space / Ctrl+Space
    const idleAltSpace = createMockEvent()
    assert.equal(
      handleMainWindowBeforeInputEvent(
        idleAltSpace,
        { alt: true, key: ' ', code: 'Space', type: 'keyDown' },
        {
          isDestroyed: () => false,
          forwardRecorderKey: (payload) => { forwarded.push(payload) }
        }
      ),
      false
    )
    assert.equal(idleAltSpace.isPrevented(), false, '未开启录制态时不得拦截 Alt+Space')

    const idleCtrlSpace = createMockEvent()
    assert.equal(
      handleMainWindowBeforeInputEvent(
        idleCtrlSpace,
        { control: true, key: 'Process', code: 'Space', type: 'keyDown' },
        {
          isDestroyed: () => false,
          isRecorderCaptureActive: () => false,
          forwardRecorderKey: (payload) => { forwarded.push(payload) }
        }
      ),
      false
    )
    assert.equal(idleCtrlSpace.isPrevented(), false, 'isRecorderCaptureActive 为 false 时不得拦截 Ctrl+Space')
    assert.equal(forwarded.length, 0)

    // 录制态：拦截并派发给录制框
    const altSpaceDown = createMockEvent()
    const handledAltDown = handleMainWindowBeforeInputEvent(
      altSpaceDown,
      { alt: true, key: ' ', code: 'Space', type: 'keyDown' },
      {
        isDestroyed: () => false,
        isRecorderCaptureActive: () => true,
        forwardRecorderKey: (payload) => { forwarded.push(payload) }
      }
    )
    assert.equal(handledAltDown, true)
    assert.equal(altSpaceDown.isPrevented(), true, '必须调用 preventDefault 阻断 Windows SC_KEYMENU 系统菜单弹出')
    assert.equal(forwarded.length, 1)
    assert.deepEqual(forwarded[0], {
      key: ' ',
      code: 'Space',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false
    })

    const altSpaceUp = createMockEvent()
    const handledAltUp = handleMainWindowBeforeInputEvent(
      altSpaceUp,
      { alt: true, key: ' ', code: 'Space', type: 'keyUp' },
      {
        isDestroyed: () => false,
        isRecorderCaptureActive: () => true,
        forwardRecorderKey: (payload) => { forwarded.push(payload) }
      }
    )
    assert.equal(handledAltUp, true)
    assert.equal(altSpaceUp.isPrevented(), true)
    assert.equal(forwarded.length, 1, 'keyUp 不得重复派发录制事件')

    const ctrlSpaceImeDown = createMockEvent()
    const handledCtrlDown = handleMainWindowBeforeInputEvent(
      ctrlSpaceImeDown,
      { control: true, key: 'Process', code: 'Space', type: 'keyDown' },
      {
        isDestroyed: () => false,
        isRecorderCaptureActive: () => true,
        forwardRecorderKey: (payload) => { forwarded.push(payload) }
      }
    )
    assert.equal(handledCtrlDown, true)
    assert.equal(ctrlSpaceImeDown.isPrevented(), true)
    assert.equal(forwarded.length, 2)
    assert.deepEqual(forwarded[1], {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false
    })
  })

  await t.test('2. [已注册热键转录制载荷] acceleratorToRecorderKeyPayload 与 dispatchRecorderKeyToWebContents', async () => {
    assert.deepEqual(acceleratorToRecorderKeyPayload('Alt+Space', 'win32'), {
      key: ' ',
      code: 'Space',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false
    })
    assert.deepEqual(acceleratorToRecorderKeyPayload('Ctrl+Space', 'win32'), {
      key: ' ',
      code: 'Space',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false
    })
    assert.deepEqual(acceleratorToRecorderKeyPayload('Alt+Shift+Space', 'win32'), {
      key: ' ',
      code: 'Space',
      ctrlKey: false,
      altKey: true,
      shiftKey: true,
      metaKey: false
    })
    assert.deepEqual(acceleratorToRecorderKeyPayload('DoubleCtrl', 'win32'), {
      key: 'DoubleCtrl',
      code: 'DoubleCtrl',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false
    })
    assert.deepEqual(acceleratorToRecorderKeyPayload('DoubleAlt', 'win32'), {
      key: 'DoubleAlt',
      code: 'DoubleAlt',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false
    })
    assert.deepEqual(acceleratorToRecorderKeyPayload('DoubleShift', 'win32'), {
      key: 'DoubleShift',
      code: 'DoubleShift',
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      metaKey: false
    })
    assert.equal(acceleratorToRecorderKeyPayload('InvalidKey', 'win32'), null)

    let executedCode = ''
    const ok = await dispatchRecorderKeyToWebContents(
      {
        isDestroyed: () => false,
        executeJavaScript: async (code) => {
          executedCode = code
          return true
        }
      },
      { key: ' ', code: 'Space', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
    )
    assert.equal(ok, true)
    assert.match(executedCode, /__ztoolsDispatchRecorderHotkey/)
  })

  await t.test('3. [Windows 原生系统菜单抑制] suppressWindowsSystemMenu 在 win32 下拦截 WM_SYSCHAR 与 system-context-menu', () => {
    const hookedMessages: number[] = []
    let sysMenuListener: ((event: { preventDefault(): void }) => void) | undefined

    suppressWindowsSystemMenu(
      {
        hookWindowMessage(message, callback) {
          hookedMessages.push(message)
          callback(Buffer.alloc(0), Buffer.alloc(0))
        },
        on(event, listener) {
          if (event === 'system-context-menu') {
            sysMenuListener = listener
          }
        }
      },
      'win32'
    )

    assert.deepEqual(hookedMessages, [WM_SYSCHAR])
    assert.equal(typeof sysMenuListener, 'function')
    const menuEvent = createMockEvent()
    sysMenuListener?.(menuEvent)
    assert.equal(menuEvent.isPrevented(), true)
  })

  await t.test('4. [跨平台安全边界] 非 win32 平台或缺少原生方法时 suppressWindowsSystemMenu 安全跳过', () => {
    let called = false
    suppressWindowsSystemMenu(
      {
        hookWindowMessage() { called = true },
        on() { called = true }
      },
      'darwin'
    )
    assert.equal(called, false)
    assert.doesNotThrow(() => suppressWindowsSystemMenu({}, 'win32'))
  })

  await t.test('5. [Happy Path] 极客条前台按下 Alt+Space 必须阻断原生菜单并 Toggle 隐藏收起', () => {
    let hidden = false
    const event = createMockEvent()
    const input: InputDetailsLike = { alt: true, key: ' ', code: 'Space', type: 'keyDown' }
    const controller: LauncherInputController = {
      hide: () => { hidden = true }
    }

    const handled = handleLauncherBeforeInputEvent(event, input, controller)

    assert.equal(handled, true)
    assert.equal(event.isPrevented(), true)
    assert.equal(hidden, true)
  })

  await t.test('6. [Beyond Happy Path - 键位边界隔离] 非修饰空格按键严禁被误伤拦截', () => {
    const testCases: InputDetailsLike[] = [
      { alt: false, key: ' ', code: 'Space', type: 'keyDown' },
      { alt: true, key: 'F4', code: 'F4', type: 'keyDown' },
      { alt: true, key: 'Tab', code: 'Tab', type: 'keyDown' },
      { alt: false, key: 'a', code: 'KeyA', type: 'keyDown' },
      { alt: true, key: 'Enter', code: 'Enter', type: 'keyDown' }
    ]

    for (const testCase of testCases) {
      const event = createMockEvent()
      const handled = handleMainWindowBeforeInputEvent(event, testCase, {})
      assert.equal(handled, false, `按键 ${JSON.stringify(testCase)} 不应被主窗口拦截`)
      assert.equal(event.isPrevented(), false)
    }
  })

  await t.test('7. [Beyond Happy Path - 畸形参数防御] 传入空字段时安全兜底', () => {
    const event = createMockEvent()
    const handledNull = handleMainWindowBeforeInputEvent(event, {}, {})
    assert.equal(handledNull, false)
    assert.equal(event.isPrevented(), false)

    const launcherHandledNull = handleLauncherBeforeInputEvent(event, {}, { hide: () => {} })
    assert.equal(launcherHandledNull, false)
  })
})
