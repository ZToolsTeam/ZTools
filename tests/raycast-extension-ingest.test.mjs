import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ingestRaycastExtension,
  auditPlatformCompatibility
} from '../scripts/ingest-raycast-extension.mjs'
import {
  renderDeclarativeRoot,
  Cache,
  environment,
  setEnvironment,
  getPreferenceValues,
  setPreferenceValues,
  clearPreferenceValues,
  usePromise,
  useCachedPromise,
  useCachedState
} from '../packages/declarative-ui/dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const fixturesDir = path.join(__dirname, 'fixtures/raycast-extensions')
const tempOutputDir = path.join(rootDir, 'dist/test-ingest-run')

describe('Raycast Extensions Ecosystem Ingestion & Compatibility Suite', () => {
  before(() => {
    fs.mkdirSync(tempOutputDir, { recursive: true })
  })

  after(() => {
    try {
      fs.rmSync(tempOutputDir, { recursive: true, force: true })
    } catch {}
  })

  // ==========================================================================
  // 1. 真实扩展端到端接入测试 (Happy Paths)
  // ==========================================================================
  describe('1. 真实扩展端到端接入与声明式运行链路', () => {
    test('案例一: ip-geolocation 能够成功接入、转译 TSX 并驱动异步渲染', async () => {
      const extDir = path.join(fixturesDir, 'ip-geolocation')
      const targetOut = path.join(tempOutputDir, 'koinzhang/ip-geolocation')

      const result = await ingestRaycastExtension(extDir, { outDir: targetOut })
      assert.equal(result.success, true)
      assert.equal(result.extName, 'ip-geolocation')
      assert.equal(result.features.length, 1)

      // 验证产物物理存在
      assert.ok(fs.existsSync(path.join(targetOut, 'plugin.json')))
      assert.ok(fs.existsSync(path.join(targetOut, 'dist/query-ip-geolocation.bundle.js')))

      // 动态装载并运行生成的 Bundle
      const bundleUrl = pathToFileURL(path.join(targetOut, 'dist/query-ip-geolocation.bundle.js')).href
      const mod = await import(bundleUrl)
      assert.equal(typeof mod.default, 'function')

      let updateCount = 0
      const root = renderDeclarativeRoot(mod.default, {
        onUpdate: () => {
          updateCount++
        }
      })

      // 首屏断言 (Loading 状态)
      const initialDesc = root.getLatest()
      assert.equal(initialDesc.type, 'List')
      assert.equal(initialDesc.props.searchBarPlaceholder, 'Query geolocation of IP or domain')

      // 等待异步数据刷新 (由 useCachedPromise 驱动)
      await new Promise(r => setTimeout(r, 60))

      const updatedDesc = root.getLatest()
      assert.ok(updateCount >= 1, '状态机必须触发响应式重新渲染')
      assert.equal(updatedDesc.children.length, 7, '必须准确呈现 7 项地理定位属性')

      const firstItem = updatedDesc.children[0]
      assert.equal(firstItem.type, 'List.Item')
      assert.equal(firstItem.props.title, 'IP')
      assert.equal(firstItem.props.subtitle, '1.1.1.1')
      assert.equal(firstItem.props.actions?.type, 'ActionPanel')
      assert.equal(firstItem.props.actions?.children?.length, 2)

      root.unmount()
    })

    test('案例二: hacker-news 能够转译下拉筛选器、Item 配件并挂载动作面板', async () => {
      const extDir = path.join(fixturesDir, 'hacker-news')
      const targetOut = path.join(tempOutputDir, 'koinzhang/hacker-news')

      const result = await ingestRaycastExtension(extDir, { outDir: targetOut })
      assert.equal(result.success, true)
      assert.equal(result.extName, 'hacker-news')

      const bundleUrl = pathToFileURL(path.join(targetOut, 'dist/frontpage.bundle.js')).href
      const mod = await import(bundleUrl)
      assert.equal(typeof mod.default, 'function')

      let updateCount = 0
      const root = renderDeclarativeRoot(mod.default, {
        onUpdate: () => {
          updateCount++
        }
      })

      // 等待异步数据刷新
      await new Promise(r => setTimeout(r, 60))

      const latest = root.getLatest()
      assert.equal(latest.type, 'List')
      assert.equal(latest.children.length, 3, '应渲染 3 篇初始文章')

      // 验证 List.Dropdown 复杂子描述符解析
      const accessory = latest.props.searchBarAccessory
      assert.ok(accessory, 'searchBarAccessory 必须存在')
      assert.equal(accessory.type, 'List.Dropdown')
      assert.equal(accessory.children.length, 3, '下拉框应包含 3 个分类选项')

      // 验证配件与动作面板递归
      const firstStory = latest.children[0]
      assert.equal(firstStory.props.title, 'Show HN: Modern Declarative UI Engine for ZTools')
      assert.deepEqual(firstStory.props.accessories, [{ text: '342 pts' }])
      assert.equal(firstStory.props.actions.type, 'ActionPanel')
      assert.equal(firstStory.props.actions.children.length, 3)

      root.unmount()
    })
  })

  // ==========================================================================
  // 2. 破坏性异常与安全门禁拦截测试 (Chaos & Boundary)
  // ==========================================================================
  describe('2. 平台专属阻抗与安全门禁拦截防御', () => {
    test('必须拦截仅支持 macOS 且调用 run-applescript 的专有扩展', async () => {
      const macExtDir = path.join(fixturesDir, 'macos-exclusive-app')

      await assert.rejects(
        async () => {
          await ingestRaycastExtension(macExtDir, { outDir: path.join(tempOutputDir, 'fail-mac') })
        },
        (err) => {
          assert.match(err.message, /系统专有阻抗/)
          assert.match(err.message, /PLATFORM_RESTRICTION/)
          assert.match(err.message, /MACOS_EXCLUSIVE_DEPENDENCY/)
          assert.match(err.message, /MACOS_SCRIPT_CALL/)
          return true
        }
      )
    })

    test('必须拦截包含 eval() 动态代码混淆的恶意扩展', async () => {
      const evilExtDir = path.join(fixturesDir, 'malicious-eval-app')

      await assert.rejects(
        async () => {
          await ingestRaycastExtension(evilExtDir, { outDir: path.join(tempOutputDir, 'fail-evil') })
        },
        (err) => {
          assert.match(err.message, /安全红线/)
          assert.match(err.message, /eval/)
          return true
        }
      )
    })

    test('缺少 package.json 清单时拒绝处理并提供明确错误', async () => {
      const emptyDir = path.join(tempOutputDir, 'non-existent-plugin')
      fs.mkdirSync(emptyDir, { recursive: true })

      await assert.rejects(
        async () => {
          await ingestRaycastExtension(emptyDir)
        },
        /不存在 package\.json/
      )
    })

    test('commands 为空数组时拒绝生成插件包', async () => {
      const emptyCmdDir = path.join(tempOutputDir, 'empty-cmd-app')
      fs.mkdirSync(emptyCmdDir, { recursive: true })
      fs.writeFileSync(
        path.join(emptyCmdDir, 'package.json'),
        JSON.stringify({ name: 'empty-cmd', commands: [] }),
        'utf8'
      )

      await assert.rejects(
        async () => {
          await ingestRaycastExtension(emptyCmdDir)
        },
        /未声明任何可执行 commands/
      )
    })
  })

  // ==========================================================================
  // 3. @raycast/utils 与系统 API 兼容层集成测试
  // ==========================================================================
  describe('3. @raycast/utils 与核心兼容 API 深度联动', () => {
    test('usePromise 在发生网络/业务异常时能够安全捕获并驱动错误状态', async () => {
      let caughtError = null

      function ErrorCommand() {
        const { error, isLoading } = usePromise(
          async () => {
            throw new Error('Network timeout HTTP 504')
          },
          [],
          {
            onError: (err) => {
              caughtError = err
            }
          }
        )
        return {
          $$typeof: Symbol.for('ztools.declarative.descriptor'),
          type: 'List',
          props: { isLoading, errorMsg: error?.message },
          children: []
        }
      }

      const root = renderDeclarativeRoot(ErrorCommand)
      await new Promise(r => setTimeout(r, 40))

      const desc = root.getLatest()
      assert.equal(desc.props.isLoading, false)
      assert.equal(desc.props.errorMsg, 'Network timeout HTTP 504')
      assert.ok(caughtError)
      assert.equal(caughtError.message, 'Network timeout HTTP 504')
      root.unmount()
    })

    test('useCachedPromise 能够在跨组件渲染中持久保持高速数据命中', async () => {
      let callTimes = 0
      const fetchWithCount = async (id) => {
        callTimes++
        return `Result for ${id} (run #${callTimes})`
      }

      function CachedComp({ id }) {
        const { data } = useCachedPromise(fetchWithCount, [id])
        return {
          $$typeof: Symbol.for('ztools.declarative.descriptor'),
          type: 'Detail',
          props: { markdown: data || 'loading' },
          children: []
        }
      }

      const root1 = renderDeclarativeRoot(() => CachedComp({ id: 'task-1' }))
      await new Promise(r => setTimeout(r, 40))
      assert.equal(root1.getLatest().props.markdown, 'Result for task-1 (run #1)')
      root1.unmount()

      // 第二次实例化相同参数，首帧直接从 Cache 命中避免白屏
      const root2 = renderDeclarativeRoot(() => CachedComp({ id: 'task-1' }))
      assert.equal(root2.getLatest().props.markdown, 'Result for task-1 (run #1)', '首帧应由缓存立即填入')
      root2.unmount()
    })

    test('Cache 类能够支持多命名空间隔离、增删查与订阅监听', () => {
      const cacheA = new Cache({ namespace: 'ns-a' })
      const cacheB = new Cache({ namespace: 'ns-b' })

      cacheA.set('key1', 'value-a')
      cacheB.set('key1', 'value-b')

      assert.equal(cacheA.get('key1'), 'value-a')
      assert.equal(cacheB.get('key1'), 'value-b', '不同命名空间键名互不污染')

      let notifiedKey = null
      let notifiedVal = null
      const unsubscribe = cacheA.subscribe((k, v) => {
        notifiedKey = k
        notifiedVal = v
      })

      cacheA.set('key2', 'val2')
      assert.equal(notifiedKey, 'key2')
      assert.equal(notifiedVal, 'val2')

      unsubscribe()
      cacheA.set('key3', 'val3')
      assert.equal(notifiedKey, 'key2', '退订后不再触发监听通知')
    })

    test('environment 与 preferences 全局配置注入与读取闭环', () => {
      setEnvironment({
        extensionName: 'my-custom-ext',
        commandName: 'inspect',
        theme: 'light'
      })

      assert.equal(environment.extensionName, 'my-custom-ext')
      assert.equal(environment.commandName, 'inspect')
      assert.equal(environment.theme, 'light')

      clearPreferenceValues()
      assert.deepEqual(getPreferenceValues(), {})

      setPreferenceValues({ apiKey: 'sk-secret-1234', timeout: 5000 })
      const prefs = getPreferenceValues()
      assert.equal(prefs.apiKey, 'sk-secret-1234')
      assert.equal(prefs.timeout, 5000)
    })
  })
})
