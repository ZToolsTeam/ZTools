# ZTools DevTools

> ZTools 远程调试工具集

## 工具列表

| 工具         | 命令                    | 说明                               |
| ------------ | ----------------------- | ---------------------------------- |
| 内置调试面板 | ZTools 内 `/#/devtools` | 无需外部工具，直接在 ZTools 内调试 |
| Web 界面     | `npm run web`           | 浏览器可视化调试面板               |
| 交互式 REPL  | `npm run repl`          | 命令行交互式控制台                 |
| 命令行执行   | `npm run exec`          | 单次执行 JS 代码                   |

## 前置条件

1. **ZTools 必须配置远程调试端口**（默认 9222）
2. **安装依赖**（仅外部工具需要）：

```bash
cd frontend/devtools
npm install
```

## 快速开始

### 方式一：内置调试面板（推荐）

直接在 ZTools 中访问：

- 路由：`/#/devtools`
- 入口：高级设置 → 开发者工具 → 打开

功能：

- 交互式控制台
- 快捷操作按钮
- 命令历史（上下箭头）
- 亮/暗模式切换
- 无需外部依赖

### 方式二：Web 可视化界面

```bash
npm run web
```

自动打开浏览器访问 http://localhost:9333，提供：

- 可视化控制台
- API 参考面板
- 快捷操作按钮
- 多目标窗口选择

### 方式三：交互式 REPL

```bash
npm run repl
```

功能：

- 交互式执行 JS 代码
- 命令历史（上下箭头）
- 快捷命令（`.help` 查看）
- 自动连接第一个目标

快捷命令：

```
.help              显示帮助
.list              列出调试目标
.target <n>        切换目标窗口
.info              显示系统信息
.plugins           列出所有插件
.notify <msg>      发送测试通知
.toast <type> <msg> 显示 Toast
.db.get <key>      获取数据库值
.db.all [prefix]   列出数据库文档
.dll <plugin> <func> [params]  调用 DLL
.clear             清屏
.exit              退出
```

### 方式四：命令行单次执行

```bash
# 列出目标
npm run list

# 执行代码
npm run exec "ztools.sys.getInfo()"

# 调用 DLL
npm run exec -- --dll ImagePlugin ProcessImage '{"path":"test.jpg"}'
```

## 常用场景

### 测试 ZTools API

```bash
# 系统信息
node exec.js "ztools.sys.getInfo()"
node exec.js "ztools.sys.getAppVersion()"

# 通知测试
node exec.js "ztools.sys.notify('测试', '这是一条测试通知')"
node exec.js "ztools.sys.toast('success', '操作成功')"

# 数据库操作
node exec.js "ztools.db.setPluginId('test')"
node exec.js "ztools.db.put({_id:'test:1', data:'value'})"
node exec.js "ztools.db.get('test:1')"
node exec.js "ztools.db.allDocs('test:')"

# 插件操作
node exec.js "ztools.plugin.getList()"
node exec.js "ztools.plugin.open('my-plugin')"
node exec.js "ztools.plugin.close('my-plugin')"
```

### DLL 插件调试

```bash
# 图像处理插件
node exec.js --dll ImagePlugin CompressImage '{"input":"test.jpg","output":"out.jpg","quality":80}'

# 右键菜单插件
node exec.js --dll ContextMenuPlugin ScanMenuItems

# OCR 插件
node exec.js --dll OCRPlugin RecognizeText '{"imagePath":"screenshot.png"}'
```

### 批量操作与自动化

```bash
# 批量测试
for i in {1..10}; do
  node exec.js "console.log('Test $i')"
done

# 自动化测试脚本
#!/bin/bash
echo "开始测试..."
node exec.js "ztools.sys.getInfo()" || exit 1
node exec.js "ztools.db.put({_id:'test',data:'ok'})" || exit 1
echo "测试通过！"
```

## 命令行参数

| 参数                         | 简写 | 说明             | 示例                               |
| ---------------------------- | ---- | ---------------- | ---------------------------------- |
| `--list`                     | `-l` | 列出所有调试目标 | `node exec.js -l`                  |
| `--target <索引\|名称>`      | `-t` | 指定目标窗口     | `node exec.js -t 0 "code"`         |
| `--dll <插件> <函数> [参数]` | `-d` | 调用 DLL 插件    | `node exec.js -d Plugin Func '{}'` |

## 配置

### 修改调试端口

编辑 `exec.js`：

```javascript
const HOST = '127.0.0.1'
const PORT = 9222 // 修改端口
```

### 远程调试

```javascript
const HOST = '192.168.1.100' // 远程 IP
const PORT = 9222
```

## 故障排查

### 常见错误

1. **未找到 ZTools 页面实例**
   - 确保 ZTools 正在运行
   - 确保启用了远程调试端口 9222

2. **连接失败**
   - 检查端口是否被占用
   - 访问 `http://127.0.0.1:9222/json` 验证

3. **JS 执行异常**
   - 检查代码语法
   - 确认 API 是否存在

## 相关文档

- [ZTools API 文档](../../docs/API使用指南.md)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)

---

**最后更新**: 2026-01-21
