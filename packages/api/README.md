# @ztools/api

ZTools 官方开放生态契约、Manifest Schema、TypeScript 类型声明与校验工具。

## 目录结构

```
packages/api/
├── package.json
├── schema/
│   └── plugin.schema.json         # 插件 Manifest JSON Schema (Draft 2020-12)
├── types/
│   └── index.d.ts                 # 权威 TypeScript 类型定义 (window.ztools & utools 兼容层)
├── contracts/                     # 跨平台运行时契约、能力清单与测试夹具
│   ├── application-version.schema.json
│   ├── capability-record.schema.json
│   ├── platform-target.schema.json
│   ├── public-error.schema.json
│   ├── runtime-identity.schema.json
│   ├── validate-contracts.mjs
│   └── fixtures/
├── runtime/                       # 运行时 SDK 快照 (ztools-api.js, plugin-sdk.js)
└── scripts/                       # 插件契约与 Manifest 校验工具
    ├── validate-plugin.mjs
    └── validate-plugin-targets.test.mjs
```

## 使用说明

### TypeScript 类型定义
在 `tsconfig.json` 或项目中引用：
```json
{
  "compilerOptions": {
    "types": ["@ztools/api"]
  }
}
```
或直接引入：
```typescript
import type { ZToolsAPI } from '@ztools/api'
```

### 插件 Manifest 校验
```bash
node packages/api/scripts/validate-plugin.mjs <plugin-directory>
```
