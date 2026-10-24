# @ztools/declarative-ui

ZTools 声明式插件 SDK：组件（`List`、`Detail`、`Form`、`ActionPanel`、`Action` 等）、系统 API（`showToast`、`showHUD`、`Clipboard`、`LocalStorage` 等）与 Hooks 运行时。插件只描述界面结构，由 ZTools 客户端统一渲染，不写 HTML 和 CSS。

插件统一这样引入：

```ts
import React, { List, ActionPanel, Action } from "@ztools/declarative-ui";
```

- 组件、系统 API 与权限说明：[API 参考](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/api.md)
- 界面布局与交互规范：[界面规范](https://github.com/ZToolsTeam/ZTools-extensions/blob/main/docs/ui-guidelines.md)

准确的类型签名以编译产物 `dist/*.d.ts` 为准。
