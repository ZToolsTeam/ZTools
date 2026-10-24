# @ztools/plugins-spec

ZTools 插件清单（`plugin.json`）的 JSON Schema 与校验函数。插件仓库的构建、扫描和合并前检查都用它校验清单。

- 清单字段、发布与下架规则：[发布规则](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/publishing.md)
- 每个权限的含义、哪些权限需要重点人工审核：[API 参考 · 权限](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/api.md#权限)

## 要点

- 必填字段：`id`、`name`、`version`、`description`、`author`、`entry`、`icon`、`permissions`、`targets`、`nativeComponents`（纯 JS 插件写 `[]`），完整定义见 [`plugin.schema.json`](plugin.schema.json)。
- `id` 用小写字母开头，只用小写字母、数字和短横线（构建脚本不接受下划线），并与插件目录名一致。
- `entry`、`icon` 必须是插件目录内的相对路径，不能用绝对路径或 `..`。
- `permissions` 是申请清单：扫描器会拦下用了却没声明权限的 Node 模块、网络请求和进程调用；高危权限会被标记为需要重点人工审核。

## 使用方式

```javascript
import fs from 'node:fs'
import { validatePluginManifest, pluginSchema } from '@ztools/plugins-spec'

const manifest = JSON.parse(fs.readFileSync('plugin.json', 'utf8'))
const result = validatePluginManifest(manifest, { baseDir: './' })

if (!result.valid) {
  console.error('清单校验未通过:', result.errors)
}
```

传入 `baseDir` 时还会检查 `entry` 与 `icon` 指向的文件是否存在，所以要在编译出 `dist/` 之后再校验。
