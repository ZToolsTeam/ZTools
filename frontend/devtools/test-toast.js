/**
 * Toast 通知系统测试脚本
 *
 * 使用方法：
 * node test-toast.js
 *
 * 前置条件：
 * - ZTools 正在运行
 * - 远程调试端口已开启（默认 9222）
 */

const { execSync } = require('child_process')

console.log('🧪 开始测试 Toast 通知系统...\n')

const tests = [
  {
    name: '成功提示',
    code: `ztools.sys.toast('success', '操作成功！')`
  },
  {
    name: '错误提示',
    code: `ztools.sys.toast('error', '操作失败，请重试')`
  },
  {
    name: '信息提示',
    code: `ztools.sys.toast('info', '这是一条信息提示')`
  },
  {
    name: '警告提示',
    code: `ztools.sys.toast('warning', '请注意检查配置')`
  },
  {
    name: '加载提示（5秒）',
    code: `ztools.sys.toast('loading', '正在处理，请稍候...', 5)`
  },
  {
    name: '自定义时长（10秒）',
    code: `ztools.sys.toast('success', '这条消息会显示10秒', 10)`
  }
]

function runTest(test, index) {
  console.log(`[${index + 1}/${tests.length}] 测试: ${test.name}`)
  console.log(`   执行: ${test.code}`)

  try {
    const result = execSync(`node exec.js "${test.code}"`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    })
    console.log(`   ✅ 成功\n`)
  } catch (error) {
    console.log(`   ❌ 失败: ${error.message}\n`)
  }
}

// 依次执行测试，每个测试间隔 2 秒
tests.forEach((test, index) => {
  setTimeout(() => {
    runTest(test, index)

    // 最后一个测试完成后显示总结
    if (index === tests.length - 1) {
      setTimeout(() => {
        console.log('✨ 测试完成！')
        console.log('\n💡 提示：')
        console.log('- Toast 通知应该在 ZTools 窗口中显示')
        console.log('- 默认 3 秒后自动消失')
        console.log('- 支持明亮/暗黑主题自动适配')
        console.log('\n📖 更多用法请参考: docs/API使用指南.md')
      }, 1000)
    }
  }, index * 2000)
})
