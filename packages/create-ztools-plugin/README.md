# create-ztools-plugin

> 🚀 全新官方 ZTools 插件脚手架工具

## 特性

- ⚡️ **极速现代化**：基于现代化工具链，零多余冗余依赖，秒级生成
- 📦 **多模板支持**：
  - `vue-vite`：Vue 3 + Vite + TypeScript 现代化 Web 视图插件模板
  - `react-vite`：React 18 + Vite + TypeScript 现代化组件化插件模板
  - `preload-only`：纯无 UI 快速功能插件模板（极简后台/快速指令执行）
- 🛡️ **规范前置**：严格遵循 ZTools 开放平台插件规范，预置合规 `window` 属性、生命周期桥接与原生目标平台绑定
- 🔍 **双运行模式**：支持交互式向导式创建与命令行参数静默快速创建

## 使用方法

### 交互式创建

```bash
npx create-ztools-plugin
```

在命令行交互提示中输入插件 ID、名称、作者、描述并选择模板。

### 命令行快速创建

```bash
# 生成 Vue 3 模板
npx create-ztools-plugin my-vue-tool --template vue-vite -y

# 生成 React 18 模板
npx create-ztools-plugin my-react-tool --template react-vite -y

# 生成纯无 UI 快速功能模板
npx create-ztools-plugin my-quick-tool --template preload-only -y
```

### 选项列表

| 参数 | 说明 |
| :--- | :--- |
| `--id <id>` | 插件唯一标识（如 `my-tool`） |
| `--name <name>` | 插件显示名称（如 `我的实用工具`） |
| `--author <author>` | 插件作者（如 `ZTools Developer`） |
| `--description <desc>` | 插件功能描述 |
| `-t, --template <type>` | 模板类型（`vue-vite` / `react-vite` / `preload-only`） |
| `-y, --yes` | 快捷模式，跳过交互询问直接生成 |
| `--overwrite` | 当目标目录存在时强制覆盖 |
| `-h, --help` | 显示帮助信息 |
| `-v, --version` | 显示脚手架版本号 |

## 开发与测试

```bash
# 构建 CLI 产物
bun run build

# 运行自动化测试
bun test
```
