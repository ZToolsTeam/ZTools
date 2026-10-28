import test from 'node:test'
import assert from 'node:assert/strict'
import { List, renderDeclarativeRoot, useEffect, useNavigation, useState } from '../dist/index.js'

test('初次 effect 的成功 pop 立即停止副作用，根页 pop 被拒绝则保留页面', () => {
  for (const removed of [true, false]) {
    let clean = 0, later = 0
    const root = renderDeclarativeRoot(() => {
      const { pop } = useNavigation()
      useEffect(() => { pop(); return () => { clean++ } }, [])
      useEffect(() => { later++ }, [])
      return List({}, [])
    }, { navigation: { push: () => {}, pop: () => removed } })
    assert.equal(clean, removed ? 1 : 0)
    assert.equal(later, removed ? 0 : 1)
    root.unmount()
    assert.equal(clean, 1)
  }
})

test('effect 自卸载后立即释放返回的资源，并停止剩余 effect', async () => {
  let update, released = 0, later = 0
  const resources = new Set()
  const root = renderDeclarativeRoot(() => {
    const [closing, setClosing] = useState(false)
    update = setClosing
    useEffect(() => {
      if (!closing) return
      resources.add('timer')
      root.unmount()
      return () => { released++; resources.delete('timer') }
    }, [closing])
    useEffect(() => { if (closing) later++ }, [closing])
    return List({}, [])
  })
  update(true)
  await Promise.resolve()
  root.unmount()
  assert.equal(released, 1)
  assert.equal(resources.size, 0)
  assert.equal(later, 0)
})

test('旧 effect 的 cleanup 重入卸载只执行一次，不再启动新 effect', async () => {
  let update, setups = 0, firstClean = 0, otherClean = 0
  const root = renderDeclarativeRoot(() => {
    const [value, setValue] = useState(0)
    update = setValue
    useEffect(() => {
      setups++
      return () => { firstClean++; root.unmount() }
    }, [value])
    useEffect(() => () => { otherClean++; root.unmount() }, [])
    return List({}, [])
  })
  update(1)
  await Promise.resolve()
  root.unmount()
  assert.deepEqual({ setups, firstClean, otherClean }, { setups: 1, firstClean: 1, otherClean: 1 })
})

test('保留的导航不能借用另一个根的活动导航，嵌套渲染后恢复父级导航', () => {
  const calls = []
  const navigation = name => ({ push: () => calls.push(name), pop: () => calls.push(name) })
  let firstNavigation
  const first = renderDeclarativeRoot(() => {
    firstNavigation = useNavigation()
    return List({}, [])
  }, { navigation: navigation('first') })
  let nested
  const second = renderDeclarativeRoot(() => {
    nested = renderDeclarativeRoot(() => List({}, []), { navigation: navigation('nested') })
    const ownNavigation = useNavigation()
    useEffect(() => { firstNavigation.push(List({}, [])); ownNavigation.pop() }, [])
    return List({}, [])
  }, { navigation: navigation('second') })
  for (const root of [first, second, nested]) root.unmount()
  assert.deepEqual(calls, ['first', 'second'])
})
