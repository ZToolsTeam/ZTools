import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { localeMessages as ossLocaleMessages } from '../frontend/src/edition-oss/locales.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')

const zhCN = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'frontend/src/locales/zh-CN.json'), 'utf8'))
const enUS = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'frontend/src/locales/en-US.json'), 'utf8'))

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(target, source) {
  const result = { ...target }
  if (!isPlainObject(source)) return result
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const srcVal = source[key]
    const dstVal = result[key]
    if (isPlainObject(dstVal) && isPlainObject(srcVal)) {
      result[key] = deepMerge(dstVal, srcVal)
    } else if (srcVal !== undefined) {
      result[key] = srcVal
    }
  }
  return result
}

test('开源版 @edition-locales 回退：edition-oss/locales.js 导出冻结空对象且无外部依赖', () => {
  assert.equal(Object.isFrozen(ossLocaleMessages), true)
  assert.deepEqual(Object.keys(ossLocaleMessages), [])
})

test('开源版 @edition-locales 回退：合并空扩展词典后基础中英文词条完整且不抛出异常', () => {
  const base = { 'zh-CN': zhCN, 'en-US': enUS }
  const merged = {}
  for (const locale of ['zh-CN', 'en-US']) {
    const extra = isPlainObject(ossLocaleMessages[locale]) ? ossLocaleMessages[locale] : null
    merged[locale] = extra ? deepMerge(base[locale], extra) : { ...base[locale] }
  }

  assert.equal(typeof merged['zh-CN'].app?.windowTitle, 'string')
  assert.equal(typeof merged['en-US'].app?.windowTitle, 'string')
  assert.ok(merged['zh-CN'].app.windowTitle.length > 0)
  assert.ok(merged['en-US'].app.windowTitle.length > 0)
  // 开源版不注入额外扩展命名空间，且深合并对原型污染输入免疫
  assert.equal(merged['zh-CN'].__proto__, Object.prototype)
  const polluted = deepMerge({ ok: 'yes' }, JSON.parse('{"__proto__":{"hacked":true}}'))
  assert.equal(({}).hacked, undefined)
  assert.equal(polluted.ok, 'yes')
})

test('开源版 @edition-locales 回退：vite.config.js 在缺少官方扩展入口时正确指向 edition-oss/locales.js', () => {
  const viteConfigSrc = fs.readFileSync(path.join(ROOT_DIR, 'frontend/vite.config.js'), 'utf8')
  assert.match(viteConfigSrc, /src\/edition-oss\/locales\.js/)
  assert.match(viteConfigSrc, /['"]@edition-locales['"]\s*:\s*editionLocalesEntry/)
})
