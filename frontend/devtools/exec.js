const http = require('http')
const WebSocket = require('ws')
const readline = require('readline')

const HOST = '127.0.0.1'
const PORT = 9222

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2)
  const result = {
    mode: 'exec',
    target: null,
    expression: null,
    dllPlugin: null,
    dllFunc: null,
    dllParams: {}
  }

  let i = 0
  while (i < args.length) {
    if (args[i] === '--list' || args[i] === '-l') {
      result.mode = 'list'
      i++
    } else if (args[i] === '--target' || args[i] === '-t') {
      result.target = args[++i]
      i++
    } else if (args[i] === '--dll' || args[i] === '-d') {
      result.mode = 'dll'
      result.dllPlugin = args[++i]
      result.dllFunc = args[++i]
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        try {
          result.dllParams = JSON.parse(args[++i])
        } catch (e) {
          result.dllParams = args[i]
        }
      }
      i++
    } else if (!args[i].startsWith('-')) {
      result.expression = args[i]
      i++
    } else {
      i++
    }
  }
  return result
}

// 获取调试目标列表
function getTargets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://${HOST}:${PORT}/json`, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            const targets = JSON.parse(data)
            const filtered = targets.filter(
              (t) => t.type === 'page' && !t.url.startsWith('devtools://')
            )
            resolve(filtered)
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

// 显示目标列表
function listTargets(targets) {
  console.log('\x1b[36m%s\x1b[0m', '可用的调试目标:')
  targets.forEach((t, i) => {
    const name = t.title || 'Untitled'
    const url = t.url
    console.log(`  [\x1b[33m${i}\x1b[0m] ${name}`)
    console.log(`      \x1b[90m${url}\x1b[0m`)
  })
}

// 选择目标
function selectTarget(targets, selector) {
  if (selector === null || selector === undefined) {
    return targets[0] // 默认第一个
  }

  // 尝试按索引选择
  const index = parseInt(selector)
  if (!isNaN(index) && index >= 0 && index < targets.length) {
    return targets[index]
  }

  // 尝试按名称匹配
  const match = targets.find(
    (t) => t.title && (t.title.includes(selector) || t.url.includes(selector))
  )
  return match || null
}

// 交互式选择
function promptSelectTarget(targets) {
  return new Promise((resolve) => {
    listTargets(targets)
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question('\n请输入目标索引 [0]: ', (answer) => {
      rl.close()
      const idx = parseInt(answer) || 0
      resolve(targets[idx] || targets[0])
    })
  })
}

// 执行 JS 表达式
function executeOnTarget(wsUrl, jsExpression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)

    ws.on('open', () => {
      const request = {
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: jsExpression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true
        }
      }
      console.log(
        '\x1b[33m%s\x1b[0m',
        `-> 发送命令: ${jsExpression.substring(0, 100)}${jsExpression.length > 100 ? '...' : ''}`
      )
      ws.send(JSON.stringify(request))
    })

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data)
        if (response.id === 1) {
          if (response.error) {
            console.error(
              '\x1b[31m%s\x1b[0m',
              'CDP 协议错误:',
              JSON.stringify(response.error, null, 2)
            )
            reject(response.error)
          } else if (response.result && response.result.exceptionDetails) {
            const ex = response.result.exceptionDetails
            console.error('\x1b[31m%s\x1b[0m', 'JS 执行异常:')
            console.error(`  ${ex.text}`)
            if (ex.exception && ex.exception.description) {
              console.error(`  ${ex.exception.description}`)
            }
            reject(ex)
          } else {
            const resultVal = response.result.result.value
            console.log('\x1b[32m%s\x1b[0m', '-> 执行结果:')
            if (typeof resultVal === 'object') {
              console.log(JSON.stringify(resultVal, null, 2))
            } else {
              console.log(resultVal)
            }
            resolve(resultVal)
          }
          ws.close()
        }
      } catch (e) {
        console.error('处理响应失败:', e)
        ws.close()
        reject(e)
      }
    })

    ws.on('error', (error) => {
      console.error('WebSocket 错误:', error)
      reject(error)
    })
  })
}

// 生成 DLL 调用表达式
function buildDllExpression(plugin, func, params) {
  const paramsStr = JSON.stringify(params || {})
  return `ztools.dllplugin.call('${plugin}', '${func}', ${paramsStr})`
}

// 显示帮助
function showHelp() {
  console.log(`
\x1b[36mZTools DevTools CLI\x1b[0m

\x1b[33m用法:\x1b[0m
  node exec.js [选项] [表达式]

\x1b[33m选项:\x1b[0m
  --list, -l              列出所有调试目标
  --target, -t <索引|名称> 指定目标窗口
  --dll, -d <插件> <函数> [参数JSON]  调用 DLL 插件

\x1b[33m示例:\x1b[0m
  node exec.js --list
  node exec.js "alert('Hello')"
  node exec.js -t 1 "ztools.sys.getAppVersion()"
  node exec.js -t "右键管理" "ztools.dllplugin.call('ContextMenuPlugin', 'ScanMenuItems', {})"
  node exec.js --dll ContextMenuPlugin ScanMenuItems
  node exec.js --dll ContextMenuPlugin AddCustomMenuItem '{"name":"Test","command":"notepad.exe","type":"file"}'
`)
}

// 主函数
async function main() {
  const args = parseArgs()

  // 无参数时显示帮助
  if (process.argv.length <= 2) {
    showHelp()
    process.exit(0)
  }

  try {
    const targets = await getTargets()

    if (targets.length === 0) {
      console.error('\x1b[31m%s\x1b[0m', '未找到 ZTools 页面实例。')
      console.error('请确认 ZTools 是否正在运行，且配置了远程调试端口 ' + PORT)
      process.exit(1)
    }

    // 列表模式
    if (args.mode === 'list') {
      listTargets(targets)
      process.exit(0)
    }

    // 选择目标
    let target
    if (args.target !== null) {
      target = selectTarget(targets, args.target)
      if (!target) {
        console.error('\x1b[31m%s\x1b[0m', `未找到匹配的目标: ${args.target}`)
        listTargets(targets)
        process.exit(1)
      }
    } else if (targets.length > 1) {
      // 多个目标时交互式选择
      target = await promptSelectTarget(targets)
    } else {
      target = targets[0]
    }

    console.log(
      '\x1b[36m%s\x1b[0m',
      `-> 连接到目标: ${target.title || 'Untitled'}`
    )

    // 构建表达式
    let expression
    if (args.mode === 'dll') {
      if (!args.dllPlugin || !args.dllFunc) {
        console.error(
          '\x1b[31m%s\x1b[0m',
          '使用 --dll 时必须指定插件名和函数名'
        )
        process.exit(1)
      }
      expression = buildDllExpression(
        args.dllPlugin,
        args.dllFunc,
        args.dllParams
      )
    } else {
      expression = args.expression
    }

    if (!expression) {
      console.error('\x1b[31m%s\x1b[0m', '请提供要执行的表达式')
      showHelp()
      process.exit(1)
    }

    // 执行
    await executeOnTarget(target.webSocketDebuggerUrl, expression)
  } catch (err) {
    console.error('\x1b[31m%s\x1b[0m', '执行失败:', err.message || err)
    process.exit(1)
  }
}

main()
