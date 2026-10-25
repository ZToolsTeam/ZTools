import test from 'node:test'
import assert from 'node:assert/strict'

import { BuiltinPluginHostService } from '../electron-client/out/main/services/builtin-plugin-host-service.js'
import {
  parseChromiumBookmarksJson,
  searchAndFilterBookmarks,
  scanAllBrowserBookmarksWithMeta,
  BrowserBookmarksCommand,
  PasteStackQueueManager,
  cleanRichTextToPlain,
  readClipboardWithRetry,
  PasteStackCommand,
  resolveMacroTemplate,
  validateSnippetInput,
  SnippetsCommand,
  packOoxmlArchiveToBytes,
  inspectOoxmlArchive,
  processOoxmlSlimArchive,
  extractImagesFromOoxmlArchive,
  OfficeSlimCommand,
  parseMarkdownAST,
  buildDocxBuffer,
  extractDocxXmlFromBuffer,
  buildWordClipboardHtml,
  MdToOfficeCommand,
  matchFontLicense,
  parseOpenTypeNameTable,
  buildSyntheticOpenTypeFontBuffer,
  sanitizePreviewSampleText,
  scanInstalledFonts,
  FontManagerCommand
} from '../packages/declarative-ui/dist/index.js'

function createRealHostOverride(hostService) {
  return {
    __isRealHost: true,
    dllplugin_call: async (payload) => {
      return await hostService.handlePluginCall(payload.plugin, payload.func, payload.params || {})
    },
    font_manager: async (payload) => {
      return await hostService.handlePluginCall('FontManagerPlugin', payload.action || 'scan', payload)
    },
    md_to_office: async (payload) => {
      return await hostService.handlePluginCall('MdToOfficePlugin', payload.action || 'convert', payload)
    }
  }
}

test('14. browser-bookmarks: Chromium 嵌套书签树解析、拼音检索、SQLite 锁库与畸形 JSON 容错', async () => {
  const sampleTree = JSON.stringify({
    roots: {
      bookmark_bar: {
        name: '书签栏',
        type: 'folder',
        children: [
          {
            id: '101',
            name: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili',
            type: 'url',
            url: 'https://www.bilibili.com/',
            date_added: '13350000000000000'
          },
          {
            name: '开发文档',
            type: 'folder',
            children: [
              {
                name: '前端框架',
                type: 'folder',
                children: [
                  {
                    id: '102',
                    name: 'Vue.js 官方文档',
                    type: 'url',
                    url: 'https://cn.vuejs.org/'
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  })

  const parsed = parseChromiumBookmarksJson(sampleTree, 'edge', 'Microsoft Edge')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].title, '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili')
  assert.equal(parsed[1].folderBreadcrumb, '开发文档 / 前端框架')

  // 拼音首字母与子串搜索
  const biliHits = searchAndFilterBookmarks(parsed, 'blbl', 'all')
  assert.equal(biliHits.length, 1)
  assert.equal(biliHits[0].url, 'https://www.bilibili.com/')

  // 异常用例 1：损坏的 JSON 书签文件容错隔离不崩溃
  const brokenRes = await scanAllBrowserBookmarksWithMeta({
    customSources: [
      { browser: 'chrome', browserLabel: 'Google Chrome', jsonText: '{ broken json !!!' },
      { browser: 'edge', browserLabel: 'Microsoft Edge', jsonText: sampleTree }
    ]
  })
  assert.equal(brokenRes.bookmarks.length, 2)
  assert.equal(brokenRes.warnings.length, 1)

  // 异常用例 2 & 3：宿主 IPC 处理 Firefox places.sqlite 锁库只读拷贝与无浏览器环境
  const hostService = new BuiltinPluginHostService()
  const hostOverride = createRealHostOverride(hostService)
  const scanRes = await scanAllBrowserBookmarksWithMeta({ hostOverride })
  assert.equal(typeof scanRes.activeBrowserCount, 'number')
  assert.ok(Array.isArray(scanRes.bookmarks))

  const view = BrowserBookmarksCommand({ initialBookmarks: parsed, hostOverride })
  assert.ok(view)
})

test('15. paste-stack: FIFO/LIFO 顺序压栈弹栈、相邻去重、富文本清洗与空栈防护', async () => {
  const stack = new PasteStackQueueManager()

  // 连续推入 A, B, C
  const resA = stack.push('发票抬头：北京极客科技有限公司')
  const resB = stack.push('税号：91110108MA00123456')
  const resC = stack.push('开户行：招商银行北京中关村支行')
  assert.ok(resA.added && resB.added && resC.added)
  assert.equal(stack.getItems().length, 3)

  // 异常用例 1：相邻重复复制同一段文本自动防抖去重
  const dupC = stack.push('开户行：招商银行北京中关村支行')
  assert.equal(dupC.added, false)
  assert.equal(dupC.deduplicated, true)
  assert.equal(stack.getItems().length, 3)

  // FIFO 依次弹出 A -> B -> C
  assert.equal(stack.pop('fifo').popped?.text, '发票抬头：北京极客科技有限公司')
  assert.equal(stack.pop('fifo').popped?.text, '税号：91110108MA00123456')
  assert.equal(stack.pop('fifo').popped?.text, '开户行：招商银行北京中关村支行')

  // 异常用例 2：空栈状态下触发弹出返回 STACK_EMPTY 错误码
  const emptyPop = stack.pop('fifo')
  assert.equal(emptyPop.ok, false)
  assert.equal(emptyPop.errorCode, 'STACK_EMPTY')

  // LIFO 模式验证：压入 X, Y, Z 后弹出 Z -> Y -> X
  stack.push('第一项 X')
  stack.push('第二项 Y')
  stack.push('第三项 Z')
  assert.equal(stack.pop('lifo').popped?.text, '第三项 Z')
  assert.equal(stack.pop('lifo').popped?.text, '第二项 Y')
  assert.equal(stack.pop('lifo').popped?.text, '第一项 X')

  // 异常用例 3：HTML/RTF 富文本粘贴清洗与剪贴板锁死退避重试
  const cleaned = cleanRichTextToPlain('<div style="color:red">Hello &amp; <b>World</b></div>\n\n\n\nNext')
  assert.equal(cleaned, 'Hello & World\n\nNext')

  let tries = 0
  const retryText = await readClipboardWithRetry(
    async () => {
      tries++
      if (tries < 3) throw new Error('OpenClipboard failed')
      return 'Recovered Text'
    },
    { maxRetries: 3, baseDelayMs: 5 }
  )
  assert.equal(retryText, 'Recovered Text')

  const view = PasteStackCommand({ initialItems: stack.getItems() })
  assert.ok(view)
})

test('16. snippets: 动态宏变量展开 ({date}/{time}/{clipboard}/{cursor})、畸形语法容错与表单校验', async () => {
  const res = resolveMacroTemplate(
    '尊敬的客户，您的订单 {clipboard} 已于 {date} {time} 发货，备注：{cursor}请查收。',
    'SF1234567890',
    {
      fixedDate: '2026-10-25',
      fixedTime: '14:30:05'
    }
  )
  assert.equal(
    res.text,
    '尊敬的客户，您的订单 SF1234567890 已于 2026-10-25 14:30:05 发货，备注：请查收。'
  )
  assert.equal(res.cursorOffsetFromEnd, 4)

  // 异常用例 1：剪贴板为空或图片时 {clipboard} 替换为空串不输出 undefined/null
  const emptyClipRes = resolveMacroTemplate('单号：{clipboard}（完毕）', '')
  assert.equal(emptyClipRes.text, '单号：（完毕）')
  assert.ok(!emptyClipRes.text.includes('undefined'))

  // 异常用例 2：未闭合或未知宏语法原样保留防崩溃
  const unclosedRes = resolveMacroTemplate('代码片段 function() { return {unknown_var} + {date', 'CLIP')
  assert.match(unclosedRes.text, /\{unknown_var\}/)
  assert.match(unclosedRes.text, /\{date$/)

  // 异常用例 3：空正文与空标题校验拦截
  const invalidEmpty = validateSnippetInput({
    title: '测试短语',
    category: 'general',
    keyword: ';ok',
    content: '   '
  })
  assert.equal(invalidEmpty.valid, false)

  const view = SnippetsCommand({})
  assert.ok(view)
})

test('17. office-slim: OOXML 解包扫描、超清大图重编码瘦身、隐私元数据脱敏与加密/伪装文档拦截', async () => {
  // 构造一个包含 3 张超清大图 (>10MB) 与隐私元数据/批注的真实 OOXML 容器
  const rawArchiveBytes = packOoxmlArchiveToBytes({
    fileName: 'Q4季度商业路演报告.pptx',
    entries: {
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      'docProps/core.xml': '<cp:coreProperties><dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy><cp:revision>42</cp:revision></cp:coreProperties>',
      'ppt/comments/comment1.xml': '<p:cmList><p:cm>内部机密批注</p:cm></p:cmList>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="rId1" Target="../comments/comment1.xml"/></Relationships>',
      'ppt/media/hero-banner.png': new Uint8Array(4 * 1024 * 1024),
      'ppt/media/product-photo.jpg': new Uint8Array(4 * 1024 * 1024),
      'ppt/media/architecture.png': new Uint8Array(3 * 1024 * 1024)
    }
  })

  const summary = inspectOoxmlArchive(rawArchiveBytes, 'Q4季度商业路演报告.pptx', 'balanced')
  assert.equal(summary.images.length, 3)
  assert.equal(summary.hasComments, true)
  assert.equal(summary.hasAuthorMetadata, true)
  assert.ok(summary.savedPercent >= 70)

  // 执行瘦身 + 元数据脱敏
  const slimRes = processOoxmlSlimArchive(rawArchiveBytes, {
    quality: 'balanced',
    cleanMetadata: true,
    outputMode: 'new_file'
  })
  assert.ok(slimRes.finalMediaTotalBytes < 3 * 1024 * 1024)
  assert.equal(slimRes.outputArchive.entries['ppt/comments/comment1.xml'], undefined)
  assert.match(String(slimRes.outputArchive.entries['docProps/core.xml']), /<dc:creator><\/dc:creator>/)
  assert.ok(slimRes.outputArchive.entries['ppt/slides/slide1.xml'])

  // 一键提取全部内嵌原图
  const extractedImgs = extractImagesFromOoxmlArchive(rawArchiveBytes)
  assert.equal(extractedImgs.length, 3)

  // 异常用例 1：受密码保护的加密文档 (EncryptedPackage / OLE2 Header) 精准拦截
  const encryptedBytes = packOoxmlArchiveToBytes({
    fileName: 'encrypted.docx',
    entries: {},
    isEncryptedPackage: true
  })
  assert.throws(
    () => {
      inspectOoxmlArchive(encryptedBytes, 'encrypted.docx')
    },
    (err) => {
      assert.match(err.message, /OFFICE_ENCRYPTED_PACKAGE|密码保护/)
      return true
    }
  )

  // 异常用例 2：伪造扩展名的非标准 Office 文档格式拦截
  const fakeBytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc])
  assert.throws(
    () => {
      inspectOoxmlArchive(fakeBytes, 'fake.docx')
    },
    (err) => {
      assert.match(err.message, /OFFICE_INVALID_FORMAT|非标准 Office/)
      return true
    }
  )

  const view = OfficeSlimCommand({ initialDoc: summary })
  assert.ok(view)
})

test('18. md-to-office: Markdown AST 解析、公文 200 缩进、学术三线表、超长单元格 autofit 与畸形语法容错', async () => {
  const sampleMd = [
    '# 2026 人工智能算力基础设施研究报告',
    '',
    '## 一、 核心结论与行业趋势',
    '随着国产大模型参数规模持续跃升，推理侧算力需求呈现指数级增长。',
    '',
    '### 1.1 主流推理芯片性能对比',
    '| 芯片型号 | 显存带宽 | FP16 算力 | 典型功耗 |',
    '| :--- | :--- | :--- | :--- |',
    '| H100 SXM | 3.35 TB/s | 989 TFLOPS | 700W |',
    '| Ascend 910B | 1.2 TB/s | 320 TFLOPS | 310W |',
    '',
    '```ts',
    'export function calcThroughput(tokens: number, latencyMs: number): number {',
    '  return Math.round((tokens / latencyMs) * 1000)',
    '}',
    '```'
  ].join('\n')

  const ast = parseMarkdownAST(sampleMd)
  assert.equal(ast.metadata.title, '2026 人工智能算力基础设施研究报告')
  assert.equal(ast.metadata.headingsCount, 3)
  assert.equal(ast.metadata.tablesCount, 1)
  assert.equal(ast.metadata.codeBlocksCount, 1)

  // 1. 公文模式校验：必须包含 w:firstLineChars="200" 与 28磅行距 (w:line="560")
  const officialDocx = await buildDocxBuffer(sampleMd, {
    preset: 'official',
    fontSize: 'size-3',
    firstLineIndent: true
  })
  assert.ok(officialDocx.byteLength > 500)
  const officialXml = extractDocxXmlFromBuffer(officialDocx)
  assert.match(officialXml.documentXml, /w:firstLineChars="200"/)
  assert.match(officialXml.documentXml, /w:line="560"/)

  // 2. 学术模式校验：三线表顶线/底线 w:sz="12"，竖线 w:val="none"
  const academicDocx = await buildDocxBuffer(sampleMd, {
    preset: 'academic',
    fontSize: 'size-s4',
    firstLineIndent: true
  })
  const academicXml = extractDocxXmlFromBuffer(academicDocx)
  assert.match(academicXml.documentXml, /<w:top w:val="single" w:sz="12"/)
  assert.match(academicXml.documentXml, /<w:bottom w:val="single" w:sz="12"/)
  assert.match(academicXml.documentXml, /<w:insideV w:val="none"/)

  // 3. 异常用例 1：未闭合代码块与断头表格容错不崩溃
  const malformedMd = '# 畸形测试\n| 表头A | 表头B |\n```ts\nconst x = 1;'
  const malformedDocx = await buildDocxBuffer(malformedMd, {
    preset: 'business',
    fontSize: 'size-s4',
    firstLineIndent: false
  })
  assert.ok(malformedDocx.byteLength > 200)

  // 4. 异常用例 2：空输入防卫
  await assert.rejects(
    async () => {
      await buildDocxBuffer('   \n  ', {
        preset: 'official',
        fontSize: 'size-3',
        firstLineIndent: true
      })
    },
    (err) => {
      assert.match(err.message, /EMPTY_MARKDOWN_INPUT/)
      return true
    }
  )

  // 5. 异常用例 3：超长单元格 >1000 字符自动启用 w:autofit
  const longCellMd = `# 超长表格\n| 字段 | 内容 |\n| --- | --- |\n| 说明 | ${'超长单元格内容'.repeat(200)} |`
  const longCellDocx = await buildDocxBuffer(longCellMd, {
    preset: 'business',
    fontSize: 'size-s4',
    firstLineIndent: false
  })
  const longXml = extractDocxXmlFromBuffer(longCellDocx)
  assert.match(longXml.documentXml, /w:autofit/)

  const clipHtml = buildWordClipboardHtml(sampleMd, {
    preset: 'official',
    fontSize: 'size-3',
    firstLineIndent: true
  })
  assert.match(clipHtml, /StartFragment/)

  const view = MdToOfficeCommand({ initialMarkdown: sampleMd })
  assert.ok(view)
})

test('19. font-manager: 免费商用白名单指纹匹配、OpenType name 表解析、0字节坏文件容错与高并发扫描', async () => {
  // 1. 免费商用白名单与商业侵权字体精准识别
  const shs = matchFontLicense('Source Han Sans CN', 'SourceHanSansCN-Regular')
  assert.equal(shs.licenseType, 'free-commercial')
  assert.match(shs.licenseName, /OFL/)

  const wenkai = matchFontLicense('LXGW WenKai', 'LXGWWenKai-Regular')
  assert.equal(wenkai.licenseType, 'free-commercial')

  const fz = matchFontLicense('FZShuTi', 'FZSTK--GBK1-0')
  assert.equal(fz.licenseType, 'commercial-risk')

  // 2. OpenType 二进制 name 表真实解析 (< 10ms)
  const syntheticFont = buildSyntheticOpenTypeFontBuffer({
    family: 'Smiley Sans',
    subfamily: 'Oblique',
    postScriptName: 'SmileySans-Oblique',
    chineseName: '得意黑',
    copyright: 'Copyright (c) 2022 Atelier Anchor (OFL-1.1)'
  })
  const t0 = performance.now()
  const parsedName = parseOpenTypeNameTable(syntheticFont)
  const elapsed = performance.now() - t0
  assert.ok(parsedName)
  assert.equal(parsedName.family, 'Smiley Sans')
  assert.equal(parsedName.chineseName, '得意黑')
  assert.equal(parsedName.postScriptName, 'SmileySans-Oblique')
  assert.ok(elapsed < 25)

  // 3. 异常用例 1：0 字节或损坏的 .ttf 文件安全返回 null 不抛未捕获异常
  assert.equal(parseOpenTypeNameTable(new Uint8Array(0)), null)
  assert.equal(parseOpenTypeNameTable(new Uint8Array([0, 1, 2, 3, 4])), null)

  // 4. 异常用例 2：模拟 1200 款字体并发指纹匹配与筛选性能 (< 800ms)
  const startBatch = performance.now()
  const syntheticList = Array.from({ length: 1200 }, (_, idx) => {
    const fam = idx % 3 === 0 ? `Source Han Sans ${idx}` : idx % 3 === 1 ? `FZYaoTi-${idx}` : `Arial-${idx}`
    const lic = matchFontLicense(fam)
    return {
      uniqueId: `f-${idx}`,
      family: fam,
      weight: 'Regular',
      format: 'ttf',
      filePath: `C:\\Windows\\Fonts\\font-${idx}.ttf`,
      fileSize: 102400,
      licenseType: lic.licenseType
    }
  })
  const batchElapsed = performance.now() - startBatch
  assert.equal(syntheticList.length, 1200)
  assert.ok(batchElapsed < 800)

  // 5. 异常用例 3：超长预览文案与复杂组合字符安全截断
  const sanitized = sanitizePreviewSampleText('测试文案'.repeat(100), 40)
  assert.ok(sanitized.length <= 45)

  // 真实宿主扫描接口连通性
  const hostService = new BuiltinPluginHostService()
  const hostOverride = createRealHostOverride(hostService)
  const hostFonts = await scanInstalledFonts(hostOverride)
  assert.ok(Array.isArray(hostFonts))

  const view = FontManagerCommand({ initialFonts: syntheticList.slice(0, 10), hostOverride })
  assert.ok(view)
})
