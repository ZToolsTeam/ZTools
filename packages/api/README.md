# @ztools/api

Official ZTools ecosystem contracts, plugin manifest JSON Schema, TypeScript type definitions, and validation utilities.

ZTools 官方开放生态契约、Manifest Schema、TypeScript 类型声明与校验工具。

## Directory Layout / 目录结构

```
packages/api/
├── package.json
├── schema/
│   └── plugin.schema.json         # Plugin Manifest JSON Schema (Draft 2020-12) / 插件 Manifest Schema
├── types/
│   └── index.d.ts                 # Authoritative TypeScript definitions / 权威 TypeScript 类型定义
├── contracts/                     # Cross-platform runtime contracts & fixtures / 跨平台运行时契约与测试夹具
│   ├── application-version.schema.json
│   ├── capability-record.schema.json
│   ├── platform-target.schema.json
│   ├── public-error.schema.json
│   ├── runtime-identity.schema.json
│   ├── validate-contracts.mjs
│   └── fixtures/
├── runtime/                       # Runtime SDK snapshots / 运行时 SDK 快照 (ztools-api.js, plugin-sdk.js)
└── scripts/                       # Contract & manifest validation tools / 插件契约与 Manifest 校验工具
    ├── validate-plugin.mjs
    └── validate-plugin-targets.test.mjs
```

## Usage / 使用说明

### TypeScript Definitions / TypeScript 类型定义

Reference in `tsconfig.json` / 在 `tsconfig.json` 或项目中引用：

```json
{
  "compilerOptions": {
    "types": ["@ztools/api"]
  }
}
```

Or import directly / 或直接引入：

```typescript
import type { ZToolsAPI } from '@ztools/api'
```

### Validate Plugin Manifest / 插件 Manifest 校验

```bash
node packages/api/scripts/validate-plugin.mjs <plugin-directory>
```
