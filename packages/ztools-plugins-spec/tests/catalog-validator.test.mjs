import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateCatalogPluginItem,
  validateStoreCatalog
} from '../src/validator.js'

describe('Store Catalog & Plugin Item Validator (Beyond Happy Path)', () => {
  describe('validateCatalogPluginItem', () => {
    it('Happy Case: 应该通过合法的插件条目', () => {
      const validItem = {
        id: 'everything-search',
        name: '文件秒搜',
        version: '1.2.0',
        author: 'ztools',
        description: '基于 NTFS MFT 的百万级文件检索',
        downloadUrl: 'https://cdn.ztools.top/plugins/ztools/everything-search/everything-search-1.2.0.zip',
        sha256: 'a'.repeat(64),
        size: 102400,
        revoked: false
      }
      const result = validateCatalogPluginItem(validItem)
      assert.equal(result.valid, true)
      assert.equal(result.errors.length, 0)
    })

    it('异常测试: 非对象与空值拦截', () => {
      assert.equal(validateCatalogPluginItem(null).valid, false)
      assert.equal(validateCatalogPluginItem(undefined).valid, false)
      assert.equal(validateCatalogPluginItem('string').valid, false)
      assert.equal(validateCatalogPluginItem([]).valid, false)
    })

    it('异常测试: 非法 ID（包含大写、特殊字符、空或越界）', () => {
      const badIds = ['', ' ', 'Invalid_ID', 'plugin@123', 'a'.repeat(65), '123start-with-number']
      for (const id of badIds) {
        const res = validateCatalogPluginItem({
          id,
          name: '测试',
          version: '1.0.0'
        })
        assert.equal(res.valid, false, `ID "${id}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('id 无效')))
      }
    })

    it('异常测试: 非法版本号（非 Semver）', () => {
      const badVersions = ['v1.0', '1.0', 'latest', '1.0.0.0', 'alpha', '']
      for (const version of badVersions) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version
        })
        assert.equal(res.valid, false, `version "${version}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('semver')))
      }
    })

    it('异常测试: 非法 downloadUrl（协议不安全或格式畸形）', () => {
      const badUrls = ['ftp://files.example.com/p.zip', 'file:///C:/test.zip', 'javascript:alert(1)', 'not-a-url', '']
      for (const downloadUrl of badUrls) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          downloadUrl
        })
        assert.equal(res.valid, false, `URL "${downloadUrl}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('downloadUrl')))
      }
    })

    it('异常测试: 非法 sha256 校验和（非 64 位、包含非十六进制、空等）', () => {
      const badSha = ['abc', 'a'.repeat(63), 'g'.repeat(64), '123456', '']
      for (const sha256 of badSha) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          sha256
        })
        assert.equal(res.valid, false, `sha256 "${sha256}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('sha256')))
      }
    })

    it('异常测试: 非法包体 size（0、负数、浮点数、非整型）', () => {
      const badSizes = [0, -100, 10.5, NaN, Infinity, '1024']
      for (const size of badSizes) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          size
        })
        assert.equal(res.valid, false, `size "${size}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('size')))
      }
    })

    it('异常测试: 非布尔类型的 revoked 状态', () => {
      const res = validateCatalogPluginItem({
        id: 'test-plugin',
        name: '测试',
        version: '1.0.0',
        revoked: 'true'
      })
      assert.equal(res.valid, false)
      assert.ok(res.errors.some((e) => e.includes('revoked')))
    })
  })

  describe('validateStoreCatalog', () => {
    it('Happy Case: 应该通过合法的全量 Catalog 索引并统计 revoked 数量', () => {
      const catalog = {
        schemaVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        plugins: [
          {
            id: 'calculator',
            name: '计算器',
            version: '1.0.0',
            downloadUrl: 'https://cdn.ztools.top/calculator.zip',
            sha256: 'b'.repeat(64),
            size: 2048,
            revoked: false
          },
          {
            id: 'malicious-tool',
            name: '恶意测试工具',
            version: '0.9.0',
            downloadUrl: 'https://cdn.ztools.top/malicious.zip',
            sha256: 'c'.repeat(64),
            size: 4096,
            revoked: true,
            revokedReason: '存在原型链逃逸风险，已被官方下架'
          }
        ]
      }
      const result = validateStoreCatalog(catalog)
      assert.equal(result.valid, true)
      assert.equal(result.totalValid, 2)
      assert.equal(result.revokedCount, 1)
      assert.equal(result.errors.length, 0)
    })

    it('异常测试: Catalog 顶层结构缺失或 plugins 非数组', () => {
      assert.equal(validateStoreCatalog(null).valid, false)
      assert.equal(validateStoreCatalog({}).valid, false)
      assert.equal(validateStoreCatalog({ plugins: 'not-array' }).valid, false)
    })

    it('异常测试: 包含重复 ID 的插件条目', () => {
      const catalogWithDuplicates = {
        schemaVersion: '1.0.0',
        plugins: [
          {
            id: 'duplicate-app',
            name: '应用 A',
            version: '1.0.0'
          },
          {
            id: 'duplicate-app',
            name: '应用 B (重复 ID)',
            version: '2.0.0'
          }
        ]
      }
      const result = validateStoreCatalog(catalogWithDuplicates)
      assert.equal(result.valid, false)
      assert.ok(result.errors.some((e) => e.includes('存在重复的插件 ID')))
    })

    it('混合容错测试: 部分条目损坏时的精准定位与统计', () => {
      const mixedCatalog = {
        schemaVersion: '1.0.0',
        plugins: [
          { id: 'valid-one', name: '有效应用', version: '1.0.0' },
          { id: 'INVALID ID', name: '损坏应用', version: 'bad-ver' },
          { id: 'valid-two', name: '有效应用2', version: '1.1.0' }
        ]
      }
      const result = validateStoreCatalog(mixedCatalog)
      assert.equal(result.valid, false)
      assert.equal(result.totalValid, 2)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0].includes('plugins[1] 校验失败'))
    })
  })
})
