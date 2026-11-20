# @ztools/plugins-spec

JSON Schema and validator for ZTools plugin manifests (`plugin.json`). Used by build, security scan, and pre-merge verification scripts in `ZTools-extensions`.

ZTools 插件清单（`plugin.json`）的 JSON Schema 与校验函数。插件仓库的构建、扫描和合并前检查都用它校验清单。

- Manifest fields, publishing & revocation rules / 清单字段、发布与下架规则：[Publishing Guide](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/publishing.md) · [发布规则](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/publishing.md)
- Permissions & review requirements / 权限说明与人工审核要求：[API Reference · Permissions](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/en/api.md#permissions) · [API 参考 · 权限](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/api.md#权限)

## Key Rules / 要点

- Required fields / 必填字段：`id`, `name`, `version`, `description`, `author`, `entry`, `icon`, `permissions`, `targets`, `nativeComponents` (`[]` for pure JS plugins). Full schema: [`plugin.schema.json`](plugin.schema.json).
- `id` must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (matching the plugin directory name). / `id` 用小写字母开头，只用小写字母、数字和短横线，并与插件目录名一致。
- `entry` and `icon` must be relative paths inside the plugin directory (no absolute paths or `..`). / `entry`、`icon` 必须是插件目录内的相对路径，不能用绝对路径或 `..`。
- `screenshots` (optional): up to 5 PNG files under `screenshots/`, each <= 1 MB, 640–2560 px wide and 400–1600 px tall. / 最多 5 张 `screenshots/` 下的 PNG，每张不超过 1 MB，宽 640–2560、高 400–1600 像素。
- `permissions`: undeclared Node modules, network requests, or process calls are rejected by the scanner; high-risk permissions require manual review. / 扫描器会拦下未声明权限的模块、网络请求和进程调用；高危权限需重点人工审核。

## Usage / 使用方式

```javascript
import fs from 'node:fs'
import { validatePluginManifest, pluginSchema } from '@ztools/plugins-spec'

const manifest = JSON.parse(fs.readFileSync('plugin.json', 'utf8'))
const result = validatePluginManifest(manifest, { baseDir: './' })

if (!result.valid) {
  console.error('Manifest validation failed:', result.errors)
}
```

When `baseDir` is provided, the validator also verifies that `entry`, `icon`, and screenshot files exist and meet size/dimension rules — run it after building `dist/`. / 传入 `baseDir` 时还会检查 `entry`、`icon` 与截图文件是否符合要求，请在编译出 `dist/` 之后校验。
