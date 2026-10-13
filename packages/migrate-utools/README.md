# @ztools/migrate

> ZTools 现代化 uTools 插件无损迁移 CLI 工具与核心转换引擎。

`@ztools/migrate` 将 uTools 插件迁移的静态代码扫描、Manifest 规范化映射、运行时同步垫片（UtoolsDbSyncShim / ServicesAdapter）注入与事务性原子保障抽象封装为开箱即用的现代化 CLI 工具与 TypeScript 库。

---

## 核心特性

- 🔍 **静态扫描与就绪度评估**：
  - 扫描源工程 `plugin.json`、JS/TS 源码、Node.js 核心模块与二进制原生依赖。
  - 计算 uTools API 调用覆盖率，输出 0-100 就绪度评分与分级风险建议（5 级兼容阶梯 TIER 1 - TIER 5）。
- ⚙️ **自动化转换与运行时适配**：
  - 采用隔离副本原则，默认输出至 `<plugin-name>-ztools/` 目录，绝对零写破坏源工程。
  - 自动规范化 Manifest（插件 ID 语义转写、Triggers 触发器映射、平台与窗口边界配置）。
  - 入口 HTML 幂等注入 `ztools://web/sdk/ztools-api.js`、`utools-db-sync-shim.js`（乐观 MVCC 内存同步数据库）与 `services-adapter.js`。
  - 支持无 `main` 的模板插件自动生成交互容器 `index.html`。
- 🛡️ **事务性安全保障与原子回滚**：
  - 支持 `--dry-run` 预演推演模式，零磁盘写入。
  - 维护文件级 SHA-256 校验和与逆向撤销日志（Undo Log），遭遇异常或解析失败时 100% 自动原子回滚。
  - 支持通过 `--rollback` 手动恢复目标目录。
  - 换行符守恒（LineEndingHelper）：严格保留原作者 CRLF / LF 换行特征（`.bat` 统一 CRLF，其余文件 LF）。

---

## 命令行用法 (CLI)

```bash
# 全局或直接运行
ztools-migrate <sourceDir> [targetDir] [选项]
```

### 命令选项

| 参数 / 选项 | 说明 |
| :--- | :--- |
| `<sourceDir>` | 源 uTools 插件目录路径（必填） |
| `[targetDir]` | 目标输出目录路径（可选，默认 `<sourceDir>-ztools`） |
| `--analyze-only` | 仅执行静态分析，输出就绪度评分与风险提示，零磁盘写操作 |
| `--dry-run` | 预演模式，仅推演生成 Diff 计划，绝对零触碰磁盘 |
| `--rollback` | 对目标工程执行原子事务回滚，恢复初始状态并清理垫片 |
| `--allow-dirty` | 允许目标工作区包含未提交的 Git 改动 |
| `--plugin-id <id>` | 显式指定符合规范的 ZTools 插件 ID (`^[a-z][a-z0-9-]*$`) |
| `--json` | 输出结构化 JSON 格式报告 |
| `-v, --version` | 查看工具版本号 |
| `-h, --help` | 显示帮助手册 |

### 使用示例

```bash
# 1. 静态评估插件兼容性
ztools-migrate ./my-plugin --analyze-only

# 2. 预演生成迁移变更清单 (Dry-Run)
ztools-migrate ./my-plugin ./my-plugin-ztools --dry-run

# 3. 正式执行无损迁移
ztools-migrate ./my-plugin ./my-plugin-ztools

# 4. 出现问题时回滚恢复
ztools-migrate ./my-plugin-ztools --rollback
```

---

## 编程式 API (Programmatic API)

可在 Node.js 或 Bun 中作为库直接调用：

```typescript
import {
  analyze,
  migrate,
  rollback,
  StaticScanAnalyzer,
  TransactionManager
} from '@ztools/migrate'

// 1. 静态扫描分析
const scanResult = analyze('./my-plugin')
console.log(`迁移就绪评分: ${scanResult.readinessScore}/100`)
console.log(`API 覆盖度: ${scanResult.apiUsage.coveragePercent}%`)

// 2. 事务性执行迁移
const result = migrate('./my-plugin', './my-plugin-ztools', {
  dryRun: false,
  allowDirty: true
})
console.log(`已安全应用 ${result.appliedCount} 项变更`)

// 3. 执行回滚
const rollbackResult = rollback('./my-plugin-ztools')
console.log(`已撤销 ${rollbackResult.totalReverted} 项文件`)
```

---

## 运行与测试

支持 Node.js (>=20) 与 Bun (>=1.0) 零依赖原生运行：

```bash
# 使用 Bun 运行测试套件
bun test tests/migrate.test.ts

# 使用 Node.js 原生测试运行器
node --test tests/migrate.test.ts
```
