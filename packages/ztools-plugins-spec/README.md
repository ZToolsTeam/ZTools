# @ztools/plugins-spec

ZTools GitOps 插件规范、JSON Schema 校验与权限模型。

## 规范设计

- 插件必须通过 `plugin.json` 声明完整元数据；
- 必填字段：`id`, `name`, `version`, `description`, `author`, `entry`, `icon`, `permissions`；
- 细粒度权限模型：插件只能访问已在 `permissions` 中显式声明的系统和 Node 能力；
- 高危权限（如 `network`, `child_process`, `system`, `shell`, `fs`）在提交发布时自动触发双人审核机制（Two-Man Rule）。

## 使用方式

```javascript
import { validatePluginManifest, pluginSchema } from '@ztools/plugins-spec'

const manifest = JSON.parse(fs.readFileSync('plugin.json', 'utf8'))
const result = validatePluginManifest(manifest, { baseDir: './' })

if (!result.valid) {
  console.error('Manifest validation failed:', result.errors)
}
```
