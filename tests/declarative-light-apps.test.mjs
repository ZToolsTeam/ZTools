import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanPluginSecurity } from '../scripts/scan-plugin-security.mjs'
import { buildPluginsRelease } from '../scripts/build-plugins-release.mjs'

// 导入 4 款全新声明式插件的纯核心逻辑 (基于编译产物测试真实运行能力)
// 计算器（随客户端内置的 plugins/calculator），与主搜索框内联计算共用同一份引擎
import { evaluateMathExpression } from '../plugins/calculator/dist/calculator-engine.js'
import CalculatorCommand from '../plugins/calculator/dist/index.js'

import {
  parseTimeInput,
  formatDateTime,
  formatBeijingTime,
  getRelativeTime
} from '../plugins/timestamp/dist/logic.js'
import TimestampCommand from '../plugins/timestamp/dist/index.js'

import {
  detectLanguage,
  translateText,
  fetchLiveTranslation
} from '../plugins/translator/dist/logic.js'
import TranslatorCommand from '../plugins/translator/dist/index.js'

import {
  createTodo,
  toggleTodoStatus,
  deleteTodoItem,
  clearCompletedTodos,
  filterAndSearchTodos
} from '../plugins/todo/dist/logic.js'
import TodoCommand, { CreateTodoForm } from '../plugins/todo/dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

describe('ZTools 纯声明式轻量插件套件集成与混沌抗毁性测试', () => {

  // =========================================================================
  // 第一部分：全景架构合规性与零 CSS 门禁审查
  // =========================================================================
  describe('1. 全景架构合规性与零 CSS 门禁审查', () => {
    const plugins = ['calculator', 'timestamp', 'translator', 'todo']

    for (const pluginId of plugins) {
      it(`插件 [${pluginId}] 必须 100% 通过 AST 安全静态门禁且绝不包含 CSS 文件`, async () => {
        const pluginDir = path.join(rootDir, 'plugins', pluginId)
        assert.ok(fs.existsSync(pluginDir), `插件目录必须存在: ${pluginDir}`)

        // 强断言：目录及子目录下绝对不允许存在任何 .css / .less / .scss 文件
        function scanDirForStyles(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            const p = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
              scanDirForStyles(p)
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase()
              assert.ok(
                !['.css', '.less', '.scss', '.sass', '.styl'].includes(ext),
                `插件 [${pluginId}] 严禁包含样式文件: ${p}`
              )
            }
          }
        }
        scanDirForStyles(pluginDir)

        // 执行官方 AST 安全扫描器
        const scanResult = await scanPluginSecurity(pluginDir)
        assert.equal(scanResult.passed, true, `插件 [${pluginId}] 必须通过 AST 安全扫描`)
        assert.equal(scanResult.violations.length, 0, `插件 [${pluginId}] 不得包含任何安全违规`)
        if (pluginId === 'translator') {
          assert.equal(scanResult.requiresTwoManReview, true, `插件 [${pluginId}] 声明 network 权限应触发双人复核审查`)
        } else {
          assert.equal(scanResult.requiresTwoManReview, false, `插件 [${pluginId}] 无需高危复核`)
        }
      })
    }

    it('自动化打包流水线应成功将 4 款新插件打包为 ZIP 发布包', async () => {
      const releaseOutDir = path.join(rootDir, 'dist/test-light-plugins-release')
      if (fs.existsSync(releaseOutDir)) {
        fs.rmSync(releaseOutDir, { recursive: true, force: true })
      }

      const res = await buildPluginsRelease({
        pluginsDir: path.join(rootDir, 'plugins'),
        outputDir: releaseOutDir,
        failFast: false
      })

      assert.ok(res.passedCount >= 4, `至少应成功打包 4 款插件，实际: ${res.passedCount}`)
      assert.ok(fs.existsSync(path.join(releaseOutDir, 'plugins.json')), '静态全网索引 plugins.json 必须生成')

      const indexJson = JSON.parse(fs.readFileSync(path.join(releaseOutDir, 'plugins.json'), 'utf8'))
      for (const p of plugins) {
        const item = indexJson.plugins.find(x => x.id === p)
        assert.ok(item, `plugins.json 中必须包含 [${p}] 插件元数据`)
        assert.ok(item.sha256, `[${p}] 必须计算 SHA256 校验和`)
        assert.ok(item.downloadUrl.endsWith('.zip'), `[${p}] 发布物必须为 .zip`)
      }
    })
  })

  // =========================================================================
  // 第二部分：极简即时计算器 (calculator) 业务闭环与破坏性异常测试
  // =========================================================================
  describe('2. 极简即时计算器 (calculator) 业务闭环与破坏性异常测试', () => {
    const ok = (expr, formatted) => {
      const r = evaluateMathExpression(expr)
      assert.equal(r.error, undefined, `${expr}: ${r.error}`)
      assert.equal(r.formattedAnswer, formatted, expr)
    }
    const fail = (expr, pattern) => {
      const r = evaluateMathExpression(expr)
      assert.equal(r.answer, null, expr)
      assert.equal(r.formattedAnswer, '', expr)
      assert.match(r.error, pattern, expr)
    }

    it('Happy Path: 基础算术运算与科学函数高精度计算', () => {
      ok('1024 * 768 + 512', '786,944')
      ok('0.1 + 0.2', '0.3')
      ok('2 ^ 10', '1,024')
      ok('sqrt(65536)', '256')
      ok('sin(pi / 2)', '1')
      ok('cos(0)', '1')
      ok('abs(-99.5)', '99.5')
      ok('log(1000)', '3')
      // 一元负号：2*-3 与 2^-1 曾被错误算成 -3 与 0
      ok('2*-3', '-6')
      ok('2^-1', '0.5')
    })

    it('Fault Injection: 除以零与模运算除以零破坏性拦截', () => {
      fail('100 / 0', /除数不能为零/)
      fail('50 % 0', /除数不能为零/)
      fail('(10 + 20) / (5 - 5)', /除数不能为零/)
    })

    it('Fault Injection: 负数开方与非法对数参数破坏性拦截', () => {
      fail('sqrt(-16)', /负数没有实数平方根/)
      fail('log(0)', /无实数解/)
      fail('ln(-5)', /无实数解/)
    })

    it('Fault Injection: 畸形括号与语法残缺异常拦截', () => {
      fail('((10 + 20)', /括号不匹配/)
      fail('10 + * 5', /参数不足/)
      fail('sqrt', /参数不足/)
      fail('10 + ', /参数不足/)
    })

    it('Fault Injection: 空值、非法字符与脚本注入攻击防御', () => {
      for (const empty of ['', '   ', null, undefined]) {
        const r = evaluateMathExpression(empty)
        assert.equal(r.isCalculation, false)
        assert.equal(r.answer, null)
      }
      fail('<script>alert(1)</script>', /非法输入字符/)
      fail('select * from user', /未知标识符/)
    })

    it('Declarative UI View: 计算器主组件渲染测试', () => {
      const view = CalculatorCommand()
      assert.equal(view.type, 'List')
      assert.ok(Array.isArray(view.children))
      assert.ok(view.children.length > 0)
    })
  })

  // =========================================================================
  // 第三部分：时间戳转换助手 (timestamp) 业务闭环与破坏性异常测试
  // =========================================================================
  describe('3. 时间戳转换助手 (timestamp) 业务闭环与破坏性异常测试', () => {
    const fixedNow = new Date('2026-10-12T16:00:00Z')

    it('Happy Path: 默认无输入时生成完整规范的实时时间指标', () => {
      const res = parseTimeInput('', fixedNow)
      assert.equal(res.valid, true)
      assert.equal(res.unixSeconds, 1791820800)
      assert.equal(res.unixMilliseconds, 1791820800000)
      assert.ok(res.localDateTime)
      assert.ok(res.beijingDateTime)
      assert.ok(res.utcIso.includes('2026-10-12'))
      assert.ok(res.relativeTime.includes('现在'))
      assert.ok(res.dayOfWeek)
    })

    it('Happy Path: 10位与13位时间戳双向精准解析', () => {
      // 10位 Unix 秒
      const res10 = parseTimeInput('1791820800', fixedNow)
      assert.equal(res10.valid, true)
      assert.equal(res10.unixSeconds, 1791820800)
      assert.equal(res10.utcIso, '2026-10-12T16:00:00.000Z')

      // 13位 Unix 毫秒
      const res13 = parseTimeInput('1791820800000', fixedNow)
      assert.equal(res13.valid, true)
      assert.equal(res13.unixMilliseconds, 1791820800000)
    })

    it('Happy Path: 常见日期文本格式智能解析', () => {
      const resDate = parseTimeInput('2026-10-12 15:30:00', fixedNow)
      assert.equal(resDate.valid, true)
      assert.ok(resDate.unixSeconds > 0)

      const resSlash = parseTimeInput('2026/10/12 15:30:00', fixedNow)
      assert.equal(resSlash.valid, true)
    })

    it('Happy Path: 相对时间多粒度推导', () => {
      const now = new Date('2026-10-12T12:00:00Z')
      const t1 = new Date(now.getTime() - 3000) // 3 秒前
      assert.equal(getRelativeTime(t1, now), '刚刚')

      const t2 = new Date(now.getTime() - 120000) // 2 分钟前
      assert.equal(getRelativeTime(t2, now), '2 分钟前')

      const t3 = new Date(now.getTime() + 7200000) // 2 小时后
      assert.equal(getRelativeTime(t3, now), '2 小时后')

      const t4 = new Date(now.getTime() - 86400000 * 3) // 3 天前
      assert.equal(getRelativeTime(t4, now), '3 天前')
    })

    it('Fault Injection: 无法解析的畸形日期文本与超前年份防御', () => {
      const rInvalid = parseTimeInput('not_a_date_string', fixedNow)
      assert.equal(rInvalid.valid, false)
      assert.ok(rInvalid.error.includes('无法解析的时间内容'))

      // 远古时间 (小于 1970)
      const rPast = parseTimeInput('1800-01-01', fixedNow)
      assert.equal(rPast.valid, false)
      assert.ok(rPast.error.includes('年份超出合理范围'))

      // 远未来时间 (大于 2200)
      const rFuture = parseTimeInput('2500-01-01', fixedNow)
      assert.equal(rFuture.valid, false)
      assert.ok(rFuture.error.includes('年份超出合理范围'))
    })

    it('Declarative UI View: 时间戳主组件渲染测试', () => {
      const view = TimestampCommand()
      assert.equal(view.type, 'List')
      assert.equal(view.props.navigationTitle, '时间戳转换助手')
      assert.ok(view.children.length > 0)
    })
  })

  // =========================================================================
  // 第四部分：多语言即时翻译 (translator) 业务闭环与破坏性异常测试
  // =========================================================================
  describe('4. 多语言即时翻译 (translator) 业务闭环与破坏性异常测试', () => {
    it('Happy Path: 智能语种探测与离线字典精确命中', () => {
      assert.equal(detectLanguage('你好，世界'), 'zh')
      assert.equal(detectLanguage('Declarative Framework'), 'en')
      assert.equal(detectLanguage('こんにちは'), 'ja')
      assert.equal(detectLanguage('안녕하세요'), 'ko')

      // 离线字典命中
      const resHello = translateText('hello')
      assert.equal(resHello.sourceLang, 'en')
      assert.equal(resHello.targetLang, 'zh')
      assert.equal(resHello.translatedText, '你好，问候')
      assert.ok(resHello.phonetic)
      assert.ok(resHello.definitions.length > 0)
      assert.ok(resHello.examples.length > 0)

      const resZh = translateText('开源')
      assert.equal(resZh.sourceLang, 'zh')
      assert.equal(resZh.targetLang, 'en')
      assert.equal(resZh.translatedText, 'Open Source')
    })

    it('Real API Integration: 真实在线神经翻译全链路闭环', async () => {
      const resLive = await fetchLiveTranslation('Hello world', 'zh')
      assert.equal(resLive.sourceText, 'Hello world')
      assert.equal(resLive.sourceLang, 'en')
      assert.equal(resLive.targetLang, 'zh')
      assert.match(resLive.translatedText, /你好/)

      const resZh = await fetchLiveTranslation('苹果', 'en')
      assert.match(resZh.translatedText.toLowerCase(), /apple/)

      const resJp = await fetchLiveTranslation('苹果', 'jp')
      assert.ok(resJp.translatedText)
    })

    it('Beyond Happy Path: 未收录新词启发式推导与容错', () => {
      const resUnknownEn = translateText('Antigravity')
      assert.equal(resUnknownEn.sourceLang, 'en')
      assert.ok(resUnknownEn.translatedText.includes('Antigravity'))

      const resUnknownZh = translateText('量子纠缠深度学习')
      assert.equal(resUnknownZh.sourceLang, 'zh')
      assert.ok(resUnknownZh.translatedText.includes('量子纠缠深度学习'))
    })

    it('Fault Injection: 空值、空白与超长异常输入', () => {
      const resEmpty = translateText('')
      assert.equal(resEmpty.sourceText, '')
      assert.equal(resEmpty.translatedText, '')

      const resSpace = translateText('    ')
      assert.equal(resSpace.sourceText, '')

      const longText = 'A'.repeat(5000)
      const resLong = translateText(longText)
      assert.ok(resLong.translatedText)
    })

    it('Declarative UI View: 翻译主组件渲染测试', () => {
      const view = TranslatorCommand()
      assert.equal(view.type, 'List')
      assert.equal(view.props.navigationTitle, '多语言即时翻译')
      assert.ok(view.children.length > 0)
    })
  })

  // =========================================================================
  // 第五部分：极简待办清单 (todo) 业务闭环与破坏性异常测试
  // =========================================================================
  describe('5. 极简待办清单 (todo) 业务闭环与破坏性异常测试', () => {
    it('Happy Path: 创建、切换状态、多维度过滤与优先级排序', () => {
      let todos = []

      // 1. 创建 3 项不同优先级的任务
      const t1 = createTodo('完成零 CSS 架构落地', 'high')
      const t2 = createTodo('编写破坏性集成测试', 'high')
      const t3 = createTodo('喝杯咖啡休息一下', 'low')
      todos = [t1, t2, t3]
      assert.equal(todos.length, 3)

      // 2. 切换 t1 为完成
      todos = toggleTodoStatus(todos, t1.id)
      assert.equal(todos.find(t => t.id === t1.id).completed, true)
      assert.ok(todos.find(t => t.id === t1.id).completedAt > 0)

      // 3. 过滤测试
      const activeList = filterAndSearchTodos(todos, 'active')
      assert.equal(activeList.length, 2)
      assert.ok(activeList.every(t => !t.completed))

      const completedList = filterAndSearchTodos(todos, 'completed')
      assert.equal(completedList.length, 1)
      assert.equal(completedList[0].id, t1.id)

      // 4. 关键词搜索
      const searchResult = filterAndSearchTodos(todos, 'all', '测试')
      assert.equal(searchResult.length, 1)
      assert.equal(searchResult[0].id, t2.id)

      // 5. 清空已完成
      todos = clearCompletedTodos(todos)
      assert.equal(todos.length, 2)
      assert.ok(!todos.some(t => t.id === t1.id))

      // 6. 删除单项
      todos = deleteTodoItem(todos, t2.id)
      assert.equal(todos.length, 1)
      assert.equal(todos[0].id, t3.id)
    })

    it('Fault Injection: 待办标题空值与空白字符严格防御', () => {
      assert.throws(() => createTodo(''), /待办事项标题不能为空/)
      assert.throws(() => createTodo('   '), /待办事项标题不能为空/)
      assert.throws(() => createTodo(null), /待办事项标题不能为空/)
      assert.throws(() => createTodo(undefined), /待办事项标题不能为空/)
    })

    it('Fault Injection: 针对不存在的 ID 执行状态切换与删除必须安全幂等', () => {
      const initial = [createTodo('任务 A', 'medium')]
      const afterToggle = toggleTodoStatus(initial, 'non-existent-id')
      assert.equal(afterToggle.length, 1)
      assert.equal(afterToggle[0].completed, false)

      const afterDelete = deleteTodoItem(initial, 'non-existent-id')
      assert.equal(afterDelete.length, 1)
    })

    it('Stress Test: 1000 条待办排序与检索性能压测', () => {
      const largeList = []
      for (let i = 0; i < 1000; i++) {
        largeList.push({
          id: `stress-${i}`,
          title: `系统任务 ${i} ${i % 2 === 0 ? '紧急维护' : '日常巡检'}`,
          completed: i % 3 === 0,
          priority: i % 5 === 0 ? 'high' : i % 2 === 0 ? 'medium' : 'low',
          createdAt: Date.now() - i * 1000
        })
      }

      const start = performance.now()
      const filtered = filterAndSearchTodos(largeList, 'active', '紧急维护')
      const elapsed = performance.now() - start

      assert.ok(filtered.length > 0)
      assert.ok(filtered.every(t => !t.completed && t.title.includes('紧急维护')))
      assert.ok(elapsed < 20, `1000条检索耗时必须小于 20ms，实际耗时: ${elapsed.toFixed(3)}ms`)
    })

    it('Declarative UI View: 待办主列表与新建 Form 表单渲染测试', () => {
      const listView = TodoCommand()
      assert.equal(listView.type, 'List')
      assert.equal(listView.props.navigationTitle, '极简待办清单')
      assert.ok(listView.children.length > 0)

      let created = null
      const formView = CreateTodoForm({
        onCreated: (item) => { created = item }
      })
      assert.equal(formView.type, 'Form')
      assert.equal(formView.props.navigationTitle, '新建待办事项')
      assert.ok(formView.children.length >= 2)
    })
  })
})
