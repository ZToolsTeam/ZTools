import { describe, expect, it, vi } from 'vitest'
import Events from '../../../public/js/cef-ipc/src/core/events.js'

function createTransport() {
  return {
    _debug: false,
    call: vi.fn(async () => ({ success: true }))
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('Events subscription lifecycle', () => {
  it('deduplicates backend subscriptions until the last local handler is removed', async () => {
    const transport = createTransport()
    const events = new Events(transport)
    const first = vi.fn()
    const second = vi.fn()

    events.on('test.event', first)
    events.on('test.event', second)
    await Promise.resolve()
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledWith('event_subscribe', { key: 'test.event' })

    events.off('test.event', first)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call).toHaveBeenCalledTimes(1)

    events.off('test.event', second)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call).toHaveBeenLastCalledWith('event_unsubscribe', { key: 'test.event' })
  })

  it('onChannel destroy awaits remote unsubscribe while no-await callers still start cleanup', async () => {
    const transport = createTransport()
    const events = new Events(transport)
    events.onChannel('updates', vi.fn())
    await Promise.resolve()
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledWith('event_subscribe', { key: 'channel:updates' })

    const cleanup = events.destroy()
    expect(events.destroy()).toBe(cleanup)
    const result = await cleanup
    expect(result).toEqual({ success: true, errors: [] })
    expect(transport.call).toHaveBeenLastCalledWith('event_unsubscribe', { key: 'channel:updates' })
    expect(transport.call).toHaveBeenCalledTimes(2)
    expect(events.handlers.size).toBe(0)
    expect(events.subscriptions.size).toBe(0)
  })

  it('waits for Main confirmation, coalesces concurrent handlers, and unsubscribes after the last disposer', async () => {
    const transport = createTransport()
    const confirmation = createDeferred()
    transport.call.mockReturnValueOnce(confirmation.promise)
    const events = new Events(transport)
    const first = vi.fn()
    const second = vi.fn()

    const firstSubscription = events.subscribeConfirmed('confirmed.event', first)
    const secondSubscription = events.subscribeConfirmed('confirmed.event', second)
    expect(events.handlers.has('confirmed.event')).toBe(false)
    await Promise.resolve()
    expect(transport.call).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledWith('event_subscribe', { key: 'confirmed.event' })

    confirmation.resolve({ success: true, subscribed: true })
    const [disposeFirst, disposeSecond] = await Promise.all([firstSubscription, secondSubscription])
    expect(events.handlers.get('confirmed.event')).toEqual(new Set([first, second]))

    await disposeFirst()
    expect(transport.call).toHaveBeenCalledTimes(1)
    await disposeSecond()
    await disposeSecond()
    expect(transport.call).toHaveBeenLastCalledWith('event_unsubscribe', { key: 'confirmed.event' })
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it('does not retain confirmed handlers after failure and allows a later retry', async () => {
    const transport = createTransport()
    const failure = new Error('subscription denied')
    transport.call.mockRejectedValueOnce(failure)
    const events = new Events(transport)
    const handler = vi.fn()

    await expect(events.subscribeConfirmed('retry.event', handler)).rejects.toBe(failure)
    expect(events.handlers.has('retry.event')).toBe(false)
    expect(events.subscriptions.has('retry.event')).toBe(false)
    expect(events.pendingConfirmedSubscriptions.has('retry.event')).toBe(false)

    const dispose = await events.subscribeConfirmed('retry.event', handler)
    expect(transport.call).toHaveBeenCalledTimes(2)
    expect(events.handlers.get('retry.event').has(handler)).toBe(true)
    await dispose()
  })

  it('reference-counts repeated registrations of the same handler without duplicate delivery', async () => {
    const transport = createTransport()
    const events = new Events(transport)
    const handler = vi.fn()
    const disposeFirst = await events.subscribeConfirmed('repeat.event', handler)
    const disposeSecond = await events.subscribeConfirmed('repeat.event', handler)

    events.dispatchEnvelope({ type: 'repeat.event' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledTimes(1)

    await disposeFirst()
    expect(events.handlers.get('repeat.event').has(handler)).toBe(true)
    expect(transport.call).toHaveBeenCalledTimes(1)
    await disposeSecond()
    expect(transport.call).toHaveBeenCalledTimes(2)
  })

  it('keeps a legacy on handler when a confirmed registration of the same handler is disposed', async () => {
    const transport = createTransport()
    const events = new Events(transport)
    const handler = vi.fn()
    events.on('mixed.event', handler)

    const dispose = await events.subscribeConfirmed('mixed.event', handler)
    expect(transport.call).toHaveBeenCalledTimes(1)
    await dispose()
    events.dispatchEnvelope({ type: 'mixed.event' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(transport.call).toHaveBeenCalledTimes(1)

    events.off('mixed.event', handler)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call).toHaveBeenLastCalledWith('event_unsubscribe', { key: 'mixed.event' })
  })

  it('removes the local handler and propagates unsubscribe failure while retaining the confirmed key for retry', async () => {
    const transport = createTransport()
    const failure = new Error('unsubscribe failed')
    transport.call.mockImplementation(async (method) => {
      if (method === 'event_unsubscribe') {
        if (transport.call.mock.calls.filter(([calledMethod]) => calledMethod === method).length === 1) {
          throw failure
        }
      }
      return { success: true }
    })
    const events = new Events(transport)
    const handler = vi.fn()
    const dispose = await events.subscribeConfirmed('retry-unsubscribe.event', handler)

    await expect(dispose()).rejects.toBe(failure)
    expect(events.handlers.has('retry-unsubscribe.event')).toBe(false)
    expect(events.subscriptions.has('retry-unsubscribe.event')).toBe(true)
    expect(events.failedUnsubscriptions.has('retry-unsubscribe.event')).toBe(true)
    await dispose()
    expect(transport.call).toHaveBeenCalledTimes(2)

    const retryDispose = await events.subscribeConfirmed('retry-unsubscribe.event', handler)
    expect(transport.call).toHaveBeenCalledTimes(3)
    expect(events.failedUnsubscriptions.has('retry-unsubscribe.event')).toBe(false)
    await retryDispose()
    expect(transport.call).toHaveBeenCalledTimes(4)
  })

  it('destroys with a pending subscribe by awaiting subscribe before unsubscribe', async () => {
    const transport = createTransport()
    const confirmation = createDeferred()
    transport.call.mockImplementation((method) => {
      if (method === 'event_subscribe') return confirmation.promise
      return Promise.resolve({ success: true })
    })
    const events = new Events(transport)
    const handler = vi.fn()
    const subscription = events.subscribeConfirmed('destroy.pending', handler)
    const cleanup = events.destroy()

    await Promise.resolve()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual(['event_subscribe'])
    confirmation.resolve({ success: true })
    await expect(subscription).rejects.toThrow('Events were cleared')
    const result = await cleanup

    expect(result.success).toBe(true)
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])
    expect(events.subscriptions.size).toBe(0)
  })

  it('returns an error summary for explicit false subscribe and unsubscribe responses', async () => {
    const transport = createTransport()
    const events = new Events(transport)
    const handler = vi.fn()
    transport.call.mockResolvedValueOnce({ success: false })

    await expect(events.subscribeConfirmed('false.subscribe', handler)).rejects.toMatchObject({
      code: 'EVENT_SUBSCRIPTION_NOT_CONFIRMED'
    })
    expect(events.handlers.has('false.subscribe')).toBe(false)
    expect(events.subscriptions.has('false.subscribe')).toBe(false)

    const dispose = await events.subscribeConfirmed('false.unsubscribe', handler)
    transport.call.mockResolvedValueOnce({ success: false })
    await expect(dispose()).rejects.toMatchObject({
      code: 'EVENT_UNSUBSCRIPTION_NOT_CONFIRMED'
    })
    expect(events.handlers.has('false.unsubscribe')).toBe(false)
    expect(events.failedUnsubscriptions.has('false.unsubscribe')).toBe(true)
    const cleanup = await events.clear()
    expect(cleanup).toEqual({ success: true, errors: [] })
  })

  it('clears a pending confirmed subscription after Main responds', async () => {
    const transport = createTransport()
    const confirmation = createDeferred()
    transport.call.mockImplementation((method) => {
      if (method === 'event_subscribe') return confirmation.promise
      return Promise.resolve({ success: true })
    })
    const events = new Events(transport)
    const subscription = events.subscribeConfirmed('clear.pending', vi.fn())
    const cleanup = events.clear()

    await Promise.resolve()
    confirmation.resolve({ success: true })
    await expect(subscription).rejects.toThrow('Events were cleared')
    const result = await cleanup

    expect(result.success).toBe(true)
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])
    expect(events.handlers.has('clear.pending')).toBe(false)
    expect(events.subscriptions.has('clear.pending')).toBe(false)
  })

  it('serializes a new subscribe after an in-flight last-handler unsubscribe', async () => {
    const transport = createTransport()
    const unsubscribe = createDeferred()
    transport.call.mockImplementation((method) => {
      if (method === 'event_unsubscribe') return unsubscribe.promise
      return Promise.resolve({ success: true })
    })
    const events = new Events(transport)
    const firstDispose = await events.subscribeConfirmed('interleaved.event', vi.fn())
    const firstCleanup = firstDispose()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])

    const secondSubscription = events.subscribeConfirmed('interleaved.event', vi.fn())
    await Promise.resolve()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])

    unsubscribe.resolve({ success: true })
    const secondDispose = await secondSubscription
    await firstCleanup
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe',
      'event_subscribe'
    ])
    await secondDispose()
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe',
      'event_subscribe',
      'event_unsubscribe'
    ])
  })

  it('does not subscribe again when clear interrupts a subscribe waiting for unsubscribe', async () => {
    const transport = createTransport()
    const unsubscribe = createDeferred()
    transport.call.mockImplementation((method) => {
      if (method === 'event_unsubscribe') return unsubscribe.promise
      return Promise.resolve({ success: true })
    })
    const events = new Events(transport)
    const disposeFirst = await events.subscribeConfirmed('clear.interleaved', vi.fn())

    const firstCleanup = disposeFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])

    const pendingSubscription = events.subscribeConfirmed('clear.interleaved', vi.fn())
    await Promise.resolve()
    const cleanup = events.clear()
    unsubscribe.resolve({ success: true })

    await expect(pendingSubscription).rejects.toThrow('Events were cleared')
    await firstCleanup
    await expect(cleanup).resolves.toEqual({ success: true, errors: [] })
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])
    expect(events.handlers.has('clear.interleaved')).toBe(false)
    expect(events.subscriptions.has('clear.interleaved')).toBe(false)
  })

  it('does not subscribe again when destroy interrupts a subscribe waiting for unsubscribe', async () => {
    const transport = createTransport()
    const unsubscribe = createDeferred()
    transport.call.mockImplementation((method) => {
      if (method === 'event_unsubscribe') return unsubscribe.promise
      return Promise.resolve({ success: true })
    })
    const events = new Events(transport)
    const disposeFirst = await events.subscribeConfirmed('destroy.interleaved', vi.fn())

    const firstCleanup = disposeFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])

    const pendingSubscription = events.subscribeConfirmed('destroy.interleaved', vi.fn())
    await Promise.resolve()
    const cleanup = events.destroy()
    unsubscribe.resolve({ success: true })

    await expect(pendingSubscription).rejects.toThrow('Events were cleared')
    await firstCleanup
    await expect(cleanup).resolves.toEqual({ success: true, errors: [] })
    expect(transport.call.mock.calls.map(([method]) => method)).toEqual([
      'event_subscribe',
      'event_unsubscribe'
    ])
    expect(events.handlers.has('destroy.interleaved')).toBe(false)
    expect(events.subscriptions.has('destroy.interleaved')).toBe(false)
  })

  it('settles a pending request as cancelled on clear and ignores a late reply', async () => {
    const events = new Events(createTransport())
    const request = events.request('clear.request', {}, { timeout: 60000 })
    const [requestId] = events.pendingRequests.keys()
    const entry = events.pendingRequests.get(requestId)
    entry.resolve = vi.fn(entry.resolve)

    const cleanup = events.clear()

    await expect(request).resolves.toEqual({ ok: false, code: 'CANCELLED' })
    await expect(cleanup).resolves.toEqual({ success: true, errors: [] })
    expect(events.pendingRequests.size).toBe(0)

    events.dispatchEnvelope({ replyTo: requestId, payload: { ok: true } })
    expect(entry.resolve).toHaveBeenCalledTimes(1)
  })

  it('drops a cancelled late reply before type and wildcard dispatch', async () => {
    const events = new Events(createTransport())
    const typeHandler = vi.fn()
    const wildcardHandler = vi.fn()
    const request = events.request('clear.reply-dispatch', {}, { timeout: 60000 })
    const [requestId] = events.pendingRequests.keys()

    const cleanup = events.clear()
    await expect(request).resolves.toEqual({ ok: false, code: 'CANCELLED' })
    await expect(cleanup).resolves.toEqual({ success: true, errors: [] })

    events.handlers.set('events.Ack', new Set([typeHandler]))
    events.handlers.set('*', new Set([wildcardHandler]))
    events.dispatchEnvelope({ type: 'events.Ack' })
    expect(typeHandler).toHaveBeenCalledTimes(1)
    expect(wildcardHandler).toHaveBeenCalledTimes(1)

    typeHandler.mockClear()
    wildcardHandler.mockClear()
    events.dispatchEnvelope({ replyTo: requestId, type: 'events.Ack', payload: { ok: true } })
    expect(typeHandler).not.toHaveBeenCalled()
    expect(wildcardHandler).not.toHaveBeenCalled()
  })

  it('settles a pending request as cancelled on destroy and ignores a late reply', async () => {
    const events = new Events(createTransport())
    const request = events.request('destroy.request', {}, { timeout: 60000 })
    const [requestId] = events.pendingRequests.keys()
    const entry = events.pendingRequests.get(requestId)
    entry.resolve = vi.fn(entry.resolve)

    const cleanup = events.destroy()

    await expect(request).resolves.toEqual({ ok: false, code: 'CANCELLED' })
    await expect(cleanup).resolves.toEqual({ success: true, errors: [] })
    expect(events.pendingRequests.size).toBe(0)

    events.dispatchEnvelope({ replyTo: requestId, payload: { ok: true } })
    expect(entry.resolve).toHaveBeenCalledTimes(1)
  })
})
