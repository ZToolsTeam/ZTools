import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const sdkSource = readFileSync(
  resolve(process.cwd(), 'src/sdk/plugin-sdk.js'),
  'utf8'
)

function loadPluginSdk(location = {}) {
  const documentHandlers = new Map()
  const eventHandlers = new Map()
  const bodyChildren = []
  const headChildren = []
  const events = {
    on: vi.fn((name, callback) => {
      const handlers = eventHandlers.get(name) || []
      handlers.push(callback)
      eventHandlers.set(name, handlers)
    }),
    off: vi.fn(),
    respond: vi.fn().mockResolvedValue(true)
  }
  const createElement = () => {
    const classes = new Set()
    return {
      id: '',
      className: '',
      textContent: '',
      style: {},
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name)
      },
      appendChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  }
  const document = {
    readyState: 'loading',
    documentElement: { classList: { toggle: vi.fn() } },
    head: {
      appendChild: vi.fn((element) => {
        element.parentNode = document.head
        headChildren.push(element)
      })
    },
    body: {
      appendChild: vi.fn((element) => {
        element.parentNode = document.body
        bodyChildren.push(element)
      }),
      removeChild: vi.fn((element) => {
        const index = bodyChildren.indexOf(element)
        if (index >= 0) bodyChildren.splice(index, 1)
        element.parentNode = null
      })
    },
    createElement: vi.fn(createElement),
    getElementById: vi.fn((id) => [...headChildren, ...bodyChildren].find((element) => element.id === id) || null),
    addEventListener: vi.fn((name, callback) => {
      documentHandlers.set(name, callback)
    }),
    removeEventListener: vi.fn()
  }
  const window = {
    location: {
      href: 'https://example.test/plugin',
      protocol: 'https:',
      hostname: 'example.test',
      ...location
    },
    ztools: { events }
  }

  runInNewContext(sdkSource, {
    window,
    document,
    console: { log: vi.fn(), error: vi.fn() },
    setTimeout,
    clearTimeout
  })
  documentHandlers.get('DOMContentLoaded')()

  return {
    sdk: window.ztoolsPlugin,
    window,
    document,
    documentHandlers,
    events,
    emit(name, envelope) {
      return [...(eventHandlers.get(name) || [])].map((callback) => callback(envelope))
    }
  }
}

describe('plugin SDK lifecycle subscriptions', () => {
  it('returns independent idempotent unsubscribe functions for duplicate callbacks', () => {
    const { sdk, emit } = loadPluginSdk()
    const callback = vi.fn()
    const unsubscribeFirst = sdk.onPluginEnter(callback)
    const unsubscribeSecond = sdk.onPluginEnter(callback)

    expect(unsubscribeFirst).toEqual(expect.any(Function))
    expect(unsubscribeSecond).toEqual(expect.any(Function))

    emit('plugin_enter', { data: { code: 'first' } })
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribeFirst()
    unsubscribeFirst()
    emit('plugin_enter', { data: { code: 'second' } })
    expect(callback).toHaveBeenCalledTimes(3)

    unsubscribeSecond()
    emit('plugin_enter', { data: { code: 'third' } })
    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('keeps the legacy onPluginOut call form and lets callers dispose it', () => {
    const { sdk, emit } = loadPluginSdk()
    const legacyHandler = vi.fn()
    const handler = vi.fn()
    const unsubscribe = sdk.onPluginOut(handler)

    // Existing call sites may intentionally ignore the newly returned function.
    sdk.onPluginOut(legacyHandler)
    emit('plugin_out', { data: { isKill: true } })
    expect(handler).toHaveBeenCalledWith(true)
    expect(legacyHandler).toHaveBeenCalledWith(true)

    unsubscribe()
    unsubscribe()
    emit('plugin_out', { data: { isKill: false } })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(legacyHandler).toHaveBeenCalledTimes(2)
  })

  it('uses the current request response for exit acknowledgement without the legacy ack call', async () => {
    const { sdk, window, events, emit } = loadPluginSdk()
    const transport = { call: vi.fn() }
    window.ztools._transport = transport
    sdk.onPluginOut(vi.fn())
    const requestId = 'host-exit-request-1'
    const envelope = {
      source: { kind: 'host' },
      envelopeId: requestId,
      correlationId: requestId,
      data: { isKill: true }
    }

    await Promise.all(emit('plugin_out', envelope))
    await Promise.all(emit('plugin_out', envelope))

    expect(events.respond).toHaveBeenCalledTimes(1)
    expect(events.respond).toHaveBeenCalledWith(requestId, { ok: true }, { scope: 'plugin' })
    expect(transport.call).not.toHaveBeenCalled()
  })

  it('recognizes the ztools plugin URL when installing the native close handler', () => {
    const { window } = loadPluginSdk({
      href: 'ztools://plugins/example/index.html',
      protocol: 'ztools:',
      hostname: 'plugins'
    })

    expect(window.__ztools_close_handler).toEqual(expect.any(Function))
  })

  it('skips a subscription disposed during dispatch without unregistering event-bus listeners', () => {
    const { sdk, events, emit } = loadPluginSdk()
    const laterHandler = vi.fn()
    let unsubscribeLater = () => {}

    sdk.onPluginEnter(() => unsubscribeLater())
    unsubscribeLater = sdk.onPluginEnter(laterHandler)

    emit('plugin_enter', { data: { code: 'dispatch' } })

    expect(laterHandler).not.toHaveBeenCalled()
    expect(events.off).not.toHaveBeenCalled()
  })

  it('returns independent idempotent unsubscribe functions for file-drop subscriptions', () => {
    const { sdk, emit } = loadPluginSdk()
    const callback = vi.fn()
    const unsubscribeFirst = sdk.onFileDrop(callback)
    const unsubscribeSecond = sdk.onFileDrop(callback)

    expect(unsubscribeFirst).toEqual(expect.any(Function))
    expect(unsubscribeSecond).toEqual(expect.any(Function))

    emit('plugin_files_dropped', { data: { files: ['first.txt'] } })
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribeFirst()
    unsubscribeFirst()
    emit('plugin_files_dropped', { data: { files: ['second.txt'] } })
    expect(callback).toHaveBeenCalledTimes(3)
    expect(callback).toHaveBeenLastCalledWith(['second.txt'], [])

    unsubscribeSecond()
    emit('plugin_files_dropped', { data: { files: ['third.txt'] } })
    expect(callback).toHaveBeenCalledTimes(3)
  })

  it('skips a file-drop subscription disposed during dispatch', () => {
    const { sdk, emit } = loadPluginSdk()
    const laterHandler = vi.fn()
    let unsubscribeLater = () => {}

    sdk.onFileDrop(() => unsubscribeLater())
    unsubscribeLater = sdk.onFileDrop(laterHandler)

    emit('plugin_files_dropped', { data: { files: ['dispatch.txt'] } })

    expect(laterHandler).not.toHaveBeenCalled()
  })

  it('shows the file overlay for Files drags and resets it on drop', () => {
    const { sdk, document, documentHandlers } = loadPluginSdk()
    sdk.enableFileDrop()
    sdk.enableFileDrop()
    const overlay = document.body.appendChild.mock.calls
      .map(([element]) => element)
      .filter((element) => element.id === 'ztools-file-drop-overlay')
      .at(-1)
    expect(document.head.appendChild).toHaveBeenCalledTimes(1)
    expect(document.head.appendChild.mock.calls[0][0].id).toBe('ztools-drop-styles')
    const preventDefault = vi.fn()

    documentHandlers.get('dragenter')({ dataTransfer: { types: ['Files'] }, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(overlay.classList.contains('zt-drop-visible')).toBe(true)

    const dropEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    documentHandlers.get('drop')(dropEvent)
    expect(dropEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(dropEvent.stopPropagation).toHaveBeenCalledTimes(1)
    expect(overlay.classList.contains('zt-drop-visible')).toBe(false)
    expect(overlay.classList.contains('zt-drop-hiding')).toBe(true)
  })
})
