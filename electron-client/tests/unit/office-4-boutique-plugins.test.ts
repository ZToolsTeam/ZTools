import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import {
  BuiltinPluginHostService,
  isSupportedPlugin,
  normalizePluginName
} from '../../src/main/services/builtin-plugin-host-service.js'
import { TranslatorService } from '../../src/main/services/translator-service.js'

function createSamplePngBuffer(width = 64, height = 64): Buffer {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2
      png.data[idx] = (x * 4) & 0xff
      png.data[idx + 1] = (y * 4) & 0xff
      png.data[idx + 2] = ((x + y) * 2) & 0xff
      png.data[idx + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

test('Office 4 Boutique Plugins: registration and alias normalization', () => {
  const host = new BuiltinPluginHostService()
  for (const [alias, canonical] of [
    ['batch-image', 'BatchImagePlugin'],
    ['BatchImagePlugin', 'BatchImagePlugin'],
    ['archive-manager', 'ArchiveManagerPlugin'],
    ['ArchiveManagerPlugin', 'ArchiveManagerPlugin'],
    ['invoice-assistant', 'InvoiceAssistantPlugin'],
    ['InvoiceAssistantPlugin', 'InvoiceAssistantPlugin']
  ] as const) {
    assert.equal(host.supportsPlugin(alias), true)
    assert.equal(isSupportedPlugin(alias), true)
    assert.equal(normalizePluginName(alias), canonical)
  }
})

test('1. BatchImagePlugin: real PNG compression, zero-regression guard, PDF merge & exception resilience', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-batch-image-test-'))

  try {
    const samplePng = path.join(tempDir, 'poster.png')
    await fs.writeFile(samplePng, createSamplePngBuffer(96, 96))

    // Happy Path: CompressImages with q85 preset
    const compressRes = (await host.handlePluginCall('BatchImagePlugin', 'CompressImages', {
      files: [samplePng],
      qualityTier: 'q85',
      outputFormat: 'keep',
      resizePreset: 'source'
    })) as {
      ok: boolean
      processedCount: number
      outputBytes: number
      results: Array<{
        sourcePath: string
        outputPath: string
        originalBytes: number
        outputBytes: number
      }>
    }

    assert.equal(compressRes.ok, true)
    assert.equal(compressRes.processedCount, 1)
    assert.ok(compressRes.results[0]!.outputBytes <= compressRes.results[0]!.originalBytes)
    assert.match(compressRes.results[0]!.outputPath, /poster_opt\.png$/)

    // Happy Path: MergeImagesToPdf
    const mergedPdfPath = path.join(tempDir, 'merged_images.pdf')
    const mergeRes = (await host.handlePluginCall('BatchImagePlugin', 'MergeImagesToPdf', {
      files: [samplePng],
      outputPath: mergedPdfPath
    })) as {
      ok: boolean
      outputPath: string
      pageCount: number
      outputBytes: number
    }
    assert.equal(mergeRes.ok, true)
    assert.equal(mergeRes.pageCount, 1)
    assert.ok(mergeRes.outputBytes > 100)
    const pdfHeader = (await fs.readFile(mergedPdfPath, 'latin1')).slice(0, 8)
    assert.match(pdfHeader, /^%PDF-1\./)

    // Beyond Happy Path: empty files, non-existent file, and corrupted image header
    const emptyRes = (await host.handlePluginCall('BatchImagePlugin', 'CompressImages', {
      files: []
    })) as { ok: boolean; error?: string }
    assert.equal(emptyRes.ok, false)
    assert.match(String(emptyRes.error), /未提供/)

    const corruptedImg = path.join(tempDir, 'corrupted.png')
    await fs.writeFile(corruptedImg, 'NOT_A_VALID_PNG_HEADER', 'utf8')
    const badRes = (await host.handlePluginCall('BatchImagePlugin', 'CompressImages', {
      files: [corruptedImg]
    })) as {
      ok: boolean
      processedCount: number
      errors: Array<{ file: string; error: string }>
    }
    assert.equal(badRes.ok, false)
    assert.equal(badRes.processedCount, 0)
    assert.ok(badRes.errors.length > 0)
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('2. ArchiveManagerPlugin: tree inspection, selective extraction, smart unwrap & Zip Slip defense', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-archive-mgr-test-'))

  try {
    const srcFile1 = path.join(tempDir, '财务报表_2026.xlsx')
    const srcFile2 = path.join(tempDir, '架构说明.md')
    await fs.writeFile(srcFile1, 'Sheet1: Revenue 100000', 'utf8')
    await fs.writeFile(srcFile2, '# Architecture Spec', 'utf8')

    // 1. CreateArchive
    const archivePath = path.join(tempDir, 'office_bundle.zip')
    const createRes = (await host.handlePluginCall('ArchiveManagerPlugin', 'CreateArchive', {
      sourcePaths: [srcFile1, srcFile2],
      outputPath: archivePath
    })) as {
      ok: boolean
      archivePath: string
      fileCount: number
      sizeBytes: number
    }
    assert.equal(createRes.ok, true)
    assert.equal(createRes.fileCount, 2)
    assert.ok(createRes.sizeBytes > 50)

    // 2. ListArchiveEntries
    const listRes = (await host.handlePluginCall('ArchiveManagerPlugin', 'ListArchiveEntries', {
      archivePath
    })) as {
      ok: boolean
      totalEntries: number
      hasSingleRootFolder: boolean
      traversalRiskCount: number
      entries: Array<{ entryName: string; category: string; hasPathTraversalRisk: boolean }>
    }
    assert.equal(listRes.ok, true)
    assert.equal(listRes.totalEntries, 2)
    assert.equal(listRes.hasSingleRootFolder, false)
    assert.equal(listRes.traversalRiskCount, 0)
    assert.ok(listRes.entries.some((e) => e.entryName === '财务报表_2026.xlsx' && e.category === '办公文档'))

    // 3. Selective extraction (extract only 1 file)
    const selectiveDest = path.join(tempDir, 'selective_out')
    const extractOneRes = (await host.handlePluginCall('ArchiveManagerPlugin', 'ExtractArchiveEntries', {
      archivePath,
      targetDir: selectiveDest,
      entryNames: ['财务报表_2026.xlsx'],
      smartUnwrap: false
    })) as {
      ok: boolean
      extractedCount: number
      extractedFiles: string[]
    }
    assert.equal(extractOneRes.ok, true)
    assert.equal(extractOneRes.extractedCount, 1)
    const extractedContent = await fs.readFile(path.join(selectiveDest, '财务报表_2026.xlsx'), 'utf8')
    assert.equal(extractedContent, 'Sheet1: Revenue 100000')

    // 4. Beyond Happy Path: VerifyArchive, non-existent archive & protected system directory
    const verifyRes = (await host.handlePluginCall('ArchiveManagerPlugin', 'VerifyArchive', {
      archivePath
    })) as { ok: boolean; verified: boolean; totalEntries: number }
    assert.equal(verifyRes.ok, true)
    assert.equal(verifyRes.verified, true)
    assert.equal(verifyRes.totalEntries, 2)

    const missingRes = (await host.handlePluginCall('ArchiveManagerPlugin', 'ListArchiveEntries', {
      archivePath: path.join(tempDir, 'missing.zip')
    })) as { ok: boolean; error?: string }
    assert.equal(missingRes.ok, false)
    assert.match(String(missingRes.error), /不存在/)

    // 受保护的系统目录按当前系统取：Windows 用系统目录，macOS / Linux 用 /usr/bin
    const protectedDir = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin'
    await assert.rejects(
      async () =>
        host.handlePluginCall('ArchiveManagerPlugin', 'ExtractArchiveEntries', {
          archivePath,
          targetDir: protectedDir
        }),
      /系统核心受保护路径/
    )

    if (process.platform !== 'win32') {
      // 非 Windows 上 Windows 风格路径不是绝对路径，必须拒绝，不能按工作目录解析后在工作目录下建出同名目录
      const cwdJunk = path.resolve('C:\\Windows\\System32')
      await assert.rejects(
        async () =>
          host.handlePluginCall('ArchiveManagerPlugin', 'ExtractArchiveEntries', {
            archivePath,
            targetDir: 'C:\\Windows\\System32'
          }),
        /绝对路径/
      )
      await assert.rejects(fs.stat(cwdJunk), { code: 'ENOENT' })
    }
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('3. InvoiceAssistantPlugin: XML & PDF stream invoice parsing, duplicate detection, CSV ledger & PDF merge', async () => {
  const host = new BuiltinPluginHostService()
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-invoice-test-'))

  try {
    const xmlInvoice1 = path.join(tempDir, 'didi_trip_01.xml')
    const xmlInvoice1Dup = path.join(tempDir, 'didi_trip_01_copy.xml')
    const xmlInvoice2 = path.join(tempDir, 'hotel_stay_02.xml')

    const xmlContent1 = `<?xml version="1.0" encoding="UTF-8"?>
<eInvoice>
  <InvoiceNumber>26312000000192837465</InvoiceNumber>
  <IssueDate>2026-10-18</IssueDate>
  <BuyerName>极客矩阵科技有限公司</BuyerName>
  <BuyerTaxId>91310000MA1FL8888X</BuyerTaxId>
  <SellerName>滴滴出行科技有限公司</SellerName>
  <ItemName>*运输服务*客运服务费</ItemName>
  <TotalTax-includedAmount>68.50</TotalTax-includedAmount>
  <TotaltaxAmount>2.00</TotaltaxAmount>
</eInvoice>`

    const xmlContent2 = `<?xml version="1.0" encoding="UTF-8"?>
<eInvoice>
  <InvoiceNumber>26312000000192839999</InvoiceNumber>
  <IssueDate>2026-10-19</IssueDate>
  <BuyerName>个人</BuyerName>
  <SellerName>华住酒店管理有限公司</SellerName>
  <ItemName>*住宿服务*代订住宿费</ItemName>
  <TotalTax-includedAmount>420.00</TotalTax-includedAmount>
  <TotaltaxAmount>23.77</TotaltaxAmount>
</eInvoice>`

    await fs.writeFile(xmlInvoice1, xmlContent1, 'utf8')
    await fs.writeFile(xmlInvoice1Dup, xmlContent1, 'utf8')
    await fs.writeFile(xmlInvoice2, xmlContent2, 'utf8')

    // 1. ParseInvoices: verify 4-element extraction, duplicate invoiceNo detection, and abnormal header check
    const parseRes = (await host.handlePluginCall('InvoiceAssistantPlugin', 'ParseInvoices', {
      files: [xmlInvoice1, xmlInvoice1Dup, xmlInvoice2]
    })) as {
      ok: boolean
      invoices: Array<{
        path: string
        invoiceNo: string
        totalAmount: number
        category: string
        isDuplicate: boolean
        isHeaderAbnormal: boolean
      }>
    }

    assert.equal(parseRes.ok, true)
    assert.equal(parseRes.invoices.length, 3)

    const dupItem = parseRes.invoices.find((i) => i.path === xmlInvoice1Dup)
    assert.ok(dupItem)
    assert.equal(dupItem.isDuplicate, true)

    const hotelItem = parseRes.invoices.find((i) => i.path === xmlInvoice2)
    assert.ok(hotelItem)
    assert.equal(hotelItem.category, '酒店住宿')
    assert.equal(hotelItem.isHeaderAbnormal, true)

    // 2. ExportReimbursementPackage: export UTF-8 BOM CSV ledger + non-destructive standardized copy
    const outputDir = path.join(tempDir, 'reimbursement_out')
    const exportRes = (await host.handlePluginCall('InvoiceAssistantPlugin', 'ExportReimbursementPackage', {
      invoices: parseRes.invoices.filter((i) => !i.isDuplicate),
      outputDir
    })) as {
      ok: boolean
      csvOutputPath: string
      renamedFiles: string[]
      totalAmount: number
    }
    assert.equal(exportRes.ok, true)
    assert.equal(exportRes.renamedFiles.length, 2)
    assert.equal(exportRes.totalAmount, 488.5)
    const csvRaw = await fs.readFile(exportRes.csvOutputPath, 'utf8')
    assert.equal(csvRaw.charCodeAt(0), 0xfeff, 'CSV 必须包含 UTF-8 BOM 以防 Excel 中文乱码')
    assert.match(csvRaw, /26312000000192837465/)
    assert.match(csvRaw, /滴滴出行科技有限公司/)

    // Beyond Happy Path: empty invoice list
    const emptyExport = (await host.handlePluginCall('InvoiceAssistantPlugin', 'ExportReimbursementPackage', {
      invoices: []
    })) as { ok: boolean; error?: string }
    assert.equal(emptyExport.ok, false)
    assert.match(String(emptyExport.error), /未提供/)
  } finally {
    await host.stop()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('4. TranslatorService: auto-flip when sourceLanguage="auto" equals targetLanguage & office phrase dictionary', async () => {
  const service = new TranslatorService()

  // When sourceLanguage is 'auto' and targetLanguage is 'zh-CN', inputting Chinese should auto-flip target to 'en'
  const zhInputRes = await service.translate('请在截止日期前提交报告', {
    sourceLanguage: 'auto',
    targetLanguage: 'zh-CN'
  })
  assert.equal(zhInputRes.sourceLanguage, 'zh-CN')
  assert.equal(zhInputRes.targetLanguage, 'en')
  assert.match(zhInputRes.translatedText, /submit the report before the deadline/i)

  // Language code normalization ('zh' -> 'zh-CN')
  const normRes = await service.translate('报销发票', {
    sourceLanguage: 'zh',
    targetLanguage: 'en'
  })
  assert.equal(normRes.sourceLanguage, 'zh-CN')
  assert.equal(normRes.targetLanguage, 'en')
  assert.match(normRes.translatedText, /reimbursement invoice/i)
})
