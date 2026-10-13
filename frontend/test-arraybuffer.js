// ========================================
// V8 ArrayBuffer 性能测试
// ========================================

async function testArrayBufferPerformance() {
  const log = (msg, type = 'info') => {
    const color = {
      success: 'color: green; font-weight: bold',
      error: 'color: red; font-weight: bold',
      info: 'color: blue',
      warn: 'color: orange'
    }[type]
    console.log(`%c[ArrayBuffer Test] ${msg}`, color)
  }

  log('开始测试 V8 ArrayBuffer 文件传输性能')

  // 检测 ArrayBuffer 支持
  const supportsArrayBuffer =
    typeof window._readFileArrayBuffer === 'function' &&
    typeof window._writeFileArrayBuffer === 'function'

  if (supportsArrayBuffer) {
    log('✅ V8 ArrayBuffer 已启用', 'success')
  } else {
    log('❌ V8 ArrayBuffer 不可用，无法测试', 'error')
    return
  }

  // 创建测试数据
  const testSizes = [
    { size: 1024, name: '1KB' },
    { size: 10 * 1024, name: '10KB' },
    { size: 100 * 1024, name: '100KB' },
    { size: 512 * 1024, name: '512KB' },
    { size: 1024 * 1024, name: '1MB' },
    { size: 5 * 1024 * 1024, name: '5MB' }
  ]

  const testDir = await ztools.fs.getCurrentDirectory()
  log(`测试目录: ${testDir}`)

  for (const test of testSizes) {
    log(`\n===== 测试文件大小: ${test.name} =====`)

    const testFile = `${testDir}/test_arraybuffer_${test.name}.bin`
    const testContent = 'A'.repeat(test.size)

    try {
      // 测试写入性能
      const writeStart = performance.now()
      await ztools.fs.writeFile(testFile, testContent)
      const writeTime = performance.now() - writeStart

      log(
        `写入耗时: ${writeTime.toFixed(2)}ms (${(test.size / 1024 / 1024 / (writeTime / 1000)).toFixed(2)} MB/s)`,
        'info'
      )

      // 测试读取性能
      const readStart = performance.now()
      const readContent = await ztools.fs.readFile(testFile)
      const readTime = performance.now() - readStart

      log(
        `读取耗时: ${readTime.toFixed(2)}ms (${(test.size / 1024 / 1024 / (readTime / 1000)).toFixed(2)} MB/s)`,
        'info'
      )

      // 验证数据完整性
      if (readContent === testContent) {
        log(`✅ 数据验证成功 (${test.name})`, 'success')
      } else {
        log(`❌ 数据验证失败 (${test.name})`, 'error')
      }

      // 清理测试文件
      await ztools.fs.deleteFile(testFile)

      // 计算总体性能
      const totalTime = writeTime + readTime
      log(
        `总耗时: ${totalTime.toFixed(2)}ms (读写平均: ${((test.size * 2) / 1024 / 1024 / (totalTime / 1000)).toFixed(2)} MB/s)`,
        'success'
      )
    } catch (error) {
      log(`❌ 测试失败: ${error.message}`, 'error')
    }
  }

  log('\n===== 性能测试完成 =====', 'success')
}

// 二进制文件测试
async function testBinaryArrayBuffer() {
  const log = (msg, type = 'info') => {
    const color = {
      success: 'color: green; font-weight: bold',
      error: 'color: red; font-weight: bold',
      info: 'color: blue'
    }[type]
    console.log(`%c[Binary Test] ${msg}`, color)
  }

  log('开始测试二进制 ArrayBuffer 传输')

  const testDir = await ztools.fs.getCurrentDirectory()
  const testFile = `${testDir}/test_binary.bin`

  // 创建随机二进制数据
  const size = 1024 * 1024 // 1MB
  const randomBytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    randomBytes[i] = Math.floor(Math.random() * 256)
  }

  try {
    // 写入二进制数据
    log(`写入 ${size} 字节随机数据...`)
    const writeStart = performance.now()

    // 将 Uint8Array 转为 Base64 字符串写入
    let binaryString = ''
    for (let i = 0; i < randomBytes.length; i++) {
      binaryString += String.fromCharCode(randomBytes[i])
    }
    const base64 = btoa(binaryString)
    await ztools.fs.writeFile(testFile, base64, { encoding: 'base64' })

    const writeTime = performance.now() - writeStart
    log(`写入完成: ${writeTime.toFixed(2)}ms`, 'success')

    // 读取二进制数据
    log('读取二进制数据...')
    const readStart = performance.now()
    const readBytes = await ztools.fs.readFileAsBinary(testFile)
    const readTime = performance.now() - readStart
    log(`读取完成: ${readTime.toFixed(2)}ms`, 'success')

    // 验证数据
    if (readBytes.length === randomBytes.length) {
      let identical = true
      for (let i = 0; i < readBytes.length; i++) {
        if (readBytes[i] !== randomBytes[i]) {
          identical = false
          break
        }
      }

      if (identical) {
        log(`✅ 二进制数据验证成功！`, 'success')
      } else {
        log(`❌ 二进制数据不一致`, 'error')
      }
    } else {
      log(
        `❌ 文件大小不匹配: ${readBytes.length} vs ${randomBytes.length}`,
        'error'
      )
    }

    // 清理
    await ztools.fs.deleteFile(testFile)
  } catch (error) {
    log(`❌ 测试失败: ${error.message}`, 'error')
  }

  log('===== 二进制测试完成 =====', 'success')
}

// 对比 ArrayBuffer 不同文件大小性能
async function comparePerformance() {
  const log = (msg, type = 'info') => {
    const color = {
      success: 'color: green; font-weight: bold',
      error: 'color: red; font-weight: bold',
      info: 'color: blue',
      warn: 'color: orange; font-weight: bold'
    }[type]
    console.log(`%c[Performance Compare] ${msg}`, color)
  }

  log('开始测试不同文件大小的 ArrayBuffer 性能')

  const testDir = await ztools.fs.getCurrentDirectory()
  const testSizes = [
    { size: 100 * 1024, name: '100KB' },
    { size: 500 * 1024, name: '500KB' },
    { size: 1024 * 1024, name: '1MB' },
    { size: 5 * 1024 * 1024, name: '5MB' },
    { size: 10 * 1024 * 1024, name: '10MB' }
  ]

  for (const test of testSizes) {
    const testContent = 'X'.repeat(test.size)
    const testFile = `${testDir}/test_size_${test.name}.txt`

    try {
      log(`\n测试 ${test.name} 文件...`)
      const t1Start = performance.now()
      await ztools.fs.writeFile(testFile, testContent)
      const content1 = await ztools.fs.readFile(testFile)
      const t1Time = performance.now() - t1Start

      log(`耗时: ${t1Time.toFixed(2)}ms`, 'info')
      log(
        `传输速度: ${((test.size * 2) / 1024 / 1024 / (t1Time / 1000)).toFixed(2)} MB/s`,
        'warn'
      )

      // 清理
      await ztools.fs.deleteFile(testFile)

      log(`✅ ${test.name} 测试完成`, 'success')
    } catch (error) {
      log(`❌ ${test.name} 测试失败: ${error.message}`, 'error')
    }
  }

  log('\n===== 性能测试完成 =====', 'success')
}

// 运行所有测试
async function runAllTests() {
  console.log(
    '%c========================================',
    'color: purple; font-size: 16px; font-weight: bold'
  )
  console.log(
    '%cV8 ArrayBuffer 完整性能测试套件',
    'color: purple; font-size: 16px; font-weight: bold'
  )
  console.log(
    '%c========================================',
    'color: purple; font-size: 16px; font-weight: bold'
  )

  try {
    await testArrayBufferPerformance()
    console.log('\n')
    await testBinaryArrayBuffer()
    console.log('\n')
    await comparePerformance()
  } catch (error) {
    console.error('%c测试套件执行失败', 'color: red; font-weight: bold', error)
  }

  console.log(
    '\n%c========================================',
    'color: purple; font-size: 16px; font-weight: bold'
  )
  console.log(
    '%c所有测试完成！',
    'color: purple; font-size: 16px; font-weight: bold'
  )
  console.log(
    '%c========================================',
    'color: purple; font-size: 16px; font-weight: bold'
  )
}

// 导出测试函数
window.testArrayBuffer = {
  runAll: runAllTests,
  performance: testArrayBufferPerformance,
  binary: testBinaryArrayBuffer,
  compare: comparePerformance
}

console.log('%c[测试工具已加载]', 'color: green; font-weight: bold')
console.log('运行测试：')
console.log('  - window.testArrayBuffer.runAll()     // 运行所有测试')
console.log('  - window.testArrayBuffer.performance() // 性能测试')
console.log('  - window.testArrayBuffer.binary()      // 二进制测试')
console.log('  - window.testArrayBuffer.compare()     // 性能对比')
