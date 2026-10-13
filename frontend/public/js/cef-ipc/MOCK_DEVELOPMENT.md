# Mock 开发环境使用指南

## 概述

ZTools API 支持在**开发环境**（无 Delphi 主程序）下调试网页，通过智能 Mock 系统实现：

- **API 调用**：自动返回合理的模拟数据
- **数据库**：使用浏览器 LocalStorage 真实存储
- **环境检测**：自动识别 localhost/127.0.0.1

## 自动启用 Mock

### 默认行为

在以下环境中，Mock 模式**自动启用**：

```javascript
// 1. localhost 环境
http://localhost:3000/plugin.html

// 2. 127.0.0.1 环境
http://127.0.0.1:8080/index.html
```

### 手动控制

```javascript
// 强制启用 Mock（不管什么环境）
localStorage.setItem('ZTOOLS_MOCK_ENABLED', '1')

// 强制禁用 Mock（即使在 localhost）
localStorage.setItem('ZTOOLS_MOCK_ENABLED', '0')

// 然后刷新页面
location.reload()
```

## Mock 行为说明

### 1. 文件系统 API (`ztools.fs`)

```javascript
// ✅ 返回模拟数据
const content = await ztools.fs.readFile('test.txt')
// => "这是 Mock 文件内容"

const exists = await ztools.fs.fileExists('any-file.txt')
// => true

const files = await ztools.fs.getDirectoryContents('C:\\')
// => ['mock-file1.txt', 'mock-file2.txt', 'mock-folder']
```

### 2. 数据库 API (`ztools.db`)

```javascript
// ✅ 真实存储到 LocalStorage
await ztools.db.setPluginId('my-plugin')

await ztools.db.put({ _id: 'doc1', name: 'Test' })
// 实际写入: localStorage['ztools_db_my-plugin_doc1']

const doc = await ztools.db.get('doc1')
// 实际读取: localStorage['ztools_db_my-plugin_doc1']
// => { _id: 'doc1', name: 'Test' }
```

**重要**：DB 数据持久化在浏览器本地，清空 localStorage 会丢失数据！

### 3. 系统 API (`ztools.sys`)

```javascript
// ✅ 模拟通知（控制台输出）
await ztools.sys.notify('标题', '消息')
// Console: [Mock 通知] 标题: 消息

// ✅ 返回模拟系统信息
const info = await ztools.sys.getInfo()
// => { os: 'Windows 10 (Mock)', version: '1.0.0-mock', ... }

// ⚠️ 操作类 API 无实际效果
await ztools.sys.shutdown() // 仅返回 { success: true }
```

### 4. 窗口 API (`ztools.window`)

```javascript
// ✅ 文件对话框返回固定路径
const result = await ztools.window.showOpenDialog()
// => { canceled: false, filePath: 'C:\\Mock\\selected-file.txt' }

// ⚠️ 窗口操作无实际效果
await ztools.window.maximize() // 仅返回 { success: true }
```

### 5. 剪贴板 API (`ztools.clipboard`)

```javascript
// ✅ 剪贴板内容存储在内存中
await ztools.clipboard.copyText('Hello')
const text = await ztools.clipboard.readText()
// => "Hello"

// ⚠️ 不会影响真实系统剪贴板
```

### 6. 网络 API (`ztools.network`)

```javascript
// ✅ 返回模拟 HTTP 响应
const response = await ztools.network.get('https://api.example.com/data')
// => { statusCode: 200, body: '{"mock": true, ...}' }

// 💡 提示：开发时可用浏览器原生 fetch（不受 CORS 限制）
const realResponse = await fetch('https://api.example.com/data')
```

### 7. DLL 插件 API (`ztools.dllplugin`)

```javascript
// ❌ DLL 插件在 Mock 环境不可用
try {
  await ztools.dllplugin.call('ZipPlugin', 'Compress', {...})
} catch (error) {
  // error: "DLL 插件在 Mock 环境下不可用，请在 ZTools 应用中运行"
}

// ❌ Archive/Image/FFmpeg API 依赖 DLL，同样不可用
await ztools.archive.compress(...)  // 会失败
await ztools.image.resize(...)      // 会失败
```

## 调试技巧

### 1. 查看 Mock 日志

打开浏览器控制台，可以看到详细的 Mock 日志：

```
[ztools-mock] Mock 环境已启用
[mock-provider] 生成 Mock 响应: filesystem_read_file {...}
[ztools-db] Non-CEF environment detected, forcing localStorage mode
```

### 2. 启用调试模式

```javascript
// 在控制台执行
localStorage.setItem('ZTOOLS_DEBUG', '1')
location.reload()

// 会显示更详细的 transport 层日志
// [ztools-transport] call -> filesystem_read_file {...}
// [ztools-transport] recv <- {...}
```

### 3. 检查环境信息

```javascript
// 查看当前环境
const env = ztools.transport.getEnvironment()
console.log(env)
// => {
//   type: 'browser',
//   isCEF: false,
//   isBrowser: true,
//   mockEnabled: true,
//   userAgent: "...",
//   platform: "..."
// }
```

## 扩展 Mock 功能

### 添加新 API 的 Mock 支持

编辑 `src/core/mock-provider.js`：

```javascript
// 1. 在对应的分类方法中添加处理器
_mockFileSystem(method, params) {
  const handlers = {
    // 添加新方法
    'filesystem_my_new_api': () => ({
      success: true,
      myData: 'mock result'
    }),
    // ... 其他方法
  }

  const handler = handlers[method]
  return handler ? handler() : this._mockDefault(method, params)
}

// 2. 重新构建
// node build.cjs
```

### 添加新模块的 Mock 支持

```javascript
// 在 MockProvider.generate() 中添加新分支
generate(method, params) {
  const prefix = method.split('_')[0]

  switch (prefix) {
    // ... 现有模块

    case 'mymodule':
      return this._mockMyModule(method, params)

    default:
      return this._mockDefault(method, params)
  }
}

// 添加处理方法
_mockMyModule(method, params) {
  const handlers = {
    'mymodule_action': () => ({ success: true, data: 'mock' })
  }

  const handler = handlers[method]
  return handler ? handler() : { success: true }
}
```

## 常见问题

### Q: 为什么 DB 数据刷新后还在？

A: DB 使用 LocalStorage 真实存储，数据持久化。清空方法：

```javascript
// 清空所有插件数据
Object.keys(localStorage)
  .filter((k) => k.startsWith('ztools_db_'))
  .forEach((k) => localStorage.removeItem(k))
```

### Q: 如何模拟 API 错误？

A: 修改 `mock-provider.js` 返回错误响应：

```javascript
'filesystem_read_file': () => ({
  success: false,
  error: '文件不存在'
})
```

### Q: Mock 环境能完全替代真实环境吗？

A: **不能**。Mock 有以下限制：

- ❌ DLL 插件功能（压缩、图片处理、FFmpeg）
- ❌ 真实的文件系统操作
- ❌ 真实的系统操作（关机、热键等）
- ❌ 真实的剪贴板交互

建议：**基础开发用 Mock，完整测试用真实环境**。

### Q: 如何在生产环境禁用 Mock？

A: Mock 只在非 CEF 环境（浏览器）启用。在 ZTools 应用中运行时，自动使用真实 API，无需配置。

## 最佳实践

### 1. 分离开发和生产逻辑

```javascript
// ✅ 推荐：统一使用 ztools API
async function loadData() {
  const data = await ztools.db.get('my-data')
  // Mock 环境：从 localStorage 读取
  // 真实环境：从 Delphi 数据库读取
  return data
}

// ❌ 不推荐：手动判断环境
if (typeof window.ztools !== 'undefined') {
  // 真实环境
} else {
  // Mock 环境
}
```

### 2. 功能降级提示

对于 Mock 不支持的功能，给用户友好提示：

```javascript
async function compressFile(input, output) {
  try {
    await ztools.archive.compress([input], output)
    return { success: true }
  } catch (error) {
    if (error.message.includes('Mock 环境')) {
      alert('压缩功能需要在 ZTools 应用中使用')
      return { success: false, reason: 'mock' }
    }
    throw error
  }
}
```

### 3. 使用环境检测

```javascript
// 检测是否在开发环境
const isDev = !ztools.transport.isCEFEnvironment()

if (isDev) {
  console.warn('当前在开发环境，部分功能不可用')
}

// 禁用依赖 DLL 的功能
document.querySelector('#compress-btn').disabled = isDev
```

## 总结

Mock 系统让你可以：

✅ 在浏览器中快速开发和调试插件  
✅ 无需启动 Delphi 主程序  
✅ 使用真实的 localStorage 存储数据  
✅ 自动识别开发环境

但记住：

⚠️ Mock 无法替代真实环境的完整测试  
⚠️ DLL 插件功能必须在 ZTools 中测试  
⚠️ 系统操作类 API 需要真实验证

**建议开发流程**：Mock 快速开发 → ZTools 完整测试 → 发布
